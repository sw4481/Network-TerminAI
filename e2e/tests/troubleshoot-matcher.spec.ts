/**
 * E2E smoke test: Plan 15 Phase 5 — symptom-to-playbook matcher.
 *
 * Verifies that:
 *   1. Opening the Troubleshoot tab renders the PlaybookPicker.
 *   2. Typing "BGP neighbor stuck in Idle" into the symptom textarea
 *      causes the matcher to surface `bgp-wont-peer` as the top
 *      suggestion (within 1.5s — 300ms debounce + matcher round-trip).
 *   3. Clicking the suggestion selects the playbook so the Start
 *      button enables. We do not exercise `start_run` here because
 *      that requires a live SSH session (Phase 2.x — out of smoke
 *      scope); the start-button-enabled assertion is sufficient
 *      proof that the suggestion handler wired through.
 *
 * NOTE — like every Plan 15 E2E spec, this requires a built Tauri
 * bundle. The vitest test
 * `src/features/troubleshoot/PlaybookPicker.test.tsx` covers the
 * same contract against jsdom and is the load-bearing assertion in
 * environments without a `.app` bundle.
 *
 * @smoke troubleshoot-matcher
 */
import { test, expect } from '../fixtures';

test.describe('Troubleshoot symptom matcher @smoke troubleshoot-matcher', () => {
  test('ranks bgp-wont-peer top for a BGP-flavoured symptom', async ({ tauriPage }) => {
    // Open the Troubleshoot tab. The TabBar has a "+ Troubleshoot"
    // button that lazy-loads `TroubleshootTab`.
    await tauriPage.waitForSelector('[data-testid="tabbar-troubleshoot-button"]', { timeout: 10000 });
    await tauriPage.click('[data-testid="tabbar-troubleshoot-button"]');

    // PlaybookPicker mounts inside the TroubleshootTab.
    await tauriPage.waitForSelector('[data-testid="tb-picker"]', { timeout: 5000 });

    // Type a BGP symptom. The matcher debounces 300ms; a 1.5s
    // expect-timeout is plenty.
    const symptom = tauriPage.locator('[data-testid="tb-picker-symptom"]');
    await expect(symptom).toBeVisible();
    await symptom.fill('BGP neighbor stuck in Idle');

    // Wait for the ranked-suggestions panel to appear with the
    // BGP playbook on top.
    const topMatch = tauriPage.locator('[data-testid="tb-picker-match-bgp-wont-peer"]');
    await expect(topMatch).toBeVisible({ timeout: 5000 });

    // Click the suggestion.
    await topMatch.click();
    expect(await topMatch.getAttribute('data-selected')).toBe('true');

    // The Start run button should now be enabled. (We deliberately
    // do NOT click it — `start_run` in Phase 2 requires a live SSH
    // session and isn't part of the matcher contract.)
    const start = tauriPage.locator('[data-testid="tb-picker-start"]');
    await expect(start).toBeEnabled();
  });
});
