/**
 * E2E Test: Parsing Sidecar Failure Modes (Plan 00 / Task 4.2)
 *
 * Exercises the three failure scenarios for the parsing sidecar pipeline
 * delivered by Plan 00 Phases 1-3:
 *
 *   1. Sidecar killed mid-session — chip flips to "down", parseShow surfaces
 *      a user-readable error (no panic, no hang), supervisor auto-respawns
 *      on the next call.
 *   2. NoParserError from dispatcher — vendor/platform with no registered
 *      parser → response error contains "no parser"; UI displays the raw
 *      output with a "no parser available" banner. Wire-level coverage lives
 *      in `sidecar/tests/test_parse_ndjson.py::test_parse_request_unsupported_returns_error`;
 *      this spec covers the UI path.
 *   3. Sidecar slow (>5s response) — UI must stay responsive (spinner /
 *      loading state) and either resolve or time out gracefully.
 *
 * NOTE: These tests are SKIPPED for the same reason as `command-blocks.spec.ts`:
 * the current `e2e/tauri-driver.ts` exposes a *mock* page object, not a real
 * WebDriver session. Tauri webviews are not Chromium and Playwright cannot
 * drive them without the full `tauri-driver` integration, which is not yet
 * configured here.
 *
 * To enable these tests:
 *   1. Install tauri-driver:  cargo install tauri-driver
 *   2. Replace the mock in `e2e/tauri-driver.ts` with a real WebDriver client.
 *   3. Configure Playwright to connect via WebDriver protocol.
 *   4. Remove `test.describe.skip(...)` below.
 *
 * Until then, see `e2e/tests/SIDECAR_FAILURE_MANUAL_TEST.md` for the manual
 * checklist that exercises the same scenarios at `bun run tauri dev`.
 *
 * Selector contract assumed by this spec (verified against current `src/components/`):
 *   - SidecarStatusChip renders `div.status-pill.running` / `div.status-pill.stopped`
 *     containing `<span class="status-label">Sidecar: vX.Y.Z|down</span>`.
 *   - There is NO `data-testid` on the chip today. The spec falls back to
 *     `.status-pill` filtered by inner text "Sidecar:". Recommend adding
 *     `data-testid="sidecar-status-chip"` when the test driver lands so the
 *     selector is robust against neighboring chips (e.g. FTP).
 */
import { test, expect } from '../fixtures';

// ---------------------------------------------------------------------------
// Helpers (factored out so the manual-test checklist can reuse the same
// selectors when this is eventually wired up to a real WebDriver).
// ---------------------------------------------------------------------------

/**
 * Locate the sidecar status chip. Prefer `data-testid` if/when the component
 * is updated; fall back to the .status-pill that contains the "Sidecar:" label.
 */
function sidecarChip(page: import('@playwright/test').Page) {
  return page
    .locator('[data-testid="sidecar-status-chip"], .status-pill:has(.status-label:text-matches("^Sidecar:"))')
    .first();
}

/**
 * Invoke `parse_show` from the renderer via the Tauri IPC bridge. Mirrors
 * `src/lib/parsers.ts::parseShow`.
 */
async function invokeParseShow(
  page: import('@playwright/test').Page,
  args: { vendor: string; platform: string; command: string; raw: string },
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return page.evaluate(async (a) => {
    try {
      // @ts-expect-error — __TAURI__ is injected by the runtime, not typed in browser DOM.
      const value = await window.__TAURI__.core.invoke('parse_show', { args: a });
      return { ok: true, value } as const;
    } catch (e) {
      return { ok: false, error: String(e) } as const;
    }
  }, args);
}

// ---------------------------------------------------------------------------
// Tests — all skipped until a real WebDriver is in place. See file header.
// ---------------------------------------------------------------------------

test.describe.skip('Parsing sidecar failure modes', () => {
  test('chip flips to down when sidecar is killed; supervisor respawns on next call', async ({
    tauriPage,
  }) => {
    // Pre-condition: app is up and the chip is reporting a healthy version.
    const chip = sidecarChip(tauriPage);
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(chip).toHaveClass(/running/);
    await expect(chip.locator('.status-label')).toHaveText(/Sidecar: v\d+\.\d+\.\d+/);

    // Action: kill the bundled python process externally. The supervisor
    // (src-tauri/src/agent_bridge — Phase 1) is responsible for noticing the
    // death and spawning a new sidecar on the next request.
    //
    // Using `pkill -f ccie_sidecar` matches the bundled module path
    // (sidecar/src/ccie_sidecar). On dev runs the process name varies, so
    // this also matches "python -m ccie_sidecar".
    const { spawnSync } = await import('child_process');
    spawnSync('pkill', ['-f', 'ccie_sidecar']);

    // Expectation 1: within ~90s the chip flips to "down". The chip polls
    // every 10s (see SidecarStatusChip.tsx) and the heartbeat row goes stale
    // after ~30s, so 90s is comfortable headroom.
    await expect(chip).toHaveClass(/stopped/, { timeout: 90_000 });
    await expect(chip.locator('.status-label')).toHaveText(/Sidecar: down/);

    // Expectation 2: a parseShow call right now must surface a user-readable
    // error string — NOT panic, NOT hang. We assert it returns within the
    // Playwright expect timeout (10s) with an Error-shaped rejection.
    const downResp = await invokeParseShow(tauriPage, {
      vendor: 'cisco',
      platform: 'iosxe',
      command: 'show version',
      raw: 'Cisco IOS XE Software, Version 17.9.1',
    });
    expect(downResp.ok).toBe(false);
    if (!downResp.ok) {
      // The Rust side wraps sidecar errors as
      //   "sidecar parse.request error: <msg>"
      // (see src-tauri/src/parsers/bridge.rs). Either that prefix or a
      // transport error like "agent bridge" is acceptable here — we just
      // care that the user gets a string, not a panic.
      expect(downResp.error.length).toBeGreaterThan(0);
      expect(downResp.error.toLowerCase()).not.toContain('panic');
    }

    // Expectation 3: supervisor auto-respawns on next call. We retry with a
    // small backoff to give the bridge time to relaunch python; the call
    // should eventually succeed AND the chip should flip back to running.
    let success = false;
    for (let i = 0; i < 6 && !success; i++) {
      await tauriPage.waitForTimeout(2_000);
      const r = await invokeParseShow(tauriPage, {
        vendor: 'cisco',
        platform: 'iosxe',
        command: 'show version',
        raw: 'Cisco IOS XE Software, Version 17.9.1',
      });
      success = r.ok;
    }
    expect(success).toBe(true);
    await expect(chip).toHaveClass(/running/, { timeout: 30_000 });
  });

  test('parseShow with unknown vendor surfaces "no parser" to the UI', async ({
    tauriPage,
  }) => {
    // Pre-condition: chip is healthy.
    const chip = sidecarChip(tauriPage);
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(chip).toHaveClass(/running/);

    // Action: vendor/platform that are guaranteed to miss the dispatcher's
    // registry. Mirrors test_parse_request_unsupported_returns_error.
    const resp = await invokeParseShow(tauriPage, {
      vendor: 'vendor_unknown',
      platform: 'os_unknown',
      command: 'show foo',
      raw: 'irrelevant raw output',
    });

    // Expectation: error response, message contains "no parser" (case-
    // insensitive), and the error is short enough to render in a banner.
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.toLowerCase()).toContain('no parser');
      // Sanity-check it's not a stack dump.
      expect(resp.error.split('\n').length).toBeLessThan(5);
    }

    // The chip itself should remain healthy — a NoParserError is a normal
    // dispatcher response, not a sidecar fault.
    await expect(chip).toHaveClass(/running/);
  });

  test('slow sidecar (>5s) keeps UI responsive and resolves gracefully', async ({
    tauriPage,
  }) => {
    // LIMITATION (2026-05-14): there is no debug-delay injection point in
    // the production sidecar today. The cleanest way to exercise this path
    // is to add a one-liner `time.sleep(6)` to
    //   sidecar/src/ccie_sidecar/server.py::handle_parse_request
    // in a dev build, then run the manual checklist (see
    // SIDECAR_FAILURE_MANUAL_TEST.md). When this spec is enabled with a real
    // WebDriver, replace the body below with:
    //   1. Inject the delay (e.g. via a hidden `__test_set_parse_delay` IPC
    //      command added behind a `#[cfg(debug_assertions)]` flag), OR
    //   2. Spin up a stub sidecar binary that always sleeps 6s.
    //
    // For now the body documents the *intended* assertions so a future
    // engineer can drop the injection point in and uncomment.

    const chip = sidecarChip(tauriPage);
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(chip).toHaveClass(/running/);

    // INTENDED: kick off a parse that is known to take >5s.
    const slowCall = invokeParseShow(tauriPage, {
      vendor: 'cisco',
      platform: 'iosxe',
      command: 'show version',
      raw: 'Cisco IOS XE Software, Version 17.9.1',
    });

    // INTENDED: while the call is in flight, a loading indicator must be
    // visible somewhere in the parsed-output surface. The `useParsedOutput`
    // hook (src/hooks/useParsedOutput.ts) sets `loading: true` while the
    // promise is pending; the consuming component is expected to render a
    // spinner with class `.parse-loading` (or similar). Pin this selector
    // when the consumer lands — for now we just verify the UI thread is
    // alive by clicking around.
    //
    // Sanity check that the renderer is not blocked: we should still be able
    // to interact with chrome (e.g. focus the chip).
    await chip.hover({ trial: true });

    // INTENDED: the call eventually resolves OR times out gracefully. Either
    // a successful response or a string error is acceptable — what we are
    // ruling out is a hung promise.
    const result = await Promise.race([
      slowCall.then((r) => ({ kind: 'resolved' as const, r })),
      tauriPage.waitForTimeout(15_000).then(() => ({ kind: 'hung' as const })),
    ]);
    expect(result.kind).toBe('resolved');
  });
});
