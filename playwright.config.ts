import { defineConfig } from '@playwright/test';

import e2eConfig from './e2e/playwright.config';

/**
 * Root entry point for the documented `bunx playwright test` command.
 *
 * The shared E2E configuration lives under `e2e/`, where its relative testDir
 * is correct only when that file is selected explicitly. Keep the root command
 * scoped to the E2E suite instead of allowing Playwright to collect Vitest
 * component tests from the rest of the repository.
 */
export default defineConfig({
  ...e2eConfig,
  testDir: './e2e/tests',
});
