import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// CSS is bundled by Vite in the browser; Node only needs the same renderer.
const source = (await readFile(new URL('../src/diagnostics.js', import.meta.url), 'utf8'))
  .replace("import './diagnostics.css';", '');
const { renderDiagnostic } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const diagnostic = () => ({ kind: 'broadcast', inputs: [{ name: 'x', shape: [2, 3] }, { name: 'y', shape: [4] }],
  axes: [{ input: 0, axis: 1 }, { input: 1, axis: 0 }], message: '维度不匹配', suggestions: ['核对维度。'] });

test('broadcast renderer right-aligns shapes and labels only the conflicting axes', () => {
  const html = renderDiagnostic(diagnostic(), escape);
  assert.match(html, /从右侧对齐维度/);
  assert.equal((html.match(/class="diagnostic-conflict"/g) || []).length, 2);
  assert.equal((html.match(/class="diagnostic-implicit"/g) || []).length, 1);
  assert.match(html, /title="dim 1：长度冲突"/);
  assert.match(html, /title="dim 0：长度冲突"/);
});

test('all error-derived names, explanations and suggestions are escaped', () => {
  const value = diagnostic();
  value.inputs[0].name = '<img src=x onerror=alert(1)>';
  value.message = '<script>alert(2)</script>';
  value.suggestions = ['<a href="javascript:alert(3)">fix</a>'];
  const html = renderDiagnostic(value, escape);
  assert.doesNotMatch(html, /<img|<script|<a /);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script/);
  assert.match(html, /&quot;javascript:/);
});

test('malformed or oversized diagnostic data produces no partial UI', () => {
  for (const mutation of [
    (value) => { value.kind = '" onmouseover="alert(1)'; },
    (value) => { value.axes[0].axis = 2; },
    (value) => { value.axes.push(value.axes[0]); },
    (value) => { value.inputs[0].shape = [Number.MAX_SAFE_INTEGER + 1]; },
    (value) => { value.inputs[0].shape = Array(65).fill(1); },
    (value) => { value.inputs[0].shape = [true]; },
    (value) => { value.suggestions = ['x'.repeat(1025)]; },
    (value) => { value.message = 'x'.repeat(2049); },
  ]) {
    const value = diagnostic();
    mutation(value);
    assert.equal(renderDiagnostic(value, escape), '');
  }
  assert.equal(renderDiagnostic(null, escape), '');
});

test('reshape renderer includes the exact requested target and scalar input', () => {
  const html = renderDiagnostic({ kind: 'reshape', inputs: [{ name: 'x', shape: [] }], axes: [],
    target_shape: [-1, 3], message: '无法推断', suggestions: ['检查元素数。'] }, escape);
  assert.match(html, /目标 shape <code>\[-1, 3\]<\/code>/);
  assert.match(html, /diagnostic-empty/);
  assert.doesNotMatch(html, /diagnostic-conflict/);
});
