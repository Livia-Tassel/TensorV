import './diagnostics.css';

const kinds = new Set(['broadcast', 'matmul', 'reshape', 'view']);
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum;
const shape = (value, signed = false) => Array.isArray(value) && value.length <= 64
  && value.every((size) => Number.isSafeInteger(size) && (signed || size >= 0));

function valid(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object' || !kinds.has(diagnostic.kind)) return false;
  const count = ['broadcast', 'matmul'].includes(diagnostic.kind) ? 2 : 1;
  if (!Array.isArray(diagnostic.inputs) || diagnostic.inputs.length !== count) return false;
  if (!diagnostic.inputs.every((input) => input && text(input.name, 256) && shape(input.shape))) return false;
  if (!text(diagnostic.message, 2048) || !Array.isArray(diagnostic.suggestions)
      || !diagnostic.suggestions.length || diagnostic.suggestions.length > 4
      || !diagnostic.suggestions.every((suggestion) => text(suggestion, 1024))) return false;
  if (!Array.isArray(diagnostic.axes) || diagnostic.axes.length > 128) return false;
  const seen = new Set();
  for (const item of diagnostic.axes) {
    if (!item || !Number.isInteger(item.input) || item.input < 0 || item.input >= count
        || !Number.isInteger(item.axis) || item.axis < 0 || item.axis >= diagnostic.inputs[item.input].shape.length) return false;
    const key = `${item.input}:${item.axis}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return count === 2 || shape(diagnostic.target_shape, true);
}

export function renderDiagnostic(diagnostic, escape) {
  if (!valid(diagnostic) || typeof escape !== 'function') return '';
  const broadcast = diagnostic.kind === 'broadcast';
  const rank = Math.max(1, ...diagnostic.inputs.map((input) => input.shape.length));
  const conflicts = new Set(diagnostic.axes.map((item) => `${item.input}:${item.axis}`));
  const heading = broadcast ? '从右侧对齐维度' : '检查输入形状';
  const headers = Array.from({ length: rank }, (_, index) => `<th scope="col">${broadcast ? index - rank : `dim ${index}`}</th>`).join('');
  const rows = diagnostic.inputs.map((input, inputIndex) => {
    const cells = Array.from({ length: rank }, (_, column) => {
      const axis = broadcast ? column - (rank - input.shape.length) : column;
      if (axis < 0) return '<td class="diagnostic-implicit" title="前导维度按长度 1 补齐">1</td>';
      if (axis >= input.shape.length) return '<td class="diagnostic-empty">—</td>';
      const conflict = conflicts.has(`${inputIndex}:${axis}`);
      return `<td class="${conflict ? 'diagnostic-conflict' : ''}" title="dim ${axis}${conflict ? '：长度冲突' : ''}">${escape(String(input.shape[axis]))}${conflict ? '<span class="diagnostic-sr-only">（冲突）</span>' : ''}</td>`;
    }).join('');
    return `<tr><th scope="row"><code>${escape(input.name)}</code>${input.shape.length ? '' : '<span class="diagnostic-scalar">标量 []</span>'}</th>${cells}</tr>`;
  }).join('');
  const target = diagnostic.target_shape
    ? `<div class="diagnostic-target">目标 shape <code>[${diagnostic.target_shape.map((size) => escape(String(size))).join(', ')}]</code></div>` : '';
  return `<section class="shape-diagnostic" data-kind="${diagnostic.kind}" aria-label="维度诊断"><strong>${heading}</strong><div class="diagnostic-table-wrap"><table><thead><tr><th scope="col">输入</th>${headers}</tr></thead><tbody>${rows}</tbody></table></div>${target}<p>${escape(diagnostic.message)}</p><ul>${diagnostic.suggestions.map((suggestion) => `<li>${escape(suggestion)}</li>`).join('')}</ul></section>`;
}
