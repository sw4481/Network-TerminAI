export const APP_THEME_IDS = [
  "terminai-dark",
  "slate-grey",
  "matrix",
] as const;

export type AppThemeId = (typeof APP_THEME_IDS)[number];

export const EDITOR_THEME_IDS = [
  "follow-app",
  "classic-dark",
  "zed-one-dark",
  "slate-grey",
  "matrix",
] as const;

export type EditorThemeId = (typeof EDITOR_THEME_IDS)[number];

export const TERMINAL_PRESET_IDS = [
  "follow-app",
  "terminai-dark",
  "slate-grey",
  "matrix",
  "custom",
] as const;

export type TerminalPresetId = (typeof TERMINAL_PRESET_IDS)[number];
export type CursorStyle = "block" | "bar" | "underline";
export type MotionPreference = "system" | "reduced";

export type TerminalAnsiPalette = {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export type TerminalAppearanceSettings = {
  preset: TerminalPresetId;
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  ansi: TerminalAnsiPalette;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
};

export type AppearanceSettingsV1 = {
  schemaVersion: 1;
  appTheme: AppThemeId;
  editorTheme: EditorThemeId;
  terminal: TerminalAppearanceSettings;
  effects: {
    matrixScanlines: boolean;
    matrixGlow: boolean;
    motion: MotionPreference;
  };
};

export type AppThemePreset = {
  id: AppThemeId;
  label: string;
  description: string;
  terminal: TerminalAppearanceSettings;
};
