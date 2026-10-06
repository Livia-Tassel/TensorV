import test from 'node:test';
import assert from 'node:assert/strict';
import { createVSCodeHost } from '../src/host.js';

function fixture() {
  let receiver, state;
  const sent = [];
  const host = createVSCodeHost({ getState: () => state, setState: (value) => { state = value; }, postMessage: (message) => sent.push(message) }, { addEventListener: (_, listener) => { receiver = listener; } });
  return { host, sent, receive: (data) => receiver({ data }), state: () => state };
}

test('webview matches responses by ID and preserves Python errors', async () => {
  const f = fixture();
  const first = f.host.request('execute', { code: 'x = 1' });
  const second = f.host.request('slice', { id: 'tensor-1' });
  f.receive({ type: 'tensorv:response', id: f.sent[1].id, ok: true, data: { values: [[1]] } });
  f.receive({ type: 'tensorv:response', id: f.sent[0].id, ok: false, message: 'PyTorch 导入失败' });
  assert.deepEqual(await second, { values: [[1]] });
  await assert.rejects(first, /PyTorch 导入失败/);
});

test('webview preferences survive recreated transport without localStorage', () => {
  const f = fixture();
  f.host.setItem('tensorv:auto', 'false');
  f.host.setItem('tensorv:scripts', 'private-code');
  assert.equal(f.host.getItem('tensorv:auto'), 'false');
  assert.deepEqual(f.state().storage, { 'tensorv:auto': 'false', 'tensorv:scripts': 'private-code' });
  assert.equal(f.sent.length, 0);
});

test('latest import is buffered until the UI is ready; unknown events do not execute', () => {
  const f = fixture();
  const imports = [];
  f.receive({ type: 'tensorv:import', code: 'first' });
  f.receive({ type: 'tensorv:import', code: 'second' });
  f.receive({ type: 'execute', code: 'ignored' });
  f.host.onImport((message) => imports.push(message.code));
  f.receive({ type: 'tensorv:import', code: 'x'.repeat(20001) });
  f.host.ready();
  assert.deepEqual(imports, ['second']);
  assert.deepEqual(f.sent, [{ type: 'tensorv:ready' }]);
});
