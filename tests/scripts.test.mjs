import test from 'node:test';
import assert from 'node:assert/strict';
import { createScriptStore } from '../src/scripts.js';

const KEY = 'tensorv:scripts:v1';
const LEGACY = 'tensorv:code:v1';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    writes: 0,
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { this.writes += 1; data.set(key, value); },
  };
}

test('initializes one script from supplied code and migrates legacy code, including empty code', () => {
  const storage = memoryStorage();
  const store = createScriptStore(storage, 'import torch');
  assert.equal(store.current().name, 'playground.py');
  assert.equal(store.current().code, 'import torch');
  assert.equal(store.persisted, true);
  assert.equal(JSON.parse(storage.getItem(KEY)).version, 1);

  for (const oldCode of ['x = 1', '']) {
    const legacy = memoryStorage({ [LEGACY]: oldCode });
    assert.equal(createScriptStore(legacy, 'default').current().code, oldCode);
    assert.equal(legacy.getItem(LEGACY), oldCode);
  }
});

test('creates, switches, edits and reloads independent scripts, preferring new storage to legacy', () => {
  const storage = memoryStorage({ [LEGACY]: 'old' });
  const store = createScriptStore(storage);
  const first = store.current();
  const second = store.create('experiment', 'x = 2');
  assert.equal(second.name, 'experiment.py');
  assert.equal(store.current().id, second.id);
  store.update('x = 3');
  store.select(first.id);
  assert.equal(store.current().code, 'old');
  store.update('x = 1');
  store.select(second.id);

  const reloaded = createScriptStore(storage);
  assert.equal(reloaded.current().id, second.id);
  assert.equal(reloaded.current().code, 'x = 3');
  assert.equal(reloaded.list()[0].code, 'x = 1');
  assert.notEqual(first.id, second.id);
});

test('same-code updates do not write, and returned objects cannot mutate the store', () => {
  const storage = memoryStorage();
  const store = createScriptStore(storage, 'x = 1');
  const writes = storage.writes;
  const original = store.current();
  const same = store.update('x = 1');
  assert.equal(storage.writes, writes);
  assert.equal(same.updatedAt, original.updatedAt);
  store.current().code = 'mutated';
  const list = store.list();
  list[0].name = 'mutated.py';
  list.push({ id: 'fake' });
  same.code = 'mutated';
  assert.deepEqual(store.current(), original);
  assert.equal(store.list().length, 1);
});

test('normalizes names and resolves duplicate names without overwriting other scripts', () => {
  const store = createScriptStore(memoryStorage());
  const first = store.create('  experiment  ');
  const second = store.create('experiment.py');
  assert.equal(first.name, 'experiment.py');
  assert.equal(second.name, 'experiment-2.py');
  assert.equal(store.rename(second.id, 'EXPERIMENT').name, 'EXPERIMENT-2.py');
  assert.equal(store.rename(first.id, 'experiment.py').name, 'experiment.py');
  for (const name of ['', '  ', '..', '.py', 'folder/file', 'folder\\file', 'x\nname', 'x'.repeat(78)]) {
    assert.throws(() => store.rename(first.id, name));
  }
  assert.equal(store.list().length, 3);
});

test('deleting the selected script picks a neighbor and never removes the last script', () => {
  const storage = memoryStorage();
  const store = createScriptStore(storage);
  const first = store.current();
  const second = store.create('second');
  const third = store.create('third');
  store.select(second.id);
  assert.equal(store.remove(second.id).id, third.id);
  assert.equal(store.remove(first.id).id, third.id);
  assert.throws(() => store.remove(third.id), /至少保留/);
  assert.equal(createScriptStore(storage).current().id, third.id);
  assert.equal(store.list().length, 1);
});

test('recovers malformed caches and salvages valid scripts with a missing current ID', () => {
  for (const raw of ['broken json', 'null', '{}', '{"version":2,"scripts":[]}', '{"version":1,"scripts":[]}']) {
    const store = createScriptStore(memoryStorage({ [KEY]: raw }), 'default');
    assert.equal(store.current().code, 'default');
    assert.equal(store.list().length, 1);
  }
  const raw = JSON.stringify({ version: 1, currentId: 'missing', scripts: [
    null,
    { id: 'bad', name: 'bad.py', code: 'x'.repeat(20001) },
    { id: 'safe', name: 'safe.py', code: 'x = 1', updatedAt: 1 },
    { id: 'safe', name: 'duplicate.py', code: 'x = 2' },
    { id: 'other', name: 'safe.py', code: 'x = 3', updatedAt: 'invalid' },
  ] });
  const store = createScriptStore(memoryStorage({ [KEY]: raw }));
  assert.equal(store.list().length, 2);
  assert.equal(store.current().id, 'safe');
  assert.equal(store.list()[1].name, 'safe-2.py');
  assert.ok(Number.isFinite(store.list()[1].updatedAt));
});

test('enforces script and code limits without changing existing work on rejected operations', () => {
  const storage = memoryStorage();
  const store = createScriptStore(storage, 'keep');
  const original = store.current();
  assert.throws(() => store.update('x'.repeat(20001)), /20000/);
  assert.deepEqual(store.current(), original);
  assert.throws(() => store.create('long', 'x'.repeat(20001)), /20000/);
  assert.equal(store.list().length, 1);
  assert.equal(store.update('x'.repeat(20000)).code.length, 20000);
  for (let index = 1; index < 20; index += 1) store.create();
  const selected = store.current();
  assert.throws(() => store.create(), /20/);
  assert.equal(store.list().length, 20);
  assert.equal(store.current().id, selected.id);
  assert.equal(new Set(store.list().map(script => script.id)).size, 20);
});

test('handles unavailable and quota-limited storage in memory and recovers later writes', () => {
  let shouldFail = true;
  const storage = memoryStorage();
  const write = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (shouldFail) throw new Error('QuotaExceededError');
    write(key, value);
  };
  const store = createScriptStore(storage, 'initial');
  assert.equal(store.persisted, false);
  const first = store.current();
  const second = store.create('unsaved', 'still here');
  assert.equal(store.current().id, second.id);
  store.update('changed');
  store.select(first.id);
  store.rename(first.id, 'renamed');
  store.remove(second.id);
  assert.equal(store.persisted, false);
  shouldFail = false;
  store.update('saved again');
  assert.equal(store.persisted, true);
  assert.equal(createScriptStore(storage).current().code, 'saved again');

  const denied = createScriptStore({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }, 'fallback');
  assert.equal(denied.current().code, 'fallback');
  assert.equal(denied.persisted, false);
  assert.equal(createScriptStore(null).persisted, false);
});

test('unknown script IDs cannot change selection or delete unrelated scripts', () => {
  const store = createScriptStore(memoryStorage());
  store.create();
  const before = store.current();
  for (const action of [() => store.select('missing'), () => store.rename('missing', 'name'), () => store.remove('missing')]) {
    assert.throws(action, /脚本不存在/);
    assert.deepEqual(store.current(), before);
    assert.equal(store.list().length, 2);
  }
});
