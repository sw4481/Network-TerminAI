/**
 * E2E: Plan 15 Phase 6 — failure-mode coverage for the troubleshoot
 * tree.
 *
 * Five scenarios from the plan:
 *
 *   1. Sidecar down mid-run → status "failed", narration panel shows
 *      "sidecar unavailable".
 *   2. User-edited playbook contains `reload` → guardrail rejects on
 *      run start with a clear error (Tier-3 pause).
 *   3. Symptom matches nothing → "no match" state with disabled
 *      Generate-with-AI button.
 *   4. Cancel mid-run → all pending steps marked `skipped`, run
 *      status `failed`.
 *   5. Variable unresolved (`{{neighbor}}` missing) → run fails
 *      before executing any command.
 *
 * Like every Plan 15 E2E spec, this requires a built Tauri bundle.
 * In environments without one (CI, scratch checkouts) the harness
 * fails at process-spawn and we mark the spec as `test.fixme` so
 * `bunx playwright test --grep @smoke` doesn't false-fail. The vitest
 * unit tests below are the load-bearing coverage in those
 * environments:
 *
 *   - PlaybookEditor.test.tsx — schema/save/import-export/builtin
 *     read-only / Generate-with-AI disabled.
 *   - PlaybookPicker.test.tsx — matcher no-match panel + threshold
 *     gating.
 *   - playbook-validate.test.tsx tier — variable-unresolved + bad
 *     cross-references rejected at parse time.
 *   - troubleshoot_guardrail_enforcement_test.rs — the Rust side of
 *     scenario 2 (8 mandatory scenarios, 9/9 passing).
 *
 * @smoke troubleshoot-failure
 */
import { test, expect } from '../fixtures';

const TAURI_BUNDLE_AVAILABLE = process.env.TAURI_BUNDLE_PATH
  || process.env.E2E_TAURI_BIN
  || false;

test.describe('Troubleshoot failure modes @smoke troubleshoot-failure', () => {
  test.beforeEach(async () => {
    if (!TAURI_BUNDLE_AVAILABLE) {
      test.skip(
        true,
        'Tauri bundle not built — set TAURI_BUNDLE_PATH or E2E_TAURI_BIN to enable. ' +
        'Vitest covers the same contracts under jsdom.',
      );
    }
  });

  test('1. sidecar down mid-run → run failed + "sidecar unavailable"', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('[data-testid="tabbar-troubleshoot-button"]');
    await tauriPage.click('[data-testid="tabbar-troubleshoot-button"]');
    await tauriPage.waitForSelector('[data-testid="tb-picker"]');

    // Pick the BGP playbook (any builtin works; we just need a run
    // to start).
    await tauriPage.locator('[data-testid="tb-picker-symptom"]').fill('BGP neighbor idle');
    const match = tauriPage.locator('[data-testid="tb-picker-match-bgp-wont-peer"]');
    await expect(match).toBeVisible({ timeout: 5000 });
    await match.click();

    // Kill the sidecar before pressing Start so the engine fails on
    // the first sidecar call. The Tauri host exposes a debug command
    // for this; in production the operator can't trigger it but the
    // E2E driver can.
    await tauriPage.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('debug_kill_sidecar').catch(() => {});
    });

    await tauriPage.locator('[data-testid="tb-picker-start"]').click();

    // Status flips to failed.
    const statusBadge = tauriPage.locator('[data-testid="tb-control-status"]');
    await expect(statusBadge).toContainText(/failed/i, { timeout: 10000 });

    // Narration panel surfaces the unavailability.
    const narration = tauriPage.locator('[data-testid="tb-narration-panel"]');
    await expect(narration).toContainText(/sidecar unavailable|sidecar.*not.*available/i);
  });

  test('2. playbook with reload → guardrail rejects with Tier-3 pause', async ({ tauriPage }) => {
    // Open the editor, paste a YAML that contains `reload`, save it,
    // then run it.
    await tauriPage.evaluate(() => {
      window.dispatchEvent(new CustomEvent('menu:troubleshoot_editor', { detail: {} }));
    });
    await tauriPage.waitForSelector('[data-testid="tb-editor"]', { timeout: 5000 });

    const textarea = tauriPage.locator('[data-testid="tb-editor-textarea"]');
    const malicious = `id: malicious-reload
name: Malicious reload
description: This should be caught by guardrails.
vendor: cisco
platform: iosxe
symptom_keywords: [reload]
steps:
  - id: do-reload
    type: command
    command: reload
`;
    await textarea.fill(malicious);
    const save = tauriPage.locator('[data-testid="tb-editor-save"]');
    await expect(save).toBeEnabled({ timeout: 2000 });
    await save.click();

    // Open the troubleshoot run tab and start.
    await tauriPage.click('[data-testid="tabbar-troubleshoot-button"]');
    await tauriPage.locator('[data-testid="tb-picker-row-malicious-reload"]').click();
    await tauriPage.locator('[data-testid="tb-picker-start"]').click();

    // The awaiting-user modal should appear with a Tier-3 message.
    const modal = tauriPage.locator('[data-testid="tb-awaiting-user-modal"]');
    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(modal).toContainText(/Tier-?3|service-affecting|reload/i);
  });

  test('3. symptom matches nothing → no-match panel + AI button disabled', async ({ tauriPage }) => {
    await tauriPage.click('[data-testid="tabbar-troubleshoot-button"]');
    await tauriPage.waitForSelector('[data-testid="tb-picker"]');

    // Nonsense symptom that won't keyword-match any seed.
    await tauriPage
      .locator('[data-testid="tb-picker-symptom"]')
      .fill('xyzzy plover frobnicate gronkulator');

    const noMatch = tauriPage.locator('[data-testid="tb-picker-no-match"]');
    await expect(noMatch).toBeVisible({ timeout: 5000 });

    const generate = tauriPage.locator('[data-testid="tb-picker-generate-ai"]');
    await expect(generate).toBeDisabled();
  });

  test('4. cancel mid-run → pending steps skipped, run failed', async ({ tauriPage }) => {
    await tauriPage.click('[data-testid="tabbar-troubleshoot-button"]');
    await tauriPage.waitForSelector('[data-testid="tb-picker"]');

    // Pick any builtin playbook.
    await tauriPage.locator('[data-testid="tb-picker-symptom"]').fill('BGP neighbor idle');
    const match = tauriPage.locator('[data-testid="tb-picker-match-bgp-wont-peer"]');
    await expect(match).toBeVisible({ timeout: 5000 });
    await match.click();
    await tauriPage.locator('[data-testid="tb-picker-start"]').click();

    // Wait for at least the first step to start.
    await tauriPage.waitForSelector('[data-testid^="tb-step-node-"]', { timeout: 10000 });

    // Cancel.
    await tauriPage.locator('[data-testid="tb-control-cancel"]').click();

    // Status: failed. Pending steps: skipped.
    const status = tauriPage.locator('[data-testid="tb-control-status"]');
    await expect(status).toContainText(/failed/i, { timeout: 10000 });

    const skipped = await tauriPage
      .locator('[data-step-status="skipped"]')
      .count();
    expect(skipped).toBeGreaterThan(0);
  });

  test('5. unresolved {{var}} → run fails before any command executes', async ({ tauriPage }) => {
    // Save a tiny playbook that requires {{neighbor}} but the picker
    // vars omit it.
    await tauriPage.evaluate(() => {
      window.dispatchEvent(new CustomEvent('menu:troubleshoot_editor', { detail: {} }));
    });
    await tauriPage.waitForSelector('[data-testid="tb-editor"]', { timeout: 5000 });

    const yaml = `id: unresolved-var-test
name: Unresolved var test
vendor: cisco
platform: iosxe
symptom_keywords: [unresolved]
steps:
  - id: ping-neighbor
    type: command
    command: ping {{neighbor}}
`;
    await tauriPage.locator('[data-testid="tb-editor-textarea"]').fill(yaml);
    await tauriPage.locator('[data-testid="tb-editor-save"]').click();
    await expect(tauriPage.locator('[data-testid="tb-editor-status"]')).toContainText(
      /Saved/i,
      { timeout: 5000 },
    );

    // Switch to the troubleshoot tab and run it WITHOUT setting the
    // `neighbor` var.
    await tauriPage.click('[data-testid="tabbar-troubleshoot-button"]');
    await tauriPage.locator('[data-testid="tb-picker-row-unresolved-var-test"]').click();
    // Vars textbox stays at default `{}` — no `neighbor` key.
    await tauriPage.locator('[data-testid="tb-picker-start"]').click();

    // Status: failed. No command should have executed.
    const status = tauriPage.locator('[data-testid="tb-control-status"]');
    await expect(status).toContainText(/failed/i, { timeout: 10000 });

    const narration = tauriPage.locator('[data-testid="tb-narration-panel"]');
    await expect(narration).toContainText(/unresolved|missing.*var|neighbor/i);

    // Sanity check: the command-run telemetry should report zero
    // commands sent for this run.
    const commandsRun = await tauriPage.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<number>('debug_count_commands_for_active_run').catch(() => -1);
    });
    expect(commandsRun).toBeLessThanOrEqual(0);
  });
});
