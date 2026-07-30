import { describe, expect, it } from "vitest";
import { createDefaultAppearanceSettings } from "../theme/defaults";
import { APP_THEME_PRESETS } from "../theme/presets";
import { createTerminalOptions, terminalSettingsForPreset } from "./terminalAppearance";

describe("xterm 5.5 appearance adapter", () => {
  it("keeps the exact legacy Dark defaults in the single xterm option source", () => {
    const options = createTerminalOptions(createDefaultAppearanceSettings());

    expect(options).toMatchObject({
      convertEol: true,
      fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
      fontSize: 13,
      fontWeight: 400,
      lineHeight: 1,
      cursorStyle: "block",
      cursorBlink: true,
      rightClickSelectsWord: true,
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
});
