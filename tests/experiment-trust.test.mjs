import test from 'node:test';
import assert from 'node:assert/strict';
import { createScriptStore } from '../src/scripts.js';

test('external experiment review follows its script through editing, switching and reload', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const store = createScriptStore(storage, 'import torch');
  const original = store.current().id;
  const external = store.create('shared.py', 'x = torch.ones(2)', { reviewRequired: true });
  store.update('x = torch.ones(3)');
  store.select(original);
  store.select(external.id);
  const reloaded = createScriptStore(storage);
  assert.equal(reloaded.current().reviewRequired, true);
  assert.equal(reloaded.current().code, 'x = torch.ones(3)');
  reloaded.approveCurrent();
  assert.equal(createScriptStore(storage).current().reviewRequired, undefined);
});

test('a quota failure cannot persist experimental code without its review flag', () => {
  let fail = false;
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => {
    if (fail) throw new Error('quota');
    data.set(key, value);
  } };
  const store = createScriptStore(storage, 'original');
  fail = true;
  const external = store.create('external', 'needs-review', { reviewRequired: true });
  assert.equal(store.persisted, false);
  assert.equal(store.current().reviewRequired, true);
  assert.equal(createScriptStore(storage).current().code, 'original');
  fail = false;
  store.rename(external.id, 'renamed');
  const reloaded = createScriptStore(storage);
  assert.equal(reloaded.current().code, 'needs-review');
  assert.equal(reloaded.current().reviewRequired, true);
});
