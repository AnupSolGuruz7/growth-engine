import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke tests against the real stack: compose Postgres + Redis must be up (pnpm infra:up).
 * globalSetup reseeds the demo site with synthetic traffic; the API and dashboard are started
 * here unless already running (reuseExistingServer).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:5180', trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'pnpm --filter @growthos/api start',
      url: 'http://localhost:4000/health',
      reuseExistingServer: true,
      timeout: 60_000,
      cwd: '../..',
    },
    {
      command: 'pnpm dev',
      url: 'http://localhost:5180',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
