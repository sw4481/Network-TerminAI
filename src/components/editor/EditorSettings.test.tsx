import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
} from "./MonacoEditor";
import { EditorSettingsPanel } from "./EditorSettings";

describe("EditorSettingsPanel", () => {
  it("saves the column selection setting", () => {
    const settings: EditorSettings = {
      ...DEFAULT_EDITOR_SETTINGS,
      columnSelection: false,
    };
    const onSave = vi.fn();

    render(
      <EditorSettingsPanel
        settings={settings}
        onSave={onSave}
        onClose={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Column Selection" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({
      ...settings,
      columnSelection: true,
    });
  });
});
