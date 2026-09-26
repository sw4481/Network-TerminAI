import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { TopolographSettingsTab } from "./TopolographSettingsTab";
import type { TopolographConfig } from "../../lib/tauri";

const config: TopolographConfig = {
  singletonId: "topolograph",
  enabled: true,
  baseUrl: "https://topolograph.local:8080",
  apiKey: "synthetic direct key",
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

  it("renders direct API-key entry and never loads Topolograph Vault metadata", async () => {
    render(<TopolographSettingsTab />);

    const apiKey = await screen.findByLabelText("API key");
    expect(apiKey).toHaveAttribute("type", "password");
    expect(apiKey).toHaveValue("synthetic direct key");
    expect(screen.getAllByText("Warning: this API key is stored unencrypted in TerminAI's local database.")).toHaveLength(2);
    expect(invokeMock.mock.calls.some(([command]) => command === "vault_list_envelopes")).toBe(false);
    expect(invokeMock.mock.calls.some(([command]) => command === "vault_list_secrets")).toBe(false);
  });

  it("normalizes the saved base URL before it crosses the Tauri boundary", async () => {
    render(<TopolographSettingsTab />);
    const baseUrl = await screen.findByLabelText("Base URL");

    fireEvent.change(baseUrl, {
      target: { value: " https://topolograph.local:8080/// " },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "current save key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("topolograph_config_save", {
        config: expect.objectContaining({
          baseUrl: "https://topolograph.local:8080",
          apiKey: "current save key",
        }),
      });
    });
  });

  it("renders connection identity, latency, tool inventory, and safety warnings", async () => {
    render(<TopolographSettingsTab />);
    await screen.findByLabelText("Base URL");

    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "current test key" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("topolograph_test_connection", {
        config: expect.objectContaining({ apiKey: "current test key" }),
      });
    });

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
      if (command === "topolograph_test_connection") return Promise.reject(new Error("failed"));
      return Promise.resolve();
    });

    render(<TopolographSettingsTab />);
    const button = await screen.findByRole("button", { name: "Test Connection" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(auditCalls).toBe(2);
  });

  it("reports testing progress without exposing the connection payload", async () => {
    let resolveTest!: (report: object) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") return Promise.resolve(config);
      if (command === "topolograph_audit_list") return Promise.resolve([]);
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

  it("disables Test Connection and gives actionable guidance when the enabled connector has no API key", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "topolograph_config_get") {
        return Promise.resolve({ ...config, apiKey: "" });
      }
      if (command === "topolograph_audit_list") return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<TopolographSettingsTab />);

    expect(await screen.findByRole("button", { name: "Test Connection" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Enable the connector and enter a base URL and API key before testing.");
  });
});
