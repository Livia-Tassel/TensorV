export function formatValue(value, precision = 4) {
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e9) return String(value);
  return Number(value.toPrecision(precision)).toString();
}

export function sliceCSV(slice) {
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const rank = slice.coords[0]?.[0]?.length ?? slice.indices?.length ?? 0;
  const lines = [[...Array.from({ length: rank }, (_, i) => `dim_${i}`), 'value', 'storage_offset'].map(quote).join(',')];
  slice.values.forEach((row, i) => row.forEach((value, j) => {
    lines.push([...slice.coords[i][j], value, slice.offsets[i][j]].map(quote).join(','));
  }));
  return '\uFEFF' + lines.join('\r\n');
}

export function distribution(values, count = 12) {
  const finite = values.flat().map((v) => typeof v === 'boolean' ? Number(v) : v).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!finite.length) return [];
  const min = Math.min(...finite), max = Math.max(...finite);
  const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
  const span = max / scale - min / scale;
  const boundary = (fraction) => min * (1 - fraction) + max * fraction;
  const bins = Array.from({ length: min === max ? 1 : count }, (_, i) => ({
    from: boundary(i / count),
    to: boundary((i + 1) / count),
    count: 0,
  }));
  for (const value of finite) bins[Math.max(0, Math.min(bins.length - 1, Math.floor((value / scale - min / scale) / (span || 1) * bins.length)))].count++;
  return bins;
}
