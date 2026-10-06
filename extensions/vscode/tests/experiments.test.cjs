const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { readExperimentText, MAX_EXPERIMENT_BYTES } = require('../lib/experiments.cjs');
const { ImportQueue } = require('../lib/webview.cjs');

test('native experiment import reads UTF-8 text without parsing or executing it', async () => {
  const text = '{"code":"raise RuntimeError(\"never run\")","title":"实验"}';
  const bytes = Buffer.from(text);
  const fileSystem = { stat: async () => ({ size: bytes.length }), readFile: async () => bytes };
  assert.equal(await readExperimentText(fileSystem, 'fixture'), text);
});

test('native experiment import rejects oversized files before reading', async () => {
  let reads = 0;
  const fileSystem = { stat: async () => ({ size: MAX_EXPERIMENT_BYTES + 1 }), readFile: async () => { reads += 1; } };
  await assert.rejects(readExperimentText(fileSystem, 'fixture'), /128 KiB/);
  assert.equal(reads, 0);
});

test('native experiment import checks changed file size and malformed UTF-8', async () => {
  const fileSystem = { stat: async () => ({ size: 1 }), readFile: async () => Buffer.alloc(MAX_EXPERIMENT_BYTES + 1) };
  await assert.rejects(readExperimentText(fileSystem, 'fixture'), /128 KiB/);
  fileSystem.readFile = async () => Buffer.from([0xff]);
  await assert.rejects(readExperimentText(fileSystem, 'fixture'), /UTF-8/);
});

test('native content queue retains only the latest experiment or Python import', async () => {
  const sent = [];
  const queue = new ImportQueue(async message => { sent.push(message); return true; });
  await queue.enqueue({ type: 'tensorv:import', code: 'old code' });
  await queue.enqueue({ type: 'tensorv:experiment', text: '{"title":"new"}' });
  await queue.markReady();
  assert.deepEqual(sent, [{ type: 'tensorv:experiment', text: '{"title":"new"}' }]);
});

async function hostFixture() {
  const { createVSCodeHost } = await import(pathToFileURL(path.resolve(__dirname, '../../../src/host.js')));
  let receive;
  const sent = [];
  const host = createVSCodeHost({ getState: () => ({}), setState() {}, postMessage: message => sent.push(message) }, {
    addEventListener: (type, handler) => { assert.equal(type, 'message'); receive = handler; },
  });
  return { host, sent, receive: message => receive({ data: message }) };
}

test('webview host buffers experiment text without executing and clears stale queued Python content', async () => {
  const { host, sent, receive } = await hostFixture();
  receive({ type: 'tensorv:import', code: 'old code' });
  const experiment = { type: 'tensorv:experiment', text: '{"code":"new code"}' };
  receive(experiment);
  const imports = [], experiments = [];
  host.onImport(message => imports.push(message));
  host.onExperiment(message => experiments.push(message));
  assert.deepEqual(imports, []);
  assert.deepEqual(experiments, [experiment]);
  assert.deepEqual(sent, []);
  host.openExperiment();
  assert.deepEqual(sent, [{ type: 'tensorv:openExperiment' }]);
});

test('webview host enforces UTF-8 byte limit instead of character count', async () => {
  const { host, receive } = await hostFixture();
  let count = 0;
  host.onExperiment(() => { count += 1; });
  receive({ type: 'tensorv:experiment', text: '中'.repeat(45000) });
  assert.equal(count, 0);
  receive({ type: 'tensorv:experiment', text: 'x'.repeat(MAX_EXPERIMENT_BYTES) });
  assert.equal(count, 1);
});

test('clipboard copies await native acknowledgement and share request IDs safely', async () => {
  const { host, sent, receive } = await hostFixture();
  const copied = host.copy('https://example.test/#experiment=123');
  const execution = host.request('execute', { code: 'pass' });
  assert.equal(sent[0].type, 'tensorv:copy');
  assert.notEqual(sent[0].id, sent[1].id);
  receive({ type: 'tensorv:response', id: sent[1].id, ok: true, data: { steps: [] } });
  receive({ type: 'tensorv:response', id: sent[0].id, ok: true, data: null });
  assert.equal(await copied, null);
  assert.deepEqual(await execution, { steps: [] });
  const rejected = host.copy('failure');
  receive({ type: 'tensorv:response', id: sent.at(-1).id, ok: false, message: 'clipboard unavailable' });
  await assert.rejects(rejected, /clipboard unavailable/);
});
