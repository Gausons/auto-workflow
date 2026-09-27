import { defineConfig } from '@playwright/test';

const port = Number(process.env.BUGFLOW_E2E_PORT || 4191);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'web/e2e',
  workers: 1,
  globalTeardown: './web/e2e/teardown.ts',
  use: { baseURL, browserName: 'chromium', headless: true },
  webServer: { command: 'node --import tsx scripts/e2e-server.ts', url: `${baseURL}/tasks`, reuseExistingServer: false, timeout: 30_000 }
});
