'use strict';

const MAX_EXPERIMENT_BYTES = 128 * 1024;

async function readExperimentText(fileSystem, uri) {
  const stat = await fileSystem.stat(uri);
  if (stat.size > MAX_EXPERIMENT_BYTES) throw new Error('实验文件不能超过 128 KiB。');
  const bytes = await fileSystem.readFile(uri);
  // Recheck after reading in case the selected file changed since stat().
  if (bytes.byteLength > MAX_EXPERIMENT_BYTES) throw new Error('实验文件不能超过 128 KiB。');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('实验文件必须使用 UTF-8 编码。'); }
}

module.exports = { readExperimentText, MAX_EXPERIMENT_BYTES };
