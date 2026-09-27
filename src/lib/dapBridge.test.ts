import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: invokeMock,
}));

import {
  dapBreakpointsGet,
  dapBreakpointsSet,
  dapCheckAvailable,
  dapClearTab,
  dapContinue,
  dapEvaluate,
  dapNext,
  dapPause,
  dapResolveInterpreter,
  dapRestart,
  dapScopes,
  dapSessionForTab,
  dapStackTrace,
  dapStart,
  dapStepIn,
  dapStepOut,
  dapStop,
  dapThreads,
  dapVariables,
} from "./tauri";

describe("Python DAP Tauri bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
  });

  it("uses the restricted lifecycle and launch command payloads", async () => {
    await dapCheckAvailable("/repo");
    await dapResolveInterpreter("/repo", "/repo/.venv/bin/python");
    await dapStart({
      tabId: "tab-1",
      workspaceRoot: "/repo",
      program: "/repo/main.py",
      interpreter: "/repo/.venv/bin/python",
      args: ["--port", "443"],
      env: { SITE: "lab" },
      stopOnEntry: true,
      justMyCode: false,
    });
    await dapSessionForTab("tab-1");
    await dapRestart("session-1");
    await dapStop("session-2");
    await dapClearTab("tab-1");

    expect(invokeMock.mock.calls).toEqual([
      ["dap_check_available", { workspaceRoot: "/repo" }],
      [
        "dap_resolve_interpreter",
        {
          workspaceRoot: "/repo",
          explicit: "/repo/.venv/bin/python",
        },
      ],
      [
        "dap_start",
        {
          tabId: "tab-1",
          workspaceRoot: "/repo",
          program: "/repo/main.py",
          interpreter: "/repo/.venv/bin/python",
          args: ["--port", "443"],
          env: { SITE: "lab" },
          stopOnEntry: true,
          justMyCode: false,
        },
      ],
      ["dap_session_for_tab", { tabId: "tab-1" }],
      ["dap_restart", { sessionId: "session-1" }],
      ["dap_stop", { sessionId: "session-2" }],
      ["dap_clear_tab", { tabId: "tab-1" }],
    ]);
  });

  it("replaces source breakpoints with a workspace-scoped line list", async () => {
    await dapBreakpointsGet("tab-1", "/repo", "/repo/main.py");
    await dapBreakpointsSet(
      "tab-1",
      "/repo",
      "/repo/main.py",
      [9, 3],
    );

    expect(invokeMock.mock.calls).toEqual([
      [
        "dap_breakpoints_get",
        {
          tabId: "tab-1",
          workspaceRoot: "/repo",
          filePath: "/repo/main.py",
        },
      ],
      [
        "dap_breakpoints_set",
        {
          tabId: "tab-1",
          workspaceRoot: "/repo",
          filePath: "/repo/main.py",
          lines: [9, 3],
        },
      ],
    ]);
  });

  it("maps paused-state, watch, and thread-control requests exactly", async () => {
    await dapThreads("session-1");
    await dapStackTrace("session-1", 7);
    await dapScopes("session-1", 11);
    await dapVariables("session-1", 21);
    await dapEvaluate("session-1", "router.hostname", 11);
    await dapContinue("session-1", 7);
    await dapPause("session-1", 7);
    await dapNext("session-1", 7);
    await dapStepIn("session-1", 7);
    await dapStepOut("session-1", 7);

    expect(invokeMock.mock.calls).toEqual([
      ["dap_threads", { sessionId: "session-1" }],
      ["dap_stack_trace", { sessionId: "session-1", threadId: 7 }],
      ["dap_scopes", { sessionId: "session-1", frameId: 11 }],
      [
        "dap_variables",
        { sessionId: "session-1", variablesReference: 21 },
      ],
      [
        "dap_evaluate",
        {
          sessionId: "session-1",
          expression: "router.hostname",
          frameId: 11,
        },
      ],
      ["dap_continue", { sessionId: "session-1", threadId: 7 }],
      ["dap_pause", { sessionId: "session-1", threadId: 7 }],
      ["dap_next", { sessionId: "session-1", threadId: 7 }],
      ["dap_step_in", { sessionId: "session-1", threadId: 7 }],
      ["dap_step_out", { sessionId: "session-1", threadId: 7 }],
    ]);
  });
});
