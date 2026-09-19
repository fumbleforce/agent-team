import { defineConfig } from '@playwright/test';

// Smoke tests over the demo: a throwaway coordinator on an in-memory database with the built web app.
const port = 4391;
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure' },
  webServer: { command: 'node bin/agent-team-demo.ts', env: { PORT: String(port) }, url: `http://127.0.0.1:${port}/`, reuseExistingServer: true, timeout: 30_000, ignoreHTTPSErrors: true },
});
