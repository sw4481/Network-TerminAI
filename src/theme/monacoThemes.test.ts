import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { createDefaultAppearanceSettings } from "./defaults";
import {
  CLASSIC_MONACO_THEME_ID,
  MATRIX_MONACO_THEME_ID,
  MONACO_THEMES,
  SLATE_GREY_MONACO_THEME_ID,
  ZED_ONE_DARK_THEME_ID,
  applyMonacoTheme,
  resolveMonacoTheme,
} from "./monacoThemes";

describe("Monaco appearance themes", () => {
  it.each([
    ["terminai-dark", "follow-app", "monaco", CLASSIC_MONACO_THEME_ID],
    ["terminai-dark", "follow-app", "zed", ZED_ONE_DARK_THEME_ID],
    ["slate-grey", "follow-app", "monaco", SLATE_GREY_MONACO_THEME_ID],
    ["slate-grey", "follow-app", "zed", SLATE_GREY_MONACO_THEME_ID],
    ["matrix", "follow-app", "monaco", MATRIX_MONACO_THEME_ID],
    ["matrix", "follow-app", "zed", MATRIX_MONACO_THEME_ID],
    ["matrix", "classic-dark", "zed", CLASSIC_MONACO_THEME_ID],
    ["slate-grey", "zed-one-dark", "monaco", ZED_ONE_DARK_THEME_ID],
    ["terminai-dark", "slate-grey", "zed", SLATE_GREY_MONACO_THEME_ID],
    ["terminai-dark", "matrix", "monaco", MATRIX_MONACO_THEME_ID],
  ] as const)(
    "resolves %s application + %s override in %s mode to %s",
    (appTheme, editorTheme, mode, expected) => {
      const settings = createDefaultAppearanceSettings();
      settings.appTheme = appTheme;
      settings.editorTheme = editorTheme;
      expect(resolveMonacoTheme(settings, mode)).toBe(expected);
    },
  );

  it("defines Grey and Matrix with semantic editor, terminal, Git, and debugger colors", () => {
    for (const id of [SLATE_GREY_MONACO_THEME_ID, MATRIX_MONACO_THEME_ID]) {
      const theme = MONACO_THEMES[id];
      expect(theme.rules.length).toBeGreaterThan(4);
      expect(theme.colors).toMatchObject({
        "editor.background": expect.any(String),
        "editor.foreground": expect.any(String),
        "editorGutter.background": expect.any(String),
        "editor.selectionBackground": expect.any(String),
        "editorWidget.background": expect.any(String),
        "editorError.foreground": expect.any(String),
        "editorWarning.foreground": expect.any(String),
        "gitDecoration.addedResourceForeground": expect.any(String),
        "gitDecoration.modifiedResourceForeground": expect.any(String),
        "gitDecoration.deletedResourceForeground": expect.any(String),
        "debugIcon.startForeground": expect.any(String),
        "debugIcon.stopForeground": expect.any(String),
        "terminal.background": expect.any(String),
        "terminal.border": expect.any(String),
      });
    }
  });

  it("updates the global Monaco theme in place without editor/model lifecycle calls", () => {
    const defineTheme = vi.fn();
    const setTheme = vi.fn();
    const create = vi.fn();
    const dispose = vi.fn();
    const monaco = {
      editor: { defineTheme, setTheme, create, dispose },
    } as unknown as typeof Monaco;

    applyMonacoTheme(monaco, SLATE_GREY_MONACO_THEME_ID);
    applyMonacoTheme(monaco, MATRIX_MONACO_THEME_ID);

    expect(defineTheme).toHaveBeenCalledWith(
      SLATE_GREY_MONACO_THEME_ID,
      MONACO_THEMES[SLATE_GREY_MONACO_THEME_ID],
    );
    expect(setTheme).toHaveBeenLastCalledWith(MATRIX_MONACO_THEME_ID);
    expect(create).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });
});
