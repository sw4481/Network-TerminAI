import { expect, it } from "vitest";
import { TopologyExport } from "./topologyExport";
import type { GraphSnapshot } from "./topology";

it("keeps native v1 interchange explicit: graph observations and import receipts survive, local collection evidence does not", () => {
  const snapshot: GraphSnapshot = {
    graph: { id: "lab", name: "Lab", created_at: 1, updated_at: 2 },
    nodes: [{ graph_id: "lab", device_ref: "r1", device_kind: "ssh", label: "R1" }], edges: [],
    positions: [{ device_ref: "r1", x: 10, y: 20 }],
    import_provenance: { format: "sc2", imported_at: 1, node_metadata: [], unsupported_protocols: [] },
    capture_evidence: [{ source_ref: "r1", protocol: "lldp", source_command: "LOCAL ONLY COMMAND", attempted_at: 100, status: "failed", observations: [] }],
  };
  const result = JSON.parse(TopologyExport.toJson(snapshot));
  expect(result).toEqual({ format: "terminai-topology", version: 1, snapshot: {
    graph: snapshot.graph, nodes: snapshot.nodes, edges: [], positions: snapshot.positions, import_provenance: snapshot.import_provenance,
  } });
  expect(TopologyExport.toJson(snapshot)).not.toContain("LOCAL ONLY COMMAND");
  expect(snapshot.capture_evidence).toHaveLength(1);
});
