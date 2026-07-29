import type * as Monaco from "monaco-editor";
import type { EditorMode } from "../../../lib/tauri";

export const CLASSIC_MONACO_THEME_ID = "vs-dark";
export const ZED_ONE_DARK_THEME_ID = "ccie-zed-one-dark";

const CLASSIC_FONT = "'SF Mono', 'Menlo', 'Monaco', monospace";
const ZED_FONT =
  '"Zed Mono", "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace';

export const ZED_ONE_DARK_THEME: Monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5C6370", fontStyle: "italic" },
    { token: "keyword", foreground: "C678DD" },
    { token: "string", foreground: "98C379" },
    { token: "number", foreground: "D19A66" },
    { token: "type.identifier", foreground: "E5C07B" },
    { token: "identifier.function", foreground: "61AFEF" },
    { token: "variable", foreground: "E06C75" },
    { token: "regexp", foreground: "56B6C2" },
    { token: "delimiter", foreground: "ABB2BF" },
  ],
  colors: {
    "editor.background": "#282C34",
    "editor.foreground": "#ABB2BF",
    "editorCursor.foreground": "#528BFF",
    "editor.selectionBackground": "#3E4451",
    "editor.inactiveSelectionBackground": "#343842",
    "editor.lineHighlightBackground": "#2C313C",
    "editorLineNumber.foreground": "#636D83",
    "editorLineNumber.activeForeground": "#ABB2BF",
    "editorGutter.background": "#282C34",
    "editorIndentGuide.background1": "#3B4048",
    "editorIndentGuide.activeBackground1": "#5C6370",
    "editorWhitespace.foreground": "#3B4048",
    "editorWidget.background": "#21252B",
    "editorWidget.border": "#3E4451",
    "editorSuggestWidget.selectedBackground": "#2C313C",
  },
};

export function themeForEditorMode(mode: EditorMode): string {
  return mode === "zed" ? ZED_ONE_DARK_THEME_ID : CLASSIC_MONACO_THEME_ID;
}

export function fontFamilyForEditorMode(mode: EditorMode): string {
  return mode === "zed" ? ZED_FONT : CLASSIC_FONT;
}

export function applyEditorModeTheme(
  monaco: typeof Monaco,
  mode: EditorMode,
): void {
  if (mode === "zed") {
    monaco.editor.defineTheme(ZED_ONE_DARK_THEME_ID, ZED_ONE_DARK_THEME);
  }
  monaco.editor.setTheme(themeForEditorMode(mode));
}
