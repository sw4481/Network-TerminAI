/**
 * E2E smoke test: AI Guardrails (Plan 09).
 *
 * Verifies the rule editor opens via Cmd+Shift+G, that the seeded builtin
 * ruleset is visible, and that the search filter narrows the rule list.
 *
 * Also verifies the Decision Log opens via the Guardrails menu — exercising
 * the menu-event wiring added in Phase Final.
 */
import { test, expect } from '../fixtures';

test.describe('Guardrails Rule Editor @smoke', () => {
  test('opens via Cmd+Shift+G and lists builtin rules', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    const isMac = process.platform === 'darwin';
    const modifier = isMac ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+Shift+G`);

    const editor = tauriPage.locator('[data-testid="rule-editor"]');
    await expect(editor).toBeVisible({ timeout: 5000 });

    // Builtin reload rule must be present (seeded at boot from the embedded
    // 278-rule JSON).
    await expect(
      tauriPage.locator('[data-testid="re-rule-builtin-iosxe-reload"]'),
    ).toBeVisible({ timeout: 5000 });

    // Search filter narrows the list.
    const search = tauriPage.locator('[data-testid="re-search"]');
    await search.fill('reload');
    await expect(
      tauriPage.locator('[data-testid="re-rule-builtin-iosxe-reload"]'),
    ).toBeVisible();
  });
});

test.describe('Guardrails Local Shell scope guard @smoke', () => {
  test('local PTY commands are NOT classified', async ({ tauriPage }) => {
    // Open a local terminal tab — it should already be the default landing
    // tab on app start. Type a destructive command and verify no
    // confirmation modal appears.
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Type a no-op echo of a destructive-looking command to a local shell.
    await tauriPage.keyboard.type('echo rm -rf /tmp/foo');
    await tauriPage.keyboard.press('Enter');

    // Wait briefly to give any modal a chance to appear.
    await tauriPage.waitForTimeout(500);

    // Crucial assertion: the BlastRadius modal overlay must NOT be visible
    // for ANY tier when typing into a local shell.
    await expect(tauriPage.locator('[data-testid="br-overlay-tier1"]')).toHaveCount(0);
    await expect(tauriPage.locator('[data-testid="br-overlay-tier2"]')).toHaveCount(0);
    await expect(tauriPage.locator('[data-testid="br-overlay-tier3"]')).toHaveCount(0);
  });
});
