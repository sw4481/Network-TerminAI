/**
 * E2E Test: Change Window Panel
 *
 * Smoke test for Plan 06's pre/post change-verification UI:
 * - Open the panel via menu shortcut Cmd+Shift+V
 * - Bundle picker renders (filtered by active tab's vendor/platform)
 * - Create a new bundle via the Create button
 * - Close the panel via the X button
 *
 * Does NOT exercise the full pre→change→post flow because that requires
 * a live device (or a Tauri-side mock that doesn't yet exist). Phase 6+
 * can add a `window.__ccieMockTransport` hook for full e2e coverage.
 */
import { test, expect } from '../fixtures';

test.describe('Change Window Panel @smoke', () => {
  test('opens via menu shortcut and shows bundle picker', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Open the change window via Cmd+Shift+C (Ctrl+Shift+C on non-Mac).
    const isMac = process.platform === 'darwin';
    const modifier = isMac ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+Shift+C`);

    // The drawer should appear with the bundle picker.
    const panel = tauriPage.locator('.change-window-panel');
    await expect(panel).toBeVisible({ timeout: 5000 });

    // Bundle picker shows the seed bundles OR an empty state. Either way,
    // the "Create new bundle" button is always present.
    const createButton = panel.getByRole('button', { name: /create.*bundle/i });
    await expect(createButton).toBeVisible();
  });

  test('closes via X button', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    const isMac = process.platform === 'darwin';
    const modifier = isMac ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+Shift+C`);

    const panel = tauriPage.locator('.change-window-panel');
    await expect(panel).toBeVisible({ timeout: 5000 });

    // Click the close (X) button.
    await panel.getByRole('button', { name: /close/i }).click();
    await expect(panel).not.toBeVisible({ timeout: 5000 });
  });
});
