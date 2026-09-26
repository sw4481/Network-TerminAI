import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  CLASSIC_MONACO_THEME_ID,
  ZED_ONE_DARK_THEME_ID,
  applyEditorModeTheme,
  fontFamilyForEditorMode,
  themeForEditorMode,
} from "./zed-one-dark";

function fakeMonaco() {
  const defineTheme = vi.fn();
  const setTheme = vi.fn();
  return {
    monaco: { editor: { defineTheme, setTheme } } as unknown as typeof Monaco,
    defineTheme,
    setTheme,
  };
}

describe("Zed One Dark theme", () => {
  it("defines and applies Zed One Dark in Zed Mode", () => {
    const fake = fakeMonaco();
    applyEditorModeTheme(fake.monaco, "zed");
    expect(fake.defineTheme).toHaveBeenCalledWith(
      ZED_ONE_DARK_THEME_ID,
      expect.objectContaining({ base: "vs-dark", inherit: true }),
    );
    expect(fake.setTheme).toHaveBeenCalledWith(ZED_ONE_DARK_THEME_ID);
  });

  it("restores classic Monaco without redefining the Zed theme", () => {
    const fake = fakeMonaco();
    applyEditorModeTheme(fake.monaco, "monaco");
    expect(fake.defineTheme).not.toHaveBeenCalled();
    expect(fake.setTheme).toHaveBeenCalledWith(CLASSIC_MONACO_THEME_ID);
    expect(themeForEditorMode("monaco")).toBe("vs-dark");
    expect(fontFamilyForEditorMode("monaco"))
      .toBe("'SF Mono', 'Menlo', 'Monaco', monospace");
  });
});
