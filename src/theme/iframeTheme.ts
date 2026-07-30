import type { AppThemeId } from "./types";

export type IframeTheme = {
  canvas: string;
  text: string;
  info: string;
  danger: string;
};

/** Resolved values for isolated srcDoc documents, which cannot inherit CSS vars. */
export const IFRAME_THEMES: Record<AppThemeId, IframeTheme> = {
  "terminai-dark": { canvas: "#0f1114", text: "#e6e1cf", info: "#5ccfe6", danger: "#f28779" },
  "slate-grey": { canvas: "#17191c", text: "#d7d9dd", info: "#9bb8ce", danger: "#cd8b8b" },
  matrix: { canvas: "#030703", text: "#b8ffb8", info: "#72d8ff", danger: "#ff6b6b" },
};
