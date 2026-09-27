/**
 * Playwright fixtures for Tauri E2E testing
 *
 * Custom fixtures for launching and managing the Tauri app during tests
 */
import { test as base, Page } from '@playwright/test';
import { launchTauriApp, TauriApp, waitForAppReady } from './tauri-driver';

type TauriFixtures = {
  tauriApp: TauriApp;
  tauriPage: Page;
};

/**
 * Extended test with Tauri fixtures
 */
export const test = base.extend<TauriFixtures>({
  // Launch Tauri app before each test
  tauriApp: async ({}, use) => {
    const app = await launchTauriApp();
    await waitForAppReady(app);
    await use(app);
    await app.close();
  },

  // Provide the page object
  tauriPage: async ({ tauriApp }, use) => {
    await use(tauriApp.page);
  },
});

export { expect } from '@playwright/test';
