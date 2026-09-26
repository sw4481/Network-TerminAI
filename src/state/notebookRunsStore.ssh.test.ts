import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {
    onmessage: ((ev: unknown) => void) | null = null;
  },
}));

import { useNotebookRuns } from "./notebookRunsStore";

describe("notebookRunsStore SSH-direct execution", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useNotebookRuns.setState({ runs: {} });
  });

  it("start forwards connection id + password to notebook_run_start", async () => {
    invokeMock.mockResolvedValue("run-1");
    await useNotebookRuns
      .getState()
      .start("nb1", "tab1", { foo: "bar" }, "conn1", "pw");

    expect(invokeMock).toHaveBeenCalledWith(
      "notebook_run_start",
      expect.objectContaining({
        notebookId: "nb1",
        tabId: "tab1",
        params: { foo: "bar" },
        connectionId: "conn1",
        password: "pw",
      }),
    );
  });

  it("start without connection still passes undefined SSH fields (legacy PTY)", async () => {
    invokeMock.mockResolvedValue("run-2");
    await useNotebookRuns.getState().start("nb1", "tab1", {});

    expect(invokeMock).toHaveBeenCalledWith(
      "notebook_run_start",
      expect.objectContaining({
        connectionId: undefined,
        password: undefined,
      }),
    );
  });

  it("resume forwards connection id + password to notebook_run_resume", async () => {
    invokeMock.mockResolvedValue(undefined);
    await useNotebookRuns.getState().resume("run-1", "tab1", "conn1", "pw");

    expect(invokeMock).toHaveBeenCalledWith(
      "notebook_run_resume",
      expect.objectContaining({
        runId: "run-1",
        tabId: "tab1",
        connectionId: "conn1",
        password: "pw",
      }),
    );
  });
});
