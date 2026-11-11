import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', outputDir: process.env.HERMES_TEST_OUTPUT || '../hermes-test-results', timeout: 120_000, workers: 1,
  expect: { timeout: 15000 },
  reporter: 'list', use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
