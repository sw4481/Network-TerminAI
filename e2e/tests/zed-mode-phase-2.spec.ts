import { expect, test } from "../fixtures";
import type { Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

async function openEditorSettings(page: Page) {
  const editorSettings = page.locator('[data-testid="editor-settings-tab"]');
  if (!(await editorSettings.isVisible().catch(() => false))) {
    if (
      !(await page
        .locator(".settings-tabs")
        .isVisible()
        .catch(() => false))
    ) {
      await page.locator(".tab-settings").click();
    }
    await page.locator(".settings-tabs button", { hasText: "Editor" }).click();
  }
  await expect(editorSettings).toBeVisible();
}

async function setEditorMode(page: Page, mode: "zed" | "monaco") {
  await openEditorSettings(page);
  const button = page.locator(`[data-testid="editor-mode-${mode}"]`);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.locator(".settings-header .close-btn").click();
}

test.describe("Zed Mode Phase 2 split workspace", () => {
  const fixtureName = `.ccie-zed-phase2-${process.pid}.txt`;
  const fixturePath = path.join(os.homedir(), fixtureName);

  test.beforeAll(() => {
    fs.writeFileSync(fixturePath, "Phase 2 focused-pane fixture\n", "utf8");
  });

  test.afterAll(() => {
    fs.rmSync(fixturePath, { force: true });
  });

  test("splits, shares a model, scopes file open, and restores the latent tree", async ({
    tauriPage,
  }) => {
    try {
      await tauriPage.waitForSelector(".tabbar", { timeout: 10_000 });
      await setEditorMode(tauriPage, "zed");

      await tauriPage.locator('[data-testid="tab-new-chooser"]').click();
      await tauriPage.locator('[data-testid="tab-new-editor"]').click();
      const editor = tauriPage.locator('[data-testid="editor-tab"]:visible');
      await expect(editor).toHaveAttribute("data-editor-mode", "zed");

      await editor.getByRole("button", { name: "Split pane right" }).click();
      await expect(editor.locator(".monaco-editor-wrapper")).toHaveCount(2);

      const panes = editor.locator('[data-testid^="editor-pane-pane-"]');
      await panes
        .nth(1)
        .getByRole("button", { name: "Split pane down" })
        .click();
      await expect(editor.locator(".monaco-editor-wrapper")).toHaveCount(3);

      const sharedText = `phase2-shared-${Date.now()}`;
      await editor.locator(".monaco-editor-wrapper").first().click();
      await tauriPage.keyboard.type(sharedText);
      await expect(
        editor.locator(".monaco-editor-wrapper").nth(1).locator(".view-lines"),
      ).toContainText(sharedText);

      // Focus the second pane and create/open a workspace file through the
      // shared explorer. Opening it must replace only that focused pane.
      await panes.nth(1).click();
      const fixture = editor.locator('[data-testid="file-node-file"]', {
        hasText: fixtureName,
      });
      await expect(fixture).toBeVisible();
      await fixture.click();
      await expect(panes.nth(1)).toContainText(fixtureName);
      await expect(panes.first()).not.toContainText(fixtureName);

      const firstPaneBefore = await panes.first().boundingBox();
      const horizontalHandle = editor
        .locator(".pane-handle-horizontal")
        .first();
      const handleBox = await horizontalHandle.boundingBox();
      expect(firstPaneBefore).not.toBeNull();
      expect(handleBox).not.toBeNull();
      await tauriPage.mouse.move(
        handleBox!.x + handleBox!.width / 2,
        handleBox!.y + handleBox!.height / 2,
      );
      await tauriPage.mouse.down();
      await tauriPage.mouse.move(
        handleBox!.x + handleBox!.width / 2 + 48,
        handleBox!.y + handleBox!.height / 2,
      );
      await tauriPage.mouse.up();
      const firstPaneAfter = await panes.first().boundingBox();
      expect(firstPaneAfter!.width).toBeGreaterThan(firstPaneBefore!.width);

      const close = panes.last().getByRole("button", { name: "Close pane" });
      await close.click();
      await expect(editor.locator(".monaco-editor-wrapper")).toHaveCount(2);

      await setEditorMode(tauriPage, "monaco");
      await expect(editor.locator(".monaco-editor-wrapper")).toHaveCount(1);
      await expect(
        editor.getByRole("button", { name: "Split pane right" }),
      ).toHaveCount(0);

      await setEditorMode(tauriPage, "zed");
      await expect(editor.locator(".monaco-editor-wrapper")).toHaveCount(2);
    } finally {
      await setEditorMode(tauriPage, "monaco");
    }
  });
});
