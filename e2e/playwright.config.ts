import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Playwright configuration for CCIE Terminal E2E tests
 *
 * This configuration is set up for testing a Tauri application.
 * The app must be built before running tests.
 */
export default defineConfig({
  testDir: './tests',

  // Timeout for each test
  timeout: 60000,

  // Expect timeout for assertions
  expect: {
    timeout: 10000,
  },

  // Run tests in files in parallel
  fullyParallel: false,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Opt out of parallel tests
  workers: 1,

  // Reporter to use
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'e2e/test-results/results.json' }],
  ],

  // Shared settings for all the projects below
  use: {
    // Base URL for navigation
    baseURL: 'tauri://localhost',

    // Collect trace on failure
    trace: 'retain-on-failure',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'retain-on-failure',

    // Viewport size
    viewport: { width: 1280, height: 800 },
  },

  // Configure projects for different scenarios
  projects: [
    {
      name: 'tauri-app',
      use: {
        ...devices['Desktop Chrome'],
        // Tauri apps run as local webview, not a browser
        // We'll use electron-like approach with webContext
      },
    },
  ],

  // Global setup/teardown — resolve relative to this config in ESM mode.
  globalSetup: resolve(__dirname, 'global-setup.ts'),
  globalTeardown: resolve(__dirname, 'global-teardown.ts'),
});
