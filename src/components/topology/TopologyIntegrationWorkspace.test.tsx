import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const openDialogMock = vi.hoisted(() => vi.fn());
const openUrlMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialogMock(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

import { TopolographWorkspace } from "./TopologyIntegrationWorkspace";

const config = {
  singletonId: "topolograph",
  enabled: true,
  baseUrl: "https://topolograph.local:8080",
  apiKey: "synthetic direct key",
  verifyTls: true,
  updatedAt: 1,
};

describe("TopolographWorkspace", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openDialogMock.mockReset();
    openUrlMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") {
        return Promise.resolve([{
          id: 7,
          occurredAt: 100,
          callerKind: "tauri",
          callerId: "topolograph",
          action: "upload.lsdb",
          targetLabel: "core.log",
          outcome: "ok",
          durationMs: 14,
          errorCode: "",
        }]);
      }
      if (command === "pyats_list_supported_devices") {
        return Promise.resolve([
          { name: "CORE1", os: "iosxe" },
          { name: "EDGE1", os: "nxos" },
        ]);
      }
      if (command === "topolograph_import_lsdb_from_pyats") {
        return Promise.resolve({ ok: true, message: "LSDB collected and uploaded.", bytes: 128, warnings: [] });
      }
      if (command === "topolograph_upload_lsdb_file") {
        return Promise.resolve({ ok: true, message: "LSDB uploaded", bytes: 42, warnings: [] });
      }
      if (command === "topolograph_upload_yaml_file") {
        return Promise.resolve({ ok: true, message: "YAML uploaded", bytes: 24, warnings: [] });
      }
      return Promise.resolve();
    });
  });

  it("renders the operator dashboard landmarks and distinct upload actions", async () => {
    render(<TopolographWorkspace />);

    expect(await screen.findByTestId("topolograph-state-ready")).toHaveTextContent(
      "Ready for a native LSDB or YAML upload.",
    );
    expect(screen.getByRole("region", { name: "Topolograph workspace" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Topolograph commands" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Topolograph" })).toHaveAttribute(
      "aria-describedby",
      "topolograph-external-note",
    );
    expect(screen.getByRole("region", { name: "Topology data uploads" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "LSDB upload" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "YAML upload" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Latest result" })).toHaveTextContent(
      "No operation run yet.",
    );
    expect(screen.getByRole("region", { name: "Recent activity" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Time" })).toBeInTheDocument();
    const activityRow = screen.getByRole("row", { name: /upload\.lsdb/ });
    expect(activityRow).toHaveTextContent(new Date(100 * 1000).toLocaleString());
  });

  it("keeps a ready connector usable when activity history is unavailable", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") return Promise.reject(new Error("audit unavailable"));
      return Promise.resolve();
    });

    render(<TopolographWorkspace />);

    const button = await screen.findByRole("button", { name: "Test connection" });
    expect(button).toBeEnabled();
  });

  it("re-enables controls when the post-operation activity refresh fails", async () => {
    openDialogMock.mockResolvedValue("/private/tmp/core.log");
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") return Promise.reject(new Error("audit unavailable"));
      if (command === "topolograph_upload_lsdb_file") return Promise.resolve({ ok: true, message: "LSDB uploaded", bytes: 42, warnings: [] });
      return Promise.resolve();
    });

    render(<TopolographWorkspace />);
    const button = await screen.findByRole("button", { name: "Choose LSDB file" });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByRole("status", { name: "Latest result" })).toHaveTextContent("LSDB uploaded");
  });

  it("uploads a native-picked LSDB file using its absolute path and selected protocol", async () => {
    openDialogMock.mockResolvedValue("/private/tmp/core.log");
    render(<TopolographWorkspace />);

    await screen.findByText("core.log");
    fireEvent.change(screen.getByLabelText("LSDB protocol"), { target: { value: "ospfv3" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose LSDB file" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("topolograph_upload_lsdb_file", {
        request: { path: "/private/tmp/core.log", protocol: "ospfv3" },
      });
    });
    expect(screen.getByLabelText("Latest result")).toHaveTextContent("LSDB uploaded");
    expect(screen.getByRole("columnheader", { name: "Action" })).toBeInTheDocument();
  });

  it("fetches LSDB from the explicitly selected saved pyATS device and protocol", async () => {
    render(<TopolographWorkspace />);

    const device = await screen.findByRole("combobox", { name: "pyATS device" });
    expect(screen.getByText("Read-only collection from the saved pyATS testbed.")).toBeInTheDocument();
    expect(device).toHaveValue("CORE1");

    fireEvent.change(device, { target: { value: "EDGE1" } });
    fireEvent.change(screen.getByRole("combobox", { name: "LSDB protocol" }), {
      target: { value: "isis" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fetch from switch" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("topolograph_import_lsdb_from_pyats", {
        request: {
          device: "EDGE1",
          protocol: "isis",
          description: null,
        },
      });
    });
    expect(screen.getByRole("status", { name: "Latest result" })).toHaveTextContent(
      "Switch fetch: LSDB collected and uploaded.",
    );
  });

  it("disables workspace controls and announces progress while fetching from a switch", async () => {
    let resolveFetch!: (value: unknown) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      if (command === "pyats_list_supported_devices") return Promise.resolve([{ name: "CORE1", os: "iosxe" }]);
      if (command === "topolograph_import_lsdb_from_pyats") {
        return new Promise((resolve) => { resolveFetch = resolve; });
      }
      return Promise.resolve();
    });

    render(<TopolographWorkspace />);
    const fetchButton = await screen.findByRole("button", { name: "Fetch from switch" });
    fireEvent.click(fetchButton);

    expect(screen.getByRole("button", { name: "Fetching from switch…" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "pyATS device" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "LSDB protocol" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose LSDB file" })).toBeDisabled();

    resolveFetch({ ok: true, message: "LSDB collected and uploaded.", bytes: 128, warnings: [] });
    await waitFor(() => expect(fetchButton).toBeEnabled());
  });

  it("shows bounded catalog and fetch failures without exposing raw details", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      if (command === "pyats_list_supported_devices") return Promise.reject(new Error("private parser details"));
      return Promise.resolve();
    });

    const { unmount } = render(<TopolographWorkspace />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved pyATS devices could not be loaded.");
    expect(screen.queryByText(/private parser details/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fetch from switch" })).toBeDisabled();
    unmount();

    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      if (command === "pyats_list_supported_devices") return Promise.resolve([{ name: "CORE1", os: "iosxe" }]);
      if (command === "topolograph_import_lsdb_from_pyats") return Promise.reject(new Error("private raw command output"));
      return Promise.resolve();
    });

    render(<TopolographWorkspace />);
    const fetchButton = await screen.findByRole("button", { name: "Fetch from switch" });
    fireEvent.click(fetchButton);

    await waitFor(() => expect(fetchButton).toBeEnabled());
    const latest = screen.getByRole("status", { name: "Latest result" });
    expect(latest).toHaveTextContent("Fetch failed. Check recent activity.");
    expect(latest).not.toHaveTextContent("private raw command output");
  });

  it("re-enables a failed upload, refreshes activity, and announces the operation", async () => {
    openDialogMock.mockResolvedValue("/private/tmp/core.log");
    let auditCalls = 0;
    let rejectUpload!: (error: Error) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") { auditCalls += 1; return Promise.resolve(auditCalls === 1 ? [] : [{ id: 8, occurredAt: 101, action: "upload.lsdb", outcome: "error", targetLabel: "core.log", durationMs: 4 }]); }
      if (command === "topolograph_upload_lsdb_file") return new Promise((_, reject) => { rejectUpload = reject; });
      return Promise.resolve();
    });

    render(<TopolographWorkspace />);
    const button = await screen.findByRole("button", { name: "Choose LSDB file" });
    fireEvent.click(button);
    expect(await screen.findByText("Uploading LSDB…")).toBeInTheDocument();
    rejectUpload(new Error("failed"));
    await waitFor(() => expect(button).toBeEnabled());
    expect(auditCalls).toBe(2);
    expect(screen.getByRole("columnheader", { name: "Outcome" })).toBeInTheDocument();
  });

  it("uploads a native-picked YAML file using its absolute path", async () => {
    openDialogMock.mockResolvedValue("/private/tmp/topology.yaml");
    render(<TopolographWorkspace />);

    await screen.findByRole("button", { name: "Choose YAML file" });
    fireEvent.click(screen.getByRole("button", { name: "Choose YAML file" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("topolograph_upload_yaml_file", { path: "/private/tmp/topology.yaml" });
    });
    expect(screen.getByLabelText("Latest result")).toHaveTextContent("YAML uploaded");
  });

  it("rejects a non-absolute picker result before file upload", async () => {
    openDialogMock.mockResolvedValue("topology.yaml");
    render(<TopolographWorkspace />);

    await screen.findByRole("button", { name: "Choose YAML file" });
    fireEvent.click(screen.getByRole("button", { name: "Choose YAML file" }));

    expect(await screen.findByLabelText("Latest result")).toHaveTextContent("Choose an absolute native file path.");
    expect(invokeMock).not.toHaveBeenCalledWith("topolograph_upload_yaml_file", expect.anything());
  });

  it("opens the configured service URL through Tauri instead of a browser popup", async () => {
    render(<TopolographWorkspace />);
    await screen.findByRole("button", { name: "Open Topolograph" });

    fireEvent.click(screen.getByRole("button", { name: "Open Topolograph" }));

    expect(openUrlMock).toHaveBeenCalledWith("https://topolograph.local:8080");
  });

  it("announces safe operation warnings in the latest result", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      if (command === "topolograph_test_connection") {
        return Promise.resolve({
          ok: true,
          message: "Connection ready",
          warnings: ["Server version was not reported."],
          serverName: "Topolograph",
          serverVersion: "",
          latencyMs: 12,
          tools: [],
          missingTools: [],
          unexpectedTools: [],
          stages: [{ name: "connection", status: "ok" }],
        });
      }
      return Promise.resolve();
    });

    render(<TopolographWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));

    const latest = await screen.findByRole("status", { name: "Latest result" });
    expect(latest).toHaveTextContent("Connection: Connection ready");
    expect(screen.getByRole("alert")).toHaveTextContent("Server version was not reported.");
  });

  it("makes the disabled connector state explicit and prevents uploads", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve({ ...config, enabled: false });
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<TopolographWorkspace />);

    expect(await screen.findByText("Topolograph is disabled in Settings.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Topolograph" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose LSDB file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose YAML file" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "LSDB protocol" })).toBeDisabled();
  });

  it("maps an empty API key to the incomplete state without Vault instructions", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve({ ...config, apiKey: "" });
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<TopolographWorkspace />);

    expect(await screen.findByTestId("topolograph-state-incomplete")).toHaveTextContent(
      "Topolograph setup is incomplete. Enter a base URL and API key in Settings.",
    );
    expect(screen.queryByTestId("topolograph-state-locked")).not.toBeInTheDocument();
    expect(screen.queryByText(/unlock.*vault/i)).not.toBeInTheDocument();
  });

  it("maps connector configuration failures to the generic failed state without Vault instructions", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.reject(new Error("CONNECTOR_LOCKED"));
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<TopolographWorkspace />);

    expect(await screen.findByTestId("topolograph-state-failed")).toHaveTextContent(
      "Topolograph status could not be loaded. Check Settings and recent activity.",
    );
    expect(screen.queryByTestId("topolograph-state-locked")).not.toBeInTheDocument();
    expect(screen.queryByText(/unlock.*vault/i)).not.toBeInTheDocument();
  });
});
