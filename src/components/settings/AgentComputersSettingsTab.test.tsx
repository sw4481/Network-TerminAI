import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { AgentComputersSettingsTab } from "./AgentComputersSettingsTab";

const config = {
  computers: [{
    name: "worker-1",
    node: "pve1",
    vmid: "120",
    baseUrl: "http://10.0.0.10:8765",
    token: "secret",
  }],
};

describe("AgentComputersSettingsTab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_computers_get_config") return Promise.resolve(config);
      if (command === "agent_computers_save_config") return Promise.resolve();
      if (command === "agent_computer_test") return Promise.resolve({ ok: true, message: "Connected" });
      if (command === "agent_computer_start") return Promise.resolve({ ok: true, message: "Started" });
      if (command === "agent_computer_stop") return Promise.resolve({ ok: true, message: "Stopped" });
      if (command === "agent_computer_provision") return Promise.resolve({ ok: true, message: "Provisioned", computer: { ...config.computers[0], baseUrl: "pct://pve1/120", token: "generated" } });
      if (command === "proxmox_list_inventory") return Promise.resolve({
        nodes: [{ node: "pve1", status: "online" }, { node: "pve2", status: "online" }],
        templates: [{ node: "pve1", vmid: "9000", name: "ubuntu-template" }],
      });
      return Promise.resolve();
    });
  });

  it("loads and saves the registry", async () => {
    render(<AgentComputersSettingsTab />);

    expect(await screen.findByDisplayValue("worker-1")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: " http://agent:8765/ " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("agent_computers_save_config", {
        config: { computers: [expect.objectContaining({ baseUrl: "http://agent:8765", name: "worker-1" })] },
      });
    });
  });

  it("tests the selected computer without saving", async () => {
    render(<AgentComputersSettingsTab />);

    await screen.findByDisplayValue("worker-1");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("agent_computer_test", {
        computer: expect.objectContaining({ name: "worker-1" }),
      });
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Connected");
  });

  it("starts and stops the saved current computer", async () => {
    render(<AgentComputersSettingsTab />);

    await screen.findByDisplayValue("worker-1");
    fireEvent.click(screen.getByRole("button", { name: "Start LXC" }));
    await screen.findByText("Started");
    fireEvent.click(screen.getByRole("button", { name: "Stop LXC" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("agent_computer_start", { computer: expect.objectContaining({ name: "worker-1", vmid: "120" }) });
      expect(invokeMock).toHaveBeenCalledWith("agent_computer_stop", { computer: expect.objectContaining({ name: "worker-1", vmid: "120" }) });
    });
  });

  it("requires save before starting edited LXC values", async () => {
    render(<AgentComputersSettingsTab />);

    await screen.findByDisplayValue("worker-1");
    fireEvent.change(screen.getByLabelText("LXC VMID"), { target: { value: "121" } });

    expect(screen.getByRole("button", { name: "Start LXC" })).toBeDisabled();
  });

  it("does not mark a saved trailing-slash URL as dirty", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_computers_get_config") return Promise.resolve({
        computers: [{ ...config.computers[0], baseUrl: "http://agent:8765/" }],
      });
      if (command === "proxmox_list_inventory") return Promise.resolve({
        nodes: [{ node: "pve1", status: "online" }],
        templates: [{ node: "pve1", vmid: "9000", name: "ubuntu-template" }],
      });
      return Promise.resolve({ ok: true, message: "OK" });
    });
    render(<AgentComputersSettingsTab />);

    await screen.findByDisplayValue("http://agent:8765/");

    expect(screen.getByRole("button", { name: "Start LXC" })).not.toBeDisabled();
  });

  it("keeps a saved node visible when inventory does not include it", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_computers_get_config") return Promise.resolve({
        computers: [{ ...config.computers[0], node: "pve3" }],
      });
      if (command === "proxmox_list_inventory") return Promise.resolve({
        nodes: [{ node: "pve1", status: "online" }, { node: "pve2", status: "online" }],
        templates: [{ node: "pve1", vmid: "9000", name: "ubuntu-template" }],
      });
      return Promise.resolve({ ok: true, message: "OK" });
    });
    render(<AgentComputersSettingsTab />);

    expect(await screen.findByRole("combobox", { name: "Proxmox node" })).toHaveDisplayValue("pve3");
  });

  it("enumerates templates when saved node casing differs from inventory", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_computers_get_config") return Promise.resolve({
        computers: [{ ...config.computers[0], node: "Proxmox3", templateVmid: "110" }],
      });
      if (command === "proxmox_list_inventory") return Promise.resolve({
        nodes: [{ node: "proxmox3", status: "online" }],
        templates: [{ node: "proxmox3", vmid: "110", name: "agent-template" }],
      });
      return Promise.resolve({ ok: true, message: "OK" });
    });
    render(<AgentComputersSettingsTab />);

    expect(await screen.findByRole("combobox", { name: "Proxmox node" })).toHaveDisplayValue("proxmox3");
    expect(screen.getByRole("combobox", { name: "Template VMID" })).toHaveDisplayValue("110 — agent-template");
  });

  it("disables edits while initial load is pending", async () => {
    let resolveConfig: (value: typeof config) => void = () => {};
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_computers_get_config") return new Promise<typeof config>((resolve) => { resolveConfig = resolve; });
      if (command === "proxmox_list_inventory") return Promise.resolve({
        nodes: [{ node: "pve1", status: "online" }],
        templates: [{ node: "pve1", vmid: "9000", name: "ubuntu-template" }],
      });
      return Promise.resolve({ ok: true, message: "OK" });
    });
    render(<AgentComputersSettingsTab />);

    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Provision LXC" })).toBeDisabled();

    resolveConfig(config);
    await waitFor(() => expect(screen.getByLabelText("Name")).not.toBeDisabled());
  });

  it("disables edits while save is pending", async () => {
    let resolveSave: () => void = () => {};
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_computers_get_config") return Promise.resolve(config);
      if (command === "proxmox_list_inventory") return Promise.resolve({
        nodes: [{ node: "pve1", status: "online" }],
        templates: [{ node: "pve1", vmid: "9000", name: "ubuntu-template" }],
      });
      if (command === "agent_computers_save_config") return new Promise<void>((resolve) => { resolveSave = resolve; });
      return Promise.resolve({ ok: true, message: "OK" });
    });
    render(<AgentComputersSettingsTab />);

    await screen.findByDisplayValue("worker-1");
    fireEvent.change(screen.getByLabelText("Bearer token"), { target: { value: "first-edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByLabelText("Bearer token")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Provision LXC" })).toBeDisabled();

    resolveSave();
    await waitFor(() => expect(screen.getByLabelText("Bearer token")).not.toBeDisabled());
  });

  it("disables provisioning while provision is pending", async () => {
    let resolveProvision: () => void = () => {};
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_computers_get_config") return Promise.resolve(config);
      if (command === "proxmox_list_inventory") return Promise.resolve({
        nodes: [{ node: "pve1", status: "online" }],
        templates: [{ node: "pve1", vmid: "9000", name: "ubuntu-template" }],
      });
      if (command === "agent_computer_provision") return new Promise((resolve) => {
        resolveProvision = () => resolve({ ok: true, message: "Provisioned", computer: { ...config.computers[0], baseUrl: "pct://pve1/120", token: "generated" } });
      });
      return Promise.resolve({ ok: true, message: "OK" });
    });
    render(<AgentComputersSettingsTab />);

    await screen.findByDisplayValue("worker-1");
    fireEvent.click(screen.getByRole("button", { name: "Provision LXC" }));

    expect(screen.getByRole("button", { name: "Provision LXC" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Provision LXC" }));

    resolveProvision();
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === "agent_computer_provision")).toHaveLength(1));
  });

  it("prepopulates Proxmox node and template VMID selectors", async () => {
    render(<AgentComputersSettingsTab />);

    expect(await screen.findByRole("combobox", { name: "Proxmox node" })).toHaveDisplayValue("pve1");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Template VMID" })).toHaveDisplayValue("9000 — ubuntu-template"));
  });

  it("preserves a saved node even when templates exist on another node", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_computers_get_config") return Promise.resolve(config);
      if (command === "proxmox_list_inventory") return Promise.resolve({
        nodes: [{ node: "pve1", status: "online" }, { node: "pve2", status: "online" }],
        templates: [{ node: "pve2", vmid: "9000", name: "pve2-template" }],
      });
      return Promise.resolve({ ok: true, message: "OK" });
    });
    render(<AgentComputersSettingsTab />);

    expect(await screen.findByRole("combobox", { name: "Proxmox node" })).toHaveDisplayValue("pve1");
    expect(screen.queryByRole("combobox", { name: "Template VMID" })).not.toBeInTheDocument();
  });

  it("defaults an unsaved computer to the first template node", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_computers_get_config") return Promise.resolve({ computers: [] });
      if (command === "proxmox_list_inventory") return Promise.resolve({
        nodes: [{ node: "pve1", status: "online" }, { node: "pve2", status: "online" }],
        templates: [{ node: "pve2", vmid: "9000", name: "pve2-template" }],
      });
      return Promise.resolve({ ok: true, message: "OK" });
    });
    render(<AgentComputersSettingsTab />);

    expect(await screen.findByRole("combobox", { name: "Proxmox node" })).toHaveDisplayValue("pve2");
    expect(screen.getByRole("combobox", { name: "Template VMID" })).toHaveDisplayValue("9000 — pve2-template");
  });

  it("provisions and saves a generated LXC agent computer", async () => {
    render(<AgentComputersSettingsTab />);

    await screen.findByDisplayValue("worker-1");
    fireEvent.change(screen.getByLabelText("Template VMID"), { target: { value: "9000" } });
    fireEvent.click(screen.getByRole("button", { name: "Provision LXC" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("agent_computer_provision", {
        computer: expect.objectContaining({ name: "worker-1", vmid: "120", templateVmid: "9000" }),
      });
      expect(invokeMock).toHaveBeenCalledWith("agent_computers_save_config", {
        config: { computers: [expect.objectContaining({ baseUrl: "pct://pve1/120", token: "generated" })] },
      });
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Provisioned");
  });
});
