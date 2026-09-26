/**
 * E2E smoke test: AgentPanel sources flow (Plan 12 Phase 5).
 *
 * Authors the end-to-end happy path:
 *   1. Open Settings → RAG tab and upload a tiny tagged doc.
 *   2. Open the AgentPanel.
 *   3. Send a question that should match the seeded doc.
 *   4. Assert the Sources badge appears below the assistant message.
 *   5. Click the badge → drawer opens.
 *   6. Assert chunk text is visible in the drawer.
 *
 * Like `rag-upload.spec.ts`, this lives in the controller's
 * pre-existing infra-blocked smoke list — a real RAG retrieval needs
 * the sidecar's ONNX embedder running. The spec is authored so that
 * once the controller can run Tauri + sidecar in CI, the assertions
 * fire without further authoring work.
 *
 * @smoke rag-agent
 */
import path from 'path';
import { test, expect } from '../fixtures';

test.describe('AgentPanel sources flow @smoke rag-agent', () => {
  test('upload doc, ask question, see sources badge + drawer', async ({
    tauriPage,
  }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // 1. Seed the RAG store with a tagged doc through the Settings → RAG tab.
    await tauriPage.click('.tab-settings');
    await tauriPage.waitForSelector('.settings-tabs', { timeout: 5000 });
    await tauriPage.click('.settings-tabs button:has-text("RAG")');
    await expect(
      tauriPage.locator('[data-testid="rag-settings-tab"]'),
    ).toBeVisible({ timeout: 5000 });

    const fixturePath = path.resolve(
      __dirname,
      '..',
      'fixtures',
      'rag',
      'tiny.md',
    );

    const dropzone = tauriPage.locator('[data-testid="rag-dropzone"]');
    const dataTransfer = await tauriPage.evaluateHandle(
      (file) => {
        const dt = new DataTransfer();
        const f = new File(
          ['# BGP\n\nNeighbor 10.0.0.1 is in Established state.\n'],
          file.name,
          { type: 'text/markdown' },
        );
        dt.items.add(f);
        return dt;
      },
      { name: 'tiny.md' },
    );
    await dropzone.dispatchEvent('drop', { dataTransfer });

    await tauriPage.waitForSelector('[data-testid="rag-modal-submit"]', {
      timeout: 5000,
    });
    // Tag with cisco-iosxe-router so a Cisco-tagged tab will retrieve it.
    await tauriPage
      .locator('button.rag-modal-tag', { hasText: 'cisco-iosxe-router' })
      .click();
    await tauriPage.click('[data-testid="rag-modal-submit"]');

    // Wait for the doc row to appear so we know the upload landed.
    await expect(
      tauriPage.locator('[data-testid="rag-doc-list"]'),
    ).toBeVisible({ timeout: 10000 });

    // 2. Close Settings, open the AgentPanel.
    // The agent panel toggle lives in the main shell — most builds
    // open it by default, but ensure it's visible.
    await tauriPage.keyboard.press('Escape');
    const agentPanel = tauriPage.locator('.agent-panel');
    await agentPanel.waitFor({ state: 'visible', timeout: 5000 });

    // 3. Type a question that should retrieve the seeded chunk.
    const input = agentPanel.locator('textarea, input[type="text"]').first();
    await input.fill('Show me the BGP neighbor status');
    const sendButton = agentPanel
      .locator('button:has-text("Send"), button[title="Send"]')
      .first();
    await sendButton.click();

    // 4. Assert the Sources badge appears under the assistant message.
    //    Generous timeout — the embed call hits ONNX which can be
    //    slow on first invocation.
    const badge = tauriPage.locator('[data-testid="agent-sources-badge"]');
    await expect(badge.first()).toBeVisible({ timeout: 30000 });
    await expect(badge.first()).toContainText(/Sources · \d+ doc/);

    // 5. Click the badge → drawer opens.
    await badge.first().click();
    const drawer = tauriPage.locator('[data-testid="agent-sources-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // 6. Assert at least one chunk card with visible text.
    const card = tauriPage.locator('[data-testid="agent-source-card"]').first();
    await expect(card).toBeVisible();
    // The seeded text mentions BGP / Established — match either.
    await expect(card).toContainText(/BGP|Established|10\.0\.0\.1/);

    void fixturePath; // path constructed for documentation; bytes flow
    // through the synthesized File above.
  });
});
