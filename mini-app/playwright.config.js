const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './smoke',
  testMatch: ['**/smoke.spec.js'],
  timeout: 45_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
