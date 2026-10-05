import { EditorView, Decoration, keymap } from '@codemirror/view';
import { EditorState, StateField, StateEffect, Prec } from '@codemirror/state';
import { indentWithTab, undo, isolateHistory } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { examples, explain } from './examples';
import { formatValue, sliceCSV, distribution } from './inspect';
import './style.css';
import { layout } from './layout';
import { createScriptStore } from './scripts';

const icons = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="m16 3 5 5L8 21H3v-5L16 3Zm-2 2 5 5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  book: '<path d="M12 5C8 2 4 3 2 4v15c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1Zm0 0v15"/>',
  moon: '<path d="M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  reset: '<path d="M3 10a9 9 0 1 1 2 9M3 3v7h7"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  chart: '<path d="M4 3v18h17M8 17v-5m5 5V6m5 11V9"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  cube: '<path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z"/><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.info}</svg>`;
const $ = (selector) => document.querySelector(selector);
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => formatValue(v, precision);
const shape = (s) => `[${s.join(', ')}]`;
const dimColor = (axis) => ['#8571db', '#34a28a', '#df9a49', '#5d92cf', '#cb739b', '#729748', '#9d83bc', '#599da5'][axis % 8];
function readLocal(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function saveLocal(key, value) { try { localStorage.setItem(key, value); } catch { /* Storage may be unavailable. */ } }

const scripts = createScriptStore({
  getItem: (key) => readLocal(key, null),
  setItem: (key, value) => localStorage.setItem(key, value),
}, examples[0].code);
const editorStates = new Map();
let editingScriptId = scripts.current().id;
let result = null;
let selected = 0;
let currentName = null;
let beforeName = null;
let compare = readLocal('tensorv:compare', 'true') === 'true';
let precision = Number(readLocal('tensorv:precision', '4')) || 4;
let heatmap = readLocal('tensorv:heatmap', 'true') === 'true';
let activeTab = 'canvas';
let activeExample = examples.find((e) => e.code === scripts.current().code)?.id;
let resetExample = readLocal(`tensorv:lesson:${editingScriptId}`, activeExample || '');
let playback = null;
let pinned = null;
let toastTimer;
let libraryCategory = '全部';
const configCache = new Map();
const sliceCache = new Map();
const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
document.documentElement.dataset.theme = readLocal('tensorv:theme', 'dark');
let automatic = readLocal('tensorv:auto', 'true') === 'true';
let busy = false;
let timer;
let pending = false;
let revision = 0;
let renderVersion = 0;
let stale = false;
let hovered = null;
let viewConfigs = { before: null, after: null };

$('#app').innerHTML = layout({ icon, shortcut, automatic, compare, heatmap });

const activeLine = StateEffect.define();
const lineField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(activeLine)) {
        const lines = effect.value.filter((n) => n > 0 && n <= transaction.state.doc.lines);
        value = Decoration.set(lines.map((n) => Decoration.line({ class: 'executed-line' }).range(transaction.state.doc.line(n).from)), true);
      }
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
const pythonHighlight = HighlightStyle.define([
  { tag: tags.keyword, class: 'tv-syntax-keyword' },
  { tag: tags.comment, class: 'tv-syntax-comment' },
  { tag: [tags.string, tags.special(tags.string)], class: 'tv-syntax-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'tv-syntax-number' },
  { tag: tags.function(tags.variableName), class: 'tv-syntax-function' },
  { tag: tags.operator, class: 'tv-syntax-operator' },
]);
function makeEditorState(code) {
  return EditorState.create({
    doc: code,
    extensions: [basicSetup, python(), syntaxHighlighting(pythonHighlight), lineField, EditorView.contentAttributes.of({ 'aria-label': 'Python 代码编辑器' }), Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { execute(); return true; } }])), keymap.of([indentWithTab]),
      EditorView.theme({ '&': { fontSize: '13px', height: '100%' }, '.cm-scroller': { fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: '1.8' }, '.cm-content': { padding: '14px 0' }, '.cm-gutters': { background: 'var(--editor-bg)', color: 'var(--muted)', border: 'none', padding: '0 5px 0 8px' }, '.cm-activeLineGutter': { background: 'var(--accent-soft)', color: 'var(--accent)' }, '.cm-activeLine': { background: 'var(--active-line)' }, '.cm-selectionBackground': { background: 'var(--selection) !important' }, '&.cm-focused': { outline: 'none' }, '.cm-line': { padding: '0 16px 0 10px' }, '.cm-cursor': { borderLeftColor: 'var(--text)' } }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          stopPlayback();
          revision++;
          stale = true;
          renderVersion++;
          $('#canvases').classList.add('stale');
          activeExample = examples.find((e) => e.code === update.state.doc.toString())?.id;
          try { scripts.update(update.state.doc.toString()); } catch (error) { $('#document-state').textContent = error.message; }
          updateSession();
          markStatus('待更新', 'pending');
          clearTimeout(timer);
          if (automatic) timer = setTimeout(execute, 650);
          updatePlayback();
        } else if (update.selectionSet && result && !stale && !busy) {
          const line = update.state.doc.lineAt(update.state.selection.main.head).number;
          const index = result.steps.findIndex((s) => line >= s.line && line <= s.end_line);
          if (index >= 0 && index !== selected) selectStep(index);
        }
        const cursor = update.state.doc.lineAt(update.state.selection.main.head);
        $('#cursor-position').textContent = `Ln ${cursor.number}, Col ${update.state.selection.main.head - cursor.from + 1}`;
      }),
    ],
  });
}
const editor = new EditorView({ state: makeEditorState(scripts.current().code), parent: $('#editor') });

function markStatus(text, type = '') {
  $('#execution-status').className = type;
  $('#execution-status').innerHTML = `<i></i>${escape(text)}`;
}
async function api(path, payload) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    if (response.status === 429) throw new Error('请求过于频繁，请稍后再运行，或关闭自动运行。');
    if (response.status === 504 || response.status === 408) throw new Error('执行或请求超时，请稍后重试。');
    if (response.status >= 500) throw new Error('执行服务暂时不可用，请稍后重试。');
    throw new Error('未连接到 PyTorch 执行服务。');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '执行失败');
  return data;
}
async function execute() {
  clearTimeout(timer);
  if (busy) { pending = true; return; }
  stopPlayback();
  busy = true;
  stale = true;
  renderVersion++;
  $('#canvases').classList.add('stale');
  updatePlayback();
  pending = false;
  const thisRevision = revision;
  const code = editor.state.doc.toString();
  $('#run').disabled = true;
  $('#run').innerHTML = '<span class="spinner"></span>执行中';
  markStatus('正在执行', 'pending');
  try {
    const next = await api('execute', { code });
    $('#runtime').dataset.state = 'ready';
    $('#runtime-label').textContent = `PyTorch ${next.torch_version}${next.execution_mode === 'isolated' ? ' · 隔离执行' : ''}`;
    if (thisRevision !== revision) {
      // A new run replaces worker snapshots, even if its response is obsolete.
      pending = pending || automatic;
      markStatus('待更新', 'pending');
      return;
    }
    $('#runtime-label').textContent = `PyTorch ${next.torch_version}${next.execution_mode === 'isolated' ? ' · 隔离执行' : ''}`;
    $('#console').textContent = next.stdout || '没有输出。使用 print(...) 查看文本结果。';
    $('#output-count').textContent = next.stdout ? next.stdout.trimEnd().split('\n').length : '0';
    showError(next.error);
    if (next.steps.length || !next.error) {
      result = next;
      selected = Math.max(0, next.steps.length - 1);
      currentName = null;
      beforeName = null;
      configCache.clear();
      sliceCache.clear();
      stale = false;
      render();
    } else {
      stale = true;
      // Retain the rendered last-successful state, whose worker IDs have expired.
      $('#canvases').classList.add('stale');
      $('#step-count').textContent = '保留上次成功画面';
    }
    markStatus(next.error ? `第 ${next.error.line} 行出错` : '已更新', next.error ? 'error' : 'success');
    $('#timing').innerHTML = `${icon('clock')}${next.elapsed_ms} ms`;
  } catch (error) {
    if (thisRevision !== revision) { pending = pending || automatic; return; }
    stale = true;
    $('#runtime').dataset.state = 'error';
    $('#runtime-label').textContent = '服务未就绪';
    showError({ type: '执行服务', message: error.message, hint: '稍后重新运行；自行部署时请检查服务状态。' });
    $('#canvases').classList.add('stale');
    markStatus('连接或执行失败', 'error');
  } finally {
    busy = false;
    $('#run').disabled = false;
    $('#run').innerHTML = `${icon('play')}运行<kbd>${shortcut} ↵</kbd>`;
    updatePlayback();
    if (pending) { pending = false; execute(); }
  }
}
function showError(error) {
  const el = $('#error-box');
  el.hidden = !error;
  if (error) el.innerHTML = `<strong>${escape(error.type)}${error.line ? ` · 第 ${error.line} 行` : ''}</strong><p>${escape(error.message)}</p>${error.hint ? `<small>${escape(error.hint)}</small>` : ''}`;
}
function selectStep(index, fromPlayback = false) {
  if (!result?.steps.length || stale || busy) return;
  if (!fromPlayback) stopPlayback();
  index = Math.max(0, Math.min(result.steps.length - 1, index));
  selected = index;
  currentName = null;
  beforeName = null;
  render();
}
function getPair() {
  const step = result?.steps[selected];
  const prev = result?.steps[selected - 1];
  if (!step) return {};
  const after = step.tensors.find((t) => t.name === currentName) || step.tensors.find((t) => step.outputs.includes(t.name)) || step.tensors.at(-1);
  const before = prev?.tensors.find((t) => t.name === beforeName) || prev?.tensors.find((t) => t.name === after?.name) || prev?.tensors.find((t) => step.inputs.includes(t.name)) || prev?.tensors.at(-1);
  return { step, prev, after, before };
}
function render() {
  renderVersion++;
  hovered = null;
  pinned = null;
  displayed.before = null;
  displayed.after = null;
  $('#canvases').classList.toggle('stale', stale);
  if (!result?.steps.length) {
    $('#timeline').innerHTML = '<span class="timeline-placeholder">无执行记录</span>';
    $('#step-count').textContent = '0 个步骤';
    $('#step-heading').innerHTML = '';
    $('#canvases').innerHTML = `<div class="empty-state">${icon('cube')}<h3>无张量数据</h3><p>运行脚本以查看结果。</p></div>`;
    $('#metadata').innerHTML = '';
    $('#explanation').innerHTML = '';
    renderAnalysis();
    updatePlayback();
    return;
  }
  const { step, prev, after, before } = getPair();
  $('#step-count').textContent = `${selected + 1} / ${result.steps.length} 个步骤`;
  $('#timeline').innerHTML = result.steps.map((s, index) => `<button class="trace-step ${index === selected ? 'selected' : ''}" data-step="${index}" aria-current="${index === selected ? 'step' : 'false'}" title="${escape(s.source)}"><span class="trace-number">${String(index + 1).padStart(2, '0')}</span><span><strong>${escape(s.outputs[0] || s.tensors.at(-1)?.name || 'Tensor')}</strong><small>第 ${s.line} 行</small></span>${icon('chevron')}</button>`).join('');
  const trace = $('#timeline'), activeTrace = trace.querySelector('.selected');
  if (activeTrace) {
    const bounds = trace.getBoundingClientRect(), activeBounds = activeTrace.getBoundingClientRect();
    if (activeBounds.right > bounds.right) trace.scrollLeft += activeBounds.right - bounds.right;
    else if (activeBounds.left < bounds.left) trace.scrollLeft -= bounds.left - activeBounds.left;
  }
  $('#timeline').querySelectorAll('[data-step]').forEach((b) => b.onclick = () => selectStep(Number(b.dataset.step)));
  const selectedLines = [];
  for (let line = step.line; line <= step.end_line; line++) selectedLines.push(line);
  editor.dispatch({ effects: activeLine.of(selectedLines) });
  $('#step-heading').innerHTML = `<div class="step-caption"><span class="section-label">${icon('code')}当前操作</span><span class="line-label">第 ${step.line} 行</span></div><code class="operation-code">${escape(step.source)}</code>`;
  $('#canvases').classList.toggle('single', !compare || !before);
  $('#canvases').innerHTML = `${compare && before ? canvasHTML('before', before, prev.tensors) : ''}${canvasHTML('after', after, step.tensors)}`;
  viewConfigs = { before: before ? defaultConfig(before) : null, after: defaultConfig(after) };
  if (compare && before) bindCanvas('before', before, before.slice);
  bindCanvas('after', after, after.slice);
  renderMetadata(after, before);
  const note = explain(step.source, before, after);
  $('#explanation').innerHTML = `<div class="hover-readout" id="hover-readout">未选择元素</div><details class="operation-help"><summary>操作说明</summary><strong>${escape(note.title)}</strong><p>${escape(note.text)}</p></details>`;
  $('#tensor-count').textContent = `${step.tensors.length} 个张量`;
  renderAnalysis();
  updatePlayback();
}
function defaultConfig(tensor) {
  if (configCache.has(tensor.id)) return structuredClone(configCache.get(tensor.id));
  const rank = tensor.shape.length;
  return { id: tensor.id, row_axis: rank >= 2 ? rank - 2 : null, col_axis: rank ? rank - 1 : null, indices: Array(rank).fill(0), row_start: 0, col_start: 0 };
}
function tensorOptions(tensors, selectedTensor) {
  return tensors.map((t) => `<option value="${escape(t.name)}" ${t.name === selectedTensor.name ? 'selected' : ''}>${escape(t.name)} · ${shape(t.shape)}</option>`).join('');
}
function dimOptions(tensor, selectedAxis) {
  return tensor.shape.map((size, axis) => `<option value="${axis}" ${axis === selectedAxis ? 'selected' : ''}>dim ${axis} · ${size}</option>`).join('');
}
function canvasHTML(side, tensor, tensors) {
  const rank = tensor.shape.length;
  return `<article class="tensor-card ${side}" id="card-${side}">
    <div class="tensor-card-heading"><span class="before-after"><i></i>${side === 'before' ? '操作前' : '操作后'}</span><select class="tensor-select" id="tensor-${side}" aria-label="${side === 'before' ? '操作前' : '操作后'}的变量">${tensorOptions(tensors, tensor)}</select></div>
    <div class="shape-chips">${tensor.shape.length ? tensor.shape.map((size, axis) => `<span class="dim-chip" style="--dim-color:${dimColor(axis)}"><small>dim ${axis}</small><strong>${size}</strong></span>`).join('<span class="shape-times">×</span>') : '<span class="scalar-chip">标量 · shape []</span>'}<span class="element-count">${tensor.numel.toLocaleString()} 个元素</span></div>
    ${tensor.available ? `<div class="axis-controls">${rank >= 2 ? `<label><span class="axis-dot" style="background:${dimColor(rank - 2)}"></span>行<select id="row-${side}" aria-label="${side} 行维度">${dimOptions(tensor, rank - 2)}</select></label>` : ''}${rank ? `<label><span class="axis-dot" style="background:${dimColor(rank - 1)}"></span>列<select id="col-${side}" aria-label="${side} 列维度">${dimOptions(tensor, rank - 1)}</select></label>` : '<span>零维 Tensor</span>'}</div><div class="fixed-controls" id="fixed-${side}"></div><div class="grid-viewport" id="grid-${side}"></div><div class="grid-paging" id="paging-${side}"></div>` : `<div class="unavailable">${icon('info')}<p>${escape(tensor.warning || '无法展示数值')}</p></div>`}
    <div class="tensor-card-footer"><span><i class="storage-dot"></i>${tensor.storage || '—'}<span class="muted"> · ${tensor.dtype}</span></span><span>${tensor.contiguous ? '连续' : '非连续'}${tensor.storage ? ` · offset ${tensor.offset}` : ''}</span></div>
  </article>`;
}
function bindCanvas(side, tensor, initialSlice) {
  $(`#tensor-${side}`).onchange = (event) => {
    if (side === 'before') beforeName = event.target.value;
    else currentName = event.target.value;
    render();
  };
  if (!tensor.available) return;
  const config = viewConfigs[side];
  const axisChange = (kind, next) => {
    const other = kind === 'row_axis' ? 'col_axis' : 'row_axis';
    if (config[other] === next) config[other] = config[kind];
    config[kind] = next;
    config.row_start = 0;
    config.col_start = 0;
    const rowSelect = $(`#row-${side}`), colSelect = $(`#col-${side}`);
    if (rowSelect) rowSelect.value = config.row_axis;
    if (colSelect) colSelect.value = config.col_axis;
    document.querySelectorAll(`#card-${side} .axis-controls label`).forEach((label) => {
      const axis = Number(label.querySelector('select').value);
      label.querySelector('.axis-dot').style.background = dimColor(axis);
    });
    renderFixed(side, tensor);
    requestSlice(side, tensor);
  };
  if ($(`#row-${side}`)) $(`#row-${side}`).onchange = (e) => axisChange('row_axis', Number(e.target.value));
  if ($(`#col-${side}`)) $(`#col-${side}`).onchange = (e) => axisChange('col_axis', Number(e.target.value));
  renderFixed(side, tensor);
  const row = $(`#row-${side}`), col = $(`#col-${side}`);
  if (row) row.value = config.row_axis;
  if (col) col.value = config.col_axis;
  if (sliceCache.has(tensor.id)) renderGrid(side, tensor, sliceCache.get(tensor.id));
  else if (initialSlice) renderGrid(side, tensor, initialSlice);
}
function renderFixed(side, tensor) {
  const config = viewConfigs[side];
  const axes = tensor.shape.map((_, axis) => axis).filter((axis) => axis !== config.row_axis && axis !== config.col_axis);
  $(`#fixed-${side}`).innerHTML = axes.map((axis) => `<label class="fixed-axis" style="--dim-color:${dimColor(axis)}"><span>dim ${axis}</span><input type="range" min="0" max="${Math.max(0, tensor.shape[axis] - 1)}" value="${config.indices[axis]}" aria-label="${side} dim ${axis} 索引" ${tensor.shape[axis] === 0 ? 'disabled' : ''}><input class="index-input" type="number" min="0" max="${Math.max(0, tensor.shape[axis] - 1)}" value="${config.indices[axis]}" aria-label="${side} dim ${axis} 索引数值"><span class="index-max">/ ${Math.max(0, tensor.shape[axis] - 1)}</span></label>`).join('');
  axes.forEach((axis, index) => {
    const label = $(`#fixed-${side}`).children[index];
    label.querySelectorAll('input').forEach((input) => input.oninput = () => {
      config.indices[axis] = Math.max(0, Math.min(tensor.shape[axis] - 1, Math.trunc(Number(input.value) || 0)));
      label.querySelectorAll('input').forEach((other) => other.value = config.indices[axis]);
      requestSlice(side, tensor);
    });
  });
}
const sliceVersions = { before: 0, after: 0 };
async function requestSlice(side, tensor) {
  if (stale || busy) {
    const grid = $(`#grid-${side}`);
    if (grid) grid.innerHTML = '<div class="slice-error">代码待更新，请先重新运行。</div>';
    return;
  }
  const version = ++sliceVersions[side];
  const rendered = renderVersion;
  pinned = null;
  clearHover();
  $(`#grid-${side}`).setAttribute('aria-busy', 'true');
  updatePlayback();
  try {
    const slice = await api('slice', { ...viewConfigs[side], indices: [...viewConfigs[side].indices] });
    if (version === sliceVersions[side] && rendered === renderVersion) renderGrid(side, tensor, slice);
  } catch (error) {
    if (rendered === renderVersion && version === sliceVersions[side]) {
      displayed[side] = null;
      $(`#grid-${side}`).innerHTML = `<div class="slice-error">${escape(error.message)}</div>`;
      renderAnalysis();
    }
  } finally {
    if (rendered === renderVersion && version === sliceVersions[side]) { $(`#grid-${side}`)?.setAttribute('aria-busy', 'false'); updatePlayback(); }
  }
}
const displayed = { before: null, after: null };
function renderGrid(side, tensor, slice) {
  displayed[side] = { tensor, slice };
  sliceCache.set(tensor.id, slice);
  configCache.set(tensor.id, { id: tensor.id, row_axis: slice.row_axis, col_axis: slice.col_axis, indices: [...slice.indices], row_start: slice.row_start, col_start: slice.col_start });
  const grid = $(`#grid-${side}`);
  if (!slice.values.length || !slice.values[0]?.length) {
    grid.innerHTML = '<div class="empty-tensor">空 Tensor · 此切片没有元素</div>';
  } else {
    const min = tensor.min ?? 0, max = tensor.max ?? 1;
    const hue = side === 'before' ? 248 : 161;
    grid.innerHTML = `<table class="tensor-grid"><thead><tr><th class="grid-corner">${slice.row_axis !== null ? `d${slice.row_axis}` : '·'}<span> / ${slice.col_axis !== null ? `d${slice.col_axis}` : '·'}</span></th>${slice.values[0].map((_, j) => `<th style="color:${slice.col_axis !== null ? dimColor(slice.col_axis) : '#969cab'}">${slice.col_start + j}</th>`).join('')}</tr></thead><tbody>${slice.values.map((row, i) => `<tr><th style="color:${slice.row_axis !== null ? dimColor(slice.row_axis) : '#969cab'}">${slice.row_start + i}</th>${row.map((value, j) => {
      const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
      const numeric = typeof value === 'boolean' ? Number(value) : value;
      const fraction = typeof numeric === 'number' && max !== min ? (numeric / scale - min / scale) / (max / scale - min / scale) : 0.3;
      const strength = heatmap ? 8 + Math.max(0, Math.min(1, fraction)) * 31 : 10;
      return `<td><button class="tensor-cell" style="--cell-color:hsl(${hue} 48% 46%);--cell-strength:${strength}%" data-side="${side}" data-offset="${slice.offsets[i][j]}" data-storage="${tensor.storage}:${tensor.dtype}" data-i="${i}" data-j="${j}" title="${escape(tensor.name)}[${slice.coords[i][j].join(', ')}] = ${escape(String(value))}" aria-label="${escape(tensor.name)} 坐标 ${slice.coords[i][j].join(', ')}，值 ${escape(String(value))}">${escape(fmt(value))}</button></td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
    grid.querySelectorAll('.tensor-cell').forEach((cell) => {
      cell.onmouseenter = () => hoverCell(cell, tensor, slice);
      cell.onfocus = () => hoverCell(cell, tensor, slice);
      cell.onmouseleave = () => clearHover();
      cell.onblur = () => clearHover();
      cell.onclick = () => {
        const key = `${side}:${cell.dataset.i}:${cell.dataset.j}`;
        if (pinned?.key === key) { pinned = null; clearHover(); }
        else { pinned = null; hoverCell(cell, tensor, slice); pinned = { ...hovered, key, html: $('#hover-readout').innerHTML }; $('#hover-readout').classList.add('pinned'); }
      };
      cell.onkeydown = (event) => {
        const directions = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
        if (!directions[event.key] || event.altKey) return;
        event.preventDefault();
        const [di, dj] = directions[event.key];
        grid.querySelector(`[data-i="${Number(cell.dataset.i) + di}"][data-j="${Number(cell.dataset.j) + dj}"]`)?.focus();
      };
    });
  }
  const rows = slice.row_total > 24, cols = slice.col_total > 24;
  $(`#paging-${side}`).innerHTML = `${rows ? pageControl('row', slice.row_start, slice.values.length, slice.row_total) : ''}${cols ? pageControl('col', slice.col_start, slice.values[0]?.length || 0, slice.col_total) : ''}${!rows && !cols ? `<span>${tensor.shape.length > 2 ? '当前二维切片' : '完整显示'}<span class="paging-dots">${tensor.shape.length ? ` · ${shape(slice.values.length ? [slice.values.length, slice.values[0].length] : [0])}` : ''}</span></span>` : ''}`;
  $(`#paging-${side}`).querySelectorAll('[data-page]').forEach((b) => b.onclick = () => {
    viewConfigs[side][`${b.dataset.page}_start`] = Number(b.dataset.start);
    requestSlice(side, tensor);
  });
  markChanges();
  if (hovered) highlightOffsets(hovered.storage, hovered.offset);
  renderAnalysis();
}
function pageControl(axis, start, size, total) {
  return `<div class="page-control"><span>${axis === 'row' ? '行' : '列'} ${start}–${Math.max(start, start + size - 1)} / ${total}</span><button data-page="${axis}" data-start="${Math.max(0, start - 24)}" ${start === 0 ? 'disabled' : ''} aria-label="上一页${axis === 'row' ? '行' : '列'}">‹</button><button data-page="${axis}" data-start="${start + 24}" ${start + size >= total ? 'disabled' : ''} aria-label="下一页${axis === 'row' ? '行' : '列'}">›</button></div>`;
}
function markChanges() {
  document.querySelectorAll('.tensor-cell.changed').forEach((cell) => cell.classList.remove('changed'));
  if (!compare || !$('#card-before') || !displayed.before || !displayed.after) return;
  const left = displayed.before, right = displayed.after;
  if (JSON.stringify(left.tensor.shape) !== JSON.stringify(right.tensor.shape)) return;
  const beforeValues = new Map();
  left.slice.values.forEach((row, i) => row.forEach((v, j) => beforeValues.set(left.slice.coords[i][j].join(','), v)));
  document.querySelectorAll('#card-after .tensor-cell').forEach((cell) => {
    const i = Number(cell.dataset.i), j = Number(cell.dataset.j);
    const coord = right.slice.coords[i][j].join(',');
    cell.classList.toggle('changed', beforeValues.has(coord) && !Object.is(beforeValues.get(coord), right.slice.values[i][j]));
  });
}
function highlightOffsets(storage, offset) {
  document.querySelectorAll('.tensor-cell').forEach((cell) => cell.classList.toggle('linked', cell.dataset.storage === storage && Number(cell.dataset.offset) === offset));
}
function hoverCell(cell, tensor, slice) {
  if (pinned) return;
  const i = Number(cell.dataset.i), j = Number(cell.dataset.j);
  hovered = { storage: `${tensor.storage}:${tensor.dtype}`, offset: slice.offsets[i][j] };
  highlightOffsets(hovered.storage, hovered.offset);
  const readout = $('#hover-readout');
  if (readout) readout.innerHTML = `${icon('grid')}<code>${escape(tensor.name)}[${slice.coords[i][j].join(', ')}]</code><span>=</span><strong>${escape(String(slice.values[i][j]))}</strong><span class="readout-storage">${tensor.storage} · 存储位置 ${hovered.offset}</span>`;
}
function clearHover() {
  if (pinned) { highlightOffsets(pinned.storage, pinned.offset); return; }
  hovered = null;
  document.querySelectorAll('.tensor-cell.linked').forEach((cell) => cell.classList.remove('linked'));
  const readout = $('#hover-readout');
  if (readout) { readout.classList.remove('pinned'); readout.innerHTML = '未选择元素'; }
}
function renderMetadata(after, before) {
  const shared = before?.storage && before.storage === after.storage;
  $('#metadata').innerHTML = `<div class="metadata-heading"><span class="section-label">布局信息 <code>${escape(after.name)}</code></span>${before ? `<span class="memory-badge ${shared ? 'shared' : 'copied'}">${shared ? '共享底层存储' : '独立存储'}</span>` : ''}</div><div class="metadata-grid"><div><small>SHAPE</small><strong>${shape(after.shape)}</strong></div><div><small>STRIDE</small><strong>${shape(after.stride)}</strong></div><div><small>CONTIGUOUS</small><strong class="${after.contiguous ? 'green-text' : 'amber-text'}">${after.contiguous ? 'True' : 'False'}</strong></div><div><small>STORAGE OFFSET</small><strong>${after.offset}</strong></div></div>`;
}

function renderAnalysis() {
  const { after } = getPair();
  const current = displayed.after;
  const memory = $('#memory-panel'), statsPanel = $('#stats-panel');
  if (!after) {
    memory.innerHTML = statsPanel.innerHTML = '<div class="empty-state"><h3>无张量数据</h3><p>运行脚本以查看结果。</p></div>';
    return;
  }
  if (current) {
    const offsets = new Map();
    current.slice.values.forEach((row, i) => row.forEach((value, j) => {
      const offset = current.slice.offsets[i][j];
      if (!offsets.has(offset)) offsets.set(offset, { value, coords: [] });
      offsets.get(offset).coords.push(current.slice.coords[i][j]);
    }));
    const aliases = [...offsets.values()].filter((entry) => entry.coords.length > 1).length;
    memory.innerHTML = `<div class="analysis-heading"><div><h3>${escape(after.name)} <span>的存储映射</span></h3><p>当前切片 · 按实际存储偏移排序，同一位置只展示一次</p></div><span class="memory-badge">${escape(after.storage)} · ${offsets.size} 个位置</span></div><div class="memory-summary"><span>${icon('layers')}<strong>${aliases}</strong> 个位置被重复引用</span><code>offset + Σ(index × stride)</code></div><div class="memory-cells">${[...offsets.entries()].sort((a, b) => a[0] - b[0]).map(([offset, entry]) => `<button class="memory-cell ${entry.coords.length > 1 ? 'aliased' : ''}" data-memory-offset="${offset}" title="${escape(entry.coords.map((c) => '[' + c.join(', ') + ']').join(' / '))}" aria-label="存储位置 ${offset}，值 ${escape(String(entry.value))}，${entry.coords.length} 次引用"><small>+${offset}</small><strong>${escape(fmt(entry.value))}</strong><span>${entry.coords.length > 1 ? '×' + entry.coords.length : '1 次引用'}</span></button>`).join('') || '<p class="muted">此切片为空，没有存储位置。</p>'}</div><div id="memory-detail" class="analysis-footnote" role="status">选择一个位置，查看引用它的逻辑坐标。这里只展示当前页可见元素，不代表整个底层存储。</div>`;
    memory.querySelectorAll('[data-memory-offset]').forEach((button) => button.onclick = () => {
      memory.querySelectorAll('.selected').forEach((item) => item.classList.remove('selected'));
      button.classList.add('selected');
      const entry = offsets.get(Number(button.dataset.memoryOffset));
      $('#memory-detail').textContent = `位置 ${button.dataset.memoryOffset} → ${entry.coords.map((c) => `${after.name}[${c.join(', ')}]`).join(' · ')} = ${entry.value}`;
    });
  } else memory.innerHTML = `<div class="empty-state"><h3>仅提供元数据</h3><p>${escape(after.warning || '该张量没有可展示的数值。')}</p></div>`;
  const stats = after.stats;
  if (!stats?.supported) {
    statsPanel.innerHTML = `<div class="empty-state">${icon('chart')}<h3>暂无实数统计</h3><p>${escape(stats?.reason || after.warning || '重新运行代码以加载统计。')}</p></div>`;
    return;
  }
  const statValue = (value) => value === null || value === undefined ? '—' : fmt(value);
  const bins = distribution(current?.slice.values || []);
  const largest = Math.max(1, ...bins.map((bin) => bin.count));
  statsPanel.innerHTML = `<div class="analysis-heading"><div><h3><code>${escape(after.name)}</code> 统计</h3><p>完整快照 · 仅有限实数</p></div><span class="memory-badge">${stats.count.toLocaleString()} 个元素</span></div><div class="stats-grid">${[['最小值', stats.min], ['最大值', stats.max], ['均值', stats.mean], ['标准差（总体）', stats.std], ['有限值', stats.finite_count], ['NaN / Inf', stats.nonfinite_count]].map(([label, value]) => `<div><small>${label}</small><strong>${statValue(value)}</strong></div>`).join('')}</div><div class="distribution-heading"><strong>当前切片的数值分布</strong><span>${bins.reduce((sum, bin) => sum + bin.count, 0)} 个有限数值 · 最多 24 × 24</span></div>${bins.length ? `<div class="histogram" role="img" aria-label="当前切片的数值分布柱状图">${bins.map((bin) => `<div class="histogram-column"><span>${bin.count || ''}</span><div style="height:${Math.max(2, bin.count / largest * 100)}px" title="${fmt(bin.from)} 至 ${fmt(bin.to)}：${bin.count} 个"></div><small>${fmt(bin.from)}</small></div>`).join('')}</div>` : '<p class="analysis-footnote">当前切片没有可统计的有限实数数值。</p>'}<div class="analysis-footnote">逻辑数据大小 ${formatBytes(after.nbytes)} · ${after.dtype} · 每个元素 ${after.element_size ?? '—'} 字节。共享视图可能引用同一存储，逻辑大小不代表额外内存分配。</div>`;
}

function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function updatePlayback() {
  const usable = Boolean(result?.steps.length) && !stale && !busy;
  $('#prev-step').disabled = !usable || selected === 0;
  $('#next-step').disabled = !usable || selected === result?.steps.length - 1;
  $('#play-steps').disabled = !usable || result.steps.length < 2;
  $('#play-steps').innerHTML = icon(playback ? 'pause' : 'play');
  $('#play-steps').setAttribute('aria-label', playback ? '暂停播放' : '播放步骤');
  $('#play-steps').title = playback ? '暂停播放' : '播放步骤';
  $('#export-data').disabled = !displayed.after || busy || stale || $('#grid-after')?.getAttribute('aria-busy') === 'true';
  $('#memory-panel').classList.toggle('stale-analysis', stale);
  $('#stats-panel').classList.toggle('stale-analysis', stale);
}
function stopPlayback() {
  clearInterval(playback);
  playback = null;
  if ($('#play-steps')) { $('#play-steps').innerHTML = icon('play'); $('#play-steps').setAttribute('aria-label', '播放步骤'); }
}
function startPlayback() {
  if (!result?.steps.length || stale || busy) return;
  if (playback) { stopPlayback(); updatePlayback(); return; }
  if (selected >= result.steps.length - 1) selectStep(0);
  playback = setInterval(() => {
    if (selected < result.steps.length - 1) selectStep(selected + 1, true);
    if (selected >= result.steps.length - 1) { stopPlayback(); updatePlayback(); }
  }, Number($('#play-speed').value));
  updatePlayback();
}
function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    $(`#${button.dataset.tab}-panel`).hidden = !active;
  });
  renderAnalysis();
}
function toast(message, action) {
  clearTimeout(toastTimer);
  const el = $('#toast');
  el.innerHTML = `${icon('check')}<span>${escape(message)}</span>${action ? '<button>撤销</button>' : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { action(); el.hidden = true; };
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 9000 : 3500);
}
function openDialog(id) {
  stopPlayback();
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  $(id).showModal();
}
function updateSession() {
  const current = scripts.current();
  $('#document-title').textContent = current.name;
  $('#file-tab-name').textContent = current.name;
  document.title = `${current.name} — TensorV`;
  const codeMatches = current.code === editor.state.doc.toString();
  $('#document-state').textContent = !codeMatches ? '超出长度上限 · 未保存' : scripts.persisted ? '已保存' : '未保存';
  $('#script-storage-status').textContent = scripts.persisted ? '浏览器本地存储' : '存储不可用 · 请下载代码';
  $('#reset').disabled = !resetExample;
  document.querySelectorAll('#sidebar-examples [data-example]').forEach((button) => {
    button.classList.toggle('active', button.dataset.example === activeExample);
    button.setAttribute('aria-current', button.dataset.example === activeExample ? 'true' : 'false');
  });
}
function renderScriptList() {
  const list = scripts.list();
  $('#script-list').innerHTML = list.map((script) => `<div class="script-row ${script.id === editingScriptId ? 'current' : ''}" data-script-id="${escape(script.id)}"><button class="script-open" data-script-open="${escape(script.id)}" aria-current="${script.id === editingScriptId ? 'page' : 'false'}" title="${escape(script.name)}">${icon('code')}<span>${escape(script.name)}</span></button><button class="icon-button script-rename" data-script-rename="${escape(script.id)}" aria-label="重命名 ${escape(script.name)}" title="重命名">${icon('edit')}</button><button class="icon-button script-delete" data-script-delete="${escape(script.id)}" aria-label="删除 ${escape(script.name)}" title="删除" ${list.length === 1 ? 'disabled' : ''}>${icon('trash')}</button></div>`).join('');
  $('#script-list').querySelectorAll('[data-script-open]').forEach((button) => button.onclick = () => openScript(button.dataset.scriptOpen));
  $('#script-list').querySelectorAll('[data-script-rename]').forEach((button) => button.onclick = () => renameScript(button.dataset.scriptRename));
  $('#script-list').querySelectorAll('[data-script-delete]').forEach((button) => button.onclick = () => deleteScript(button.dataset.scriptDelete));
}
function flushDraft() {
  try { scripts.update(editor.state.doc.toString()); return true; }
  catch (error) { toast(`${error.message} 请先下载或缩短当前代码。`); return false; }
}
function activateScript(script) {
  stopPlayback(); clearTimeout(timer);
  revision++;
  editingScriptId = script.id;
  editor.setState(editorStates.get(script.id) || makeEditorState(script.code));
  editor.dispatch({ effects: activeLine.of([]) });
  activeExample = examples.find((e) => e.code === script.code)?.id;
  resetExample = readLocal(`tensorv:lesson:${script.id}`, activeExample || '');
  result = null; currentName = null; beforeName = null; stale = false;
  configCache.clear(); sliceCache.clear();
  $('#console').textContent = ''; $('#output-count').textContent = '0';
  const cursor = editor.state.doc.lineAt(editor.state.selection.main.head);
  $('#cursor-position').textContent = `Ln ${cursor.number}, Col ${editor.state.selection.main.head - cursor.from + 1}`;
  $('#timing').textContent = '—'; $('#tensor-count').textContent = '—';
  showError(null); renderScriptList(); updateSession(); render(); closeSidebar();
  setMobileView('editor');
  execute();
}
function openScript(id) {
  if (id === editingScriptId) { closeSidebar(); setMobileView('editor'); return; }
  if (!flushDraft()) return;
  editorStates.set(editingScriptId, editor.state);
  try { activateScript(scripts.select(id)); } catch (error) { toast(error.message); }
}
function newScript(name = 'untitled.py', code = 'import torch\n\n') {
  if (!flushDraft()) return null;
  editorStates.set(editingScriptId, editor.state);
  try {
    const script = scripts.create(name, code);
    activateScript(script);
    return script;
  } catch (error) { toast(error.message); return null; }
}
let namingScriptId = null;
function renameScript(id) {
  const script = scripts.list().find((s) => s.id === id);
  if (!script) return;
  namingScriptId = id;
  $('#script-name').value = script.name;
  $('#script-dialog-error').hidden = true;
  openDialog('#script-dialog'); $('#script-name').focus(); $('#script-name').select();
}
let deletingScriptId = null;
function deleteScript(id) {
  const script = scripts.list().find((s) => s.id === id);
  if (!script) return;
  deletingScriptId = id;
  $('#delete-description').textContent = `删除「${script.name}」？此操作无法撤销。`;
  openDialog('#delete-dialog');
}
function renderSidebarExamples() {
  $('#sidebar-examples').innerHTML = [...new Set(examples.map((e) => e.category))].map((category) => `<details open><summary>${escape(category)}</summary>${examples.filter((e) => e.category === category).map((e) => `<button class="sidebar-example" data-example="${e.id}" title="${escape(e.op)}"><span>${escape(e.title)}</span><code class="example-op">${escape(e.op.split(' / ')[0])}</code></button>`).join('')}</details>`).join('');
  $('#sidebar-examples').querySelectorAll('[data-example]').forEach((button) => button.onclick = () => loadExample(button.dataset.example));
}
function setMobileView(view) {
  $('.workspace').dataset.mobileView = view;
  $('#mobile-editor').setAttribute('aria-pressed', String(view === 'editor'));
  $('#mobile-inspector').setAttribute('aria-pressed', String(view === 'inspector'));
  if (view === 'editor') {
    $('.workspace').classList.remove('focus-mode');
    $('#focus-view').setAttribute('aria-pressed', 'false');
    $('#focus-view').setAttribute('aria-label', '专注画布');
  }
  editor.requestMeasure();
}
function closeSidebar() {
  $('#app').classList.remove('sidebar-open');
  $('#sidebar-backdrop').hidden = true;
  updateSidebarAccess();
}
function updateSidebarAccess() {
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  const opened = mobile ? $('#app').classList.contains('sidebar-open') : !$('#app').classList.contains('sidebar-collapsed');
  $('#sidebar').inert = !opened;
  $('#sidebar-toggle').setAttribute('aria-expanded', String(opened));
  $('#sidebar-toggle').setAttribute('aria-controls', 'sidebar');
}
function toggleSidebar() {
  if (window.matchMedia('(max-width: 900px)').matches) {
    const opened = $('#app').classList.toggle('sidebar-open');
    $('#sidebar-backdrop').hidden = !opened;
  } else {
    const collapsed = $('#app').classList.toggle('sidebar-collapsed');
    saveLocal('tensorv:sidebar-collapsed', String(collapsed));
  }
  updateSidebarAccess(); editor.requestMeasure();
}
function replaceCode(code, message) {
  if (code === editor.state.doc.toString()) { execute(); return; }
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: code }, selection: { anchor: 0 }, annotations: isolateHistory.of('full') });
  const replacedRevision = revision;
  toast(message, () => {
    if (revision !== replacedRevision) { toast(`代码已继续编辑，请使用 ${shortcut} Z 按顺序撤销。`); return; }
    undo(editor);
    if (automatic) execute();
  });
  execute();
}
function loadExample(id) {
  const example = examples.find((item) => item.id === id);
  if (!example) return;
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  const existing = scripts.list().find((script) => script.code === example.code);
  if (existing) { openScript(existing.id); return; }
  const script = newScript(`${id}.py`, example.code);
  if (script) { resetExample = id; saveLocal(`tensorv:lesson:${script.id}`, id); updateSession(); }
}
function renderLibrary() {
  const query = $('#example-search').value.trim().toLowerCase();
  const filtered = examples.filter((e) => (libraryCategory === '全部' || e.category === libraryCategory) && `${e.title} ${e.op} ${e.description} ${e.goal} ${(e.tags || []).join(' ')}`.toLowerCase().includes(query));
  $('#example-categories').innerHTML = ['全部', ...new Set(examples.map((e) => e.category).filter(Boolean))].map((category) => `<button data-category="${escape(category)}" aria-pressed="${category === libraryCategory}" class="${category === libraryCategory ? 'active' : ''}">${escape(category)}</button>`).join('');
  $('#example-categories').querySelectorAll('button').forEach((button) => button.onclick = () => { libraryCategory = button.dataset.category; renderLibrary(); });
  $('#library-results').innerHTML = filtered.map((e) => `<button class="library-card" data-example="${escape(e.id)}">${icon('code')}<div class="library-card-main"><h3>${escape(e.title)}</h3><p>${escape(e.description)}</p></div><code>${escape(e.op)}</code>${icon('plus')}</button>`).join('') || `<div class="library-empty"><p>没有找到相关示例</p><button id="clear-search" class="compare-button">清除筛选</button></div>`;
  $('#library-results').querySelectorAll('[data-example]').forEach((button) => button.onclick = () => loadExample(button.dataset.example));
  if ($('#clear-search')) $('#clear-search').onclick = () => { $('#example-search').value = ''; libraryCategory = '全部'; renderLibrary(); $('#example-search').focus(); };
  $('#library-count').textContent = `${filtered.length} / ${examples.length} 个示例`;
}
function openLibrary() { renderLibrary(); openDialog('#library-dialog'); $('#example-search').focus(); }
function downloadFile(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportData(kind) {
  if (!displayed.after || stale || busy || $('#grid-after')?.getAttribute('aria-busy') === 'true') { toast('请等待最新数据就绪后再导出。'); return; }
  const { tensor, slice } = displayed.after;
  const name = `${tensor.name.replace(/[^\w-]/g, '_')}-step-${selected + 1}`;
  if (kind === 'csv') downloadFile(sliceCSV(slice), `${name}.csv`, 'text/csv;charset=utf-8');
  else {
    const { slice: defaultSlice, ...metadata } = tensor;
    downloadFile(JSON.stringify({ scope: 'visible_slice', step: selected + 1, source: result.steps[selected].source, tensor: metadata, slice }, null, 2), `${name}.json`, 'application/json');
  }
  $('#export-dialog').close(); toast('当前切片已导出。');
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  saveLocal('tensorv:theme', dark ? 'dark' : 'light');
  updateThemeButton();
}
function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#theme').innerHTML = `${icon(dark ? 'sun' : 'moon')}<span>${dark ? '浅色主题' : '深色主题'}</span>`;
  $('#theme').setAttribute('aria-label', dark ? '切换浅色主题' : '切换深色主题');
  document.querySelector('meta[name="theme-color"]').content = dark ? '#212121' : '#ffffff';
}
const commands = [
  { title: '运行代码', detail: `${shortcut} Enter`, run: execute },
  { title: '新建脚本', detail: 'Python', run: () => newScript() },
  { title: '重命名当前脚本', detail: '', run: () => renameScript(editingScriptId) },
  { title: '浏览示例', detail: `${examples.length} 个示例`, run: openLibrary },
  { title: '切换深色 / 浅色主题', detail: '个性化', run: toggleTheme },
  { title: '导入 Python 文件', detail: '.py / .txt', run: () => $('#file-input').click() },
  { title: '下载 Python 代码', detail: '保存到本机', run: () => $('#download').click() },
  { title: '播放 / 暂停执行步骤', detail: '逐步回看', run: startPlayback },
  { title: '查看张量画布', detail: '数值与维度', run: () => setTab('canvas') },
  { title: '查看存储映射', detail: '理解共享与重叠', run: () => setTab('memory') },
  { title: '查看数值统计', detail: '均值与数值分布', run: () => setTab('stats') },
  { title: '使用帮助与快捷键', detail: '?', run: () => openDialog('#help-dialog') },
  ...examples.map((e) => ({ title: e.title, detail: e.op, run: () => loadExample(e.id) })),
];
let commandIndex = 0;
let filteredCommands = [];
function renderCommands() {
  const query = $('#command-search').value.trim().toLowerCase();
  filteredCommands = commands.filter((c) => `${c.title} ${c.detail}`.toLowerCase().includes(query));
  commandIndex = Math.min(commandIndex, Math.max(0, filteredCommands.length - 1));
  $('#command-results').innerHTML = filteredCommands.map((c, i) => `<button class="command-item ${i === commandIndex ? 'selected' : ''}" data-command="${i}"><span>${icon('arrow')}${escape(c.title)}</span><small>${escape(c.detail)}</small></button>`).join('') || '<p class="command-empty">没有匹配的操作，试试其他关键词。</p>';
  $('#command-results').querySelectorAll('button').forEach((button) => button.onclick = () => runCommand(Number(button.dataset.command)));
  $('#command-results .selected')?.scrollIntoView({ block: 'nearest' });
}
function runCommand(index) { $('#command-dialog').close(); filteredCommands[index]?.run(); }
function openCommands() { commandIndex = 0; $('#command-search').value = ''; renderCommands(); openDialog('#command-dialog'); $('#command-search').focus(); }

$('#run').onclick = execute;
$('#auto').onclick = () => {
  automatic = !automatic;
  saveLocal('tensorv:auto', String(automatic));
  $('#auto').setAttribute('aria-checked', String(automatic));
  $('#auto .switch').classList.toggle('on', automatic);
  if (automatic && stale) execute();
  else if (!automatic) clearTimeout(timer);
};
$('#compare').onclick = () => {
  compare = !compare;
  saveLocal('tensorv:compare', String(compare));
  $('#compare').classList.toggle('active', compare);
  $('#compare').setAttribute('aria-pressed', String(compare));
  render();
};
$('#console-toggle').onclick = () => {
  const show = $('#console').hidden;
  $('#console').hidden = !show;
  $('#console-toggle').setAttribute('aria-expanded', String(show));
  $('#console-chevron').textContent = show ? '−' : '＋';
};
$('#download').onclick = () => {
  downloadFile(editor.state.doc.toString(), scripts.current().name, 'text/x-python');
  toast('Python 代码已下载。');
};
$('#copy-code').onclick = async () => {
  try { await navigator.clipboard.writeText(editor.state.doc.toString()); toast('代码已复制到剪贴板。'); }
  catch { toast('剪贴板不可用，请在编辑器中选择代码后复制。'); }
};
$('#import').onclick = () => $('#file-input').click();
$('#file-input').onchange = async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 100000) { toast('文件过大，请导入不超过 20,000 字符的 Python 片段。'); return; }
  try {
    const code = await file.text();
    if (code.length > 20000) { toast('代码超过 20,000 字符，请先缩短。'); return; }
    if (newScript(file.name, code)) toast(`已导入 ${file.name}`);
  } catch { toast('无法读取该文件，请重新选择。'); }
};
$('#reset').onclick = () => replaceCode((examples.find((e) => e.id === resetExample) || examples[0]).code, '已恢复示例，原稿可撤销找回。');
$('#prev-step').onclick = () => selectStep(selected - 1);
$('#next-step').onclick = () => selectStep(selected + 1);
$('#play-steps').onclick = startPlayback;
$('#play-speed').onchange = () => { if (playback) { stopPlayback(); startPlayback(); } };
$('#focus-view').onclick = () => {
  const focused = $('.workspace').classList.toggle('focus-mode');
  $('#focus-view').setAttribute('aria-pressed', String(focused));
  $('#focus-view').setAttribute('aria-label', focused ? '退出专注画布' : '专注画布');
};
document.querySelectorAll('[data-tab]').forEach((button, index, buttons) => {
  button.onclick = () => setTab(button.dataset.tab);
  button.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus(); setTab(buttons[next].dataset.tab);
  };
});
$('#precision').value = String(precision);
$('#precision').onchange = () => { precision = Number($('#precision').value); saveLocal('tensorv:precision', String(precision)); redrawGrids(); };
$('#heatmap').onclick = () => { heatmap = !heatmap; saveLocal('tensorv:heatmap', String(heatmap)); $('#heatmap').setAttribute('aria-pressed', String(heatmap)); redrawGrids(); };
function redrawGrids() { for (const side of ['before', 'after']) if (displayed[side]) renderGrid(side, displayed[side].tensor, displayed[side].slice); }
$('#export-data').onclick = () => openDialog('#export-dialog');
$('#export-csv').onclick = () => exportData('csv');
$('#export-json').onclick = () => exportData('json');
$('#browse-examples').onclick = openLibrary;
$('#rail-search').onclick = openCommands;
for (const id of ['#help', '#status-help']) $(id).onclick = () => openDialog('#help-dialog');
$('#new-script').onclick = () => newScript();
$('#sidebar-import').onclick = () => $('#file-input').click();
$('#rename-current').onclick = () => renameScript(editingScriptId);
$('#sidebar-toggle').onclick = toggleSidebar;
$('#sidebar-close').onclick = () => { toggleSidebar(); $('#sidebar-toggle').focus(); };
$('#sidebar-backdrop').onclick = closeSidebar;
$('#mobile-editor').onclick = () => setMobileView('editor');
$('#mobile-inspector').onclick = () => setMobileView('inspector');
$('#script-form').onsubmit = (event) => {
  event.preventDefault();
  try {
    scripts.rename(namingScriptId, $('#script-name').value);
    renderScriptList(); updateSession(); $('#script-dialog').close();
  } catch (error) { $('#script-dialog-error').textContent = error.message; $('#script-dialog-error').hidden = false; }
};
$('#confirm-delete').onclick = () => {
  try {
    const active = deletingScriptId === editingScriptId;
    const current = scripts.remove(deletingScriptId);
    editorStates.delete(deletingScriptId);
    $('#delete-dialog').close();
    if (active) activateScript(current);
    else { renderScriptList(); updateSession(); }
  } catch (error) { toast(error.message); }
};
$('#theme').onclick = toggleTheme;
$('#example-search').oninput = renderLibrary;
$('#command-search').oninput = () => { commandIndex = 0; renderCommands(); };
$('#command-dialog').onkeydown = (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); commandIndex = Math.max(0, Math.min(filteredCommands.length - 1, commandIndex + (event.key === 'ArrowDown' ? 1 : -1))); renderCommands();
  } else if (event.key === 'Enter' && event.target === $('#command-search')) { event.preventDefault(); runCommand(commandIndex); }
};
document.querySelectorAll('[data-close]').forEach((button) => button.onclick = () => button.closest('dialog').close());
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  const box = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
}));
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommands(); return; }
  if (event.key === 'Escape') { pinned = null; clearHover(); stopPlayback(); closeSidebar(); }
  if (document.querySelector('dialog[open]')) return;
  if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); selectStep(selected + (event.key === 'ArrowRight' ? 1 : -1)); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.target.closest('.cm-editor')) { event.preventDefault(); execute(); }
  if (event.key === '?' && !event.target.closest('input, textarea, [contenteditable]')) openDialog('#help-dialog');
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPlayback(); updatePlayback(); } });
window.addEventListener('beforeunload', (event) => {
  if (!scripts.persisted || scripts.current().code !== editor.state.doc.toString()) {
    event.preventDefault(); event.returnValue = '';
  }
});
function setEditorWidth(value) {
  const width = Math.max(26, Math.min(52, value));
  $('.workspace').style.setProperty('--editor-width', `${width}%`);
  $('#panel-resizer').setAttribute('aria-valuenow', String(Math.round(width)));
  saveLocal('tensorv:editor-width', String(width));
}
setEditorWidth(Number(readLocal('tensorv:editor-width', '36')) || 36);
$('#panel-resizer').onpointerdown = (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const resizer = event.currentTarget;
  resizer.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing');
  resizer.onpointermove = (move) => {
    const bounds = $('.workspace').getBoundingClientRect();
    setEditorWidth((move.clientX - bounds.left) / bounds.width * 100);
  };
  const end = () => { resizer.onpointermove = null; document.body.classList.remove('resizing'); };
  resizer.onpointerup = end; resizer.onpointercancel = end; resizer.onlostpointercapture = end;
};
$('#panel-resizer').onkeydown = (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  setEditorWidth(event.key === 'Home' ? 26 : event.key === 'End' ? 52 : Number($('#panel-resizer').getAttribute('aria-valuenow')) + (event.key === 'ArrowRight' ? 2 : -2));
};
window.addEventListener('resize', () => {
  if (!window.matchMedia('(max-width: 900px)').matches) { $('#app').classList.remove('sidebar-open'); $('#sidebar-backdrop').hidden = true; }
  updateSidebarAccess();
});
if (readLocal('tensorv:sidebar-collapsed', 'false') === 'true') $('#app').classList.add('sidebar-collapsed');
renderSidebarExamples();
renderScriptList();
updateSidebarAccess();
updateSession();
updateThemeButton();
render();
execute();
