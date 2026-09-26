import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

async function openEditorSettings(tauriPage: Page) {
  const editorSettings = tauriPage.locator(
    '[data-testid="editor-settings-tab"]',
  );

  if (!(await editorSettings.isVisible().catch(() => false))) {
    const settingsTabs = tauriPage.locator(".settings-tabs");
    if (!(await settingsTabs.isVisible().catch(() => false))) {
      await tauriPage.locator(".tab-settings").click();
    }
    await tauriPage
      .locator(".settings-tabs button", { hasText: "Editor" })
      .click();
  }

  await expect(editorSettings).toBeVisible();
}

async function attemptCleanupStep(
  errors: unknown[],
  step: () => Promise<void>,
) {
  try {
    await step();
  } catch (error) {
    errors.push(error);
  }
}

async function restoreClassicMode(tauriPage: Page) {
  const errors: unknown[] = [];
  const classicMode = tauriPage.locator('[data-testid="editor-mode-monaco"]');
  const closeSettings = tauriPage.locator(
    ".settings-window > .settings-header > .close-btn",
  );

  await attemptCleanupStep(errors, () => openEditorSettings(tauriPage));
  await attemptCleanupStep(errors, () => expect(classicMode).toBeEnabled());
  await attemptCleanupStep(errors, () => classicMode.click());
  await attemptCleanupStep(errors, () =>
    expect(classicMode).toHaveAttribute("aria-pressed", "true"),
  );
  await attemptCleanupStep(errors, () =>
    expect(tauriPage.locator("body")).not.toHaveClass(/zed-mode/),
  );
  await attemptCleanupStep(errors, async () => {
    if (await closeSettings.isVisible()) {
      await closeSettings.click();
    }
  });

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Classic-mode restoration failed in ${errors.length} steps`,
    );
  }
}

test.describe("Zed Mode foundation", () => {
  test("applies Zed Mode live and cleanly returns to classic Monaco", async ({
    tauriPage,
  }) => {
    let primaryFailed = false;
    let primaryError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;

    try {
      await tauriPage.waitForSelector(".tabbar", { timeout: 10_000 });

      await openEditorSettings(tauriPage);
      await tauriPage.locator('[data-testid="editor-mode-zed"]').click();
      await expect(tauriPage.locator("body")).toHaveClass(/zed-mode/);

      const vim = tauriPage.getByRole("checkbox", { name: "Vim mode" });
      await expect(vim).toBeEnabled();
      await vim.check();
      await tauriPage.locator(".settings-header .close-btn").click();

      await tauriPage.locator('[data-testid="tab-new-chooser"]').click();
      await tauriPage.locator('[data-testid="tab-new-editor"]').click();

      const editorTab = tauriPage.locator('[data-testid="editor-tab"]:visible');
      await expect(editorTab).toHaveCount(1);
      const monaco = editorTab.locator(".monaco-editor-wrapper");
      await expect(editorTab).toHaveAttribute("data-editor-mode", "zed");
      await expect(monaco).toHaveAttribute(
        "data-editor-theme",
        "ccie-zed-one-dark",
      );
      await expect(monaco).toHaveAttribute("data-vim-enabled", "true");

      await openEditorSettings(tauriPage);
      const classicMode = tauriPage.locator(
        '[data-testid="editor-mode-monaco"]',
      );
      await classicMode.click();
      await expect(classicMode).toHaveAttribute("aria-pressed", "true");
      await expect(tauriPage.locator("body")).not.toHaveClass(/zed-mode/);
      await tauriPage.locator(".settings-header .close-btn").click();

      await expect(editorTab).toHaveAttribute("data-editor-mode", "monaco");
      await expect(monaco).toHaveAttribute("data-editor-theme", "vs-dark");
      await expect(monaco).toHaveAttribute("data-vim-enabled", "false");
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    } finally {
      try {
        await restoreClassicMode(tauriPage);
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }

    if (primaryFailed && cleanupFailed) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Zed Mode acceptance failed and classic-mode restoration also failed",
      );
    }
    if (primaryFailed) {
      throw primaryError;
    }
    if (cleanupFailed) {
      throw cleanupError;
    }
  });
});
