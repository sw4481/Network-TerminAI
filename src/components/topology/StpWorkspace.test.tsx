import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Position, type Edge, type EdgeProps } from "@xyflow/react";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { StpLinkEdge, StpWorkspace } from "./TopologyIntegrationWorkspace";
import type { StpInstance, StpPort } from "../../lib/tauri";

const contractPort = {
  deviceId: "core-1",
  interface: "Gi1/0/1",
  role: "designated",
  state: "forwarding",
  cost: 4,
  bundleId: "Port-channel1",
  explicitEvidence: null,
} satisfies StpPort;

const contractInstance = {
  id: "vlan-10",
  label: "VLAN 10",
  vlan: "10",
  mode: "pvst",
  bridgeId: "32768.core-1",
  rootId: "32768.core-1",
  bridgePriority: 32768,
  rootPriority: 32768,
  rootCost: 4,
  rootPort: "Gi1/0/1",
  topologyChangeCount: 2,
  ports: [contractPort],
} satisfies StpInstance;

const edgeInstance = {
  id: "vlan-10",
  label: "VLAN 10",
  vlan: "10",
  mode: "pvst",
  bridgeId: "32768.edge-1",
  rootId: "32768.core-1",
  bridgePriority: 32768,
  rootPriority: 32768,
  rootCost: 8,
  rootPort: "Eth1/1",
  topologyChangeCount: 3,
  ports: [
    {
      deviceId: "edge-1",
      interface: "Eth1/1",
      role: "root",
      state: "forwarding",
      cost: 4,
      bundleId: "Port-channel10",
      explicitEvidence: null,
    },
    {
      deviceId: "edge-1",
      interface: "Eth1/2",
      role: "alternate",
      state: "blocking",
      cost: 19,
      bundleId: null,
      explicitEvidence: "Peer priority is lower",
    },
  ],
} satisfies StpInstance;

const completeSnapshot = {
  id: "snapshot-complete",
  startedAt: 1_700_000_000,
  status: "complete",
  baselineEligible: true,
  payload: {
    devices: [
      { deviceId: "core-1", platform: "iosxe" },
      { deviceId: "edge-1", platform: "nxos" },
    ],
    instances: [
      {
        ...contractInstance,
      },
      edgeInstance,
      {
        id: "mst-0",
        label: "MST 0",
        mode: "mst",
        bridgeId: "32768.edge-1",
        rootId: "32768.core-1",
        bridgePriority: 32768,
        rootPriority: 32768,
        rootCost: 12,
        rootPort: "Eth1/1",
        topologyChangeCount: 1,
        mstRegion: "campus/1/abc123",
        ports: [
          {
            deviceId: "edge-1",
            interface: "Eth1/1",
            role: "root",
            state: "forwarding",
          },
        ],
      },
    ],
    links: [
      {
        id: "confirmed-link-core",
        instanceId: "vlan-10",
        localDeviceId: "core-1",
        remoteDeviceId: "edge-1",
        localInterface: "Gi1/0/1",
        bidirectional: true,
      },
      {
        id: "confirmed-link-edge",
        instanceId: "vlan-10",
        localDeviceId: "edge-1",
        remoteDeviceId: "core-1",
        localInterface: "Eth1/1",
        bidirectional: true,
      },
      {
        id: "provisional-link",
        instanceId: "mst-0",
        localDeviceId: "edge-1",
        remoteDeviceId: "core-1",
        localInterface: "Eth1/1",
        bidirectional: false,
      },
    ],
    findings: [
      { kind: "ROOT_CHANGED", severity: "warning", detail: "Root changed" },
    ],
    gaps: [{ source: "neighbors", code: "lldp_missing" }],
  },
};

const partialSnapshot = {
  ...completeSnapshot,
  id: "snapshot-partial",
  startedAt: 1_700_000_100,
  status: "partial",
  baselineEligible: false,
  payload: {
    ...completeSnapshot.payload,
    instances: [completeSnapshot.payload.instances[1]],
    links: [completeSnapshot.payload.links[1]],
  },
};

function failedSnapshot(errorSummary: string) {
  return {
    ...completeSnapshot,
    id: `snapshot-failed-${errorSummary}`,
    status: "failed",
    baselineEligible: false,
    errorSummary,
    payload: {
      devices: [],
      instances: [],
      links: [],
      findings: [],
      gaps: [],
    },
  };
}

function configureInvoke(snapshots = [partialSnapshot, completeSnapshot]) {
  invokeMock.mockImplementation((command: string, args?: { settings?: object }) => {
    if (command === "stp_snapshot_list") return Promise.resolve(snapshots);
    if (command === "stp_settings_get") {
      return Promise.resolve({ scheduleEnabled: false, intervalMinutes: 60 });
    }
    if (command === "stp_settings_save") {
      return Promise.resolve(args?.settings);
    }
    return Promise.resolve(undefined);
  });
}

describe("StpWorkspace", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    configureInvoke();
  });

  it("accepts legacy instances with omitted optional summaries and nullable port evidence", () => {
    const legacyContractInstance: StpInstance = {
      id: "legacy",
      label: null,
      vlan: null,
      mode: null,
      bridgeId: null,
      rootId: null,
      ports: [{
        deviceId: "core-1",
        interface: "Gi1/0/2",
        role: null,
        state: null,
        cost: null,
        bundleId: null,
        explicitEvidence: null,
      }],
    } satisfies StpInstance;

    expect(legacyContractInstance.bridgePriority).toBeUndefined();
    expect(legacyContractInstance.rootPriority).toBeUndefined();
    expect(legacyContractInstance.rootCost).toBeUndefined();
    expect(legacyContractInstance.rootPort).toBeUndefined();
    expect(legacyContractInstance.ports[0].cost).toBeNull();
    expect(legacyContractInstance.ports[0].bundleId).toBeNull();
    expect(legacyContractInstance.ports[0].explicitEvidence).toBeNull();
  });

  it("switches the selected snapshot and suppresses partial domain summaries", async () => {
    render(<StpWorkspace />);

    expect(await screen.findByTestId("stp-snapshot-snapshot-partial")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("stp-partial-notice")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("stp-snapshot-snapshot-complete"));

    expect(screen.getByTestId("stp-snapshot-snapshot-complete")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByTestId("stp-partial-notice")).not.toBeInTheDocument();
    expect(screen.getByTestId("stp-summary-root-bridge")).toHaveTextContent(
      "32768.core-1",
    );
  });

  it("renders compact device nodes and only real links for the selected instance", async () => {
    render(<StpWorkspace />);
    fireEvent.click(await screen.findByTestId("stp-snapshot-snapshot-complete"));

    fireEvent.change(screen.getByLabelText("VLAN/MST instance"), {
      target: { value: "vlan-10" },
    });
    const rootNode = screen.getByTestId("stp-node-core-1");
    expect(rootNode).toHaveTextContent("core-1");
    expect(rootNode).toHaveTextContent("iosxe");
    expect(rootNode).toHaveTextContent("Root bridge");
    expect(rootNode).toHaveTextContent("1 port");
    expect(rootNode).toHaveTextContent("1 neighbor");
    expect(rootNode).not.toHaveTextContent("Gi1/0/1");
    expect(screen.getByTestId("stp-neighbor-confirmed-link-core")).toHaveTextContent("Confirmed");
    expect(screen.queryByTestId("stp-neighbor-provisional-link")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("VLAN/MST instance"), {
      target: { value: "mst-0" },
    });
    expect(screen.queryByTestId("stp-neighbor-confirmed-link-core")).not.toBeInTheDocument();
    expect(screen.getByTestId("stp-neighbor-provisional-link")).toHaveTextContent("Provisional");
  });

  it.each([
    ["confirmed", false],
    ["provisional", true],
  ] as const)("renders %s topology evidence with the correct edge treatment", (confidence, dashed) => {
    const props = {
      id: `edge-${confidence}`,
      source: "core-1",
      target: "edge-1",
      sourceX: 0,
      sourceY: 0,
      targetX: 100,
      targetY: 100,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: { confidence },
      selected: false,
      animated: false,
      sourceHandleId: null,
      targetHandleId: null,
    } as unknown as EdgeProps<Edge<{ confidence: "confirmed" | "provisional" }, "stp">>;
    const { container } = render(<svg><StpLinkEdge {...props} /></svg>);

    const edge = container.querySelector(`[data-testid="stp-edge-edge-${confidence}"]`);
    const path = container.querySelector("path");
    expect(edge).toHaveAttribute("data-confidence", confidence);
    expect(path).toHaveClass(`stp-link__path--${confidence}`);
    expect(path?.classList.contains("stp-link__path--provisional")).toBe(dashed);
  });

  it("summarizes root, bridge, port, and topology-change evidence for one instance", async () => {
    render(<StpWorkspace />);
    fireEvent.click(await screen.findByTestId("stp-snapshot-snapshot-complete"));

    expect(screen.getByTestId("stp-summary-root-bridge")).toHaveTextContent("32768.core-1");
    expect(screen.getByTestId("stp-summary-non-root-bridges")).toHaveTextContent("1");
    expect(screen.getByTestId("stp-summary-root-ports")).toHaveTextContent("1");
    expect(screen.getByTestId("stp-summary-blocked-ports")).toHaveTextContent("1");
    expect(screen.getByTestId("stp-summary-topology-changes")).toHaveTextContent("5");
  });

  it("shows local and proven reciprocal interfaces with neighbor confidence", async () => {
    render(<StpWorkspace />);
    fireEvent.click(await screen.findByTestId("stp-snapshot-snapshot-complete"));

    const confirmed = screen.getByTestId("stp-neighbor-confirmed-link-core");
    expect(confirmed).toHaveTextContent("core-1");
    expect(confirmed).toHaveTextContent("Gi1/0/1");
    expect(confirmed).toHaveTextContent("edge-1");
    expect(confirmed).toHaveTextContent("Eth1/1");
    expect(confirmed).toHaveTextContent("Confirmed");

    fireEvent.change(screen.getByLabelText("VLAN/MST instance"), {
      target: { value: "mst-0" },
    });
    const provisional = screen.getByTestId("stp-neighbor-provisional-link");
    expect(provisional).toHaveTextContent("Not reported");
    expect(provisional).toHaveTextContent("Provisional");
  });

  it("moves selected-device bridge and port detail into the inspector", async () => {
    render(<StpWorkspace />);
    fireEvent.click(await screen.findByTestId("stp-snapshot-snapshot-complete"));

    fireEvent.click(screen.getByTestId("stp-node-edge-1"));
    const inspector = screen.getByTestId("stp-device-inspector");
    expect(inspector).toHaveTextContent("edge-1");
    expect(inspector).toHaveTextContent("Non-root bridge");
    expect(inspector).toHaveTextContent("Root port Eth1/1");
    expect(inspector).toHaveTextContent("Bridge priority 32768");
    expect(inspector).toHaveTextContent("Root priority 32768");
    expect(inspector).toHaveTextContent("Root cost 8");
    expect(inspector).toHaveTextContent("Eth1/2");
    expect(inspector).toHaveTextContent("Peer priority is lower");

    fireEvent.change(screen.getByLabelText("VLAN/MST instance"), {
      target: { value: "mst-0" },
    });
    expect(screen.getByTestId("stp-device-inspector")).toHaveTextContent(
      "MST region campus/1/abc123",
    );
  });

  it("keeps a lone device visible and names missing neighbor evidence", async () => {
    configureInvoke([{
      ...completeSnapshot,
      id: "snapshot-single-device",
      payload: {
        devices: [{ deviceId: "solo-1", platform: "iosxe" }],
        instances: [{
          id: "vlan-20",
          label: "VLAN 20",
          vlan: "20",
          mode: "pvst",
          bridgeId: "32768.solo-1",
          rootId: "32768.solo-1",
          ports: [],
        }],
        links: [],
        findings: [],
        gaps: [{ source: "neighbors", code: "no_adjacency_evidence" }],
      },
    } as unknown as typeof completeSnapshot]);

    render(<StpWorkspace />);

    expect(await screen.findByTestId("stp-node-solo-1")).toBeInTheDocument();
    expect(screen.getByTestId("stp-no-neighbor-evidence")).toHaveTextContent(
      "No neighbor evidence",
    );
  });

  it("keeps bridge and root details visible across all instances", async () => {
    render(<StpWorkspace />);
    fireEvent.click(await screen.findByTestId("stp-snapshot-snapshot-complete"));

    fireEvent.change(screen.getByLabelText("VLAN/MST instance"), {
      target: { value: "all" },
    });

    expect(screen.getByTestId("stp-all-instance-summary")).toHaveTextContent(
      "Bridge 32768.core-1",
    );
    expect(screen.getByTestId("stp-all-instance-summary")).toHaveTextContent(
      "Bridge 32768.edge-1",
    );
    expect(screen.getByTestId("stp-all-instance-summary")).toHaveTextContent(
      "Root 32768.core-1",
    );
  });

  it("renders findings and evidence gaps in separate regions", async () => {
    render(<StpWorkspace />);
    fireEvent.click(await screen.findByTestId("stp-snapshot-snapshot-complete"));

    expect(screen.getByRole("heading", { name: "Findings" }).parentElement).toHaveTextContent(
      "ROOT_CHANGED",
    );
    expect(
      screen.getByRole("heading", { name: "Evidence gaps" }).parentElement,
    ).toHaveTextContent("neighbors: lldp_missing");
  });

  it("saves enabled schedule state and the selected supported interval", async () => {
    render(<StpWorkspace />);
    const enabled = await screen.findByRole("checkbox", { name: "Schedule collection" });

    fireEvent.click(enabled);
    fireEvent.change(screen.getByLabelText("Collection interval"), {
      target: { value: "240" },
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("stp_settings_save", {
        settings: expect.objectContaining({
          scheduleEnabled: true,
          intervalMinutes: 240,
        }),
      });
    });
    expect(screen.getByText("Every 240 minutes")).toBeInTheDocument();
  });

  it("restores the prior schedule settings when persistence fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "stp_snapshot_list") return Promise.resolve([completeSnapshot]);
      if (command === "stp_settings_get") {
        return Promise.resolve({ scheduleEnabled: false, intervalMinutes: 60 });
      }
      if (command === "stp_settings_save") return Promise.reject(new Error("save_failed"));
      return Promise.resolve(undefined);
    });

    render(<StpWorkspace />);
    const enabled = await screen.findByRole("checkbox", { name: "Schedule collection" });
    fireEvent.click(enabled);

    await waitFor(() => {
      expect(enabled).not.toBeChecked();
    });
    expect(screen.getByText("Schedule disabled")).toBeInTheDocument();
  });

  it.each([
    ["unsupported_platform", "platform", "unavailable on Windows"],
    ["testbed_unavailable", "pyats", "pyATS testbed is unavailable"],
    ["no_supported_devices", "devices", "No supported IOS-XE or NX-OS devices"],
    ["collection_active", "locked", "currently locked by another run"],
  ])("renders stable failure code %s as an explicit state", async (errorSummary, state, message) => {
    configureInvoke([failedSnapshot(errorSummary)]);

    render(<StpWorkspace />);

    expect(await screen.findByTestId(`stp-state-${state}`)).toHaveTextContent(message);
  });

  it("makes the no-baseline state explicit when no snapshots exist", async () => {
    configureInvoke([]);
    render(<StpWorkspace />);

    expect((await screen.findAllByTestId("stp-state-no-baseline"))[0]).toHaveTextContent(
      "No baseline yet. Configure pyATS and collect a snapshot.",
    );
  });

  it("keeps its initial state as loading until snapshot hydration settles", () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "stp_snapshot_list") return new Promise(() => {});
      if (command === "stp_settings_get") return Promise.resolve({ scheduleEnabled: false, intervalMinutes: 60 });
      return Promise.resolve(undefined);
    });

    render(<StpWorkspace />);

    expect(screen.getByTestId("stp-state-loading")).toHaveTextContent("Loading spanning-tree snapshots");
  });
});
