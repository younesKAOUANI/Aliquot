import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the read-only viewer.
 *
 * These run against a stack that is already up, rather than starting one:
 * `docker compose up` is the documented way in, the seeded dataset is what the
 * viewer is meant to render, and a `webServer` block that spun up its own
 * instance would be testing a different system from the one a reviewer sees.
 * The trade is that the suite fails with a connection error when the stack is
 * down, so `globalSetup` turns that into a sentence explaining what to run.
 *
 * Scope is deliberately narrow. The guarantees live in the database and are
 * covered by `test/integration`; what a browser can check that nothing else can
 * is that the viewer actually wires up to the API -- which is precisely where
 * the two bugs these tests were written for lived.
 */
export default defineConfig({
  testDir: './test/e2e',
  globalSetup: './test/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.ALIQUOT_E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
