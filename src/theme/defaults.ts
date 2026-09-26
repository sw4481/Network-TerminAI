import type { AppearanceSettingsV1, TerminalAnsiPalette } from "./types";

// These are xterm 5.5.0 ThemeService's DEFAULT_ANSI_COLORS. TerminAI's
// current constructors omit every ANSI and selection field, so encoding their
// effective values keeps Dark visually identical once Task 3 applies them.
const DARK_ANSI: TerminalAnsiPalette = {
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
};

/**
 * The original xterm settings are intentionally retained here: #0f1114,
 * #e6e1cf, #5ccfe6, Menlo 13px, a blinking block cursor, and no PTY changes.
 */
export function createDefaultAppearanceSettings(): AppearanceSettingsV1 {
  return {
    schemaVersion: 1,
    appTheme: "terminai-dark",
    editorTheme: "follow-app",
    terminal: {
      preset: "follow-app",
      foreground: "#E6E1CF",
      background: "#0F1114",
      cursor: "#5CCFE6",
      cursorAccent: "#000000",
      // xterm 5.5's omitted selection default: rgba(255, 255, 255, 0.3).
      selectionBackground: "#FFFFFF4D",
      ansi: { ...DARK_ANSI },
      fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
      fontSize: 13,
      fontWeight: 400,
      lineHeight: 1,
      cursorStyle: "block",
      cursorBlink: true,
    },
    effects: {
      matrixScanlines: false,
      matrixGlow: false,
      motion: "system",
    },
  };
}

export const DEFAULT_APPEARANCE_SETTINGS = createDefaultAppearanceSettings();
