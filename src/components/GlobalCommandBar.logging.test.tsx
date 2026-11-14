import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
  listen: vi.fn(),
  target: { terminalId: "pane-a", backendPtyId: "pty-a" },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => false }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save, message: mocks.message }));
vi.mock("../lib/workflowDispatcher", () => ({
  resolveWorkflowTerminalTarget: () => ({ ...mocks.target }),
  runWorkflowOnTerminal: vi.fn(),
}));
vi.mock("../lib/workflows", () => ({
  globalCommandBarGet: vi.fn().mockResolvedValue({ schema_version: 1, workflow_ids: [] }),
  globalCommandBarSet: vi.fn(),
  workflowList: vi.fn().mockResolvedValue([]),
}));

import { GlobalCommandBar } from "./GlobalCommandBar";
import { TerminalLoggingControls } from "./TerminalLoggingControls";
import { useTerminalLoggingStore, type TerminalLogStatus } from "../state/terminalLoggingStore";

const active: TerminalLogStatus = {
  id: "log-a", tabId: "pty-a", path: "/tmp/session.txt", active: true, error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.target = { terminalId: "pane-a", backendPtyId: "pty-a" };
  mocks.save.mockResolvedValue(active.path);
  mocks.message.mockResolvedValue("Cancel");
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "editor_file_exists") return false;
    if (command === "terminal_log_start" || command === "terminal_log_status") return { ...active };
    if (command === "terminal_log_stop") return { ...active, active: false };
    throw new Error(`Unexpected command ${command}`);
  });
  useTerminalLoggingStore.setState({ logs: {}, pending: false, listenerError: null });
});
afterEach(cleanup);

it("offers terminal logging immediately beside the workflow control", async () => {
  render(<GlobalCommandBar tabId="logging-tab" vendor="generic" platform="generic" />);
  const workflow = await screen.findByRole("button", { name: "Pin workflow" });
  const logging = screen.getByRole("button", { name: "Log terminal" });
  expect(workflow.nextElementSibling).toContainElement(logging);
});

it("cancelling the save dialog never starts or opens a logfile", async () => {
  mocks.save.mockResolvedValue(null);
  render(<TerminalLoggingControls tabId="tab-a" terminalId="pane-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Log terminal" }));
  await waitFor(() => expect(useTerminalLoggingStore.getState().pending).toBe(false));
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it.each(["Append", "Overwrite", "Cancel"])("offers the explicit existing-file choice: %s", async (choice) => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "editor_file_exists") return true;
    return { ...active };
  });
  mocks.message.mockResolvedValue(choice);
  render(<TerminalLoggingControls tabId="tab-a" terminalId="pane-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Log terminal" }));
  await waitFor(() => expect(useTerminalLoggingStore.getState().pending).toBe(false));
  expect(mocks.message).toHaveBeenCalledWith(expect.stringContaining(active.path), expect.objectContaining({
    buttons: { yes: "Append", no: "Overwrite", cancel: "Cancel" },
  }));
  if (choice === "Cancel") {
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "terminal_log_start")).toHaveLength(0);
  } else {
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_log_start", {
      tabId: "pty-a", path: active.path, mode: choice.toLowerCase(),
    });
  }
});

it("captures the original pane before the dialog and stops that pane after focus changes", async () => {
  let finishDialog!: (value: string) => void;
  mocks.save.mockReturnValue(new Promise<string>((resolve) => { finishDialog = resolve; }));
  const { rerender } = render(<TerminalLoggingControls tabId="tab-a" terminalId="pane-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Log terminal" }));
  mocks.target = { terminalId: "pane-b", backendPtyId: "pty-b" };
  rerender(<TerminalLoggingControls tabId="tab-a" terminalId="pane-b" />);
  await act(async () => finishDialog(active.path));
  const stop = await screen.findByRole("button", { name: "Stop logging session.txt" });
  expect(mocks.invoke).toHaveBeenCalledWith("terminal_log_start", {
    tabId: "pty-a", path: active.path, mode: "create",
  });
  expect(screen.getByRole("button", { name: "Log terminal" })).toBeEnabled();
  fireEvent.click(stop);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("terminal_log_stop", { tabId: "pty-a" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop logging session.txt" })).not.toBeInTheDocument());
});

it("a closed original session is rejected visibly, without reporting logging active", async () => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "editor_file_exists") return false;
    throw new Error("terminal is no longer active");
  });
  render(<TerminalLoggingControls tabId="tab-a" terminalId="pane-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Log terminal" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("terminal is no longer active");
  expect(screen.queryByRole("button", { name: /Stop logging/ })).not.toBeInTheDocument();
});

it("writer failure events clear the active indicator and expose incomplete-log errors", async () => {
  render(<TerminalLoggingControls tabId="tab-a" terminalId="pane-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Log terminal" }));
  await screen.findByRole("button", { name: "Stop logging session.txt" });
  await useTerminalLoggingStore.getState().initListener();
  const handler = mocks.listen.mock.calls[0][1];
  act(() => handler({ payload: { ...active, active: false, error: "Log incomplete: disk full" } }));
  expect(screen.getByRole("alert")).toHaveTextContent("Log incomplete: disk full");
  expect(screen.queryByRole("button", { name: /Stop logging/ })).not.toBeInTheDocument();
});

it("an old logfile event cannot stop a newer logfile on the same pane", async () => {
  await useTerminalLoggingStore.getState().start("tab-a", mocks.target, active.path, "create");
  useTerminalLoggingStore.getState().receive({ ...active, id: "old-log", active: false });
  expect(useTerminalLoggingStore.getState().logs["pty-a"].active).toBe(true);
});

it("a delayed status response cannot resurrect a logfile after its stopped event", async () => {
  await useTerminalLoggingStore.getState().start("tab-a", mocks.target, active.path, "create");
  let finishStatus!: (value: TerminalLogStatus) => void;
  mocks.invoke.mockReturnValueOnce(new Promise<TerminalLogStatus>((resolve) => { finishStatus = resolve; }));
  const refresh = useTerminalLoggingStore.getState().refresh("tab-a", mocks.target);
  useTerminalLoggingStore.getState().receive({ ...active, active: false, error: "disk full" });
  finishStatus(active);
  await refresh;
  expect(useTerminalLoggingStore.getState().logs["pty-a"]).toMatchObject({ active: false, error: "disk full" });
});
