import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEBUG_OUTPUT_MAX_CHARS,
  appendBoundedDebugOutput,
} from "./useDebugSession";

const eventApi = vi.hoisted(() => ({
  listen: vi.fn(),
  handler: null as ((event: { payload: unknown }) => void) | null,
}));

const tauri = vi.hoisted(() => ({
  dapCheckAvailable: vi.fn(),
  dapClearTab: vi.fn(),
  dapContinue: vi.fn(),
  dapEvaluate: vi.fn(),
  dapNext: vi.fn(),
  dapPause: vi.fn(),
  dapRestart: vi.fn(),
  dapScopes: vi.fn(),
  dapSessionForTab: vi.fn(),
  dapStackTrace: vi.fn(),
  dapStart: vi.fn(),
  dapStepIn: vi.fn(),
  dapStepOut: vi.fn(),
  dapStop: vi.fn(),
  dapThreads: vi.fn(),
  dapVariables: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventApi.listen,
}));

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri")>(
    "../lib/tauri",
  );
  return { ...actual, ...tauri };
});

import { useDebugSession } from "./useDebugSession";

const session = {
  sessionId: "session-1",
  tabId: "tab-1",
  workspaceRoot: "/repo",
  program: "/repo/main.py",
  interpreter: "/repo/.venv/bin/python",
  adapterName: "debugpy",
  status: "running" as const,
};

function emit(event: string, body: Record<string, unknown> = {}) {
  eventApi.handler?.({
    payload: {
      sessionId: "session-1",
      tabId: "tab-1",
      event,
      body,
    },
  });
}

describe("useDebugSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventApi.handler = null;
    eventApi.listen.mockImplementation(
      async (_name: string, handler: typeof eventApi.handler) => {
        eventApi.handler = handler;
        return vi.fn();
      },
    );
    tauri.dapSessionForTab.mockResolvedValue(null);
    tauri.dapCheckAvailable.mockResolvedValue({
      available: true,
      adapterPython: "/repo/sidecar/.venv/bin/python",
      interpreter: "/repo/.venv/bin/python",
      message: null,
    });
    tauri.dapStart.mockResolvedValue(session);
    tauri.dapClearTab.mockResolvedValue(undefined);
    tauri.dapStop.mockResolvedValue(undefined);
    tauri.dapThreads.mockResolvedValue({
      threads: [{ id: 7, name: "MainThread" }],
    });
    tauri.dapStackTrace.mockResolvedValue({
      stackFrames: [
        {
          id: 11,
          name: "main",
          source: { name: "main.py", path: "/repo/main.py" },
          line: 5,
          column: 1,
        },
      ],
    });
    tauri.dapScopes.mockResolvedValue({
      scopes: [
        {
          name: "Locals",
          variablesReference: 21,
          expensive: false,
        },
      ],
    });
    tauri.dapVariables.mockResolvedValue({
      variables: [
        {
          name: "router",
          value: "{'hostname': 'r1'}",
          type: "dict",
          variablesReference: 31,
        },
      ],
    });
    tauri.dapEvaluate.mockResolvedValue({
      result: "'r1'",
      type: "str",
      variablesReference: 0,
    });
    tauri.dapContinue.mockResolvedValue({});
    tauri.dapPause.mockResolvedValue({});
    tauri.dapNext.mockResolvedValue({});
    tauri.dapStepIn.mockResolvedValue({});
    tauri.dapStepOut.mockResolvedValue({});
  });

  it("starts only after availability and hydrates paused state plus watches", async () => {
    const { result } = renderHook(() => useDebugSession("tab-1", true));
    await waitFor(() => expect(eventApi.handler).not.toBeNull());

    await act(async () => {
      expect(
        await result.current.start({
          tabId: "tab-1",
          workspaceRoot: "/repo",
          program: "/repo/main.py",
        }),
      ).toBe(true);
      await result.current.addWatch("router['hostname']");
    });

    expect(result.current.status).toBe("running");
    expect(tauri.dapCheckAvailable).toHaveBeenCalledWith("/repo");

    act(() => emit("stopped", { threadId: 7, reason: "breakpoint" }));

    await waitFor(() => {
      expect(result.current.status).toBe("paused");
      expect(result.current.frames[0]?.name).toBe("main");
      expect(result.current.scopes[0]?.variables[0]?.name).toBe("router");
      expect(result.current.watches[0]?.value).toBe("'r1'");
    });
    expect(tauri.dapThreads).toHaveBeenCalledWith("session-1");
    expect(tauri.dapStackTrace).toHaveBeenCalledWith("session-1", 7);
    expect(tauri.dapScopes).toHaveBeenCalledWith("session-1", 11);
    expect(tauri.dapVariables).toHaveBeenCalledWith("session-1", 21);
    expect(tauri.dapEvaluate).toHaveBeenCalledWith(
      "session-1",
      "router['hostname']",
      11,
    );
  });

  it("clears stale paused references on continue and ignores foreign sessions", async () => {
    const { result } = renderHook(() => useDebugSession("tab-1", true));
    await waitFor(() => expect(eventApi.handler).not.toBeNull());
    await act(async () => {
      await result.current.start({
        tabId: "tab-1",
        workspaceRoot: "/repo",
        program: "/repo/main.py",
      });
    });
    act(() => emit("stopped", { threadId: 7 }));
    await waitFor(() => expect(result.current.frames).toHaveLength(1));

    act(() => emit("continued", { threadId: 7 }));
    expect(result.current.status).toBe("running");
    expect(result.current.frames).toEqual([]);
    expect(result.current.scopes).toEqual([]);

    act(() => {
      eventApi.handler?.({
        payload: {
          sessionId: "obsolete-session",
          tabId: "tab-1",
          event: "output",
          body: { output: "stale" },
        },
      });
    });
    expect(result.current.output).toEqual([]);
  });

  it("cleans the backend session after natural termination", async () => {
    const { result } = renderHook(() => useDebugSession("tab-1", true));
    await waitFor(() => expect(eventApi.handler).not.toBeNull());
    await act(async () => {
      await result.current.start({
        tabId: "tab-1",
        workspaceRoot: "/repo",
        program: "/repo/main.py",
      });
    });

    act(() => emit("terminated"));
    await waitFor(() => expect(result.current.status).toBe("stopped"));
    await waitFor(() =>
      expect(tauri.dapStop).toHaveBeenCalledWith("session-1"),
    );
    expect(result.current.session).toBeNull();
  });
});

describe("debug output bounding", () => {
  it("retains only the newest bounded output content", () => {
    const first = "a".repeat(DEBUG_OUTPUT_MAX_CHARS);
    const bounded = appendBoundedDebugOutput(
      [{ category: "stdout", output: first }],
      { category: "stderr", output: "tail" },
    );
    expect(bounded).toEqual([{ category: "stderr", output: "tail" }]);

    const oversized = appendBoundedDebugOutput([], {
      category: "console",
      output: "x".repeat(DEBUG_OUTPUT_MAX_CHARS + 20),
    });
    expect(oversized[0].output).toHaveLength(DEBUG_OUTPUT_MAX_CHARS);
  });
});
