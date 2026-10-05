import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const origin = new URL(process.argv[2] || 'http://invalid.invalid').origin;
if (!process.argv[2] || !origin.startsWith('https://')) throw new Error('Usage: node scripts/verify-public.mjs https://your-domain');
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined) });
try {
  const errors = [];
  const contexts = [await browser.newContext(), await browser.newContext()];
  const pages = [];
  const results = [];
  for (const context of contexts) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    page.on('pageerror', (error) => errors.push(error.message));
    const execution = page.waitForResponse((response) => response.url().endsWith('/api/execute'));
    await page.goto(origin);
    const response = await execution;
    assert.equal(response.status(), 200);
    const result = await response.json();
    assert.equal(result.execution_mode, 'isolated');
    assert.equal(result.error, null);
    await page.locator('#execution-status.success').waitFor({ timeout: 40000 });
    assert.equal(await page.locator('#grid-after .tensor-cell').count(), 12);
    const cookie = (await context.cookies()).find((item) => item.name === '__Host-tensorv_session');
    assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Strict');
    pages.push(page); results.push(result);
  }
  const snapshot = results[0].steps.at(-1).tensors.find((tensor) => tensor.name === 'y');
  const slice = (page, id) => page.evaluate(async (snapshotId) => {
    const response = await fetch('/api/slice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: snapshotId, indices: [1, 0, 0] }),
    });
    return { status: response.status, data: await response.json() };
  }, id);
  const retained = await slice(pages[0], snapshot.id);
  assert.equal(retained.status, 200);
  assert.deepEqual(retained.data.values[0], [12, 16, 20]);
  assert.equal((await slice(pages[1], snapshot.id)).status, 400);
  const forbidden = await contexts[0].request.post(`${origin}/api/execute`, {
    headers: { Origin: 'https://untrusted.invalid' }, data: { code: 'x = torch.arange(1)' },
  });
  assert.equal(forbidden.status(), 403);
  const health = await contexts[0].request.get(`${origin}/api/health`);
  assert.equal(health.status(), 200);
  assert.equal(health.headers()['set-cookie'], undefined);
  await pages[0].getByRole('tab', { name: '数值统计' }).click();
  await pages[0].locator('.stats-grid').waitFor();
  await pages[0].getByRole('tab', { name: '张量画布' }).click();
  await mkdir('test-results', { recursive: true });
  await pages[0].screenshot({ path: 'test-results/tensorv-public.png' });
  assert.deepEqual(errors, []);
  console.log('HTTPS UI, isolated execution, private snapshots, secure cookies and origin restrictions passed.');
} finally {
  await browser.close();
}
