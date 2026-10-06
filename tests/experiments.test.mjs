import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  validateExperiment, serializeExperiment, parseExperiment, encodeExperiment, decodeExperiment, experimentURL,
  MAX_EXPERIMENT_BYTES, MAX_EXPERIMENT_URL_LENGTH,
} from '../src/experiments.js';

function fixture() {
  return {
    format: 'tensorv-experiment', version: 1, title: '转置实验：张量 🧪',
    code: 'import torch\nx = torch.arange(24).reshape(2, 3, 4)\ny = x.transpose(1, 2)\n',
    environment: { torch: '2.14.1+cpu', app: '0.3.0' },
    view: {
      step: { index: 1, line: 3, source: 'y = x.transpose(1, 2)' },
      referenceStep: { index: 0, line: 2, source: 'x = torch.arange(24).reshape(2, 3, 4)' },
      before: { name: 'x', shape: [2, 3, 4], row_axis: 1, col_axis: 2, indices: [1, 0, 0], row_start: 0, col_start: 0 },
      after: { name: 'y', shape: [2, 4, 3], row_axis: 0, col_axis: 2, indices: [0, 2, 0], row_start: 0, col_start: 0 },
      compare: true, heatmap: false, precision: 8, tab: 'memory',
    },
  };
}

function plainHash(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return '#tv=1.p.' + Buffer.from(text).toString('base64url');
}

function withGlobal(name, value, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return Promise.resolve().then(run).finally(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  });
}

test('Chinese, emoji, multiline code and two independent high-dimensional views round-trip through JSON', () => {
  const expected = fixture();
  const parsed = parseExperiment(serializeExperiment(expected));
  assert.deepEqual(parsed, expected);
  assert.notEqual(parsed, expected);
  assert.notEqual(parsed.view.after.indices, expected.view.after.indices);
  assert.deepEqual(parseExperiment('\uFEFF' + serializeExperiment(expected)), expected);
});

test('empty experiments and scalar, vector, empty and paginated views have explicit valid states', () => {
  const value = fixture();
  value.code = '';
  value.environment.torch = null;
  value.view.step = value.view.referenceStep = value.view.before = value.view.after = null;
  assert.deepEqual(validateExperiment(value), value);
  for (const shape of [[], [0], [72], [0, 3], [2, 0, 4]]) {
    value.view.after = { name: '标量或切片', shape, row_axis: shape.length >= 2 ? shape.length - 2 : null,
      col_axis: shape.length ? shape.length - 1 : null, indices: shape.map(() => 0),
      row_start: 0, col_start: shape.length === 1 && shape[0] === 72 ? 48 : 0 };
    assert.deepEqual(validateExperiment(value).view.after, value.view.after);
  }
});

test('normalization strips snapshots, server IDs, paths, environment actions and prototype keys', () => {
  const value = fixture();
  value.snapshot_id = 'run-secret';
  value.path = 'C:/private/source.py';
  value.data = [1, 2, 3];
  value.environment.install = 'do not run';
  value.view.after.id = 'server-snapshot';
  value.view.after.storage = 'S1';
  value.view.after.values = [[1, 2, 3]];
  value.view.step.run_id = 'server-run';
  const json = JSON.stringify(value).slice(0, -1) + ',"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}';
  assert.deepEqual(parseExperiment(json), fixture());
  assert.equal({}.polluted, undefined);
  assert.doesNotMatch(serializeExperiment(value), /run-secret|private|server-snapshot|server-run|do not run/);
});

test('validation reads own data fields and never invokes getters or toJSON', () => {
  const value = fixture();
  Object.defineProperty(value, 'ignored', { get() { assert.fail('Unknown field getter ran'); } });
  value.toJSON = () => assert.fail('toJSON ran');
  assert.deepEqual(parseExperiment(serializeExperiment(value)), fixture());
  Object.defineProperty(value, 'code', { get() { assert.fail('Code getter ran'); } });
  assert.throws(() => validateExperiment(value), { code: 'INVALID_EXPERIMENT' });
  const sparse = fixture();
  sparse.view.after.indices = new Array(3);
  assert.throws(() => validateExperiment(sparse), { code: 'INVALID_EXPERIMENT' });
});

test('unknown formats, future versions and inherited field values are rejected', () => {
  for (const input of [null, [], true, '', 2]) assert.throws(() => validateExperiment(input), { code: 'INVALID_EXPERIMENT' });
  const wrongFormat = fixture(); wrongFormat.format = 'some-other-document';
  assert.throws(() => validateExperiment(wrongFormat), { code: 'INVALID_EXPERIMENT' });
  for (const version of [0, 2, '1', true, null]) {
    assert.throws(() => validateExperiment({ ...fixture(), version }), { code: 'UNSUPPORTED_VERSION' });
  }
  assert.throws(() => validateExperiment(Object.create(fixture())), { code: 'INVALID_EXPERIMENT' });
});

test('text lengths, strict types, ranks, axes, indices and page ranges are bounded', () => {
  const mutations = [
    (v) => { v.title = ' '; }, (v) => { v.title = 'x'.repeat(81); },
    (v) => { v.code = 'x'.repeat(20001); }, (v) => { v.environment.torch = {}; },
    (v) => { v.environment.app = 'x'.repeat(65); }, (v) => { v.view.step.index = 128; },
    (v) => { v.view.step.line = 0; }, (v) => { v.view.step.index = false; },
    (v) => { v.view.step.source = 'x'.repeat(20001); }, (v) => { v.view.compare = 1; },
    (v) => { v.view.heatmap = 'true'; }, (v) => { v.view.precision = '4'; },
    (v) => { v.view.tab = 'unknown'; }, (v) => { v.view.after.name = 'x'.repeat(257); },
    (v) => { v.view.after.shape = Array(65).fill(1); },
    (v) => { v.view.after.shape[0] = -1; }, (v) => { v.view.after.shape[0] = Infinity; },
    (v) => { v.view.after.shape[0] = Number.MAX_SAFE_INTEGER + 1; },
    (v) => { v.view.after.shape[0] = true; }, (v) => { v.view.after.row_axis = 3; },
    (v) => { v.view.after.row_axis = false; }, (v) => { v.view.after.row_axis = null; },
    (v) => { v.view.after.col_axis = v.view.after.row_axis; },
    (v) => { v.view.after.indices = [0, 0]; }, (v) => { v.view.after.indices[0] = NaN; },
    (v) => { v.view.after.indices[0] = -1; }, (v) => { v.view.after.indices[0] = 2; },
    (v) => { v.view.after.row_start = -1; }, (v) => { v.view.after.row_start = 2; },
    (v) => { v.view.after.col_start = 3; }, (v) => { delete v.view.after; },
  ];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value);
    assert.throws(() => validateExperiment(value), { code: 'INVALID_EXPERIMENT' }, mutate.toString());
  }
});

test('JSON limits count UTF-8 bytes and escaped data, not only source characters', () => {
  const value = fixture();
  value.code = value.view.step.source = value.view.referenceStep.source = '界'.repeat(20000);
  assert.throws(() => serializeExperiment(value), { code: 'EXPERIMENT_TOO_LARGE' });
  value.code = value.view.step.source = value.view.referenceStep.source = '\0'.repeat(10000);
  assert.throws(() => serializeExperiment(value), { code: 'EXPERIMENT_TOO_LARGE' });
  assert.throws(() => parseExperiment(' '.repeat(MAX_EXPERIMENT_BYTES + 1)), { code: 'EXPERIMENT_TOO_LARGE' });
  assert.throws(() => parseExperiment('界'.repeat(Math.ceil(MAX_EXPERIMENT_BYTES / 3))), { code: 'EXPERIMENT_TOO_LARGE' });
  assert.throws(() => parseExperiment('{"format":'), { code: 'INVALID_EXPERIMENT' });
});

test('gzip links round-trip Chinese and preserve every observation field', async () => {
  const value = fixture();
  const hash = await encodeExperiment(value);
  assert.match(hash, /^#tv=1\.g\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeExperiment(hash), value);
  assert.deepEqual(await decodeExperiment(plainHash(value)), value);
});

test('missing or unavailable gzip compression falls back to portable plain JSON', async () => {
  for (const constructor of [undefined, class { constructor() { throw new Error('Unavailable'); } }]) {
    await withGlobal('CompressionStream', constructor, async () => {
      const hash = await encodeExperiment(fixture());
      assert.match(hash, /^#tv=1\.p\./);
      assert.deepEqual(await decodeExperiment(hash), fixture());
    });
  }
});

test('gzip links report missing decompression support without silently using another format', async () => {
  const hash = await encodeExperiment(fixture());
  await withGlobal('DecompressionStream', undefined, async () => {
    await assert.rejects(decodeExperiment(hash), { code: 'UNSUPPORTED_COMPRESSION' });
    assert.deepEqual(await decodeExperiment(plainHash(fixture())), fixture());
  });
});

test('malformed, noncanonical, truncated and unknown-version links are rejected', async () => {
  for (const hash of ['', 'https://example.org/#tv=1.p.e30', '#tv=1.p.', '#tv=1.p.A', '#tv=1.p.AR',
    '#tv=1.p.e30=', '#tv=1.z.e30', '#tv=1.p.e30&run=1', '#tv=1.g.AAAA']) {
    await assert.rejects(decodeExperiment(hash), { code: 'INVALID_LINK' }, hash);
  }
  await assert.rejects(decodeExperiment('#tv=2.p.e30'), { code: 'UNSUPPORTED_VERSION' });
  await assert.rejects(decodeExperiment(plainHash({ ...fixture(), version: 2 })), { code: 'UNSUPPORTED_VERSION' });
  const truncated = gzipSync(Buffer.from(serializeExperiment(fixture()))).subarray(0, -4);
  await assert.rejects(decodeExperiment('#tv=1.g.' + truncated.toString('base64url')), { code: 'INVALID_LINK' });
  await assert.rejects(decodeExperiment('#tv=1.p.' + Buffer.from([0xFF]).toString('base64url')), { code: 'INVALID_LINK' });
});

test('decompression cancels a small gzip payload whose output exceeds 128 KiB', { timeout: 5000 }, async () => {
  const compressed = gzipSync(Buffer.alloc(MAX_EXPERIMENT_BYTES * 8, 32));
  const hash = '#tv=1.g.' + compressed.toString('base64url');
  assert.ok(hash.length < MAX_EXPERIMENT_URL_LENGTH);
  await assert.rejects(decodeExperiment(hash), { code: 'EXPERIMENT_TOO_LARGE' });
});

test('oversized links are refused and the same experiment remains available as a file', async () => {
  const value = fixture();
  value.code = 'x'.repeat(13000);
  assert.deepEqual(parseExperiment(serializeExperiment(value)), value);
  await withGlobal('CompressionStream', undefined, async () => {
    await assert.rejects(encodeExperiment(value), { code: 'LINK_TOO_LONG' });
  });
  await assert.rejects(decodeExperiment('#tv=1.g.' + 'A'.repeat(MAX_EXPERIMENT_URL_LENGTH)), { code: 'LINK_TOO_LONG' });
  await assert.rejects(experimentURL(fixture(), 'https://example.org/' + 'a'.repeat(MAX_EXPERIMENT_URL_LENGTH)), { code: 'LINK_TOO_LONG' });
});

test('share URLs remove old query and fragment data while accepting only credential-free HTTP(S)', async () => {
  const url = new URL(await experimentURL(fixture(), 'https://tensorv.example/workspace?token=secret#old-data'));
  assert.equal(url.origin, 'https://tensorv.example');
  assert.equal(url.pathname, '/workspace');
  assert.equal(url.search, '');
  assert.deepEqual(await decodeExperiment(url.hash), fixture());
  assert.match(await experimentURL(fixture(), 'http://127.0.0.1:8765/'), /^http:\/\/127\.0\.0\.1:8765\/#tv=/);
  for (const base of ['javascript:alert(1)', 'data:text/html,bad', 'file:///private/source.py', '/relative', 'https://user:password@example.org/']) {
    await assert.rejects(experimentURL(fixture(), base), { code: 'INVALID_BASE_URL' });
  }
});

test('encoding and decoding preserve code as text and never request the execution service', async () => {
  const value = fixture();
  value.title = '<img src=x onerror=alert(1)>';
  value.code = "__import__('os').system('do-not-run')";
  await withGlobal('fetch', () => assert.fail('Experiment helpers must not access the network'), async () => {
    assert.deepEqual(await decodeExperiment(await encodeExperiment(value)), value);
  });
});
