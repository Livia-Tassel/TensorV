// Portable experiment documents contain code and view settings, never snapshots
// or server-issued IDs. Decoding performs no network requests or code execution.
export const EXPERIMENT_FORMAT = 'tensorv-experiment';
export const EXPERIMENT_VERSION = 1;
export const MAX_EXPERIMENT_BYTES = 128 * 1024;
export const MAX_EXPERIMENT_URL_LENGTH = 16384;
const MAX_CODE_LENGTH = 20000;
const encoder = new TextEncoder();

export class ExperimentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExperimentError';
    this.code = code;
  }
}

function fail(message, code = 'INVALID_EXPERIMENT') {
  throw new ExperimentError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label}必须是普通对象。`);
  return value;
}

function field(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`实验缺少有效的 ${key} 字段。`);
  return descriptor.value;
}

function string(value, label, maximum, nonempty = false) {
  if (typeof value !== 'string' || value.length > maximum || (nonempty && !value.trim())) {
    fail(`${label}必须是${nonempty ? '非空' : ''}文本，且不超过 ${maximum.toLocaleString('en-US')} 个字符。`);
  }
  return value;
}

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label}超出允许范围。`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label}必须是布尔值。`);
  return value;
}

function array(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label}长度无效。`);
  // Read own data properties only: sparse arrays and accessor entries are not
  // produced by JSON and should not invoke callbacks during direct validation.
  return Array.from({ length: value.length }, (_, index) => field(value, String(index)));
}

function step(value, label) {
  if (value === null) return null;
  object(value, label);
  return {
    index: integer(field(value, 'index'), `${label}索引`, 127),
    line: integer(field(value, 'line'), `${label}行号`, MAX_CODE_LENGTH + 1, 1),
    source: string(field(value, 'source'), `${label}语句`, MAX_CODE_LENGTH, true),
  };
}

function tensorView(value, label) {
  if (value === null) return null;
  object(value, label);
  const shape = array(field(value, 'shape'), `${label}形状`, 64).map((size) => integer(size, `${label}维度长度`));
  const rank = shape.length;
  const row = field(value, 'row_axis');
  const col = field(value, 'col_axis');
  if ((rank < 2 && row !== null) || (rank >= 2 && (!Number.isInteger(row) || row < 0 || row >= rank))) {
    fail(`${label}行维度无效。`);
  }
  if ((rank === 0 && col !== null) || (rank > 0 && (!Number.isInteger(col) || col < 0 || col >= rank))
      || (rank >= 2 && row === col)) fail(`${label}列维度无效。`);
  const indices = array(field(value, 'indices'), `${label}切片索引`, 64);
  if (indices.length !== rank) fail(`${label}索引数量必须与维度数量相同。`);
  indices.forEach((index, axis) => integer(index, `${label}切片索引`, Math.max(0, shape[axis] - 1)));
  return {
    name: string(field(value, 'name'), `${label}变量名`, 256, true),
    shape,
    row_axis: row,
    col_axis: col,
    indices,
    row_start: integer(field(value, 'row_start'), `${label}行起点`, row === null ? 0 : Math.max(0, shape[row] - 1)),
    col_start: integer(field(value, 'col_start'), `${label}列起点`, col === null ? 0 : Math.max(0, shape[col] - 1)),
  };
}

function boundedJSON(value) {
  const json = JSON.stringify(value);
  if (encoder.encode(json).byteLength > MAX_EXPERIMENT_BYTES) {
    fail('实验文件超过 128 KiB，请缩短代码或保存较小的实验。', 'EXPERIMENT_TOO_LARGE');
  }
  return json;
}

export function validateExperiment(input) {
  object(input, '实验');
  if (field(input, 'format') !== EXPERIMENT_FORMAT) fail('这不是 TensorV 实验文件。');
  if (field(input, 'version') !== EXPERIMENT_VERSION) fail('不支持此实验版本，请使用兼容版本的 TensorV。', 'UNSUPPORTED_VERSION');
  const environment = object(field(input, 'environment'), '实验环境');
  const torch = field(environment, 'torch');
  const view = object(field(input, 'view'), '观察设置');
  const precision = field(view, 'precision');
  const tab = field(view, 'tab');
  if (![4, 6, 8].includes(precision)) fail('数值精度只能是 4、6 或 8 位有效数字。');
  if (!['canvas', 'memory', 'stats'].includes(tab)) fail('观察标签无效。');
  const result = {
    format: EXPERIMENT_FORMAT,
    version: EXPERIMENT_VERSION,
    title: string(field(input, 'title'), '实验标题', 80, true),
    code: string(field(input, 'code'), 'Python 代码', MAX_CODE_LENGTH),
    environment: {
      torch: torch === null ? null : string(torch, 'PyTorch 版本', 64, true),
      app: string(field(environment, 'app'), 'TensorV 版本', 64, true),
    },
    view: {
      step: step(field(view, 'step'), '执行步骤'),
      referenceStep: step(field(view, 'referenceStep'), '对照步骤'),
      before: tensorView(field(view, 'before'), '操作前'),
      after: tensorView(field(view, 'after'), '操作后'),
      compare: boolean(field(view, 'compare'), '前后对照'),
      heatmap: boolean(field(view, 'heatmap'), '热力图'),
      precision,
      tab,
    },
  };
  boundedJSON(result);
  return result;
}

export function serializeExperiment(experiment) {
  return boundedJSON(validateExperiment(experiment));
}

export function parseExperiment(text) {
  if (typeof text !== 'string') fail('实验文件必须是 UTF-8 JSON 文本。');
  // Check character count first to avoid encoding an arbitrarily large string.
  if (text.length > MAX_EXPERIMENT_BYTES || encoder.encode(text).byteLength > MAX_EXPERIMENT_BYTES) {
    fail('实验文件超过 128 KiB，请缩短代码或保存较小的实验。', 'EXPERIMENT_TOO_LARGE');
  }
  let value;
  try { value = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); }
  catch { fail('实验文件不是有效的 JSON，可能已损坏或被截断。'); }
  return validateExperiment(value);
}

function base64url(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 4096) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 4096));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function unbase64url(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) fail('实验链接内容无效或已被截断。', 'INVALID_LINK');
  let binary;
  try { binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)); }
  catch { fail('实验链接内容无效或已被截断。', 'INVALID_LINK'); }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (base64url(bytes) !== value) fail('实验链接编码无效或已被截断。', 'INVALID_LINK');
  return bytes;
}

async function transform(bytes, Constructor) {
  if (bytes.byteLength > MAX_EXPERIMENT_BYTES) fail('实验数据超过 128 KiB。', 'EXPERIMENT_TOO_LARGE');
  let offset = 0;
  // Feed bounded chunks instead of handing a whole compressed payload to the
  // decompressor. Cancel as soon as expanded output crosses the document limit.
  const input = new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 512, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
  const reader = input.pipeThrough(new Constructor('gzip')).getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_EXPERIMENT_BYTES) fail('实验解压后的内容超过 128 KiB。', 'EXPERIMENT_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch { /* A failed gzip stream may already be closed. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) { result.set(chunk, position); position += chunk.byteLength; }
  return result;
}

function checkLinkLength(value) {
  if (value.length > MAX_EXPERIMENT_URL_LENGTH) {
    fail('实验链接超过 16,384 个字符，请改为导出实验文件。', 'LINK_TOO_LONG');
  }
  return value;
}

export async function encodeExperiment(experiment) {
  const plain = encoder.encode(serializeExperiment(experiment));
  let payload = plain;
  let format = 'p';
  if (typeof globalThis.CompressionStream === 'function') {
    try {
      const compressed = await transform(plain, globalThis.CompressionStream);
      if (compressed.byteLength < plain.byteLength) { payload = compressed; format = 'g'; }
    } catch { /* Older browser implementations can still share plain JSON. */ }
  }
  return checkLinkLength(`#tv=${EXPERIMENT_VERSION}.${format}.${base64url(payload)}`);
}

export async function decodeExperiment(hash) {
  if (typeof hash !== 'string') fail('实验链接必须是文本。', 'INVALID_LINK');
  checkLinkLength(hash);
  const match = /^#tv=([0-9]+)\.([a-z])\.([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) fail('实验链接格式无效或已被截断。', 'INVALID_LINK');
  if (match[1] !== String(EXPERIMENT_VERSION)) fail('不支持此实验链接版本。', 'UNSUPPORTED_VERSION');
  if (!['g', 'p'].includes(match[2])) fail('实验链接使用了不支持的编码格式。', 'INVALID_LINK');
  let bytes = unbase64url(match[3]);
  if (match[2] === 'g') {
    if (typeof globalThis.DecompressionStream !== 'function') {
      fail('当前浏览器不支持解压实验链接，请更新浏览器或请发送方导出实验文件。', 'UNSUPPORTED_COMPRESSION');
    }
    try { bytes = await transform(bytes, globalThis.DecompressionStream); }
    catch (error) {
      if (error instanceof ExperimentError) throw error;
      fail('实验链接解压失败，内容可能已损坏或被截断。', 'INVALID_LINK');
    }
  }
  let json;
  try { json = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('实验链接不是有效的 UTF-8 文本。', 'INVALID_LINK'); }
  return parseExperiment(json);
}

export async function experimentURL(experiment, baseURL) {
  if (typeof baseURL !== 'string') fail('分享地址必须是 HTTP 或 HTTPS 网页。', 'INVALID_BASE_URL');
  let url;
  try { url = new URL(baseURL); }
  catch { fail('分享地址无效。', 'INVALID_BASE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail('分享地址必须是不含凭据的 HTTP 或 HTTPS 网页。', 'INVALID_BASE_URL');
  }
  // Do not leak query parameters or a previously opened experiment into links.
  url.search = '';
  url.hash = await encodeExperiment(experiment);
  return checkLinkLength(url.href);
}
