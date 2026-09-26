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
  const expected = {
    "follow-app": {
      "terminai-dark": { monaco: CLASSIC_MONACO_THEME_ID, zed: ZED_ONE_DARK_THEME_ID },
      "slate-grey": { monaco: SLATE_GREY_MONACO_THEME_ID, zed: SLATE_GREY_MONACO_THEME_ID },
      matrix: { monaco: MATRIX_MONACO_THEME_ID, zed: MATRIX_MONACO_THEME_ID },
    },
    "classic-dark": { monaco: CLASSIC_MONACO_THEME_ID, zed: CLASSIC_MONACO_THEME_ID },
    "zed-one-dark": { monaco: ZED_ONE_DARK_THEME_ID, zed: ZED_ONE_DARK_THEME_ID },
    "slate-grey": { monaco: SLATE_GREY_MONACO_THEME_ID, zed: SLATE_GREY_MONACO_THEME_ID },
    matrix: { monaco: MATRIX_MONACO_THEME_ID, zed: MATRIX_MONACO_THEME_ID },
  } as const;
  const completeMatrix = (["terminai-dark", "slate-grey", "matrix"] as const).flatMap((appTheme) =>
    (["follow-app", "classic-dark", "zed-one-dark", "slate-grey", "matrix"] as const).flatMap((editorTheme) =>
      (["monaco", "zed"] as const).map((mode) => {
        const resolved = editorTheme === "follow-app"
          ? expected[editorTheme][appTheme][mode]
          : expected[editorTheme][mode];
        return [appTheme, editorTheme, mode, resolved] as const;
      }),
    ),
  );

  it.each(completeMatrix)(
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
