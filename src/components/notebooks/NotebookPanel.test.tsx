import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NotebookPanel } from "./NotebookPanel";
import type { RunnableNotebookDto } from "../../lib/runnableNotebook";
import { useNotebookRuns } from "../../state/notebookRunsStore";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  channelInstances: [] as Array<{ onmessage?: (e: unknown) => void }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    onmessage?: (e: unknown) => void;
    constructor() {
      mocks.channelInstances.push(this);
    }
  },
}));

const sampleNotebook: RunnableNotebookDto = {
  id: "nb-1",
  frontmatter: {
    title: "Test MOP",
    description: "test",
    vendor: "cisco",
    platform: "iosxe",
    parameters: [{ name: "host", prompt: "Host", default: "1.1.1.1" }],
  },
  cells: [
    { type: "parameter", params: [{ name: "host", prompt: "Host", default: "1.1.1.1" }] },
    { type: "markdown", content: "# Step 1" },
    {
      type: "command",
      content: "show version",
      metadata: {},
    },
    { type: "approval", content: "Continue?" },
    {
      type: "assertion",
      spec: {
        command: "show version",
        jsonpath: "$.version",
        op: "equals",
        expected: "17.09.04",
      },
    },
  ],
  body_markdown: "",
  created_at: 0,
  updated_at: 0,
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.channelInstances.length = 0;
  // Clear store state
  useNotebookRuns.setState({ runs: {} });

  // Mock device list calls
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "ssh_list_connections") {
      return Promise.resolve([
        { id: "ssh-1", name: "Router1", host: "10.1.1.1", user: "admin", port: 22, password_encrypted: "enc1" },
        { id: "ssh-2", name: "Switch1", host: "10.1.1.2", user: "admin", port: 22, password_encrypted: "enc2" },
      ]);
    }
    if (cmd === "netconf_device_list") {
      return Promise.resolve([
        { id: 1, name: "XE-Device", host: "10.2.2.1" },
      ]);
    }
    if (cmd === "ssh_decrypt_password") {
      return Promise.resolve("testpass123");
    }
    return Promise.resolve(null);
  });
});

describe("NotebookPanel", () => {
  it("renders title, description and one cell per cell entry", () => {
    render(<NotebookPanel notebook={sampleNotebook} tabId="tab-1" />);
    expect(screen.getByText("Test MOP")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByTestId("cell-parameter")).toBeInTheDocument();
    expect(screen.getByTestId("cell-markdown")).toBeInTheDocument();
    expect(screen.getByTestId("cell-command")).toBeInTheDocument();
    expect(screen.getByTestId("cell-approval")).toBeInTheDocument();
    expect(screen.getByTestId("cell-assertion")).toBeInTheDocument();
  });

  it("starts a run when Run is clicked, passing params", async () => {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "ssh_list_connections") return Promise.resolve([]);
      if (cmd === "netconf_device_list") return Promise.resolve([]);
      if (cmd === "notebook_run_start") return Promise.resolve("run-xyz");
      return Promise.resolve(null);
    });

    render(<NotebookPanel notebook={sampleNotebook} tabId="tab-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("target-current-tab")).toBeInTheDocument();
    });

    const input = screen.getByTestId("param-input-host") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9.9.9.9" } });

    fireEvent.click(screen.getByTestId("toolbar-run"));
    await waitFor(() => {
      const startCall = mocks.invoke.mock.calls.find((c) => c[0] === "notebook_run_start");
      expect(startCall).toBeDefined();
    });
    const startCall = mocks.invoke.mock.calls.find((c) => c[0] === "notebook_run_start")!;
    const [name, args] = startCall;
    expect(name).toBe("notebook_run_start");
    expect((args as any).notebookId).toBe("nb-1");
    expect((args as any).tabId).toBe("tab-1");
    expect((args as any).params).toEqual({ host: "9.9.9.9" });
  });

  it("displays status updates from RunEvents", async () => {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "ssh_list_connections") return Promise.resolve([]);
      if (cmd === "netconf_device_list") return Promise.resolve([]);
      if (cmd === "notebook_run_start") return Promise.resolve("run-evt-1");
      return Promise.resolve(null);
    });

    render(<NotebookPanel notebook={sampleNotebook} tabId="tab-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("target-current-tab")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("toolbar-run"));
    await waitFor(() => expect(mocks.channelInstances.length).toBeGreaterThan(0));

    const channel = mocks.channelInstances[0]!;
    channel.onmessage?.({ type: "cell_started", cell_idx: 2 });
    channel.onmessage?.({
      type: "cell_finished",
      cell_idx: 2,
      status: "passed",
      block_id: "b-1",
      error: null,
    });
    channel.onmessage?.({ type: "run_finished", status: "completed" });

    await waitFor(() => {
      const summary = screen.getByTestId("run-summary");
      expect(summary).toHaveTextContent("1/5 passed");
      expect(summary).toHaveTextContent("completed");
    });
  });

  it("shows Continue button when an approval cell is awaiting", async () => {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "ssh_list_connections") return Promise.resolve([]);
      if (cmd === "netconf_device_list") return Promise.resolve([]);
      if (cmd === "notebook_run_start") return Promise.resolve("run-app-1");
      if (cmd === "notebook_run_approve") return Promise.resolve(undefined);
      return Promise.resolve(null);
    });

    render(<NotebookPanel notebook={sampleNotebook} tabId="tab-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("target-current-tab")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("toolbar-run"));
    await waitFor(() => expect(mocks.channelInstances.length).toBeGreaterThan(0));
    const channel = mocks.channelInstances[0]!;
    channel.onmessage?.({ type: "awaiting_approval", cell_idx: 3, prompt: "Continue?" });

    await waitFor(() => {
      expect(screen.getByTestId("approval-continue")).toBeInTheDocument();
    });

    // Click should fire notebook_run_approve.
    fireEvent.click(screen.getByTestId("approval-continue"));
    await waitFor(() => {
      const calls = mocks.invoke.mock.calls.map((c) => c[0]);
      expect(calls).toContain("notebook_run_approve");
    });
  });

  it("Stop button fires notebook_run_cancel during run", async () => {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "ssh_list_connections") return Promise.resolve([]);
      if (cmd === "netconf_device_list") return Promise.resolve([]);
      if (cmd === "notebook_run_start") return Promise.resolve("run-cancel-1");
      if (cmd === "notebook_run_cancel") return Promise.resolve(undefined);
      return Promise.resolve(null);
    });

    render(<NotebookPanel notebook={sampleNotebook} tabId="tab-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("target-current-tab")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("toolbar-run"));
    await waitFor(() => expect(mocks.channelInstances.length).toBeGreaterThan(0));
    const channel = mocks.channelInstances[0]!;
    channel.onmessage?.({ type: "cell_started", cell_idx: 2 });

    fireEvent.click(screen.getByTestId("toolbar-stop"));
    await waitFor(() => {
      const calls = mocks.invoke.mock.calls.map((c) => c[0]);
      expect(calls).toContain("notebook_run_cancel");
    });
  });

  it("shows device selector with current tab as default", async () => {
    render(<NotebookPanel notebook={sampleNotebook} tabId="tab-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("target-current-tab")).toBeInTheDocument();
    });

    const currentTabRadio = screen.getByTestId("target-current-tab") as HTMLInputElement;
    expect(currentTabRadio.checked).toBe(true);
  });

  it("allows selecting SSH connection and passes connectionId to start", async () => {
    // Reset and set up all mocks needed for this test
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === "ssh_list_connections") {
        return Promise.resolve([
          { id: "ssh-1", name: "Router1", host: "10.1.1.1", user: "admin", port: 22, password_encrypted: "enc1" },
          { id: "ssh-2", name: "Switch1", host: "10.1.1.2", user: "admin", port: 22, password_encrypted: "enc2" },
        ]);
      }
      if (cmd === "netconf_device_list") {
        return Promise.resolve([]);
      }
      if (cmd === "ssh_decrypt_password" && args?.encrypted === "enc2") {
        return Promise.resolve("password123");
      }
      if (cmd === "notebook_run_start") {
        return Promise.resolve("run-ssh-1");
      }
      return Promise.resolve(null);
    });

    render(<NotebookPanel notebook={sampleNotebook} tabId="tab-1" />);

    // Wait for devices to load
    await waitFor(() => {
      expect(screen.getByTestId("target-ssh")).toBeInTheDocument();
    });

    // Select SSH option
    const sshRadio = screen.getByTestId("target-ssh") as HTMLInputElement;
    fireEvent.click(sshRadio);

    await waitFor(() => {
      expect(sshRadio.checked).toBe(true);
    });

    // Select specific SSH connection
    const sshSelect = screen.getByTestId("ssh-connection-select") as HTMLSelectElement;
    fireEvent.change(sshSelect, { target: { value: "ssh-2" } });

    // Start the run
    fireEvent.click(screen.getByTestId("toolbar-run"));

    await waitFor(() => {
      const startCall = mocks.invoke.mock.calls.find((c) => c[0] === "notebook_run_start");
      expect(startCall).toBeDefined();
      const args = startCall![1] as any;
      expect(args.connectionId).toBe("ssh-2");
      expect(args.password).toBe("password123");
    });
  });
});
