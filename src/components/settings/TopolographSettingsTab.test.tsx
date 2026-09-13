import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { TopolographSettingsTab } from "./TopolographSettingsTab";

const config = {
  singletonId: "topolograph",
  enabled: true,
  baseUrl: "https://topolograph.local:8080",
  secretId: "vault-topolograph",
  verifyTls: true,
  updatedAt: 1,
};

describe("TopolographSettingsTab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") return Promise.resolve([{ id: 1, occurredAt: 100, action: "test.connection", outcome: "ok", targetLabel: "topolograph", durationMs: 12 }]);
      if (command === "topolograph_config_save") return Promise.resolve();
      if (command === "vault_list_envelopes") {
        return Promise.resolve([{ id: "envelope-1", name: "Infrastructure" }]);
      }
      if (command === "vault_list_secrets") {
        return Promise.resolve([{ id: "vault-topolograph", envelopeId: "envelope-1", kind: "api_token", label: "Topolograph API token" }]);
      }
      if (command === "topolograph_test_connection") {
        return Promise.resolve({
          ok: true,
          message: "Connected",
          warnings: ["HTTP transport is not encrypted"],
          serverName: "Topolograph MCP",
          serverVersion: "1.3.1",
          latencyMs: 12.5,
          tools: ["get_all_graphs", "get_graph_status"],
          missingTools: [],
          unexpectedTools: ["future_tool"],
          stages: [
            { name: "initialize", status: "passed" },
            { name: "tool_inventory", status: "passed" },
            { name: "bounded_probe", status: "passed" },
          ],
        });
      }
      return Promise.resolve();
    });
  });

  it("normalizes the saved base URL before it crosses the Tauri boundary", async () => {
    render(<TopolographSettingsTab />);
    const baseUrl = await screen.findByLabelText("Base URL");

    fireEvent.change(baseUrl, {
      target: { value: " https://topolograph.local:8080/// " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("topolograph_config_save", {
        config: expect.objectContaining({
          baseUrl: "https://topolograph.local:8080",
        }),
      });
    });
  });

  it("renders connection identity, latency, tool inventory, and safety warnings", async () => {
    render(<TopolographSettingsTab />);
    await screen.findByLabelText("Base URL");

    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    expect(await screen.findByText("Topolograph MCP 1.3.1")).toBeInTheDocument();
    expect(screen.getByText("12.5 ms")).toBeInTheDocument();
    expect(screen.getByText("get_all_graphs, get_graph_status")).toBeInTheDocument();
    expect(screen.getByText(/Unexpected tools: future_tool/)).toBeInTheDocument();
    expect(screen.getByText("HTTP transport is not encrypted")).toBeInTheDocument();
    expect(screen.getByText("Initialize: passed")).toBeInTheDocument();
    expect(screen.getByText("Bounded probe: passed")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Action" })).toBeInTheDocument();
  });

  it("re-enables Test Connection after a failure and refreshes activity", async () => {
    let auditCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") { auditCalls += 1; return Promise.resolve([]); }
      if (command === "vault_list_envelopes") return Promise.resolve([{ id: "envelope-1", name: "Infrastructure" }]);
      if (command === "vault_list_secrets") return Promise.resolve([{ id: "vault-topolograph", envelopeId: "envelope-1", kind: "api_token", label: "Topolograph API token" }]);
      if (command === "topolograph_test_connection") return Promise.reject(new Error("failed"));
      return Promise.resolve();
    });

    render(<TopolographSettingsTab />);
    const button = await screen.findByRole("button", { name: "Test Connection" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(auditCalls).toBe(2);
  });

  it("explains that a locked Vault blocks the connection test", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      if (command === "vault_list_envelopes") return Promise.resolve([{ id: "envelope-1", name: "Infrastructure" }]);
      if (command === "vault_list_secrets") return Promise.resolve([{ id: "vault-topolograph", envelopeId: "envelope-1", kind: "api_token", label: "Topolograph API token" }]);
      if (command === "topolograph_test_connection") return Promise.reject(new Error("Topolograph Vault secret unavailable: vault is locked"));
      return Promise.resolve();
    });

    render(<TopolographSettingsTab />);
    const button = await screen.findByRole("button", { name: "Test Connection" });
    fireEvent.click(button);

    expect(await screen.findByText("Unlock the selected Vault secret and try again.")).toBeInTheDocument();
  });

  it("reports testing progress without exposing the connection payload", async () => {
    let resolveTest!: (report: object) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      if (command === "vault_list_envelopes") return Promise.resolve([{ id: "envelope-1", name: "Infrastructure" }]);
      if (command === "vault_list_secrets") return Promise.resolve([{ id: "vault-topolograph", envelopeId: "envelope-1", kind: "api_token", label: "Topolograph API token" }]);
      if (command === "topolograph_test_connection") {
        return new Promise((resolve) => { resolveTest = resolve; });
      }
      return Promise.resolve();
    });

    render(<TopolographSettingsTab />);
    await screen.findByLabelText("Base URL");
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    expect(screen.getByRole("button", { name: "Testing connection…" })).toBeInTheDocument();
    resolveTest({ ok: true, message: "Connected", warnings: [], serverName: "", serverVersion: "", latencyMs: null, tools: [], missingTools: [], unexpectedTools: [], stages: [] });
    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Connection result" })).toHaveTextContent("Connected");
    });
  });

  it("keeps Test Connection unavailable until the enabled connector is complete", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") {
        return Promise.resolve({ ...config, enabled: false, secretId: "" });
      }
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<TopolographSettingsTab />);

    expect(await screen.findByRole("button", { name: "Test Connection" })).toBeDisabled();
  });

  it("selects Vault secret metadata without revealing a secret value", async () => {
    render(<TopolographSettingsTab />);

    const secret = await screen.findByLabelText("Vault secret");
    expect(secret).toHaveValue("vault-topolograph");
    expect(screen.getByRole("option", { name: "Topolograph API token (api_token)" })).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("vault_list_envelopes");
    expect(invokeMock).toHaveBeenCalledWith("vault_list_secrets", { envelopeId: "envelope-1" });
  });

  it("makes an empty Vault metadata list safe to operate", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve({ ...config, secretId: "stale-secret" });
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      if (command === "vault_list_envelopes") return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<TopolographSettingsTab />);

    expect(await screen.findByText("No Vault secrets available. Add a secret in Vault before enabling Topolograph.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
  });

  it("blocks a stale saved Vault secret until the operator selects available metadata", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve({ ...config, secretId: "stale-secret" });
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      if (command === "vault_list_envelopes") return Promise.resolve([{ id: "envelope-1", name: "Infrastructure" }]);
      if (command === "vault_list_secrets") return Promise.resolve([{ id: "available-secret", envelopeId: "envelope-1", kind: "api_token", label: "Available token" }]);
      return Promise.resolve();
    });

    render(<TopolographSettingsTab />);

    expect(await screen.findByText("The saved Vault secret is unavailable. Select another secret before testing.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
  });

  it("reports unavailable Vault metadata without attempting to access secret values", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      if (command === "vault_list_envelopes") return Promise.reject(new Error("locked"));
      return Promise.resolve();
    });

    render(<TopolographSettingsTab />);

    expect(await screen.findByText("Vault secret metadata is unavailable. Unlock Vault or try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
  });
});
