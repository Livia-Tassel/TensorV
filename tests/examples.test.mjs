import test from 'node:test';
import assert from 'node:assert/strict';
import { examples, explain } from '../src/examples.js';
import { runPython } from '../scripts/test-python.mjs';

test('reshape explanations require known storage IDs before claiming shared storage', () => {
  for (const [before, after] of [[{}, {}], [{ storage: null }, { storage: null }], [undefined, undefined]]) {
    assert.equal(explain('y = x.reshape(2, 6)', before, after).title, '按照逻辑顺序重新分组');
  }
  assert.match(explain('y = x.reshape(2, 6)', { storage: 'S1' }, { storage: 'S1' }).title, /共享/);
  assert.doesNotMatch(explain('y = x.reshape(2, 6)', { storage: 'S1' }, { storage: 'S2' }).title, /共享/);
});

test('every lesson executes in the real engine and teaches the expected tensor semantics', () => {
  const result = runPython(['-c', `
import json, sys
from tensorv.engine import Engine
results = {}
for example in json.load(sys.stdin):
    result = Engine().execute(example['code'])
    if result['error'] is not None:
        raise AssertionError(f"{example['id']}: {result['error']}")
    assert result['steps'], example['id']
    results[example['id']] = {t['name']: t for t in result['steps'][-1]['tensors']}
print(json.dumps(results, allow_nan=False))
`], {
    input: JSON.stringify(examples),
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const lessons = JSON.parse(result.stdout);
  assert.equal(Object.keys(lessons).length, examples.length);

  assert.equal(lessons.basics.value.slice.values[0][0], 7);
  assert.deepEqual(lessons.broadcast.y.shape, [3, 4]);
  assert.deepEqual(lessons.broadcast.expanded.stride, [0, 1]);
  assert.equal(lessons.broadcast.expanded.storage, lessons.broadcast.bias.storage);
  assert.notEqual(lessons.broadcast.y.storage, lessons.broadcast.x.storage);
  assert.deepEqual(lessons.matmul.y.slice.values, [[4, 5], [10, 11]]);
  assert.deepEqual(lessons.reduction.row_sum.shape, [3]);
  assert.deepEqual(lessons.reduction.row_mean.shape, [3, 1]);
  assert.deepEqual(lessons.reduction.centered.slice.values[0], [-1.5, -0.5, 0.5, 1.5]);
  assert.deepEqual(lessons.mask.y.slice.values, [[1, 2, 3, 4, 5]]);
  assert.notEqual(lessons.mask.y.storage, lessons.mask.x.storage);
  assert.deepEqual(lessons.mask.z.shape, [3, 4]);
  assert.deepEqual(lessons.autograd.grad.slice.values, [[2, 4], [6, 8]]);
});
