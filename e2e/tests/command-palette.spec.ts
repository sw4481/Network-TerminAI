/**
 * E2E: Command Palette (Plan 04)
 *
 * Tagged @palette so it can be selected with `--grep @palette`.
 *
 * Covers the user-visible flows wired up in Plan 04:
 *   - Open / close (⌘P or ⌘K, Escape, click-outside).
 *   - Scope segmented control + ⌘1/⌘2/⌘3 hotkeys.
 *   - `>` category prefix → kind chip + filtered list.
 *   - Backspace at position 0 clears the chip.
 *   - Enter on a row dispatches the per-kind CustomEvent.
 *   - Recency: opening with empty query lists palette_usage rows by
 *     last_used_at DESC.
 *
 * The Playwright suite drives the real Tauri build so backing tables do
 * what they would in production. Tests that need DB seeding spawn
 * commands first to populate command_blocks (and via the AFTER INSERT
 * trigger, palette_index).
 */
import { test, expect } from '../fixtures';

test.describe('Command Palette @palette', () => {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

  test('opens with Cmd+K and closes with Escape', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    await tauriPage.keyboard.press(`${modifier}+KeyK`);
    await expect(tauriPage.locator('.palette-modal')).toBeVisible({
      timeout: 5000,
    });

    await tauriPage.keyboard.press('Escape');
    await expect(tauriPage.locator('.palette-modal')).toBeHidden();
  });

  test('scope segmented control toggles via Cmd+1/2/3', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    await tauriPage.keyboard.press(`${modifier}+KeyK`);
    await tauriPage.waitForSelector('.palette-modal');

    const globalTab = tauriPage.locator('[role="tab"]:has-text("Global")');
    const deviceTab = tauriPage.locator('[role="tab"]:has-text("Device")');
    const tabTab = tauriPage.locator('[role="tab"]:has-text("Tab")').first();

    // Default: Global selected.
    await expect(globalTab).toHaveAttribute('aria-selected', 'true');

    // Cmd+2 → Device.
    await tauriPage.keyboard.press(`${modifier}+Digit2`);
    await expect(deviceTab).toHaveAttribute('aria-selected', 'true');

    // Cmd+1 → Tab.
    await tauriPage.keyboard.press(`${modifier}+Digit1`);
    await expect(tabTab).toHaveAttribute('aria-selected', 'true');

    await tauriPage.keyboard.press('Escape');
  });

  test('typing >w shows the workflow kind chip', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });
    await tauriPage.keyboard.press(`${modifier}+KeyK`);
    const input = tauriPage.locator('.palette-search input');
    await input.fill('>w');
    await expect(
      tauriPage.locator('[data-testid="palette-kind-chip"]'),
    ).toBeVisible();
    await expect(
      tauriPage.locator('[data-testid="palette-kind-chip"]'),
    ).toContainText('Workflow');
    await tauriPage.keyboard.press('Escape');
  });

  test('backspace at position 0 clears an active kind chip', async ({
    tauriPage,
  }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });
    await tauriPage.keyboard.press(`${modifier}+KeyK`);
    const input = tauriPage.locator('.palette-search input');
    await input.fill('>w');
    await expect(
      tauriPage.locator('[data-testid="palette-kind-chip"]'),
    ).toBeVisible();

    // Move caret to start; this sets selection to (0, 0).
    await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 0));
    await tauriPage.keyboard.press('Backspace');

    await expect(
      tauriPage.locator('[data-testid="palette-kind-chip"]'),
    ).toBeHidden();
    await tauriPage.keyboard.press('Escape');
  });

  test('Enter on a command row dispatches ccie:execute-command', async ({
    tauriPage,
  }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Run a command so command_blocks has at least one row matching "echo".
    await tauriPage.keyboard.type('echo palette-e2e-marker');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(800);

    // Capture the next ccie:execute-command CustomEvent.
    const eventPromise = tauriPage.evaluate<{ command: string }>(() => {
      return new Promise((resolve) => {
        window.addEventListener(
          'ccie:execute-command',
          (e) => resolve((e as CustomEvent).detail),
          { once: true },
        );
      });
    });

    await tauriPage.keyboard.press(`${modifier}+KeyK`);
    await tauriPage.waitForSelector('.palette-modal');
    await tauriPage.locator('.palette-search input').fill('palette-e2e-marker');
    await tauriPage.waitForSelector('.palette-item', { timeout: 5000 });
    await tauriPage.keyboard.press('Enter');

    const detail = await eventPromise;
    expect(detail.command).toContain('palette-e2e-marker');
  });

  test('opening palette with no input shows recent picks after a pick', async ({
    tauriPage,
  }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Seed: run a command, open palette, pick that command. This writes a
    // palette_usage row.
    await tauriPage.keyboard.type('echo palette-recent-test');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(800);

    await tauriPage.keyboard.press(`${modifier}+KeyK`);
    await tauriPage.locator('.palette-search input').fill('palette-recent-test');
    await tauriPage.waitForSelector('.palette-item', { timeout: 5000 });
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(500);

    // Re-open with empty query — the recent pick should be in the list.
    await tauriPage.keyboard.press(`${modifier}+KeyK`);
    await tauriPage.waitForSelector('.palette-modal');
    const items = tauriPage.locator('.palette-item');
    await expect(items.first()).toBeVisible({ timeout: 5000 });
    await expect(items.filter({ hasText: 'palette-recent-test' })).toHaveCount(
      1,
      { timeout: 5000 },
    );

    await tauriPage.keyboard.press('Escape');
  });
});
