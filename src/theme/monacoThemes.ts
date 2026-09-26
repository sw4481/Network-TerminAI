import type * as Monaco from "monaco-editor";
import type { EditorMode } from "../lib/tauri";
import type { AppearanceSettingsV1 } from "./types";

/** The stock Monaco Dark palette remains the exact classic Dark fallback. */
export const CLASSIC_MONACO_THEME_ID = "vs-dark";
export const ZED_ONE_DARK_THEME_ID = "ccie-zed-one-dark";
export const SLATE_GREY_MONACO_THEME_ID = "ccie-slate-grey";
export const MATRIX_MONACO_THEME_ID = "ccie-matrix";

const BASE_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: "comment", foreground: "7E8793", fontStyle: "italic" },
  { token: "keyword", foreground: "B7A6E8" },
  { token: "string", foreground: "9DCB8C" },
  { token: "number", foreground: "D9B77A" },
  { token: "type.identifier", foreground: "D9C58B" },
  { token: "identifier.function", foreground: "88B9DE" },
  { token: "variable", foreground: "D89AA2" },
  { token: "regexp", foreground: "82C5C4" },
  { token: "delimiter", foreground: "D7D9DD" },
];

function theme(
  rules: Monaco.editor.ITokenThemeRule[],
  colors: Record<string, string>,
): Monaco.editor.IStandaloneThemeData {
  return { base: "vs-dark", inherit: true, rules, colors };
}

export const ZED_ONE_DARK_THEME = theme([
  { token: "comment", foreground: "5C6370", fontStyle: "italic" },
  { token: "keyword", foreground: "C678DD" },
  { token: "string", foreground: "98C379" },
  { token: "number", foreground: "D19A66" },
  { token: "type.identifier", foreground: "E5C07B" },
  { token: "identifier.function", foreground: "61AFEF" },
  { token: "variable", foreground: "E06C75" },
  { token: "regexp", foreground: "56B6C2" },
  { token: "delimiter", foreground: "ABB2BF" },
], {
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
});

export const SLATE_GREY_MONACO_THEME = theme(BASE_RULES, {
  "editor.background": "#17191C",
  "editor.foreground": "#D7D9DD",
  "editorCursor.foreground": "#B9C0C9",
  "editor.selectionBackground": "#46505B",
  "editor.inactiveSelectionBackground": "#343A42",
  "editor.lineHighlightBackground": "#202328",
  "editorLineNumber.foreground": "#79808A",
  "editorLineNumber.activeForeground": "#F4F5F6",
  "editorGutter.background": "#17191C",
  "editorIndentGuide.background1": "#30353C",
  "editorIndentGuide.activeBackground1": "#66707C",
  "editorWhitespace.foreground": "#30353C",
  "editorWidget.background": "#202328",
  "editorWidget.border": "#46505B",
  "editorSuggestWidget.selectedBackground": "#30353C",
  "editorError.foreground": "#E2A0A0",
  "editorWarning.foreground": "#DDD09D",
  "editorInfo.foreground": "#A9C7DD",
  "editorHint.foreground": "#A8D2D3",
  "gitDecoration.addedResourceForeground": "#B3CFA8",
  "gitDecoration.modifiedResourceForeground": "#A9C7DD",
  "gitDecoration.deletedResourceForeground": "#E2A0A0",
  "debugIcon.startForeground": "#B3CFA8",
  "debugIcon.stopForeground": "#E2A0A0",
  "debugIcon.pauseForeground": "#DDD09D",
  "terminal.background": "#17191C",
  "terminal.border": "#46505B",
  "panel.border": "#46505B",
});

export const MATRIX_MONACO_THEME = theme([
  { token: "comment", foreground: "4F8C56", fontStyle: "italic" },
  { token: "keyword", foreground: "8DFF9A" },
  { token: "string", foreground: "B8FFB8" },
  { token: "number", foreground: "D9FF6A" },
  { token: "type.identifier", foreground: "A2FFF7" },
  { token: "identifier.function", foreground: "72D8FF" },
  { token: "variable", foreground: "F0B6FF" },
  { token: "regexp", foreground: "6AFFF1" },
  { token: "delimiter", foreground: "E8FFE8" },
], {
  "editor.background": "#030703",
  "editor.foreground": "#8DFF9A",
  "editorCursor.foreground": "#B8FFB8",
  "editor.selectionBackground": "#1B5E20",
  "editor.inactiveSelectionBackground": "#114017",
  "editor.lineHighlightBackground": "#071207",
  "editorLineNumber.foreground": "#3D7042",
  "editorLineNumber.activeForeground": "#B8FFB8",
  "editorGutter.background": "#030703",
  "editorIndentGuide.background1": "#123A18",
  "editorIndentGuide.activeBackground1": "#39FF6A",
  "editorWhitespace.foreground": "#123A18",
  "editorWidget.background": "#071207",
  "editorWidget.border": "#1B5E20",
  "editorSuggestWidget.selectedBackground": "#123A18",
  "editorError.foreground": "#FF9B9B",
  "editorWarning.foreground": "#ECFF9B",
  "editorInfo.foreground": "#A5E7FF",
  "editorHint.foreground": "#A2FFF7",
  "gitDecoration.addedResourceForeground": "#8DFF9A",
  "gitDecoration.modifiedResourceForeground": "#A5E7FF",
  "gitDecoration.deletedResourceForeground": "#FF9B9B",
  "debugIcon.startForeground": "#8DFF9A",
  "debugIcon.stopForeground": "#FF9B9B",
  "debugIcon.pauseForeground": "#ECFF9B",
  "terminal.background": "#030703",
  "terminal.border": "#1B5E20",
  "panel.border": "#1B5E20",
});

export const MONACO_THEMES: Record<string, Monaco.editor.IStandaloneThemeData> = {
  [ZED_ONE_DARK_THEME_ID]: ZED_ONE_DARK_THEME,
  [SLATE_GREY_MONACO_THEME_ID]: SLATE_GREY_MONACO_THEME,
  [MATRIX_MONACO_THEME_ID]: MATRIX_MONACO_THEME,
};

/** Explicit editor preferences always win over the application appearance. */
export function resolveMonacoTheme(
  settings: Pick<AppearanceSettingsV1, "appTheme" | "editorTheme">,
  mode: EditorMode,
): string {
  if (settings.editorTheme !== "follow-app") {
    return {
      "classic-dark": CLASSIC_MONACO_THEME_ID,
      "zed-one-dark": ZED_ONE_DARK_THEME_ID,
      "slate-grey": SLATE_GREY_MONACO_THEME_ID,
      matrix: MATRIX_MONACO_THEME_ID,
    }[settings.editorTheme];
  }
  if (settings.appTheme === "slate-grey") return SLATE_GREY_MONACO_THEME_ID;
  if (settings.appTheme === "matrix") return MATRIX_MONACO_THEME_ID;
  return mode === "zed" ? ZED_ONE_DARK_THEME_ID : CLASSIC_MONACO_THEME_ID;
}

/** Defines custom palettes and switches Monaco globally; it never owns models. */
export function applyMonacoTheme(monaco: typeof Monaco, themeId: string): void {
  const definition = MONACO_THEMES[themeId];
  if (definition) monaco.editor.defineTheme(themeId, definition);
  monaco.editor.setTheme(themeId);
}
