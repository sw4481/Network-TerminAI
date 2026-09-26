import { describe, expect, it, vi } from "vitest";
import { clearCiscoMarkers, setCiscoMarkers } from "./ciscoMarkers";

describe("Cisco Monaco markers", () => {
  it("sets only the Cisco marker owner with one-based ranges", () => {
    const model = {};
    const monaco = {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
      editor: { setModelMarkers: vi.fn() },
    };

    setCiscoMarkers(monaco as never, model as never, [
      {
        line: 4,
        column: 2,
        endColumn: 12,
        severity: "warning",
        message: "High impact",
        source: "guardrails",
        code: "guardrail-save",
      },
    ]);

    expect(monaco.editor.setModelMarkers).toHaveBeenCalledWith(
      model,
      "cisco-lint",
      [
        {
          startLineNumber: 4,
          startColumn: 2,
          endLineNumber: 4,
          endColumn: 12,
          message: "High impact (guardrails)",
          severity: 4,
        },
      ],
    );
  });

  it("maps every severity and clamps invalid ranges", () => {
    const monaco = {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
      editor: { setModelMarkers: vi.fn() },
    };

    setCiscoMarkers(monaco as never, {} as never, [
      {
        line: 0,
        column: -2,
        endColumn: 0,
        severity: "error",
        message: "Error",
        source: "cisco-structural",
        code: "error",
      },
      {
        line: 2,
        column: 3,
        endColumn: 4,
        severity: "info",
        message: "Info",
        source: "guardrails",
        code: "info",
      },
    ]);

    expect(monaco.editor.setModelMarkers).toHaveBeenCalledWith(
      expect.anything(),
      "cisco-lint",
      [
        expect.objectContaining({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
          severity: 8,
        }),
        expect.objectContaining({ severity: 2 }),
      ],
    );
  });

  it("clears Cisco markers without touching other owners", () => {
    const model = {};
    const monaco = { editor: { setModelMarkers: vi.fn() } };

    clearCiscoMarkers(monaco as never, model as never);

    expect(monaco.editor.setModelMarkers).toHaveBeenCalledWith(
      model,
      "cisco-lint",
      [],
    );
  });
});
