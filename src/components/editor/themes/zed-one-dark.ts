/**
 * Compatibility facade for legacy editor imports. Palette ownership now lives
 * in src/theme/monacoThemes so appearance and editor mode stay independent.
 */
import type * as Monaco from "monaco-editor";
import type { EditorMode } from "../../../lib/tauri";
import { createDefaultAppearanceSettings } from "../../../theme/defaults";
import {
  CLASSIC_MONACO_THEME_ID,
  ZED_ONE_DARK_THEME,
  ZED_ONE_DARK_THEME_ID,
  applyMonacoTheme,
  resolveMonacoTheme,
} from "../../../theme/monacoThemes";

export { CLASSIC_MONACO_THEME_ID, ZED_ONE_DARK_THEME, ZED_ONE_DARK_THEME_ID };

const CLASSIC_FONT = "'SF Mono', 'Menlo', 'Monaco', monospace";
const ZED_FONT =
  '"Zed Mono", "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace';

export function themeForEditorMode(mode: EditorMode): string {
  return resolveMonacoTheme(createDefaultAppearanceSettings(), mode);
}

export function fontFamilyForEditorMode(mode: EditorMode): string {
  return mode === "zed" ? ZED_FONT : CLASSIC_FONT;
}

export function applyEditorModeTheme(monaco: typeof Monaco, mode: EditorMode): void {
  applyMonacoTheme(monaco, themeForEditorMode(mode));
}
