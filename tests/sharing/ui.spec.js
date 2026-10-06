import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { encodeExperiment, parseExperiment } from '../../src/experiments.js';

const matrixCode = 'import torch\nx = torch.arange(6).reshape(2, 3)\n';

function experiment(overrides = {}) {
  return {
    format: 'tensorv-experiment', version: 1, title: 'Shared matrix', code: matrixCode,
    environment: { torch: null, app: '0.4.0' },
    view: {
      step: { index: 0, line: 2, source: 'x = torch.arange(6).reshape(2, 3)' },
      referenceStep: null, before: null,
      after: { name: 'x', shape: [2, 3], row_axis: 0, col_axis: 1, indices: [0, 0], row_start: 0, col_start: 0 },
      compare: false, heatmap: true, precision: 4, tab: 'canvas',
    },
    ...overrides,
  };
}

function executions(page) {
  const requests = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/execute')) requests.push(request);
  });
  return requests;
}

async function updated(page) {
  await expect(page.locator('#execution-status')).toContainText('已更新', { timeout: 40000 });
  await expect(page.locator('#run')).toBeEnabled();
  await expect(page.locator('#error-box')).toBeHidden();
}

async function run(page, action = () => page.locator('#run').click()) {
  const response = page.waitForResponse((item) => item.url().endsWith('/api/execute') && item.request().method() === 'POST');
  await action();
  await response;
  await updated(page);
}

async function importExperiment(page, document) {
  await page.locator('#experiment-file-input').setInputFiles({
    name: 'matrix.tensorv.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(page.locator('#experiment-notice')).toBeVisible();
}

async function remainsUnexecuted(page, requests, expected = 0) {
  // Cross the ordinary automatic-run debounce so this asserts that a request
  // does not arrive later, not merely that the immediate event queue is empty.
  await page.waitForTimeout(850);
  expect(requests).toHaveLength(expected);
}

let browserErrors;
test.beforeEach(async ({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('shared link previews without execution even when automatic mode was saved', async ({ page }) => {
  const requests = executions(page);
  await page.addInitScript(() => localStorage.setItem('tensorv:auto', 'true'));
  await page.goto(`/${await encodeExperiment(experiment())}`);
  await expect(page.locator('#experiment-notice')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('torch.arange(6)');
  await expect(page.locator('#grid-after .tensor-cell')).toHaveCount(0);
  await remainsUnexecuted(page, requests);
  // Removing the URL fragment must not erase the imported script's review gate.
  await page.evaluate(() => history.replaceState(null, '', location.pathname));
  await page.reload();
  await expect(page.locator('#experiment-notice')).toBeVisible();
  await remainsUnexecuted(page, requests);
  await run(page);
  expect(requests).toHaveLength(1);
  await expect(page.locator('#grid-after .tensor-cell')).toHaveText(['0', '1', '2', '3', '4', '5']);
});

test('file preview cancels a pending automatic run and stays gated after script switching', async ({ page }) => {
  const requests = executions(page);
  await page.goto('/');
  await updated(page);
  const originalId = await page.locator('#script-list .script-row.current').getAttribute('data-script-id');
  requests.length = 0;
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n# Pending old draft\n');
  await importExperiment(page, experiment());
  const importedId = await page.locator('#script-list .script-row.current').getAttribute('data-script-id');
  expect(importedId).not.toBe(originalId);
  await expect(page.locator('#script-list .script-row')).toHaveCount(2);
  await remainsUnexecuted(page, requests);
  await run(page, () => page.locator(`[data-script-open="${originalId}"]`).click());
  await page.locator(`[data-script-open="${importedId}"]`).click();
  await expect(page.locator('#experiment-notice')).toBeVisible();
  await remainsUnexecuted(page, requests, 1);
  await run(page);
  expect(requests).toHaveLength(2);
  await expect(page.locator('#grid-after .tensor-cell')).toHaveText(['0', '1', '2', '3', '4', '5']);
});

test('an earlier execution response cannot execute or populate a newly imported preview', async ({ page }) => {
  const requests = executions(page);
  await page.goto('/');
  await updated(page);
  requests.length = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/execute', async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    const sent = page.waitForRequest((request) => request.url().endsWith('/api/execute'));
    await page.locator('#run').click();
    await sent;
    await importExperiment(page, experiment());
    const completed = page.waitForResponse((response) => response.url().endsWith('/api/execute'));
    release();
    await completed;
    await expect(page.locator('#run')).toBeEnabled();
    await remainsUnexecuted(page, requests, 1);
    await expect(page.locator('#grid-after .tensor-cell')).toHaveCount(0);
    await expect(page.locator('#experiment-notice')).toBeVisible();
  } finally {
    release();
  }
});

test('experiment export restores independent slices of the same tensor and the chosen baseline', async ({ page, context }) => {
  await page.goto('/');
  await updated(page);
  const code = 'import torch\nx = torch.arange(180).reshape(2, 3, 30)\ny = x.transpose(1, 2)\n';
  await run(page, () => page.locator('#file-input').setInputFiles({ name: 'views.py', mimeType: 'text/x-python', buffer: Buffer.from(code) }));
  await page.locator('#reference-step').selectOption('1');
  await page.locator('#tensor-before').selectOption('y');
  await page.locator('#card-before').getByRole('button', { name: '下一页行' }).click();
  await expect(page.locator('#grid-before [data-i="0"][data-j="0"]')).toHaveText('24');
  await page.locator('#row-after').selectOption('0');
  await page.getByRole('spinbutton', { name: 'after dim 1 索引数值' }).fill('20');
  await expect(page.locator('#grid-after [data-i="0"][data-j="0"]')).toHaveText('20');
  await expect(page.locator('#grid-after [data-i="1"][data-j="0"]')).toHaveText('110');
  await page.locator('#precision').selectOption('8');
  await page.locator('#heatmap').click();
  await page.getByRole('tab', { name: '存储映射' }).click();
  await page.locator('#share-experiment').click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#download-experiment').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.tensorv\.json$/);
  const exported = parseExperiment(await readFile(await download.path(), 'utf8'));
  expect(exported.code).toBe(code);
  expect(exported.view.referenceStep.index).toBe(1);
  expect(exported.view.before.name).toBe('y');
  expect(exported.view.after.name).toBe('y');
  expect(exported.view.before.row_start).toBe(24);
  expect(exported.view.after.row_axis).toBe(0);
  expect(exported.view.after.indices[1]).toBe(20);
  expect(exported.view).not.toHaveProperty('id');
  expect(exported.view.after).not.toHaveProperty('values');
  expect(exported.view.after).not.toHaveProperty('id');

  const recipient = await context.newPage();
  recipient.on('pageerror', (error) => browserErrors.push(error.message));
  const requests = executions(recipient);
  await recipient.goto(`/${await encodeExperiment(exported)}`);
  await expect(recipient.locator('#experiment-notice')).toBeVisible();
  await remainsUnexecuted(recipient, requests);
  await run(recipient);
  await expect(recipient.locator('#reference-step')).toHaveValue('1');
  await expect(recipient.locator('#tab-memory')).toHaveAttribute('aria-selected', 'true');
  await expect(recipient.locator('#precision')).toHaveValue('8');
  await expect(recipient.locator('#heatmap')).toHaveAttribute('aria-pressed', 'false');
  await recipient.getByRole('tab', { name: '张量画布' }).click();
  await expect(recipient.locator('#grid-before .tensor-cell')).toHaveCount(18);
  await expect(recipient.locator('#grid-before [data-i="0"][data-j="0"]')).toHaveText('24');
  await expect(recipient.locator('#row-before')).toHaveValue('1');
  await expect(recipient.locator('#row-after')).toHaveValue('0');
  await expect(recipient.getByRole('spinbutton', { name: 'after dim 1 索引数值' })).toHaveValue('20');
  await expect(recipient.locator('#grid-after [data-i="0"][data-j="0"]')).toHaveText('20');
  await expect(recipient.locator('#grid-after [data-i="1"][data-j="0"]')).toHaveText('110');
  await recipient.close();
});

test('an unsupported shared-link version does not execute the previous saved script', async ({ page }) => {
  const requests = executions(page);
  await page.addInitScript(() => {
    localStorage.setItem('tensorv:auto', 'true');
    localStorage.setItem('tensorv:code:v1', 'import torch\nx = torch.tensor([12345])\n');
  });
  await page.goto('/#tv=99.p.e30');
  await expect(page.getByText(/不支持此实验链接版本/).first()).toBeVisible();
  await remainsUnexecuted(page, requests);
  await expect(page.locator('#grid-after .tensor-cell')).toHaveCount(0);
});

test('shape changes fall back to a valid view after the user runs the imported code', async ({ page }) => {
  const document = experiment();
  document.environment.torch = '0.0.0-test';
  document.view.after = { name: 'x', shape: [2, 3, 30], row_axis: 0, col_axis: 2, indices: [1, 2, 29], row_start: 1, col_start: 24 };
  const requests = executions(page);
  await page.goto(`/${await encodeExperiment(document)}`);
  await expect(page.locator('#experiment-notice')).toBeVisible();
  await remainsUnexecuted(page, requests);
  await run(page);
  await expect(page.locator('#row-after')).toHaveValue('0');
  await expect(page.locator('#col-after')).toHaveValue('1');
  await expect(page.locator('#grid-after .tensor-cell')).toHaveText(['0', '1', '2', '3', '4', '5']);
  await expect(page.locator('.slice-error')).toHaveCount(0);
});

test('valid display titles become safe local script names without running the experiment', async ({ page }) => {
  const requests = executions(page);
  await page.goto('/');
  await updated(page);
  requests.length = 0;
  await importExperiment(page, experiment({ title: 'reshape / view' }));
  await expect(page.locator('#document-title')).toHaveText('reshape _ view.py');
  await importExperiment(page, experiment({ title: 'a'.repeat(80) }));
  const title = await page.locator('#document-title').textContent();
  expect(title).toHaveLength(80);
  expect(title).toMatch(/\.py$/);
  await expect(page.locator('.cm-content')).toContainText('torch.arange(6)');
  await expect(page.locator('#script-list .script-row')).toHaveCount(3);
  await remainsUnexecuted(page, requests);
});
