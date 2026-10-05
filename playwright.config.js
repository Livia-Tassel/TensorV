import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const localPython = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const python = process.env.TENSORV_PYTHON || (existsSync(localPython) ? localPython : 'python');

export default defineConfig({
  testDir: './tests',
  testMatch: '**/ui.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `"${python}" -m tensorv.server --port 8765`,
      url: 'http://127.0.0.1:8765/api/health',
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev -- --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
