import { createDefaultAppearanceSettings } from "./defaults";
import type { AppThemePreset, TerminalAppearanceSettings } from "./types";

function terminalPreset(
  preset: TerminalAppearanceSettings["preset"],
  values: Partial<TerminalAppearanceSettings>,
): TerminalAppearanceSettings {
  const dark = createDefaultAppearanceSettings().terminal;
  return {
    ...dark,
    ...values,
    preset,
    ansi: { ...dark.ansi, ...values.ansi },
  };
}

export const APP_THEME_PRESETS: readonly AppThemePreset[] = [
  {
    id: "terminai-dark",
    label: "TerminAI Dark",
    description: "The existing TerminAI dark appearance.",
    terminal: terminalPreset("terminai-dark", {}),
  },
  {
    id: "slate-grey",
    label: "Slate Grey",
    description: "A neutral charcoal palette with reduced saturation.",
    terminal: terminalPreset("slate-grey", {
      foreground: "#D7D9DD",
      background: "#17191C",
      cursor: "#B9C0C9",
      cursorAccent: "#17191C",
      selectionBackground: "#46505B",
      ansi: {
        black: "#202328",
        red: "#CD8B8B",
        green: "#98B98F",
        yellow: "#C6B782",
        blue: "#8FAFC6",
        magenta: "#B39DBA",
        cyan: "#8FB9BA",
        white: "#D7D9DD",
        brightBlack: "#79808A",
        brightRed: "#E2A0A0",
        brightGreen: "#B3CFA8",
        brightYellow: "#DDD09D",
        brightBlue: "#A9C7DD",
        brightMagenta: "#CAB3D0",
        brightCyan: "#A8D2D3",
        brightWhite: "#F4F5F6",
      },
    }),
  },
  {
    id: "matrix",
    label: "Matrix",
    description: "Black surfaces with restrained phosphor-green accents.",
    terminal: terminalPreset("matrix", {
      foreground: "#8DFF9A",
      background: "#030703",
      cursor: "#B8FFB8",
      cursorAccent: "#030703",
      selectionBackground: "#1B5E20",
      ansi: {
        black: "#071207",
        red: "#FF6B6B",
        green: "#39FF6A",
        yellow: "#D9FF6A",
        blue: "#72D8FF",
        magenta: "#E58CFF",
        cyan: "#6AFFF1",
        white: "#B8FFB8",
        brightBlack: "#3D7042",
        brightRed: "#FF9B9B",
        brightGreen: "#8DFF9A",
        brightYellow: "#ECFF9B",
        brightBlue: "#A5E7FF",
        brightMagenta: "#F0B6FF",
        brightCyan: "#A2FFF7",
        brightWhite: "#E8FFE8",
      },
    }),
  },
];

export function getAppThemePreset(id: AppThemePreset["id"]): AppThemePreset {
  return APP_THEME_PRESETS.find((preset) => preset.id === id) ?? APP_THEME_PRESETS[0];
}
