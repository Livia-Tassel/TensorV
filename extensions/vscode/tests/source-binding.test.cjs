const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SourceBinding } = require('../lib/source-binding.cjs');

function fixture() {
  let next = 0;
  const messages = [];
  const binding = new SourceBinding(message => messages.push(message), () => `source-${++next}`);
  const document = { uri: { toString: () => 'file:///workspace/source.py' }, version: 1, isClosed: false,
    code: 'x = torch.arange(3)', getText() { return this.code; } };
  return { binding, document, messages };
}

test('full-file binding reads the latest unsaved document and guards exact execution versions', () => {
  const { binding, document, messages } = fixture();
  const source = binding.replace(document);
  assert.equal(source.mode, 'file');
  document.code = 'x = torch.arange(8)'; document.version += 1;
  binding.changed(document);
  assert.equal(messages.at(-1).type, 'tensorv:sourceChanged');
  assert.equal(messages.at(-1).code, document.code);
  assert.equal(binding.read(source.id).code, document.code);
  assert.throws(() => binding.read(source.id, 1), { code: 'SOURCE_CHANGED' });
  assert.equal(binding.read(source.id, 2).source.version, 2);
});

test('suspending stops notifications and execution but latest token can resume with current text', () => {
  const { binding, document, messages } = fixture();
  const { id } = binding.replace(document);
  binding.bind(null);
  document.code = 'new unsaved text'; document.version += 1;
  binding.changed(document);
  assert.equal(messages.length, 0);
  assert.throws(() => binding.read(id), { code: 'SOURCE_UNAVAILABLE' });
  binding.bind(id);
  assert.equal(messages.at(-1).code, document.code);
  assert.equal(binding.read(id).source.version, 2);
});

test('a newer native import retires the old token and cannot be displaced by a stale rebind', () => {
  const { binding, document, messages } = fixture();
  const first = binding.replace(document);
  const secondDocument = { ...document, uri: { toString: () => 'file:///workspace/new.py' } };
  const second = binding.replace(secondDocument);
  assert.equal(messages[0].source.id, first.id);
  assert.throws(() => binding.bind(first.id), { code: 'SOURCE_UNAVAILABLE' });
  assert.equal(messages.at(-1).source.id, first.id);
  assert.equal(binding.read(second.id).source.uri, 'file:///workspace/new.py');
});

test('selection imports remain isolated copies and never expand to whole-file execution', () => {
  const { binding, document, messages } = fixture();
  const selected = binding.replace(document, { mode: 'selection', lineOffset: 4 });
  document.version += 1;
  binding.changed(document);
  assert.equal(messages.length, 0);
  assert.equal(selected.lineOffset, 4);
  assert.throws(() => binding.read(selected.id), { code: 'SOURCE_UNAVAILABLE' });
});

test('oversized source rejects execution then recovers after the document is shortened', () => {
  const { binding, document, messages } = fixture();
  const { id } = binding.replace(document);
  document.code = 'x'.repeat(20001); document.version += 1;
  binding.changed(document);
  assert.equal(messages.at(-1).type, 'tensorv:sourceUnavailable');
  assert.throws(() => binding.read(id), /20,000/);
  document.code = 'x = torch.ones(1)'; document.version += 1;
  binding.changed(document);
  assert.equal(messages.at(-1).type, 'tensorv:sourceChanged');
  assert.equal(binding.read(id).code, document.code);
});

test('closing, deleting or renaming the source retires it even when notifications were suspended', () => {
  for (const action of ['close', 'delete', 'rename', 'delete-folder']) {
    const { binding, document, messages } = fixture();
    const { id } = binding.replace(document);
    binding.bind(null);
    if (action === 'close') { document.isClosed = true; binding.closed(document); }
    else binding.removed(action === 'delete-folder' ? { toString: () => 'file:///workspace' } : document.uri, action === 'rename');
    assert.equal(messages.at(-1).source.id, id);
    assert.equal(messages.at(-1).type, 'tensorv:sourceUnavailable');
    assert.throws(() => binding.bind(id), { code: 'SOURCE_UNAVAILABLE' });
  }
});

test('unrelated documents and neighboring folder prefixes cannot invalidate a binding', () => {
  const { binding, document, messages } = fixture();
  const { id } = binding.replace(document);
  binding.changed({ ...document });
  binding.closed({ ...document });
  binding.removed({ toString: () => 'file:///work' });
  assert.equal(messages.length, 0);
  assert.equal(binding.read(id).source.id, id);
});

test('closing the last source tab retires a still-open document model but split tabs preserve it', () => {
  const { binding, document, messages } = fixture();
  const { id } = binding.replace(document);
  const tab = { input: { uri: document.uri } };
  binding.tabsChanged({ closed: [tab] }, [{ tabs: [tab] }]);
  assert.equal(binding.read(id).source.id, id);
  assert.equal(messages.length, 0);
  binding.tabsChanged({ closed: [tab] }, [{ tabs: [{ input: { uri: { toString: () => 'file:///other.py' } } }] }]);
  assert.equal(document.isClosed, false);
  assert.equal(messages.at(-1).type, 'tensorv:sourceUnavailable');
  assert.match(messages.at(-1).message, /标签页已关闭/);
  assert.throws(() => binding.read(id), { code: 'SOURCE_UNAVAILABLE' });
});

test('edit-source can access only the latest document and never reads an arbitrary URI', () => {
  const { binding, document } = fixture();
  const { id } = binding.replace(document);
  binding.bind(null);
  assert.equal(binding.document(id, false), document);
  assert.throws(() => binding.document('file:///private/secret.py', false), { code: 'SOURCE_UNAVAILABLE' });
  binding.retire('panel closed', false);
  assert.throws(() => binding.document(id, false), { code: 'SOURCE_UNAVAILABLE' });
});

test('host transports source events, native edit requests and structured stale-version errors', async () => {
  const { createVSCodeHost } = await import(pathToFileURL(path.resolve(__dirname, '../../../src/host.js')));
  let receive;
  const sent = [], changed = [], unavailable = [];
  const host = createVSCodeHost({ getState: () => ({}), setState() {}, postMessage: value => sent.push(value) }, {
    addEventListener: (type, handler) => { receive = value => handler({ data: value }); },
  });
  const message = { type: 'tensorv:sourceChanged', source: { id: 'source-1', version: 2 }, code: 'new code' };
  receive(message);
  host.onSourceChanged(value => changed.push(value));
  host.onSourceUnavailable(value => unavailable.push(value));
  assert.deepEqual(changed, [message]);
  host.bindSource('source-1');
  host.editSource('source-1');
  assert.deepEqual(sent.map(value => value.type), ['tensorv:bindSource', 'tensorv:editSource']);
  const request = host.getSource('source-1');
  const rpc = sent.at(-1);
  assert.equal(rpc.action, 'getSource');
  receive({ type: 'tensorv:response', id: rpc.id, ok: false, code: 'SOURCE_CHANGED', message: 'source changed' });
  await assert.rejects(request, { code: 'SOURCE_CHANGED' });
  receive({ type: 'tensorv:sourceUnavailable', source: { id: 'source-1' }, message: 'closed' });
  assert.equal(unavailable[0].message, 'closed');
});
