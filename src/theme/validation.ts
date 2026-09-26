import { createDefaultAppearanceSettings } from "./defaults";
import {
  APP_THEME_IDS,
  EDITOR_THEME_IDS,
  TERMINAL_PRESET_IDS,
  type AppearanceSettingsV1,
  type CursorStyle,
  type MotionPreference,
  type TerminalAnsiPalette,
  type TerminalAppearanceSettings,
} from "./types";

export const APPEARANCE_LIMITS = {
  fontSize: { min: 8, max: 32 },
  fontWeight: { min: 100, max: 900 },
  lineHeight: { min: 1, max: 2 },
} as const;

const ANSI_KEYS: (keyof TerminalAnsiPalette)[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
  "brightMagenta", "brightCyan", "brightWhite",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inSet<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function clamp(value: number, limits: { min: number; max: number }): number {
  return Math.min(limits.max, Math.max(limits.min, value));
}

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1].toUpperCase();
  if (hex.length === 3 || hex.length === 4) {
    return `#${[...hex].map((part) => part + part).join("")}`;
  }
  return `#${hex}`;
}

function parseAnsi(value: unknown): TerminalAnsiPalette | null {
  if (!isRecord(value)) return null;
  const ansi = {} as TerminalAnsiPalette;
  for (const key of ANSI_KEYS) {
    const color = normalizeHexColor(value[key]);
    if (!color) return null;
    ansi[key] = color;
  }
  return ansi;
}

function parseTerminal(value: unknown): TerminalAppearanceSettings | null {
  if (!isRecord(value) || !inSet(value.preset, TERMINAL_PRESET_IDS)) return null;
  const foreground = normalizeHexColor(value.foreground);
  const background = normalizeHexColor(value.background);
  const cursor = normalizeHexColor(value.cursor);
  const cursorAccent = normalizeHexColor(value.cursorAccent);
  const selectionBackground = normalizeHexColor(value.selectionBackground);
  const ansi = parseAnsi(value.ansi);
  const fontSize = value.fontSize;
  const fontWeight = value.fontWeight;
  const lineHeight = value.lineHeight;
  if (!foreground || !background || !cursor || !cursorAccent || !selectionBackground || !ansi) return null;
  if (typeof value.fontFamily !== "string" || value.fontFamily.trim().length === 0 || value.fontFamily.length > 256) return null;
  if (
    typeof fontSize !== "number" || !Number.isFinite(fontSize) ||
    typeof fontWeight !== "number" || !Number.isFinite(fontWeight) ||
    typeof lineHeight !== "number" || !Number.isFinite(lineHeight)
  ) return null;
  if (!inSet(value.cursorStyle, ["block", "bar", "underline"] as const) || typeof value.cursorBlink !== "boolean") return null;
  return {
    preset: value.preset,
    foreground,
    background,
    cursor,
    cursorAccent,
    selectionBackground,
    ansi,
    fontFamily: value.fontFamily.trim(),
    fontSize: clamp(fontSize, APPEARANCE_LIMITS.fontSize),
    fontWeight: clamp(fontWeight, APPEARANCE_LIMITS.fontWeight),
    lineHeight: clamp(lineHeight, APPEARANCE_LIMITS.lineHeight),
    cursorStyle: value.cursorStyle as CursorStyle,
    cursorBlink: value.cursorBlink,
  };
}

/** Returns null for unsupported schema versions and invalid persisted data. */
export function migrateAppearanceSettings(value: unknown): AppearanceSettingsV1 | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const terminal = parseTerminal(value.terminal);
  if (!terminal || !inSet(value.appTheme, APP_THEME_IDS) || !inSet(value.editorTheme, EDITOR_THEME_IDS) || !isRecord(value.effects)) return null;
  if (typeof value.effects.matrixScanlines !== "boolean" || typeof value.effects.matrixGlow !== "boolean" || !inSet(value.effects.motion, ["system", "reduced"] as const)) return null;
  return {
    schemaVersion: 1,
    appTheme: value.appTheme,
    editorTheme: value.editorTheme,
    terminal,
    effects: {
      matrixScanlines: value.effects.matrixScanlines,
      matrixGlow: value.effects.matrixGlow,
      motion: value.effects.motion as MotionPreference,
    },
  };
}

export function parseAppearanceSettings(value: unknown): AppearanceSettingsV1 | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return migrateAppearanceSettings(candidate);
}

/** Safely reads backend/local persisted values; all failures retain current Dark. */
export function normalizeAppearanceSettings(value: unknown): AppearanceSettingsV1 {
  return parseAppearanceSettings(value) ?? createDefaultAppearanceSettings();
}
