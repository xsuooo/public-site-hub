const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: 'ui-e2e.spec.js',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'line' : 'list',
  outputDir: '.playwright/test-results'
});
