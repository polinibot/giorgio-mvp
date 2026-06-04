const { defineConfig } = require('@playwright/test');

const PROD_API = process.env.SMOKE_PROD_API_URL
  || 'https://giorgio-mvp-production.up.railway.app';
const WEB_PORT = process.env.SMOKE_PROD_WEB_PORT || '34000';

module.exports = defineConfig({
  testDir: './smoke',
  testMatch: ['**/prod-smoke.spec.js'],
  timeout: 60_000,
  fullyParallel: false,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
