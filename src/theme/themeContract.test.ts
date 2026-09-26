import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE_SETTINGS } from "./defaults";
import { APP_THEME_PRESETS } from "./presets";
import {
  APPEARANCE_LIMITS,
  migrateAppearanceSettings,
  normalizeAppearanceSettings,
  parseAppearanceSettings,
} from "./validation";

describe("appearance contract", () => {
  it("keeps the current Dark terminal values as the safe default", () => {
    expect(DEFAULT_APPEARANCE_SETTINGS).toMatchObject({
      schemaVersion: 1,
      appTheme: "terminai-dark",
      editorTheme: "follow-app",
      terminal: {
        preset: "follow-app",
        background: "#0F1114",
        foreground: "#E6E1CF",
        cursor: "#5CCFE6",
        cursorAccent: "#000000",
        fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
        fontSize: 13,
        cursorStyle: "block",
        cursorBlink: true,
      },
    });
  });

  it("matches the effective CDN xterm 5.5 legacy theme when ANSI and selection were omitted", () => {
    // xterm 5.5.0 ThemeService defaults: DEFAULT_ANSI_COLORS plus
    // rgba(255, 255, 255, 0.3) for active/inactive selection. The legacy
    // TerminAI constructors only supplied the four non-default values below.
    expect(DEFAULT_APPEARANCE_SETTINGS.terminal).toMatchObject({
      foreground: "#E6E1CF",
      background: "#0F1114",
      cursor: "#5CCFE6",
      cursorAccent: "#000000",
      selectionBackground: "#FFFFFF4D",
      ansi: {
        black: "#2E3436",
        red: "#CC0000",
        green: "#4E9A06",
        yellow: "#C4A000",
        blue: "#3465A4",
        magenta: "#75507B",
        cyan: "#06989A",
        white: "#D3D7CF",
        brightBlack: "#555753",
        brightRed: "#EF2929",
        brightGreen: "#8AE234",
        brightYellow: "#FCE94F",
        brightBlue: "#729FCF",
        brightMagenta: "#AD7FA8",
        brightCyan: "#34E2E2",
        brightWhite: "#EEEEEC",
      },
    });
  });

  it("defines each bundled app preset with a complete terminal palette", () => {
    expect(APP_THEME_PRESETS.map((preset) => preset.id)).toEqual([
      "terminai-dark",
      "slate-grey",
      "matrix",
    ]);
    for (const preset of APP_THEME_PRESETS) {
      expect(preset.terminal.ansi).toHaveProperty("brightWhite");
      expect(preset.terminal.background).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("normalizes colors and clamps documented numeric limits", () => {
    const candidate = structuredClone(DEFAULT_APPEARANCE_SETTINGS);
    candidate.terminal.foreground = "#abc";
    candidate.terminal.selectionBackground = "#1234";
    candidate.terminal.fontSize = 1;
    candidate.terminal.fontWeight = 2000;
    candidate.terminal.lineHeight = 50;

    expect(parseAppearanceSettings(candidate)).toEqual({
      ...DEFAULT_APPEARANCE_SETTINGS,
      terminal: {
        ...DEFAULT_APPEARANCE_SETTINGS.terminal,
        foreground: "#AABBCC",
        selectionBackground: "#11223344",
        fontSize: APPEARANCE_LIMITS.fontSize.min,
        fontWeight: APPEARANCE_LIMITS.fontWeight.max,
        lineHeight: APPEARANCE_LIMITS.lineHeight.max,
      },
    });
  });

  it("falls back to Dark for malformed, invalid, and future persisted values", () => {
    expect(normalizeAppearanceSettings('{not json')).toEqual(
      DEFAULT_APPEARANCE_SETTINGS,
    );
    expect(normalizeAppearanceSettings({ schemaVersion: 2 })).toEqual(
      DEFAULT_APPEARANCE_SETTINGS,
    );

    const invalid = structuredClone(DEFAULT_APPEARANCE_SETTINGS);
    invalid.appTheme = "not-a-theme" as typeof invalid.appTheme;
    invalid.terminal.foreground = "red";
    expect(normalizeAppearanceSettings(invalid)).toEqual(
      DEFAULT_APPEARANCE_SETTINGS,
    );
  });

  it("only migrates the current known schema", () => {
    expect(migrateAppearanceSettings(DEFAULT_APPEARANCE_SETTINGS)).toEqual(
      DEFAULT_APPEARANCE_SETTINGS,
    );
    expect(migrateAppearanceSettings({ schemaVersion: 999 })).toBeNull();
  });
});
