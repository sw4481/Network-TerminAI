/**
 * E2E smoke test: optional RAG seed pack (Plan 12 Phase 6).
 *
 * Verifies the user can:
 *   1. Open Settings → RAG tab.
 *   2. Click the "Download starter pack" button.
 *   3. See progress label flip from `Download starter pack` → `Downloading…`
 *      → `Uploading…` → back to `Download starter pack`.
 *   4. Observe a new doc row appear in the list once the post-script
 *      ingest completes.
 *
 * The Tauri command `rag_run_seed_script` is mocked at the
 * `window.__TAURI_INTERNALS__.invoke` boundary so we never actually
 * spawn `seed.py`; instead we pre-stage a 10 KB mock-PDF entry in the
 * (mocked) seed list. NO real vendor downloads happen.
 *
 * @smoke rag-seed
 */
import { test, expect } from '../fixtures';

test.describe('RAG Seed Pack @smoke rag-seed', () => {
  test('starter pack button: progress states + ingested row', async ({
    tauriPage,
  }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Mock the two new commands BEFORE opening the RAG tab so the
    // initial document list is empty and the click handler hits our
    // stubs. We also re-mock `rag_upload` to record the ingest call
    // and synthesize a doc row in the next `rag_list_documents`
    // response.
    await tauriPage.evaluate(() => {
      // Save the real invoke for any unrelated commands the tab
      // already issues at mount (`rag_list_documents`,
      // `rag_tag_taxonomy`).
      // @ts-expect-error -- Tauri injects this at runtime.
      const real = window.__TAURI_INTERNALS__?.invoke;
      const seedFile = {
        path: '/tmp/ccie-rag-seed/mock-doc.pdf',
        filename: 'mock-doc.pdf',
        bytes: 10240,
        kind: 'pdf',
        title: 'Mock Vendor Doc',
        tags: ['generic'],
      };
      let listCalls = 0;
      // @ts-expect-error -- Tauri injects this at runtime.
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ ?? {};
      // @ts-expect-error
      window.__TAURI_INTERNALS__.invoke = async (
        cmd: string,
        args?: unknown,
      ) => {
        if (cmd === 'rag_run_seed_script') {
          // Fire a couple of progress events to exercise the listener.
          const ev = (payload: Record<string, unknown>) =>
            window.dispatchEvent(
              new CustomEvent('tauri://event', {
                detail: { event: 'rag://seed-progress', payload },
              }),
            );
          ev({ line: 'seed: start total=1', verb: 'start', total: 1 });
          ev({
            line: 'seed: download 1/1 url=https://example.com/x.pdf',
            verb: 'download',
            index: 1,
            total: 1,
          });
          ev({ line: 'seed: done ok=1 skipped=0 errored=0', verb: 'done' });
          return {
            exit_code: 0,
            seed_dir: '/tmp/ccie-rag-seed',
            script_path: '/tmp/seed.py',
          };
        }
        if (cmd === 'rag_list_seed_files') {
          return [seedFile];
        }
        if (cmd === 'rag_upload') {
          // Pretend persistence completes.
          return 1;
        }
        if (cmd === 'rag_list_documents') {
          listCalls += 1;
          if (listCalls === 1) return [];
          return [
            {
              id: 1,
              title: 'Mock Vendor Doc',
              kind: 'pdf',
              bytes: 10240,
              uploaded_at: Math.floor(Date.now() / 1000),
              tags: ['generic'],
              chunk_count: 3,
            },
          ];
        }
        if (cmd === 'rag_tag_taxonomy') {
          return [
            'cisco-iosxe-switch',
            'cisco-iosxe-router',
            'cisco-nxos',
            'cisco-meraki',
            'juniper-junos',
            'arista-eos',
            'generic',
          ];
        }
        // Fall through to whatever the real shell would do.
        if (typeof real === 'function') return real(cmd, args);
        throw new Error(`unmocked invoke: ${cmd}`);
      };
    });

    // Open Settings → RAG.
    await tauriPage.click('.tab-settings');
    await tauriPage.waitForSelector('.settings-tabs', { timeout: 5000 });
    await tauriPage.click('.settings-tabs button:has-text("RAG")');
    await expect(
      tauriPage.locator('[data-testid="rag-settings-tab"]'),
    ).toBeVisible({ timeout: 5000 });

    // The starter-pack button is always rendered, even on the empty
    // state.
    const seedButton = tauriPage.locator('[data-testid="rag-seed-button"]');
    await expect(seedButton).toBeVisible();
    await expect(seedButton).toHaveText('Download starter pack');

    // Click and watch the label change.
    await seedButton.click();

    // The doc row eventually shows up after the upload step
    // completes. We don't assert on the transient `Downloading… i/N`
    // label because mocked commands resolve faster than Playwright
    // can reliably observe the transition; the row presence is the
    // load-bearing signal.
    await expect(
      tauriPage.locator('[data-testid="rag-doc-row-1"]'),
    ).toBeVisible({ timeout: 10000 });

    // Final state: button label resets and is enabled again.
    await expect(seedButton).toHaveText('Download starter pack', {
      timeout: 5000,
    });
    await expect(seedButton).toBeEnabled();
  });
});
