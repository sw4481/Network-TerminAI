import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { openNeighbor, type TopologyNode } from "./topology";

function makeNode(overrides: Partial<TopologyNode> = {}): TopologyNode {
  return {
    graph_id: "00000000-0000-0000-0000-0000000000g1",
    device_ref: "core-sw-01",
    device_kind: "discovered",
    label: "core-sw-01",
    mgmt_ip: "10.0.0.2",
    ...overrides,
  };
}

describe("openNeighbor", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("opens an SSH tab when neighbor resolves to a saved SSH connection", async () => {
    invokeMock.mockResolvedValue({ kind: "ssh", device_ref: "10.0.0.2" });
    const onOpenSshTab = vi.fn();
    const onOpenNetconfTab = vi.fn();
    const onUnknownNeighbor = vi.fn();

    const node = makeNode();
    await openNeighbor(node, {
      onOpenSshTab,
      onOpenNetconfTab,
      onUnknownNeighbor,
    });

    expect(invokeMock).toHaveBeenCalledWith("device_lookup_by_ref", {
      ref: "10.0.0.2",
    });
    expect(onOpenSshTab).toHaveBeenCalledWith("10.0.0.2");
    expect(onOpenSshTab).toHaveBeenCalledTimes(1);
    expect(onOpenNetconfTab).not.toHaveBeenCalled();
    expect(onUnknownNeighbor).not.toHaveBeenCalled();
  });

  it("opens a NETCONF tab when neighbor resolves to a saved NETCONF device", async () => {
    invokeMock.mockResolvedValue({ kind: "netconf", device_ref: "10.0.0.2" });
    const onOpenSshTab = vi.fn();
    const onOpenNetconfTab = vi.fn();
    const onUnknownNeighbor = vi.fn();

    const node = makeNode();
    await openNeighbor(node, {
      onOpenSshTab,
      onOpenNetconfTab,
      onUnknownNeighbor,
    });

    expect(onOpenNetconfTab).toHaveBeenCalledWith("10.0.0.2");
    expect(onOpenNetconfTab).toHaveBeenCalledTimes(1);
    expect(onOpenSshTab).not.toHaveBeenCalled();
    expect(onUnknownNeighbor).not.toHaveBeenCalled();
  });

  it("calls onUnknownNeighbor with the original node when lookup returns null", async () => {
    invokeMock.mockResolvedValue(null);
    const onOpenSshTab = vi.fn();
    const onOpenNetconfTab = vi.fn();
    const onUnknownNeighbor = vi.fn();

    const node = makeNode();
    await openNeighbor(node, {
      onOpenSshTab,
      onOpenNetconfTab,
      onUnknownNeighbor,
    });

    expect(onUnknownNeighbor).toHaveBeenCalledWith(node);
    expect(onUnknownNeighbor).toHaveBeenCalledTimes(1);
    expect(onOpenSshTab).not.toHaveBeenCalled();
    expect(onOpenNetconfTab).not.toHaveBeenCalled();
  });

  it("falls back to onUnknownNeighbor when device_lookup_by_ref throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("command not found"));
    const onOpenSshTab = vi.fn();
    const onOpenNetconfTab = vi.fn();
    const onUnknownNeighbor = vi.fn();

    const node = makeNode();
    await expect(
      openNeighbor(node, {
        onOpenSshTab,
        onOpenNetconfTab,
        onUnknownNeighbor,
      }),
    ).resolves.toBeUndefined();

    expect(onUnknownNeighbor).toHaveBeenCalledWith(node);
    expect(onOpenSshTab).not.toHaveBeenCalled();
    expect(onOpenNetconfTab).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("falls back to device_ref when mgmt_ip is undefined", async () => {
    invokeMock.mockResolvedValue(null);
    const onOpenSshTab = vi.fn();
    const onOpenNetconfTab = vi.fn();
    const onUnknownNeighbor = vi.fn();

    const node = makeNode({ mgmt_ip: undefined, device_ref: "edge-rtr-7" });
    await openNeighbor(node, {
      onOpenSshTab,
      onOpenNetconfTab,
      onUnknownNeighbor,
    });

    expect(invokeMock).toHaveBeenCalledWith("device_lookup_by_ref", {
      ref: "edge-rtr-7",
    });
    expect(onUnknownNeighbor).toHaveBeenCalledWith(node);
  });
});
