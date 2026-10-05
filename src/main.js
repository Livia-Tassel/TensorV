import { EditorView, Decoration, keymap } from '@codemirror/view';
import { EditorState, StateField, StateEffect } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { basicSetup } from 'codemirror';
import { examples, explain } from './examples';
import './style.css';

const icons = {
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
const fmt = (v) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : Number(v.toPrecision(5)).toString()) : String(v);
const shape = (s) => `[${s.join(', ')}]`;
const dimColor = (axis) => ['#8571db', '#34a28a', '#df9a49', '#5d92cf', '#cb739b', '#729748', '#9d83bc', '#599da5'][axis % 8];
function readLocal(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function saveLocal(key, value) { try { localStorage.setItem(key, value); } catch { /* Storage may be unavailable. */ } }

let result = null;
let selected = 0;
let currentName = null;
let beforeName = null;
let compare = true;
let automatic = readLocal('tensorv:auto', 'true') === 'true';
let busy = false;
let timer;
let pending = false;
let revision = 0;
let renderVersion = 0;
let stale = false;
let hovered = null;
let viewConfigs = { before: null, after: null };

$('#app').innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark">${icon('cube')}</span><strong>Tensor<span>V</span></strong><span class="version">PLAYGROUND</span></div>
    <div class="top-right"><span class="runtime"><i></i><span id="runtime-label">本地 PyTorch</span></span><a href="https://docs.pytorch.org/docs/stable/tensors.html" target="_blank" rel="noreferrer">PyTorch 文档 ${icon('external')}</a></div>
  </header>
  <div class="workspace-heading"><div><div class="eyebrow">THINK IN TENSORS</div><h1>看见每一次变换<span>。</span></h1><p>写一行代码，理解一个维度。</p></div><div class="heading-actions"><button class="auto-control" id="auto" role="switch" aria-checked="${automatic}"><span class="switch ${automatic ? 'on' : ''}"></span>自动运行</button><button class="run-button" id="run">${icon('play')}运行代码<span>⌘ ↵</span></button></div></div>
  <main class="workspace">
    <aside class="editor-panel panel">
      <div class="panel-header"><div class="file-tab">${icon('code')}<span>playground.py</span><i></i></div><button id="download" class="icon-button" title="下载 Python 代码" aria-label="下载 Python 代码">${icon('download')}</button></div>
      <div id="editor"></div>
      <div class="editor-footer"><span id="execution-status"><i></i>等待运行</span><span>Python · CPU</span></div>
      <div id="error-box" role="alert" hidden></div>
      <div class="console-section"><button id="console-toggle" aria-expanded="false"><span>输出 <span id="output-count">0</span></span><span id="console-chevron">＋</span></button><pre id="console" hidden></pre></div>
      <div class="examples-heading"><span>从一个例子开始</span><span>探索操作 ${icon('arrow')}</span></div>
      <div class="example-list">${examples.map((e) => `<button class="example-card" data-example="${e.id}"><span class="example-icon">${icon(e.id === 'clamp' ? 'arrow' : 'grid')}</span><span><strong>${e.title}</strong><small>${e.description}</small></span><code>${e.op}</code></button>`).join('')}</div>
      <div class="editor-note">${icon('info')}代码仅在本机执行，草稿自动保存在浏览器。</div>
    </aside>
    <section class="inspector-panel panel">
      <div class="panel-header"><div class="panel-title">${icon('cube')}<strong>Tensor 画布</strong><span class="pill">LIVE</span></div><button id="compare" class="compare-button active" aria-pressed="true">前后对照</button></div>
      <div class="trace-section"><div class="section-label"><span>执行轨迹</span><span id="step-count">—</span></div><div id="timeline" class="timeline"></div></div>
      <div class="inspector-content"><div id="step-heading"></div><div id="canvases" class="canvases"></div><div id="metadata"></div><div id="explanation"></div></div>
      <div class="inspector-footer"><span>${icon('info')}悬停元素查看坐标 · 共享存储时联动高亮</span><span id="timing">—</span></div>
    </section>
  </main>
  <footer class="page-footer"><span>TENSORV <span>让抽象的维度，变得具体。</span></span><span>LOCAL-FIRST · v0.1</span></footer>
`;

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
const editor = new EditorView({
  state: EditorState.create({
    doc: readLocal('tensorv:code:v1', examples[0].code),
    extensions: [basicSetup, python(), lineField, keymap.of([indentWithTab, { key: 'Mod-Enter', run: () => { execute(); return true; } }]),
      EditorView.theme({ '&': { fontSize: '13px', height: '100%' }, '.cm-scroller': { fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: '1.95' }, '.cm-content': { padding: '18px 0' }, '.cm-gutters': { background: '#fafbfc', color: '#a5acb8', border: 'none', padding: '0 5px 0 8px' }, '.cm-activeLineGutter': { background: '#f0edf9', color: '#7d66ce' }, '.cm-activeLine': { background: '#f7f5fc' }, '.cm-selectionBackground': { background: '#e5dff6 !important' }, '&.cm-focused': { outline: 'none' }, '.cm-line': { padding: '0 16px 0 10px' } }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          revision++;
          stale = true;
          $('#canvases').classList.add('stale');
          saveLocal('tensorv:code:v1', update.state.doc.toString());
          markStatus('待更新', 'pending');
          clearTimeout(timer);
          if (automatic) timer = setTimeout(execute, 650);
        } else if (update.selectionSet && result && !stale) {
          const line = update.state.doc.lineAt(update.state.selection.main.head).number;
          const index = result.steps.findIndex((s) => line >= s.line && line <= s.end_line);
          if (index >= 0 && index !== selected) selectStep(index);
        }
      }),
    ],
  }),
  parent: $('#editor'),
});

function markStatus(text, type = '') {
  $('#execution-status').className = type;
  $('#execution-status').innerHTML = `<i></i>${escape(text)}`;
}
async function api(path, payload) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '执行失败');
  return data;
}
async function execute() {
  clearTimeout(timer);
  if (busy) { pending = true; return; }
  busy = true;
  pending = false;
  const thisRevision = revision;
  const code = editor.state.doc.toString();
  $('#run').disabled = true;
  $('#run').innerHTML = '<span class="spinner"></span>执行中';
  markStatus('正在执行', 'pending');
  try {
    const next = await api('execute', { code });
    if (thisRevision !== revision) {
      // A new run replaces worker snapshots, even if its response is obsolete.
      pending = pending || automatic;
      markStatus('待更新', 'pending');
      return;
    }
    $('#runtime-label').textContent = `PyTorch ${next.torch_version}`;
    $('#console').textContent = next.stdout || '没有输出。使用 print(...) 查看文本结果。';
    $('#output-count').textContent = next.stdout ? next.stdout.trimEnd().split('\n').length : '0';
    showError(next.error);
    if (next.steps.length || !next.error) {
      result = next;
      selected = Math.max(0, next.steps.length - 1);
      currentName = null;
      beforeName = null;
      stale = false;
      render();
    } else {
      stale = true;
      // Retain the rendered last-successful state, whose worker IDs have expired.
      $('#canvases').classList.add('stale');
      $('#step-count').textContent = '保留上次成功画面';
    }
    markStatus(next.error ? `第 ${next.error.line} 行出错` : '已更新 · 保存在本机', next.error ? 'error' : 'success');
    $('#timing').innerHTML = `${icon('clock')}${next.elapsed_ms} ms`;
  } catch (error) {
    stale = true;
    showError({ type: '执行服务', message: error.message, hint: '检查本地服务是否启动，然后点击运行代码。' });
    $('#canvases').classList.add('stale');
    markStatus('连接或执行失败', 'error');
  } finally {
    busy = false;
    $('#run').disabled = false;
    $('#run').innerHTML = `${icon('play')}运行代码<span>⌘ ↵</span>`;
    if (pending) { pending = false; execute(); }
  }
}
function showError(error) {
  const el = $('#error-box');
  el.hidden = !error;
  if (error) el.innerHTML = `<strong>${escape(error.type)}${error.line ? ` · 第 ${error.line} 行` : ''}</strong><p>${escape(error.message)}</p>${error.hint ? `<small>${escape(error.hint)}</small>` : ''}`;
}
function selectStep(index) {
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
  displayed.before = null;
  displayed.after = null;
  $('#canvases').classList.toggle('stale', stale);
  if (!result?.steps.length) {
    $('#timeline').innerHTML = '<span class="timeline-placeholder">运行代码后，这里会记录每一步变换</span>';
    $('#step-count').textContent = '0 个步骤';
    $('#step-heading').innerHTML = '';
    $('#canvases').innerHTML = `<div class="empty-state">${icon('cube')}<h3>从一个 Tensor 开始</h3><p>写下 <code>x = torch.arange(12).reshape(3, 4)</code><br>或从左侧选择一个例子。</p></div>`;
    $('#metadata').innerHTML = '';
    $('#explanation').innerHTML = '';
    return;
  }
  const { step, prev, after, before } = getPair();
  $('#step-count').textContent = `${selected + 1} / ${result.steps.length} 个步骤`;
  $('#timeline').innerHTML = result.steps.map((s, index) => `<button class="trace-step ${index === selected ? 'selected' : ''}" data-step="${index}" title="${escape(s.source)}"><span class="trace-number">${index + 1}</span><span><strong>${escape(s.outputs[0] || s.tensors.at(-1)?.name || 'Tensor')}</strong><small>第 ${s.line} 行</small></span>${icon('chevron')}</button>`).join('');
  $('#timeline').querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#timeline').querySelectorAll('[data-step]').forEach((b) => b.onclick = () => selectStep(Number(b.dataset.step)));
  const selectedLines = [];
  for (let line = step.line; line <= step.end_line; line++) selectedLines.push(line);
  editor.dispatch({ effects: activeLine.of(selectedLines) });
  $('#step-heading').innerHTML = `<div class="step-caption"><span class="section-label">当前操作</span><span class="line-label">LINE ${step.line}</span></div><code class="operation-code">${escape(step.source)}</code>`;
  $('#canvases').classList.toggle('single', !compare || !before);
  $('#canvases').innerHTML = `${compare && before ? canvasHTML('before', before, prev.tensors) : ''}${canvasHTML('after', after, step.tensors)}`;
  viewConfigs = { before: before ? defaultConfig(before) : null, after: defaultConfig(after) };
  if (compare && before) bindCanvas('before', before, before.slice);
  bindCanvas('after', after, after.slice);
  renderMetadata(after, before);
  const note = explain(step.source, before, after);
  $('#explanation').innerHTML = `<div class="learning-note"><span class="note-icon">${icon('info')}</span><div><strong>${note.title}</strong><p>${note.text}</p></div></div><div class="hover-readout" id="hover-readout">${icon('grid')}悬停一个格子，查看完整坐标和存储位置。</div>`;
}
function defaultConfig(tensor) {
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
  if (initialSlice) renderGrid(side, tensor, initialSlice);
}
function renderFixed(side, tensor) {
  const config = viewConfigs[side];
  const axes = tensor.shape.map((_, axis) => axis).filter((axis) => axis !== config.row_axis && axis !== config.col_axis);
  $(`#fixed-${side}`).innerHTML = axes.map((axis) => `<label class="fixed-axis" style="--dim-color:${dimColor(axis)}"><span>dim ${axis}</span><input type="range" min="0" max="${Math.max(0, tensor.shape[axis] - 1)}" value="${config.indices[axis]}" aria-label="${side} dim ${axis} 索引" ${tensor.shape[axis] === 0 ? 'disabled' : ''}><input class="index-input" type="number" min="0" max="${Math.max(0, tensor.shape[axis] - 1)}" value="${config.indices[axis]}" aria-label="${side} dim ${axis} 索引数值"><span class="index-max">/ ${Math.max(0, tensor.shape[axis] - 1)}</span></label>`).join('');
  axes.forEach((axis, index) => {
    const label = $(`#fixed-${side}`).children[index];
    label.querySelectorAll('input').forEach((input) => input.oninput = () => {
      config.indices[axis] = Math.max(0, Math.min(tensor.shape[axis] - 1, Number(input.value) || 0));
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
  try {
    const slice = await api('slice', { ...viewConfigs[side], indices: [...viewConfigs[side].indices] });
    if (version === sliceVersions[side] && rendered === renderVersion) renderGrid(side, tensor, slice);
  } catch (error) {
    if (rendered === renderVersion && version === sliceVersions[side]) $(`#grid-${side}`).innerHTML = `<div class="slice-error">${escape(error.message)}</div>`;
  }
}
const displayed = { before: null, after: null };
function renderGrid(side, tensor, slice) {
  displayed[side] = { tensor, slice };
  const grid = $(`#grid-${side}`);
  if (!slice.values.length || !slice.values[0]?.length) {
    grid.innerHTML = '<div class="empty-tensor">空 Tensor · 此切片没有元素</div>';
  } else {
    const min = tensor.min ?? 0, max = tensor.max ?? 1;
    const hue = side === 'before' ? 247 : 164;
    grid.innerHTML = `<table class="tensor-grid"><thead><tr><th class="grid-corner">${slice.row_axis !== null ? `d${slice.row_axis}` : '·'}<span> / ${slice.col_axis !== null ? `d${slice.col_axis}` : '·'}</span></th>${slice.values[0].map((_, j) => `<th style="color:${slice.col_axis !== null ? dimColor(slice.col_axis) : '#969cab'}">${slice.col_start + j}</th>`).join('')}</tr></thead><tbody>${slice.values.map((row, i) => `<tr><th style="color:${slice.row_axis !== null ? dimColor(slice.row_axis) : '#969cab'}">${slice.row_start + i}</th>${row.map((value, j) => {
      const fraction = typeof value === 'number' && max !== min ? (value - min) / (max - min) : 0.3;
      const light = 97 - Math.max(0, Math.min(1, fraction)) * 13;
      return `<td><button class="tensor-cell" style="--cell-bg:hsl(${hue} 43% ${light}%)" data-side="${side}" data-offset="${slice.offsets[i][j]}" data-storage="${tensor.storage}:${tensor.dtype}" data-i="${i}" data-j="${j}" title="${escape(tensor.name)}[${slice.coords[i][j].join(', ')}] = ${escape(fmt(value))}" aria-label="${escape(tensor.name)} 坐标 ${slice.coords[i][j].join(', ')}，值 ${escape(fmt(value))}">${escape(fmt(value))}</button></td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
    grid.querySelectorAll('.tensor-cell').forEach((cell) => {
      cell.onmouseenter = () => hoverCell(cell, tensor, slice);
      cell.onfocus = () => hoverCell(cell, tensor, slice);
      cell.onmouseleave = () => clearHover();
      cell.onblur = () => clearHover();
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
}
function pageControl(axis, start, size, total) {
  return `<div class="page-control"><span>${axis === 'row' ? '行' : '列'} ${start}–${Math.max(start, start + size - 1)} / ${total}</span><button data-page="${axis}" data-start="${Math.max(0, start - 24)}" ${start === 0 ? 'disabled' : ''} aria-label="上一页${axis === 'row' ? '行' : '列'}">‹</button><button data-page="${axis}" data-start="${start + 24}" ${start + size >= total ? 'disabled' : ''} aria-label="下一页${axis === 'row' ? '行' : '列'}">›</button></div>`;
}
function markChanges() {
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
  const i = Number(cell.dataset.i), j = Number(cell.dataset.j);
  hovered = { storage: `${tensor.storage}:${tensor.dtype}`, offset: slice.offsets[i][j] };
  highlightOffsets(hovered.storage, hovered.offset);
  const readout = $('#hover-readout');
  if (readout) readout.innerHTML = `${icon('grid')}<code>${escape(tensor.name)}[${slice.coords[i][j].join(', ')}]</code><span>=</span><strong>${escape(fmt(slice.values[i][j]))}</strong><span class="readout-storage">${tensor.storage} · 存储位置 ${hovered.offset}</span>`;
}
function clearHover() {
  hovered = null;
  document.querySelectorAll('.tensor-cell.linked').forEach((cell) => cell.classList.remove('linked'));
  const readout = $('#hover-readout');
  if (readout) readout.innerHTML = `${icon('grid')}悬停一个格子，查看完整坐标和存储位置。`;
}
function renderMetadata(after, before) {
  const shared = before?.storage && before.storage === after.storage;
  $('#metadata').innerHTML = `<div class="metadata-heading"><span class="section-label">布局信息 <code>${escape(after.name)}</code></span>${before ? `<span class="memory-badge ${shared ? 'shared' : 'copied'}">${shared ? '共享底层存储' : '独立存储'}</span>` : ''}</div><div class="metadata-grid"><div><small>SHAPE</small><strong>${shape(after.shape)}</strong></div><div><small>STRIDE</small><strong>${shape(after.stride)}</strong></div><div><small>CONTIGUOUS</small><strong class="${after.contiguous ? 'green-text' : 'amber-text'}">${after.contiguous ? 'True' : 'False'}</strong></div><div><small>STORAGE OFFSET</small><strong>${after.offset}</strong></div></div>`;
}

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
  const url = URL.createObjectURL(new Blob([editor.state.doc.toString()], { type: 'text/x-python' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'playground.py';
  anchor.click();
  URL.revokeObjectURL(url);
};
document.querySelectorAll('[data-example]').forEach((button) => button.onclick = () => {
  const example = examples.find((e) => e.id === button.dataset.example);
  document.querySelectorAll('[data-example]').forEach((b) => b.classList.toggle('active', b === button));
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: example.code }, selection: { anchor: 0 } });
  execute();
});
render();
execute();
