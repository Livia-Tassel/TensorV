import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const localPython = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const python = process.env.TENSORV_PYTHON || (existsSync(localPython) ? localPython : 'python');
const apiPort = Number(process.env.TENSORV_TEST_PORT || 8765);
const uiPort = Number(process.env.TENSORV_TEST_UI_PORT || 5173);
if (![apiPort, uiPort].every(port => Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('Invalid TensorV test port');

export default defineConfig({
  testDir: './tests',
  testMatch: '**/ui.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${uiPort}`,
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `"${python}" -m tensorv.server --port ${apiPort}`,
      url: `http://127.0.0.1:${apiPort}/api/health`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npm run dev -- --port ${uiPort} --strictPort`,
      url: `http://127.0.0.1:${uiPort}`,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
