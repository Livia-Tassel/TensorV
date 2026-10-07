import { test, expect } from '@playwright/test';

const original = 'import torch\nx = torch.arange(12).reshape(2, 3, 2)\ny = x.transpose(1, 2)\n';
const changed = 'import torch\nx = torch.arange(36).reshape(3, 3, 4)\ny = x.transpose(1, 2)\n';
const apiBaseURL = `http://127.0.0.1:${process.env.TENSORV_TEST_PORT || 8765}`;

async function updated(page) {
  await expect(page.locator('#execution-status')).toContainText('已更新', { timeout: 40000 });
  await expect(page.locator('#run')).toBeEnabled();
  await expect(page.locator('#error-box')).toBeHidden();
}

async function sourceHost(page, request) {
  const messages = [];
  const executed = [];
  let code = original;
  let source = { id: 'bound-file-one', mode: 'file', uri: 'file:///tensor-example.py', version: 1, lineOffset: 0 };
  let changeAfterRead = null;
  let nextExecutionGate = null;
  const send = (message) => page.evaluate((value) => window.postMessage(value, '*'), message);
  const reply = (id, result) => send({ type: 'tensorv:response', id, ...result });

  await page.exposeBinding('tensorVSourceHost', async (_, message) => {
    messages.push(message);
    if (message.type !== 'tensorv:request') return;
    if (message.action === 'getSource') {
      const snapshot = { code, source: { ...source } };
      if (changeAfterRead) {
        code = changeAfterRead;
        source = { ...source, version: source.version + 1 };
        changeAfterRead = null;
      }
      await reply(message.id, { ok: true, data: snapshot });
      return;
    }
    if (message.action === 'execute' && message.payload.sourceId && message.payload.sourceVersion !== source.version) {
      await send({ type: 'tensorv:sourceChanged', code, source: { ...source } });
      await reply(message.id, { ok: false, code: 'SOURCE_CHANGED', message: '源文件在同步后发生修改，请使用最新版本。' });
      return;
    }
    const payload = message.action === 'execute' && message.payload.sourceId ? { code } : message.payload;
    const executionSource = message.payload.sourceId ? { ...source, code } : null;
    if (message.action === 'execute') executed.push(payload.code);
    const response = await request.post(`${apiBaseURL}/api/${message.action}`, { data: payload });
    const data = await response.json();
    if (message.action === 'execute' && nextExecutionGate) {
      const gate = nextExecutionGate;
      nextExecutionGate = null;
      await gate;
    }
    if (!page.isClosed()) await reply(message.id, { ok: response.ok(), data: executionSource ? { ...data, source: executionSource } : data, message: data.message });
  });
  await page.addInitScript(() => {
    let state;
    window.acquireVsCodeApi = () => ({
      getState: () => state,
      setState: (value) => { state = value; },
      postMessage: (message) => window.tensorVSourceHost(message),
    });
  });
  await page.goto('/');
  await expect(page.locator('#runtime-label')).toContainText('等待运行');
  await send({ type: 'tensorv:import', title: 'tensor-example.py', code, source: { ...source } });
  await updated(page);

  return {
    messages,
    executed,
    changeDuringNextRun(next) { changeAfterRead = next; },
    holdNextExecution(gate) { nextExecutionGate = gate; },
    async update(next, version) {
      if (version >= source.version) { code = next; source = { ...source, version }; }
      await send({ type: 'tensorv:sourceChanged', code: next, source: { ...source, version } });
    },
  };
}

let browserErrors;
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('manual Run retries a source version race even with automatic execution disabled', async ({ page, request }) => {
  const host = await sourceHost(page, request);
  await expect(page.locator('#auto')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  const count = await page.locator('#script-list .script-row').count();
  host.changeDuringNextRun(changed);
  await page.locator('#run').click();
  await expect(page.locator('#metadata')).toContainText('[3, 4, 3]');
  await updated(page);
  await expect(page.locator('#source-state')).toContainText('已更新');
  await expect(page.locator('.cm-content')).toContainText('torch.arange(36)');
  await expect(page.locator('#script-list .script-row')).toHaveCount(count);
  expect(host.executed).toEqual([original, changed]);
  expect(host.messages.filter((message) => message.type === 'tensorv:request' && message.action === 'getSource').length).toBeGreaterThanOrEqual(3);
});

test('late source versions and an older execution cannot overwrite a detached example', async ({ page, request }) => {
  const host = await sourceHost(page, request);
  await host.update(changed, 3);
  await expect(page.locator('#source-state')).toContainText('待更新');
  await host.update(original, 2);
  await expect(page.locator('.cm-content')).toContainText('torch.arange(36)');
  expect(host.executed).toEqual([original]);
  await page.locator('#run').click();
  await expect(page.locator('#metadata')).toContainText('[3, 4, 3]');
  await updated(page);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  host.holdNextExecution(gate);
  try {
    await page.locator('#run').click();
    await expect.poll(() => host.executed.length).toBe(3);
    await page.locator('#sidebar-toggle').click();
    await page.locator('#sidebar-examples [data-example]').first().click();
    const exampleCode = await page.locator('.cm-content').textContent();
    const exampleId = await page.locator('#script-list .script-row.current').getAttribute('data-script-id');
    release();
    await updated(page);
    await expect(page.locator('#source-bar')).toBeHidden();
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
    const executionCount = host.executed.length;
    await host.update('import torch\nx = torch.tensor([999])\n', 4);
    await page.waitForTimeout(850);
    await expect(page.locator('#script-list .script-row.current')).toHaveAttribute('data-script-id', exampleId);
    await expect(page.locator('.cm-content')).toHaveText(exampleCode);
    expect(host.executed).toHaveLength(executionCount);
    expect(host.messages.some((message) => message.type === 'tensorv:bindSource' && message.sourceId === null)).toBe(true);
  } finally {
    release();
  }
});
