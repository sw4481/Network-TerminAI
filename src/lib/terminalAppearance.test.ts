import { describe, expect, it } from "vitest";
import { createDefaultAppearanceSettings } from "../theme/defaults";
import { APP_THEME_PRESETS } from "../theme/presets";
import { applyTerminalOptions, createTerminalOptions, terminalSettingsForPreset } from "./terminalAppearance";
import { Terminal as Xterm55Terminal } from "./xterm55OptionsFixture";

describe("xterm 5.5 appearance adapter", () => {
  it("keeps the exact legacy Dark defaults in the single xterm option source", () => {
    const options = createTerminalOptions(createDefaultAppearanceSettings());

    expect(options).toMatchObject({
      convertEol: true,
      scrollback: 32000,
      fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
      fontSize: 13,
      fontWeight: 400,
      lineHeight: 1,
      cursorStyle: "block",
      cursorBlink: true,
      rightClickSelectsWord: false,
      allowProposedApi: true,
      theme: {
        background: "#0F1114",
        foreground: "#E6E1CF",
        cursor: "#5CCFE6",
        cursorAccent: "#000000",
        selectionBackground: "#FFFFFF4D",
        black: "#2E3436",
        brightWhite: "#EEEEEC",
      },
    });
  });

  it("resolves follow-app and named terminal presets from the approved contract", () => {
    const settings = createDefaultAppearanceSettings();
    settings.appTheme = "matrix";

    expect(terminalSettingsForPreset(settings)).toMatchObject({
      preset: "matrix",
      background: APP_THEME_PRESETS[2].terminal.background,
    });

    settings.terminal = { ...settings.terminal, preset: "slate-grey" };
    expect(terminalSettingsForPreset(settings)).toMatchObject({
      preset: "slate-grey",
      foreground: APP_THEME_PRESETS[1].terminal.foreground,
    });
  });

  it("preserves custom terminal values instead of replacing them with the app preset", () => {
    const settings = createDefaultAppearanceSettings();
    settings.appTheme = "matrix";
    settings.terminal = {
      ...settings.terminal,
      preset: "custom",
      fontSize: 19,
      foreground: "#ABCDEF",
    };

    expect(terminalSettingsForPreset(settings)).toMatchObject({
      preset: "custom",
      fontSize: 19,
      foreground: "#ABCDEF",
    });
  });

  it("executes the pinned 5.5 public option setter for every mutable adapter key", () => {
    const terminal = new Xterm55Terminal({ cols: 80, rows: 24, theme: { background: "#000000" } });
    const firstTheme = terminal.options.theme;
    const options = createTerminalOptions(createDefaultAppearanceSettings());

    applyTerminalOptions(terminal as never, options);

    expect(terminal.options).toMatchObject({
      theme: options.theme,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      fontWeight: options.fontWeight,
      lineHeight: options.lineHeight,
      cursorStyle: options.cursorStyle,
      cursorBlink: options.cursorBlink,
    });
    expect(terminal.options.theme).not.toBe(firstTheme);
    expect(terminal.options.cols).toBe(80);
    expect(terminal.options.rows).toBe(24);
    expect(terminal.assigned).toEqual(expect.arrayContaining([
      "theme", "fontFamily", "fontSize", "fontWeight", "lineHeight",
      "cursorStyle", "cursorBlink", "scrollback",
    ]));
    expect(terminal.assigned).not.toContain("cols");
    expect(terminal.assigned).not.toContain("rows");
  });
});
