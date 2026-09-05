import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as Monaco from "monaco-editor";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalConnectionState } from "../../state/terminalConnectionStore";

const sendSelectionToCisco = vi.hoisted(() => vi.fn());

vi.mock("./ciscoSelectionBridge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./ciscoSelectionBridge")>();
  return { ...actual, sendSelectionToCisco };
});

import { useTerminalConnectionStore } from "../../state/terminalConnectionStore";
import { SendSelectionToCisco } from "./SendSelectionToCisco";

function connection(
  overrides: Partial<TerminalConnectionState> = {},
): TerminalConnectionState {
  return {
    terminal_id: "terminal-core",
    backend_pty_id: "pty-core",
    connection_id: "connection-core",
    display_name: "Core",
    vendor: "cisco",
    platform: "iosxe",
    accent_color: "cyan",
    syntax_highlighting_enabled: true,
    syntax_profile: "cisco",
    lifecycle: "connected",
    ssh_command: "ssh core",
    exit_status: null,
    error: null,
    ...overrides,
  };
}

function setConnections(connections: TerminalConnectionState[]) {
  useTerminalConnectionStore.setState({
    byTerminalId: Object.fromEntries(
      connections.map((entry) => [entry.terminal_id, entry]),
    ),
    terminalIdByBackendPtyId: Object.fromEntries(
      connections.map((entry) => [entry.backend_pty_id, entry.terminal_id]),
    ),
  });
}

function editorWithSelection(text: string) {
  const selection = {
    startLineNumber: 2,
    startColumn: 1,
    endLineNumber: 3,
    endColumn: 1,
  };
  let currentText = text;
  const listeners = new Set<() => void>();
  const getValueInRange = vi.fn(() => currentText);
  const editor = {
    getSelection: vi.fn(() => selection),
    getModel: vi.fn(() => ({ getValueInRange })),
    onDidChangeCursorSelection: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  return {
    editor,
    selection,
    getValueInRange,
    setSelection: (nextText: string) => {
      currentText = nextText;
      listeners.forEach((listener) => listener());
    },
  };
}

describe("SendSelectionToCisco", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConnections([]);
  });

  it("shows only connected Cisco targets and requires selection", () => {
    setConnections([
      connection(),
      connection({
        terminal_id: "terminal-disconnected",
        backend_pty_id: "pty-disconnected",
        connection_id: "connection-disconnected",
        display_name: "Access",
        lifecycle: "disconnected",
      }),
      connection({
        terminal_id: "terminal-juniper",
        backend_pty_id: "pty-juniper",
        connection_id: "connection-juniper",
        display_name: "Edge",
        vendor: "juniper",
        platform: "junos",
        syntax_profile: "junos",
      }),
    ]);
    const { editor } = editorWithSelection("");

    render(
      <SendSelectionToCisco
        editor={editor}
        sessionId="editor-tab-1"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: "Core · iosxe" })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Access/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Edge/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText(/sent verbatim/i)).toHaveTextContent(
      "Include a trailing newline in the selection to execute the final command.",
    );
  });

  it("passes the exact editor selection and target to the bridge", async () => {
    const user = userEvent.setup();
    const selectedText = "show clock\n";
    const { editor, selection, getValueInRange } =
      editorWithSelection(selectedText);
    const onClose = vi.fn();
    setConnections([connection()]);
    sendSelectionToCisco.mockResolvedValue("sent");

    render(
      <SendSelectionToCisco
        editor={editor}
        sessionId="editor-tab-7"
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(sendSelectionToCisco).toHaveBeenCalledWith(
        expect.objectContaining({
          selection: selectedText,
          target: {
            terminalId: "terminal-core",
            backendPtyId: "pty-core",
            displayName: "Core",
            vendor: "cisco",
            platform: "iosxe",
          },
          sessionId: "editor-tab-7",
        }),
      ),
    );
    expect(getValueInRange).toHaveBeenLastCalledWith(selection);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Sent selection to Core.",
    );
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("refreshes send availability when the editor selection changes", async () => {
    const user = userEvent.setup();
    const { editor, setSelection } = editorWithSelection("");
    setConnections([connection()]);
    sendSelectionToCisco.mockResolvedValue("cancelled");

    render(
      <SendSelectionToCisco
        editor={editor}
        sessionId="editor-tab-8"
        onClose={vi.fn()}
      />,
    );

    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();

    setSelection("show interfaces\n");

    await waitFor(() => expect(sendButton).toBeEnabled());
    await user.click(sendButton);
    await waitFor(() =>
      expect(sendSelectionToCisco).toHaveBeenCalledWith(
        expect.objectContaining({ selection: "show interfaces\n" }),
      ),
    );
  });

  it("shows the result status before closing the picker", async () => {
    const user = userEvent.setup();
    const { editor } = editorWithSelection("show clock\n");
    const onClose = vi.fn();
    setConnections([connection()]);
    sendSelectionToCisco.mockResolvedValue("cancelled");

    render(
      <SendSelectionToCisco
        editor={editor}
        sessionId="editor-tab-9"
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Send canceled. Verify the Cisco target is still connected and try again.",
    );
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("does not claim success for no-target or canceled results", async () => {
    const user = userEvent.setup();
    const { editor } = editorWithSelection("show clock\n");

    const noTarget = render(
      <SendSelectionToCisco
        editor={editor}
        sessionId="editor-tab-1"
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Connect a Cisco terminal before sending."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.queryByText(/Sent selection/)).not.toBeInTheDocument();

    noTarget.unmount();
    setConnections([connection()]);
    sendSelectionToCisco.mockResolvedValue("cancelled");
    const onClose = vi.fn();
    render(
      <SendSelectionToCisco
        editor={editor}
        sessionId="editor-tab-1"
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Send canceled. Verify the Cisco target is still connected and try again.",
    );
    expect(screen.queryByText(/Sent selection/)).not.toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
