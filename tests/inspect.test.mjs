import test from 'node:test';
import assert from 'node:assert/strict';
import { formatValue, sliceCSV, distribution } from '../src/inspect.js';

test('CSV exports original precision, coordinates and offsets for high-dimensional slices', () => {
  const csv = sliceCSV({ values: [[0.123456789, '1+2j']], coords: [[[1, 2, 3], [1, 2, 4]]], offsets: [[15, 16]] });
  assert.equal(csv, '\uFEFF"dim_0","dim_1","dim_2","value","storage_offset"\r\n"1","2","3","0.123456789","15"\r\n"1","2","4","1+2j","16"');
  assert.equal(formatValue(0.123456789, 4), '0.1235');
});

test('CSV handles scalar and empty tensors without inventing coordinates', () => {
  assert.equal(sliceCSV({ values: [[7]], coords: [[[]]], offsets: [[0]] }), '\uFEFF"value","storage_offset"\r\n"7","0"');
  assert.equal(sliceCSV({ values: [], coords: [], offsets: [], indices: [0, 0] }), '\uFEFF"dim_0","dim_1","value","storage_offset"');
});

test('distribution conserves sample counts and excludes non-numeric values', () => {
  const bins = distribution([[0, 1, 2, 3], [4, 5, NaN, Infinity, 'nan', '1+2j']], 3);
  assert.deepEqual(bins.map((bin) => bin.count), [2, 2, 2]);
  assert.equal(bins[0].from, 0);
  assert.equal(bins.at(-1).to, 5);
  assert.deepEqual(distribution([['nan', 'inf']]), []);
  assert.deepEqual(distribution([[2, 2]]), [{ from: 2, to: 2, count: 2 }]);
});

test('distribution handles extreme float64 ranges and boolean values', () => {
  const bins = distribution([[-1.7e308, 0, 1.7e308]]);
  assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), 3);
  assert.equal(bins[0].count, 1);
  assert.equal(bins.at(-1).count, 1);
  assert.ok(bins.every((bin) => Number.isFinite(bin.from) && Number.isFinite(bin.to)));
  assert.equal(distribution([[true, false, true]]).reduce((sum, bin) => sum + bin.count, 0), 3);
});
