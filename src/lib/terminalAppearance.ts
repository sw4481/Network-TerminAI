import { createDefaultAppearanceSettings } from "../theme/defaults";
import { APP_THEME_PRESETS } from "../theme/presets";
import type {
  AppearanceSettingsV1,
  TerminalAppearanceSettings,
} from "../theme/types";

/**
 * Runtime contract: TerminAI loads @xterm/xterm@5.5.0 from jsDelivr. Its
 * bundled Terminal exposes a mutable `options` object for these keys; only
 * `cols` and `rows` are constructor-only. Keep the adapter deliberately small
 * and use a replacement theme object (xterm requires that for object options).
 */
export type MutableXtermOptions = {
  convertEol: boolean;
  scrollback: number;
  rightClickSelectsWord: boolean;
  allowProposedApi: boolean;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  cursorStyle: TerminalAppearanceSettings["cursorStyle"];
  cursorBlink: boolean;
  theme: Record<string, string>;
};

const ANSI_THEME_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
  "brightMagenta", "brightCyan", "brightWhite",
] as const;

export function terminalSettingsForPreset(
  settings: AppearanceSettingsV1,
): TerminalAppearanceSettings {
  const requested = settings.terminal.preset;
  if (requested === "custom") return settings.terminal;
  const presetId = requested === "follow-app" ? settings.appTheme : requested;
  const preset = APP_THEME_PRESETS.find((candidate) => candidate.id === presetId);
  const colors = preset?.terminal ?? createDefaultAppearanceSettings().terminal;
  // A preset owns colors; typography and cursor controls remain independently
  // editable so a user can follow the application palette without sacrificing
  // their preferred terminal metrics.
  return {
    ...colors,
    preset: presetId,
    fontFamily: settings.terminal.fontFamily,
    fontSize: settings.terminal.fontSize,
    fontWeight: settings.terminal.fontWeight,
    lineHeight: settings.terminal.lineHeight,
    cursorStyle: settings.terminal.cursorStyle,
    cursorBlink: settings.terminal.cursorBlink,
  };
}

export function createTerminalOptions(
  settings: AppearanceSettingsV1,
): MutableXtermOptions {
  const terminal = terminalSettingsForPreset(settings);
  const theme: Record<string, string> = {
    foreground: terminal.foreground,
    background: terminal.background,
    cursor: terminal.cursor,
    cursorAccent: terminal.cursorAccent,
    selectionBackground: terminal.selectionBackground,
  };
  for (const key of ANSI_THEME_KEYS) theme[key] = terminal.ansi[key];

  return {
    convertEol: true,
    scrollback: 32000,
    rightClickSelectsWord: false,
    allowProposedApi: true,
    fontFamily: terminal.fontFamily,
    fontSize: terminal.fontSize,
    fontWeight: terminal.fontWeight,
    lineHeight: terminal.lineHeight,
    cursorStyle: terminal.cursorStyle,
    cursorBlink: terminal.cursorBlink,
    theme,
  };
}

export function terminalMetricsChanged(
  before: MutableXtermOptions,
  after: MutableXtermOptions,
): boolean {
  return before.fontFamily !== after.fontFamily
    || before.fontSize !== after.fontSize
    || before.fontWeight !== after.fontWeight
    || before.lineHeight !== after.lineHeight;
}

export function applyTerminalOptions(
  xterm: { options: MutableXtermOptions },
  options: MutableXtermOptions,
): void {
  xterm.options = options;
}
