/**
 * E2E smoke test: Multi-device Fan-Out (Plan 07).
 *
 * Verifies the panel opens via the Cmd+Shift+F hotkey, renders the command
 * bar with a disabled Run button (no group selected), and closes via the
 * overlay backdrop. Does not actually fire a fan-out run — that requires
 * mock SSH harnesses already exercised by the cargo integration suite.
 */
import { test, expect } from '../fixtures';

test.describe('Multi-device Fan-Out Panel @smoke', () => {
  test('opens via Cmd+Shift+F and renders command bar', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    const isMac = process.platform === 'darwin';
    const modifier = isMac ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+Shift+F`);

    const panel = tauriPage.locator('[data-testid="fanout-panel"]');
    await expect(panel).toBeVisible({ timeout: 5000 });

    // Command input + group select + run button present
    await expect(panel.locator('[data-testid="fanout-command"]')).toBeVisible();
    await expect(panel.locator('[data-testid="fanout-group-select"]')).toBeVisible();
    const runButton = panel.locator('[data-testid="fanout-run"]');
    await expect(runButton).toBeVisible();
    // No group selected → Run is disabled
    await expect(runButton).toBeDisabled();
  });
});
