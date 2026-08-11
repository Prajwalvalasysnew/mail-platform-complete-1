import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // A full-route test runs WCAG A/AA analysis on thirteen data-backed pages.
  // Firefox/WebKit can legitimately exceed two minutes on loaded CI hosts.
  timeout: 300_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // These tests share a real API, database, and login-abuse limiter.
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: process.env.ADMIN_CONSOLE_URL ?? 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
