import type { AppearanceSettingsV1, TerminalAnsiPalette } from "./types";

const DARK_ANSI: TerminalAnsiPalette = {
  black: "#1A1D23",
  red: "#F28779",
  green: "#7CD99A",
  yellow: "#F0C674",
  blue: "#5CCFE6",
  magenta: "#B39CFF",
  cyan: "#5CD6C0",
  white: "#E6E1CF",
  brightBlack: "#6C7380",
  brightRed: "#FF9688",
  brightGreen: "#9AE6B4",
  brightYellow: "#FCD34D",
  brightBlue: "#7DD3FC",
  brightMagenta: "#C4B5FD",
  brightCyan: "#99F6E4",
  brightWhite: "#FFFFFF",
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
      selectionBackground: "#264F78",
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
