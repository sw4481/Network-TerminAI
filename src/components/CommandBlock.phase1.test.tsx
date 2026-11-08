import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TopologyNode } from "../lib/topology";
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("./topology/InlineTopologyPanel", () => ({
  InlineTopologyPanel: ({ storeNodes }: { storeNodes: TopologyNode[] }) => <div data-testid="inline-input">{storeNodes.map((node) => node.label).join(",")}</div>,
}));
import { CommandBlock } from "./CommandBlock";
import { useTopologyStore } from "../state/topologyStore";
import { useTabs } from "../state/tabsStore";
import { GLOBAL_GRAPH_ID } from "../lib/topology";
import type { Block } from "../state/blocksStore";
afterEach(cleanup);

it.each(["block", "text"])("keeps completed inline topology Global-only when %s ingestion runs with a named graph selected", async (source) => {
  useTopologyStore.setState(useTopologyStore.getInitialState(), true);
  useTabs.setState({ tabs: [] });
  const namedNode: TopologyNode = { graph_id: "lab", device_ref: "lab-only", device_kind: "ssh", label: "Named graph device" };
  const globalNode: TopologyNode = { graph_id: GLOBAL_GRAPH_ID, device_ref: "global-only", device_kind: "ssh", label: "Global device" };
  useTopologyStore.setState({ currentGraphId: "lab", nodes: [namedNode], edges: [] });
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string, args: { graphId: string }) => {
    if (command === "topology_get_graph") return Promise.resolve({ graph: { id: args.graphId, name: "Global", created_at: 0, updated_at: 0 }, nodes: [globalNode], edges: [], positions: [] });
    return Promise.resolve({ nodes_added: 1, edges_added: 0, cache_updated: true });
  });
  const block: Block = { id: `inline-${source}`, tabId: "inline-tab", command: "show cdp neighbors", cwd: "/synthetic", timestamp: 0, output: "synthetic neighbors", outputLineCount: 1, collapsed: false, bookmarked: false, pinned: false, tags: [], exitCode: 0 };
  render(<CommandBlock block={block} active={false} />);
  await act(async () => {
    if (source === "block") await useTopologyStore.getState().ingestFromBlock(block.id, "cisco", "iosxe", "source", "ssh");
    else await useTopologyStore.getState().ingestFromText(block.command, block.output, "cisco", "iosxe", "source", "ssh");
  });
  expect(screen.getByTestId("inline-input")).toHaveTextContent("Global device");
  expect(screen.getByTestId("inline-input")).not.toHaveTextContent("Named graph device");
  expect(useTopologyStore.getState().currentGraphId).toBe("lab");
  expect(useTopologyStore.getState().nodes).toEqual([namedNode]);
  expect(invokeMock).toHaveBeenCalledWith("topology_get_graph", { graphId: GLOBAL_GRAPH_ID });
});
