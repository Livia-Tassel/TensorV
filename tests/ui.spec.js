import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('fixed baseline survives step changes and keeps the chosen variable', async ({ page }) => {
  await importCode(page, 'import torch\nx = torch.arange(6).reshape(2, 3)\ny = x.transpose(0, 1)\nz = y + 10\n');
  await page.locator('#reference-step').selectOption('0');
  await page.locator('#tensor-before').selectOption('x');
  await expect(page.locator('#grid-before .tensor-cell')).toHaveText(['0', '1', '2', '3', '4', '5']);
  await page.locator('#tensor-after').selectOption('y');
  await page.locator('#prev-step').click();
  await expect(page.locator('#tensor-after')).toHaveValue('y');
  await expect(page.locator('#card-before .before-after')).toContainText('基准 · 第 2 行');
  await expect(page.locator('#grid-before .tensor-cell')).toHaveText(['0', '1', '2', '3', '4', '5']);
  await page.locator('#next-step').click();
  await expect(page.locator('#tensor-after')).toHaveValue('y');
  await page.locator('#tensor-after').selectOption('z');
  await expect(page.locator('#grid-after .tensor-cell')).toHaveText(['10', '13', '11', '14', '12', '15']);
  await page.locator('#run').click();
  await updated(page);
  await expect(page.locator('#reference-step')).toHaveValue('previous');
});

test('shape errors retain raw errors and show dimensions even in focused canvas', async ({ page }) => {
  await page.locator('#focus-view').click();
  const executed = page.waitForResponse((response) => response.url().endsWith('/api/execute'));
  await page.locator('#file-input').setInputFiles({ name: 'broadcast-error.py', mimeType: 'text/x-python', buffer: Buffer.from('import torch\nx = torch.zeros(3, 4)\nbias = torch.zeros(3)\ny = x + bias\n') });
  await executed;
  await expect(page.locator('#error-box')).toBeVisible();
  await expect(page.locator('#error-box')).toContainText('RuntimeError');
  await expect(page.locator('#error-box')).toContainText('广播');
  await expect(page.locator('#error-box')).toContainText('bias');
  await expect(page.locator('#run')).toBeEnabled();
  await expectViewportLayout(page);
});

test('VS Code transport imports code and uses host saving without browser API requests', async ({ page, request }) => {
  const hostMessages = [];
  await page.exposeBinding('sendToTensorVHost', async (_, message) => {
    hostMessages.push(message);
    if (message.type !== 'tensorv:request') return;
    const response = await request.post(`http://127.0.0.1:${process.env.TENSORV_TEST_PORT || 8765}/api/${message.action}`, { data: message.payload });
    const data = await response.json();
    await page.evaluate((reply) => window.postMessage(reply, '*'), { type: 'tensorv:response', id: message.id, ok: response.ok(), data, message: data.message });
  });
  await page.addInitScript(() => {
    let state;
    window.acquireVsCodeApi = () => ({ getState: () => state, setState: (value) => { state = value; }, postMessage: (message) => window.sendToTensorVHost(message) });
  });
  const apiRequests = [];
  page.on('request', (request) => { if (request.url().includes('/api/')) apiRequests.push(request.url()); });
  await page.reload();
  await expect(page.locator('#runtime-label')).toContainText('等待运行');
  await expect(page.locator('#auto')).toHaveAttribute('aria-checked', 'false');
  expect(hostMessages.filter((message) => message.type === 'tensorv:request')).toHaveLength(0);
  const imported = { type: 'tensorv:import', code: 'import torch\nx = torch.tensor([12, 24])\ny = x + 1\n', title: 'from-editor.py', source: { uri: 'file:///example.py', lineOffset: 8 } };
  await page.evaluate((message) => window.postMessage(message, '*'), imported);
  await updated(page);
  await expect(page.locator('#grid-after .tensor-cell')).toHaveText(['13', '25']);
  await expect(page.locator('.workspace')).toHaveClass(/focus-mode/);
  await page.locator('#reveal-source').click();
  await expect.poll(() => hostMessages.some((message) => message.type === 'tensorv:revealLine' && message.line === 3)).toBe(true);
  await page.locator('#export-data').click();
  await page.locator('#export-json').click();
  await expect.poll(() => hostMessages.some((message) => message.type === 'tensorv:save' && message.filename.endsWith('.json') && message.content.includes('visible_slice'))).toBe(true);
  const count = await page.locator('#script-list .script-row').count();
  await page.evaluate((message) => window.postMessage(message, '*'), { ...imported, code: 'import torch\nx = torch.tensor([31])\n' });
  await expect(page.locator('#grid-after .tensor-cell')).toHaveText(['31']);
  await expect(page.locator('#script-list .script-row')).toHaveCount(count);
  expect(apiRequests).toEqual([]);
});

let browserErrors;

async function updated(page) {
  await expect(page.locator('#execution-status')).toContainText('已更新', { timeout: 40_000 });
  await expect(page.locator('#run')).toBeEnabled();
  await expect(page.locator('#error-box')).toBeHidden();
}

async function importCode(page, code) {
  const executed = page.waitForResponse((response) => response.url().endsWith('/api/execute') && response.request().method() === 'POST');
  await page.locator('#file-input').setInputFiles({ name: 'ui-example.py', mimeType: 'text/x-python', buffer: Buffer.from(code) });
  await executed;
  await updated(page);
}

async function loadExample(page, id) {
  await page.locator('#browse-examples').click();
  await page.locator('#example-search').fill('');
  await page.locator('#example-categories [data-category="全部"]').click();
  const executed = page.waitForResponse((response) => response.url().endsWith('/api/execute'));
  await page.locator(`#library-results [data-example="${id}"]`).click();
  await executed;
  await updated(page);
}

async function downloadText(download) {
  return readFile(await download.path(), 'utf8');
}

async function expectViewportLayout(page) {
  const size = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollY: window.scrollY,
  }));
  expect(size.width).toBeLessThanOrEqual(size.viewportWidth + 1);
  expect(size.height).toBeLessThanOrEqual(size.viewportHeight + 1);
  expect(size.scrollY).toBe(0);
}

test.beforeEach(async ({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/');
  await updated(page);
});

test.afterEach(async () => {
  expect(browserErrors, 'The browser should not raise uncaught JavaScript errors').toEqual([]);
});

test('real transpose values, shared storage, pinning and whole-tensor statistics', async ({ page }) => {
  await expect(page.locator('#runtime')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#step-count')).toHaveText('3 / 3 个步骤');
  await expect(page.locator('#tensor-after')).toHaveValue('y');
  await expect(page.locator('#grid-after .tensor-cell')).toHaveCount(12);
  await expect(page.locator('#grid-after [data-i="0"][data-j="1"]')).toHaveText('4');
  await expect(page.locator('#metadata')).toContainText('[2, 4, 3]');
  await expect(page.locator('#metadata')).toContainText('[12, 1, 4]');
  const cell = page.locator('#grid-after [data-i="0"][data-j="1"]');
  await cell.hover();
  await expect(page.locator('#grid-before [data-i="1"][data-j="0"]')).toHaveClass(/linked/);
  await cell.click();
  await expect(page.locator('#hover-readout')).toHaveClass(/pinned/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#hover-readout')).not.toHaveClass(/pinned/);
  await page.mouse.move(0, 0);
  await expectViewportLayout(page);
  await page.screenshot({ path: 'test-results/tensorv-professional-desktop.png', fullPage: true });
  await page.getByRole('tab', { name: '数值统计' }).click();
  await expect(page.locator('.stats-grid > div').filter({ has: page.getByText('均值', { exact: true }) }).locator('strong')).toHaveText('11.5');
  await expect(page.locator('.stats-grid > div').filter({ has: page.getByText('最大值', { exact: true }) }).locator('strong')).toHaveText('23');
  await expect(page.getByRole('img', { name: '当前切片的数值分布柱状图' })).toBeVisible();
});

test('operation documentation is collapsed until requested', async ({ page }) => {
  const help = page.locator('details.operation-help');
  await expect(help).toBeVisible();
  await expect(help).not.toHaveAttribute('open', '');
  await expect(help.locator('p')).toBeHidden();
  await help.locator('summary').click();
  await expect(help.locator('p')).toBeVisible();
  await help.locator('summary').click();
  await expect(help.locator('p')).toBeHidden();
  await expectViewportLayout(page);
});

test('scripts preserve independent drafts, names and selection across reloads', async ({ page }) => {
  await expect(page.locator('#script-list .script-row')).toHaveCount(1);
  await expect(page.locator('#script-list [data-script-delete]')).toBeDisabled();
  const originalId = await page.locator('#script-list .script-row').getAttribute('data-script-id');
  await page.locator('#rename-current').click();
  await page.locator('#script-name').fill('matrix-experiment');
  await page.locator('#script-form').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#document-title')).toHaveText('matrix-experiment.py');
  await page.getByRole('switch', { name: '自动运行' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('import torch\nx = torch.tensor([42, 64])\n');
  await expect(page.locator('#document-state')).toHaveText('已保存');
  await page.keyboard.press('ControlOrMeta+Enter');
  await updated(page);
  const created = page.waitForResponse((response) => response.url().endsWith('/api/execute'));
  await page.locator('#new-script').click();
  await created;
  await updated(page);
  await expect(page.locator('#script-list .script-row')).toHaveCount(2);
  await expect(page.locator('#document-title')).toHaveText('untitled.py');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.cm-content')).not.toContainText('42');
  const selected = page.waitForResponse((response) => response.url().endsWith('/api/execute'));
  await page.locator(`[data-script-open="${originalId}"]`).click();
  await selected;
  await updated(page);
  await expect(page.locator('#grid-after .tensor-cell')).toHaveText(['42', '64']);
  await page.reload();
  await updated(page);
  await expect(page.locator('#document-title')).toHaveText('matrix-experiment.py');
  await expect(page.locator('#grid-after .tensor-cell')).toHaveText(['42', '64']);
  await page.locator(`[data-script-delete="${originalId}"]`).click();
  await page.locator('#delete-dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('#script-list .script-row')).toHaveCount(2);
  await page.locator(`[data-script-delete="${originalId}"]`).click();
  const deleted = page.waitForResponse((response) => response.url().endsWith('/api/execute'));
  await page.locator('#confirm-delete').click();
  await deleted;
  await updated(page);
  await expect(page.locator('#script-list .script-row')).toHaveCount(1);
  await expect(page.locator('#document-title')).toHaveText('untitled.py');
  await expect(page.locator('#script-list [data-script-delete]')).toBeDisabled();
});

test('switching scripts discards an error response from the previous script', async ({ page }) => {
  await page.getByRole('switch', { name: '自动运行' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('x = (');
  let requests = 0;
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  await page.route('**/api/execute', async (route) => {
    const requestNumber = ++requests;
    const response = await route.fetch();
    if (requestNumber === 1) await firstGate;
    if (requestNumber === 2) await secondGate;
    await route.fulfill({ response });
  });
  try {
    const firstRequest = page.waitForRequest((request) => request.url().endsWith('/api/execute'));
    await page.locator('#run').click();
    await firstRequest;
    await page.locator('#new-script').click();
    await expect(page.locator('#document-title')).toHaveText('untitled.py');
    const secondRequest = page.waitForRequest((request) => request.url().endsWith('/api/execute'));
    releaseFirst();
    await secondRequest;
    await expect(page.locator('#error-box')).toBeHidden();
    await expect(page.locator('#step-count')).toHaveText('0 个步骤');
    releaseSecond();
    await updated(page);
    await expect(page.locator('.cm-content')).not.toContainText('x = (');
    await expect(page.locator('#error-box')).toBeHidden();
  } finally {
    releaseFirst();
    releaseSecond();
  }
});

test('searchable lesson library, empty results and overlapping unfold storage', async ({ page }) => {
  const originalId = await page.locator('#script-list .script-row.current').getAttribute('data-script-id');
  await page.locator('#browse-examples').click();
  await expect(page.getByRole('dialog', { name: '示例', exact: true })).toBeVisible();
  await expect(page.locator('#library-results .library-card')).toHaveCount(13);
  await page.getByRole('textbox', { name: '搜索教学示例' }).fill('not-a-tensor-operator');
  await expect(page.locator('#library-results')).toContainText('没有找到相关示例');
  await page.getByRole('button', { name: '清除筛选' }).click();
  await page.getByRole('textbox', { name: '搜索教学示例' }).fill('unfold');
  await expect(page.locator('#library-results .library-card')).toHaveCount(1);
  const executed = page.waitForResponse((response) => response.url().endsWith('/api/execute'));
  await page.locator('#library-results [data-example="unfold"]').click();
  await executed;
  await updated(page);
  await expect(page.locator('#library-dialog')).not.toBeVisible();
  await expect(page.locator('#script-list .script-row')).toHaveCount(2);
  await expect(page.locator(`[data-script-id="${originalId}"]`)).toBeVisible();
  await page.getByRole('tab', { name: '存储映射' }).click();
  await expect(page.locator('.memory-cell')).toHaveCount(6);
  await expect(page.locator('.memory-cell.aliased')).toHaveCount(4);
  await page.locator('[data-memory-offset="2"]').click();
  await expect(page.locator('#memory-detail')).toContainText('y[0, 0, 2]');
  await expect(page.locator('#memory-detail')).toContainText('y[0, 1, 1]');
  await expect(page.locator('#memory-detail')).toContainText('y[0, 2, 0]');
});

test('manual editing preserves last successful view on syntax errors and recovers', async ({ page }) => {
  await page.getByRole('switch', { name: '自动运行' }).click();
  await expect(page.getByRole('switch', { name: '自动运行' })).toHaveAttribute('aria-checked', 'false');
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('import torch\nx = torch.arange(6).reshape(2, 3)\nprint("hello TensorV")\n');
  await expect(page.locator('#execution-status')).toContainText('待更新');
  await page.keyboard.press('ControlOrMeta+Enter');
  await updated(page);
  await page.locator('#console-toggle').click();
  await expect(page.locator('#console')).toContainText('hello TensorV');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('x = (');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#error-box')).toContainText('SyntaxError');
  await expect(page.locator('#grid-after .tensor-cell')).toHaveCount(6);
  await expect(page.locator('#step-count')).toHaveText('保留上次成功画面');
  await expect(page.locator('#export-data')).toBeDisabled();
  await importCode(page, 'import torch\nx = torch.tensor([7, 8, 9])\n');
  await expect(page.locator('#grid-after .tensor-cell')).toHaveText(['7', '8', '9']);
  await page.reload();
  await updated(page);
  await expect(page.locator('#grid-after .tensor-cell')).toHaveText(['7', '8', '9']);
  await expect(page.getByRole('switch', { name: '自动运行' })).toHaveAttribute('aria-checked', 'false');
});

test('high-dimensional paging, indices, axis swapping and JSON export use real values', async ({ page }) => {
  await importCode(page, 'import torch\nx = torch.arange(1800).reshape(2, 30, 30)\ny = x.transpose(1, 2)\n');
  await expect(page.locator('#grid-after .tensor-cell')).toHaveCount(576);
  await expect(page.locator('#grid-after [data-i="0"][data-j="1"]')).toHaveText('30');
  await page.locator('#card-after').getByRole('button', { name: '下一页列' }).click();
  await expect(page.locator('#grid-after [data-i="0"][data-j="0"]')).toHaveText('720');
  await page.getByRole('spinbutton', { name: 'after dim 0 索引数值' }).fill('1');
  await expect(page.locator('#grid-after [data-i="0"][data-j="0"]')).toHaveText('1620');
  await page.locator('#row-after').selectOption('0');
  await expect(page.getByRole('spinbutton', { name: 'after dim 1 索引数值' })).toBeVisible();
  await expect(page.locator('#grid-after .tensor-cell')).toHaveCount(48);
  await expect(page.locator('#grid-after [data-i="1"][data-j="1"]')).toHaveText('930');
  await page.locator('#export-data').click();
  const download = page.waitForEvent('download');
  await page.locator('#export-json').click();
  const data = JSON.parse(await downloadText(await download));
  expect(data.scope).toBe('visible_slice');
  expect(data.tensor.shape).toEqual([2, 30, 30]);
  expect(data.slice.row_axis).toBe(0);
  expect(data.slice.values[1][1]).toBe(930);
});

test('Python import and data downloads retain the full original precision', async ({ page }) => {
  const code = 'import torch\nx = torch.tensor([[1.234567891, 2.0], [3.0, 4.0]], dtype=torch.float64)\n';
  await importCode(page, code);
  await expect(page.locator('#grid-after .tensor-cell').first()).toHaveText('1.235');
  await page.locator('#precision').selectOption('8');
  await expect(page.locator('#grid-after .tensor-cell').first()).toHaveText('1.2345679');
  await page.locator('#export-data').click();
  const csvDownload = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const csv = await downloadText(await csvDownload);
  expect(csv).toContain('1.234567891');
  expect(csv.trim().split(/\r?\n/)).toHaveLength(5);
  const pythonDownload = page.waitForEvent('download');
  await page.locator('#download').click();
  expect(await downloadText(await pythonDownload)).toBe(code);
});

test('keyboard commands, persisted theme, resizer and focus mode', async ({ page }) => {
  const nextTheme = (await page.locator('html').getAttribute('data-theme')) === 'dark' ? 'light' : 'dark';
  const separator = page.getByRole('separator', { name: '调整编辑器宽度' });
  const initialWidth = Number(await separator.getAttribute('aria-valuenow'));
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#command-dialog')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索快捷指令' }).fill(nextTheme === 'dark' ? '深色' : '浅色');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', nextTheme);
  await expect(page.locator('#command-dialog')).not.toBeVisible();
  await page.mouse.move(0, 0);
  await expectViewportLayout(page);
  await page.screenshot({ path: `test-results/tensorv-professional-${nextTheme}-desktop.png`, fullPage: true });
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', String(initialWidth + 2));
  await page.getByRole('button', { name: '专注画布', exact: true }).click();
  await expect(page.locator('.workspace')).toHaveClass(/focus-mode/);
  await page.getByRole('button', { name: '退出专注画布', exact: true }).click();
  await expect(page.locator('.workspace')).not.toHaveClass(/focus-mode/);
  await page.reload();
  await updated(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', nextTheme);
  await expect(separator).toHaveAttribute('aria-valuenow', String(initialWidth + 2));
});

test('step playback, keyboard navigation and comparison can be toggled', async ({ page }) => {
  await page.locator('#play-speed').selectOption('750');
  await page.getByRole('button', { name: '播放步骤', exact: true }).click();
  await expect(page.locator('#step-count')).toHaveText('1 / 3 个步骤');
  await expect(page.locator('#step-count')).toHaveText('3 / 3 个步骤');
  await expect(page.getByRole('button', { name: '播放步骤', exact: true })).toBeVisible();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('#step-count')).toHaveText('2 / 3 个步骤');
  await page.locator('#compare').click();
  await expect(page.locator('#card-before')).toHaveCount(0);
  await page.locator('#compare').click();
  await expect(page.locator('#card-before')).toBeVisible();
  await page.locator('#heatmap').click();
  await expect(page.locator('#heatmap')).toHaveAttribute('aria-pressed', 'false');
});

test('mobile editor, inspector and navigation fit within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await updated(page);
  await expectViewportLayout(page);
  await expect(page.locator('.editor-panel')).toBeVisible();
  await expect(page.locator('.inspector-panel')).toBeHidden();
  await page.screenshot({ path: 'test-results/tensorv-professional-mobile-editor.png', fullPage: true });
  await page.locator('#mobile-inspector').click();
  await expect(page.locator('.editor-panel')).toBeHidden();
  await expect(page.locator('.inspector-panel')).toBeVisible();
  await expect(page.locator('#grid-after .tensor-cell')).toHaveCount(12);
  await expectViewportLayout(page);
  await page.screenshot({ path: 'test-results/tensorv-professional-mobile-inspector.png', fullPage: true });
  await page.locator('#sidebar-toggle').click();
  await page.locator('#browse-examples').click();
  await expect(page.locator('#example-search')).toBeVisible();
  await page.locator('#example-search').fill('matmul');
  await expect(page.locator('#library-results .library-card')).toHaveCount(1);
  const bounds = await page.locator('#library-dialog').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  await page.getByRole('button', { name: '关闭示例库' }).click();
  await page.locator('#help').click();
  await expect(page.getByRole('heading', { name: '使用帮助', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭使用帮助' }).click();
  await page.locator('#sidebar-close').click();
  await page.locator('#mobile-editor').click();
  await expect(page.locator('.editor-panel')).toBeVisible();
  await expectViewportLayout(page);
});




test('delayed slices remain consistent through precision redraw and comparison toggles', async ({ page }) => {
  await importCode(page, 'import torch\nx = torch.arange(24).reshape(2, 3, 4)\ny = x.transpose(1, 2)\n');
  await page.route('**/api/slice', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  const sliceResponse = page.waitForResponse((response) => response.url().endsWith('/api/slice'));
  await page.getByRole('spinbutton', { name: 'after dim 0 索引数值' }).fill('1');
  await page.locator('#precision').selectOption('6');
  await page.locator('#compare').click();
  await sliceResponse;
  await expect(page.locator('#grid-after')).not.toHaveAttribute('aria-busy', 'true');
  const index = Number(await page.getByRole('spinbutton', { name: 'after dim 0 索引数值' }).inputValue());
  await expect(page.locator('#grid-after [data-i="0"][data-j="0"]')).toHaveText(String(index * 12));
  await page.locator('#compare').click();
  await expect(page.locator('#grid-after [data-i="0"][data-j="0"]')).toHaveText(String(index * 12));
});

test('production build serves executable JavaScript and real tensor output', async ({ page, request }) => {
  await page.goto(`http://127.0.0.1:${process.env.TENSORV_TEST_PORT || 8765}/`);
  await updated(page);
  const scripts = await page.locator('script[src]').evaluateAll((nodes) => nodes.map((node) => node.src));
  expect(scripts.length).toBeGreaterThan(0);
  for (const url of scripts) {
    const response = await request.get(url);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toMatch(/javascript|ecmascript/);
  }
  await expect(page.locator('#grid-after [data-i="0"][data-j="1"]')).toHaveText('4');
  await expect(page.locator('#runtime')).toHaveAttribute('data-state', 'ready');
});


test('int64 values above the JavaScript safe range stay exact in cells and CSV', async ({ page }) => {
  await importCode(page, 'import torch\nx = torch.tensor([9007199254740993, 9223372036854775807, -9223372036854775808], dtype=torch.int64)\n');
  await expect(page.locator('#grid-after .tensor-cell')).toHaveText(['9007199254740993', '9223372036854775807', '-9223372036854775808']);
  await page.locator('#export-data').click();
  const download = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const csv = await downloadText(await download);
  expect(csv).toContain('"9007199254740993"');
  expect(csv).toContain('"9223372036854775807"');
  expect(csv).toContain('"-9223372036854775808"');
  expect(csv).not.toContain('9007199254740992');
});
