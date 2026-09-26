import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useIacLint } from "./useIacLint";
import * as tauri from "../lib/tauri";

describe("useIacLint", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("debounces and calls iacLintFile, returning diagnostics", async () => {
    const spy = vi.spyOn(tauri, "iacLintFile").mockResolvedValue({
      diagnostics: [
        { line: 1, column: 1, severity: "error", message: "x", source: "terraform fmt" },
      ],
      linters: [{ name: "terraform fmt", ran: true, available: true, reason: null }],
    });

    const { result } = renderHook(() =>
      useIacLint({ filePath: "main.tf", content: "locals {}", language: "hcl", debounceMs: 10 }),
    );

    await waitFor(() => expect(result.current.diagnostics).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith("main.tf", "locals {}", "hcl");
  });

  it("does not lint when filePath is null", async () => {
    const spy = vi.spyOn(tauri, "iacLintFile").mockResolvedValue({ diagnostics: [], linters: [] });
    renderHook(() =>
      useIacLint({ filePath: null, content: "", language: "hcl", debounceMs: 10 }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it("swallows lint errors (sidecar down) and reports unavailable", async () => {
    vi.spyOn(tauri, "iacLintFile").mockRejectedValue(new Error("sidecar down"));
    const { result } = renderHook(() =>
      useIacLint({ filePath: "main.tf", content: "x", language: "hcl", debounceMs: 10 }),
    );
    await waitFor(() => expect(result.current.error).toBe("sidecar down"));
    expect(result.current.diagnostics).toEqual([]);
  });
});
