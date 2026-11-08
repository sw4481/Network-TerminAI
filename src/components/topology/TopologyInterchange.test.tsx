import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("../../lib/topologyExport", () => ({ TopologyExport: { toJson: vi.fn().mockReturnValue("{}"), saveJson: vi.fn().mockResolvedValue(false), saveDrawio: vi.fn(), savePng: vi.fn().mockResolvedValue(false) } }));
const measurement = vi.hoisted(() => ({ ready: true, nodes: [] as { id: string; position: { x: number; y: number } }[] }));
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  ReactFlow: ({ defaultNodes, children }: { defaultNodes: typeof measurement.nodes; children: import("react").ReactNode }) => {
    measurement.nodes = defaultNodes;
    return <div>{defaultNodes.map((node) => <div key={node.id} className="neighbor-node" data-device-ref={node.id}>
      <span className="neighbor-node__circle" /><span className="neighbor-node__label">{node.id}</span><span className="neighbor-node__kind">Discovered</span>
    </div>)}{children}</div>;
  },
  useNodesInitialized: () => measurement.ready,
  useReactFlow: () => ({ getNodes: () => measurement.nodes, getInternalNode: (id: string) => ({ ...measurement.nodes.find((node) => node.id === id),
    measured: { width: 150, height: 65 }, internals: { handleBounds: { source: [{ x: 75, y: 65, width: 1, height: 1, position: "bottom" }], target: [{ x: 75, y: 0, width: 1, height: 1, position: "top" }] } } }) }),
}));
import { TopologyInterchange } from "./TopologyInterchange";
import { TopologyExport } from "../../lib/topologyExport";
import { useTopologyStore } from "../../state/topologyStore";
import type { GraphSnapshot } from "../../lib/topology";
const initial = useTopologyStore.getState();
const snapshot: GraphSnapshot = { graph: { id: "g", name: "Synthetic", created_at: 1, updated_at: 2 }, nodes: ["a", "b"].map((ref) => ({ graph_id: "g", device_ref: ref, label: ref, device_kind: "discovered" })), edges: [], positions: [{ device_ref: "a", x: 1, y: 2 }, { device_ref: "b", x: 300, y: 2 }] };
const preview = { format: "sc2", node_count: 2, edge_count: 1, placeholder_count: 1, warnings: ["Capture time unknown"] };
const originalShow = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  invokeMock.mockReset(); vi.mocked(TopologyExport.saveJson).mockClear();
  vi.mocked(TopologyExport.savePng).mockReset().mockResolvedValue(false); measurement.ready = true; measurement.nodes = [];
  useTopologyStore.setState({ ...initial, currentGraphId: "g", graphs: [snapshot.graph] });
});
afterEach(() => { cleanup(); HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose; });
const mount = () => render(<TopologyInterchange snapshot={snapshot} visibleNodes={[snapshot.nodes[0]]} visibleEdges={[]} />);
function upload(content = "{}", size?: number) {
  const file = new File([content], "map.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: () => Promise.resolve(content) });
  if (size !== undefined) Object.defineProperty(file, "size", { value: size });
  fireEvent.change(screen.getByLabelText("Topology JSON file"), { target: { files: [file] } });
}
it("previews offline before an explicit named import and cancel makes no write", async () => {
  invokeMock.mockResolvedValue(preview); mount();
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" })); upload();
  expect(await screen.findByText(/2 devices.*1 links.*1 placeholders/)).toBeInTheDocument();
  expect(screen.getByText("Capture time unknown")).toBeInTheDocument();
  expect(invokeMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(invokeMock).not.toHaveBeenCalledWith("topology_import_graph", expect.anything());
});
it("imports into a new named graph without selecting it", async () => {
  invokeMock.mockImplementation((method) => method === "topology_preview_import" ? Promise.resolve(preview) : Promise.resolve({ ...snapshot, graph: { ...snapshot.graph, id: "new", name: "Reviewed map" } })); mount();
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" })); upload();
  await screen.findByText(/2 devices.*1 links/);
  fireEvent.change(screen.getByLabelText("Imported graph name"), { target: { value: "Reviewed map" } });
  fireEvent.click(screen.getByRole("button", { name: "Create imported graph" }));
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("topology_import_graph", { content: "{}", name: "Reviewed map" }));
  expect(useTopologyStore.getState().currentGraphId).toBe("g");
  expect(await screen.findByRole("status")).toHaveTextContent("Reviewed map");
});
it("rejects oversized files before reading or invoking the backend", async () => {
  mount(); fireEvent.click(screen.getByRole("button", { name: "Import JSON" })); upload("{}", 10 * 1024 * 1024 + 1);
  expect(await screen.findByRole("alert")).toHaveTextContent("10 MiB"); expect(invokeMock).not.toHaveBeenCalled();
});
it("ignores a preview returned after cancel", async () => {
  let resolve!: (value: typeof preview) => void;
  invokeMock.mockReturnValue(new Promise((done) => { resolve = done; })); mount();
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" })); upload();
  await waitFor(() => expect(invokeMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
  await act(async () => resolve(preview)); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("does not export excluded link provenance merely because endpoints remain", async () => {
  const imported: GraphSnapshot = { ...snapshot, import_provenance: { format: "sc2", imported_at: 3, node_metadata: [], unsupported_protocols: [{ a_device_ref: "a", a_port: "Gi1", b_device_ref: "b", b_port: "Gi2", raw_protocol: "custom" }] } };
  render(<TopologyInterchange snapshot={imported} visibleNodes={snapshot.nodes} visibleEdges={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  await waitFor(() => expect(TopologyExport.saveJson).toHaveBeenCalled());
  expect(vi.mocked(TopologyExport.saveJson).mock.calls[0][0].import_provenance?.unsupported_protocols).toEqual([]);
});

it("exports complete filtered/full PNG snapshots using measured geometry and reports native cancellation", async () => {
  mount(); fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
  await waitFor(() => expect(TopologyExport.savePng).toHaveBeenCalledTimes(1));
  expect(vi.mocked(TopologyExport.savePng).mock.calls[0][0].nodes.map((node) => node.device_ref)).toEqual(["a"]);
  expect(vi.mocked(TopologyExport.savePng).mock.calls[0][1]).toEqual([expect.objectContaining({ device_ref: "a", width: 150, height: 65, visual: expect.anything() })]);
  expect(await screen.findByRole("status")).toHaveTextContent("cancelled; no file saved");
  fireEvent.change(screen.getByLabelText("Export scope"), { target: { value: "all" } });
  fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
  await waitFor(() => expect(TopologyExport.savePng).toHaveBeenCalledTimes(2));
  expect(vi.mocked(TopologyExport.savePng).mock.calls[1][0].nodes).toHaveLength(2);
  expect(vi.mocked(TopologyExport.savePng).mock.calls[1][1][1]).toMatchObject({ device_ref: "b", x: 300 });
});
it("shows PNG raster/native errors rather than success", async () => {
  vi.mocked(TopologyExport.savePng).mockRejectedValue(new Error("disk full"));
  mount(); fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Export failed: disk full");
  expect(screen.queryByText("Topology export saved.")).not.toBeInTheDocument();
});
it("cancels pending measurement without starting a PNG save", async () => {
  measurement.ready = false;
  mount(); fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
  await act(async () => {});
  expect(TopologyExport.savePng).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("cancelled");
});
it("aborts a cancelled PNG and ignores its late receipt after a newer export starts", async () => {
  let finish!: (saved: boolean) => void;
  vi.mocked(TopologyExport.savePng).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  mount(); fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
  await waitFor(() => expect(TopologyExport.savePng).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(TopologyExport.savePng).mock.calls[0][4]!;
  fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
  expect(signal.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("cancelled; no file saved"));
  await act(async () => finish(true));
  expect(screen.getByRole("status")).toHaveTextContent("cancelled; no file saved");
});
it("aborts on unmount and does not save a mutable live snapshot", async () => {
  vi.mocked(TopologyExport.savePng).mockImplementation(() => new Promise(() => {}));
  const live = structuredClone(snapshot);
  const view = render(<TopologyInterchange snapshot={live} visibleNodes={live.nodes} visibleEdges={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
  await waitFor(() => expect(TopologyExport.savePng).toHaveBeenCalled());
  const [frozen, , , , signal] = vi.mocked(TopologyExport.savePng).mock.calls[0];
  live.nodes[0].label = "changed after click";
  expect(frozen.nodes[0].label).toBe("a");
  view.unmount(); expect(signal?.aborted).toBe(true);
});

it("exports all filtered nodes by default, supports full graph, and reports cancellation truthfully", async () => {
  mount(); fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  await waitFor(() => expect(TopologyExport.saveJson).toHaveBeenCalled());
  expect(vi.mocked(TopologyExport.saveJson).mock.calls[0][0].nodes.map((node) => node.device_ref)).toEqual(["a"]);
  expect(await screen.findByRole("status")).toHaveTextContent("cancelled");
  fireEvent.change(screen.getByLabelText("Export scope"), { target: { value: "all" } });
  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
  await waitFor(() => expect(TopologyExport.saveJson).toHaveBeenCalledTimes(2));
  expect(vi.mocked(TopologyExport.saveJson).mock.calls[1][0].nodes).toHaveLength(2);
});
