/**
 * E2E smoke test: Drift Sidebar (Plan 08).
 *
 * Verifies the sidebar opens via Cmd+Shift+D, the intent dropdown renders,
 * and the Run Now button is disabled when no template is selected.
 */
import { test, expect } from '../fixtures';

test.describe('Drift Sidebar @smoke', () => {
  test('opens via Cmd+Shift+D and renders the empty state', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    const isMac = process.platform === 'darwin';
    const modifier = isMac ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+Shift+D`);

    const sidebar = tauriPage.locator('[data-testid="drift-sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    // The template select dropdown is always present; Run Now is disabled
    // until a template is picked.
    await expect(sidebar.locator('[data-testid="drift-template-select"]')).toBeVisible();
    const run = sidebar.locator('[data-testid="drift-run"]');
    await expect(run).toBeVisible();
    await expect(run).toBeDisabled();
  });
});
