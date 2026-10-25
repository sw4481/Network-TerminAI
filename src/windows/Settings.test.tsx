import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/tauri")>(),
  ...Object.fromEntries([
    "stealthwatchGetConfig", "iseGetConfig", "cmlGetConfig", "catalystCenterGetConfig",
    "splunkGetConfig", "aciGetConfig", "fmcGetConfig", "thousandeyesGetConfig",
    "merakiGetConfig", "secureEndpointGetConfig", "ciscoXdrGetConfig",
  ].map(name => [name, vi.fn().mockResolvedValue(null)])),
  aiGetConfig: vi.fn(),
  aiSaveConfig: vi.fn(),
  agentCatalogUpdateStart: vi.fn(),
  agentCatalogUpdateStatus: vi.fn(async (agentId: string) => ({ agent_id: agentId, catalog_id: agentId.replace(/-/g, "_"), job_id: null, state: "idle", phase: null, added: 0, already_known: 0, skipped: 0, warnings: [], source_urls: [], checked_at: null, error: null })),
  contextGraphGetEnabled: vi.fn().mockResolvedValue(false),
  contextGraphGetStaleness: vi.fn().mockResolvedValue(7200),
}));

import { aiGetConfig, aiSaveConfig, agentCatalogUpdateStart, agentCatalogUpdateStatus, type CiscoApiProduct } from "../lib/tauri";

const ciscoPages: [string, CiscoApiProduct][] = [
  ["Stealthwatch", "stealthwatch"], ["ISE", "ise"], ["CML", "cml"],
  ["Catalyst Center", "catalyst-center"], ["Splunk", "splunk"], ["ACI", "aci"],
  ["FMC", "fmc"], ["ThousandEyes", "thousandeyes"], ["Meraki", "meraki"],
  ["Secure Endpoint", "secure-endpoint"], ["Cisco XDR", "cisco-xdr"],
];

describe("Cisco API update routes", () => {
  it.each(ciscoPages)("%s updates only its own product", async (label, agentId) => {
    vi.mocked(agentCatalogUpdateStart).mockResolvedValue({ agent_id: agentId, catalog_id: agentId.replace(/-/g, "_"), job_id: "job", state: "completed", phase: null, added: 1, already_known: 0, skipped: 0, warnings: [], source_urls: [], checked_at: "2026-10-16T12:00:00Z", error: null });
    render(<Settings isOpen onClose={() => {}} />);
    const heading = screen.getByRole("heading", { name: "Cisco" });
    const tab = screen.getByRole("button", { name: label });
    expect(heading.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(tab);
    const update = await screen.findByRole("button", { name: `Update APIs for ${label}` });
    await waitFor(() => expect(update).toBeEnabled());
    expect(agentCatalogUpdateStatus).toHaveBeenCalledExactlyOnceWith(agentId);
    fireEvent.click(update);
    await waitFor(() => expect(agentCatalogUpdateStart).toHaveBeenCalledExactlyOnceWith(agentId));
    expect(screen.getAllByRole("button", { name: /Update APIs for/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(screen.queryByRole("button", { name: /Update APIs for/ })).not.toBeInTheDocument();
  });
});
import { Settings } from "./Settings";

const savedConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  apiKey: "",
  baseUrl: "",
  maxAgentSteps: 42,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(aiGetConfig).mockResolvedValue(savedConfig);
  vi.mocked(aiSaveConfig).mockResolvedValue(undefined);
});

describe("Settings general AI configuration", () => {
  it("loads and saves a global step limit without changing the provider settings", async () => {
    render(<Settings isOpen onClose={() => {}} />);
    const steps = await screen.findByRole("textbox", { name: "Maximum agent steps" });
    await waitFor(() => expect(steps).toHaveValue("42"));
    expect(steps).toHaveAccessibleDescription(/DeepAgents.*graph steps.*60.*Legacy.*12\/16.*next turn/i);

    fireEvent.change(steps, { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Configuration" }));
    await waitFor(() => expect(aiSaveConfig).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: undefined,
      baseUrl: undefined,
      maxAgentSteps: 200,
    }));
    expect(await screen.findByText(/Configuration saved successfully/)).toBeInTheDocument();
  });

  it("leaves engine defaults in effect when the saved limit is absent or cleared", async () => {
    vi.mocked(aiGetConfig).mockResolvedValue({ ...savedConfig, maxAgentSteps: null });
    render(<Settings isOpen onClose={() => {}} />);
    const steps = await screen.findByRole("textbox", { name: "Maximum agent steps" });
    expect(steps).toHaveValue("");

    fireEvent.change(steps, { target: { value: "1" } });
    fireEvent.change(steps, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Configuration" }));
    await waitFor(() => expect(aiSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ maxAgentSteps: null })));
  });

  it.each(["0", "-1", "1.5", "501", "1e2", "not a number"])(
    "rejects an invalid step limit (%s) without saving",
    async (value) => {
      render(<Settings isOpen onClose={() => {}} />);
      const steps = await screen.findByRole("textbox", { name: "Maximum agent steps" });
      fireEvent.change(steps, { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "Save Configuration" }));
      expect(aiSaveConfig).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent("Maximum agent steps must be a whole number from 1 to 500.");
    },
  );

  it.each(["1", "500"])("accepts the inclusive boundary %s", async (value) => {
    render(<Settings isOpen onClose={() => {}} />);
    const steps = await screen.findByRole("textbox", { name: "Maximum agent steps" });
    fireEvent.change(steps, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save Configuration" }));
    await waitFor(() => expect(aiSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ maxAgentSteps: Number(value) }),
    ));
  });
});
