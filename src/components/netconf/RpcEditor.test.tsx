import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RpcEditor } from "./RpcEditor";
import { useNetconfRunner } from "../../state/netconfRunnerStore";
import * as tauri from "../../lib/tauri";

vi.mock("../../state/netconfRunnerStore");
vi.mock("../../lib/tauri");

describe("RpcEditor", () => {
  const mockPatch = vi.fn();
  const mockOnSend = vi.fn();
  const mockOnToggleHistory = vi.fn();
  const mockOnToggleSavedRpcs = vi.fn();

  const defaultState = {
    status: "connected" as const,
    editor_mode: "xml" as const,
    cli_platform: "iosxe" as const,
    rpc_xml: "",
    response: null,
    sending: false,
    rpc_error: null,
    host: "192.168.1.1",
    port: 830,
    username: "admin",
    password: "admin",
    session_id: null,
    server_session_id: null,
    capabilities: [],
    framing: null,
    connection_error: null,
    save_as_device: false,
    device_name: "",
    selected_device_id: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useNetconfRunner as any).mockReturnValue(mockPatch);
  });

  it("shows CLI help banner in CLI mode", () => {
    const cliState = { ...defaultState, editor_mode: "cli" as const };
    render(
      <RpcEditor
        tabId="test-tab"
        state={cliState}
        onSend={mockOnSend}
        historyOpen={false}
        onToggleHistory={mockOnToggleHistory}
        savedRpcsOpen={false}
        onToggleSavedRpcs={mockOnToggleSavedRpcs}
      />
    );

    expect(
      screen.getByText(/auto-wrapped via Cisco-IOS-XE-cli-rpc/i)
    ).toBeInTheDocument();
  });

  it("does not show CLI help banner in XML mode", () => {
    render(
      <RpcEditor
        tabId="test-tab"
        state={defaultState}
        onSend={mockOnSend}
        historyOpen={false}
        onToggleHistory={mockOnToggleHistory}
        savedRpcsOpen={false}
        onToggleSavedRpcs={mockOnToggleSavedRpcs}
      />
    );

    expect(
      screen.queryByText(/auto-wrapped via Cisco-IOS-XE-cli-rpc/i)
    ).not.toBeInTheDocument();
  });

  it("shows Preview XML button in CLI mode", () => {
    const cliState = { ...defaultState, editor_mode: "cli" as const };
    render(
      <RpcEditor
        tabId="test-tab"
        state={cliState}
        onSend={mockOnSend}
        historyOpen={false}
        onToggleHistory={mockOnToggleHistory}
        savedRpcsOpen={false}
        onToggleSavedRpcs={mockOnToggleSavedRpcs}
      />
    );

    expect(screen.getByTestId("netconf-preview-xml")).toBeInTheDocument();
  });

  it("Preview XML button is disabled when no CLI text", () => {
    const cliState = { ...defaultState, editor_mode: "cli" as const, rpc_xml: "" };
    render(
      <RpcEditor
        tabId="test-tab"
        state={cliState}
        onSend={mockOnSend}
        historyOpen={false}
        onToggleHistory={mockOnToggleHistory}
        savedRpcsOpen={false}
        onToggleSavedRpcs={mockOnToggleSavedRpcs}
      />
    );

    const previewButton = screen.getByTestId("netconf-preview-xml");
    expect(previewButton).toBeDisabled();
  });

  it("opens preview modal when Preview XML is clicked", async () => {
    const wrappedXml = "<edit-config><target><running/></target><config>test</config></edit-config>";
    (tauri.netconfWrapCli as any).mockResolvedValue(wrappedXml);

    const cliState = {
      ...defaultState,
      editor_mode: "cli" as const,
      rpc_xml: "interface Loopback99",
    };

    render(
      <RpcEditor
        tabId="test-tab"
        state={cliState}
        onSend={mockOnSend}
        historyOpen={false}
        onToggleHistory={mockOnToggleHistory}
        savedRpcsOpen={false}
        onToggleSavedRpcs={mockOnToggleSavedRpcs}
      />
    );

    const previewButton = screen.getByTestId("netconf-preview-xml");
    fireEvent.click(previewButton);

    await waitFor(() => {
      expect(screen.getByTestId("netconf-preview-modal")).toBeInTheDocument();
      expect(screen.getByText("NETCONF XML Preview")).toBeInTheDocument();
      expect(screen.getByText(wrappedXml)).toBeInTheDocument();
    });
  });

  it("closes preview modal when Close button is clicked", async () => {
    const wrappedXml = "<edit-config>test</edit-config>";
    (tauri.netconfWrapCli as any).mockResolvedValue(wrappedXml);

    const cliState = {
      ...defaultState,
      editor_mode: "cli" as const,
      rpc_xml: "show version",
    };

    render(
      <RpcEditor
        tabId="test-tab"
        state={cliState}
        onSend={mockOnSend}
        historyOpen={false}
        onToggleHistory={mockOnToggleHistory}
        savedRpcsOpen={false}
        onToggleSavedRpcs={mockOnToggleSavedRpcs}
      />
    );

    // Open preview
    const previewButton = screen.getByTestId("netconf-preview-xml");
    fireEvent.click(previewButton);

    await waitFor(() => {
      expect(screen.getByTestId("netconf-preview-modal")).toBeInTheDocument();
    });

    // Close preview
    const closeButton = screen.getByText("Close");
    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(screen.queryByTestId("netconf-preview-modal")).not.toBeInTheDocument();
    });
  });
});
