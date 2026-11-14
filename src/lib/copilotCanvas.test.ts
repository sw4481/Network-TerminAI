import { describe, expect, it } from "vitest";
import fixture from "../../tests/fixtures/copilot_canvas/v1.json";
import { CanvasContextBuilder, CanvasReferenceResolver, type CanvasCard, type EvidenceSnapshot, type SelectedContext } from "./copilotCanvas";

const snapshots = fixture.snapshots as EvidenceSnapshot[];
const cards = fixture.cards.map((spec, index) => ({ ...spec, card_id: `card-${index}`,
  workspace_id: fixture.request.workspace_id, run_id: fixture.request.run_id,
  created_at: "2026-10-25T12:00:02Z" })) as CanvasCard[];

describe("Canvas selected context", () => {
  it("resolves single and multiple immutable cards with null/false/zero and original provenance", () => {
    const input = structuredClone(snapshots);
    const builder = new CanvasContextBuilder(cards, input);
    (input[0].data as { devices: { errors: number }[] }).devices[0].errors = 999;
    const single = builder.build(fixture.request.workspace_id, ["card-2"], 48000);
    expect(single.ok).toBe(true);
    if (!single.ok) throw new Error(single.limitation);
    expect(single.selection.values).toContainEqual({ ref: { evidence_id: "evidence-a", path: "/devices/0/enabled" }, value: false });
    expect(single.selection.values).toContainEqual({ ref: { evidence_id: "evidence-a", path: "/devices/0/note" }, value: null });
    single.selection.values[0].ref.path = "/missing-after-result-mutation";
    const multiple = builder.build(fixture.request.workspace_id, ["card-2", "card-1", "card-2"], 48000);
    if (!multiple.ok) throw new Error(multiple.limitation);
    expect(multiple.selection.card_ids).toEqual(["card-2", "card-1"]);
    expect(multiple.selection.values).toContainEqual({ ref: { evidence_id: "evidence-a", path: "/devices/0/errors" }, value: 0 });
    expect(multiple.context).toContain('"collected_at":"2026-10-25T12:00:00Z"');
    expect(multiple.context).toContain('"run_id":"run-1"');
    expect(multiple.context).toContain('"helper":"inventory"');
    expect(multiple.context).toContain("not new observations or authorization");
    expect(multiple.selection.omitted).toBeNull();
  });

  it("rejects foreign identity, missing refs, copied cells and conflicting card identity", () => {
    for (const invalid of [
      { ...cards[2], workspace_id: "other" },
      { ...cards[2], run_id: "other" },
      { ...cards[2], source_refs: [{ evidence_id: "missing", path: "" }] },
      { ...cards[2], metadata: { fields: [{ label: "Copied", ref: false }] } },
    ]) {
      const result = new CanvasContextBuilder([invalid as CanvasCard], snapshots).build(fixture.request.workspace_id, ["card-2"], 48000);
      expect(result.ok).toBe(false);
    }
    expect(new CanvasContextBuilder([cards[2], cards[2]], snapshots).build(fixture.request.workspace_id, ["card-2"], 48000).ok).toBe(false);
  });

  it("discloses invalid/budget omissions and rejects when no selected card fits, without clipping values", () => {
    const builder = new CanvasContextBuilder(cards, snapshots);
    expect(builder.build(fixture.request.workspace_id, ["card-2"], 10)).toEqual({ ok: false, limitation: expect.stringMatching(/budget/i) });
    const single = builder.build(fixture.request.workspace_id, ["card-2"], 48000);
    if (!single.ok) throw new Error(single.limitation);
    const partial = builder.build(fixture.request.workspace_id, ["card-2", "card-1", "missing"], single.context.length + 200);
    if (!partial.ok) throw new Error(partial.limitation);
    expect(partial.selection.card_ids).toEqual(["card-2"]);
    expect(partial.selection.omitted).toEqual({ count: 2, reason: expect.stringMatching(/budget|unavailable/i) });
    expect(partial.context.length).toBeLessThanOrEqual(single.context.length + 200);
    expect(partial.context).toContain('"omitted":{"count":2');
  });
});

describe("Canvas source references", () => {
  it("resolves all seven fixture card types from actual snapshot values", () => {
    const resolver = new CanvasReferenceResolver(snapshots);
    expect(cards.map(card => resolver.resolveCard(card).ok)).toEqual(Array(7).fill(true));
    const table = resolver.resolveCard(cards[1]);
    expect(table.ok && table.card.type === "table" && table.card.metadata.rows[0].cells.errors).toBe(0);
    expect(table.ok && table.card.type === "table" && table.card.metadata.rows[1].cells.id).toBe("__proto__");
    const fields = resolver.resolveCard(cards[2]);
    expect(fields.ok && fields.card.type === "key_value" && fields.card.metadata.fields.map(field => field.value)).toEqual([false, null]);
    const chart = resolver.resolveCard(cards[3]);
    expect(chart.ok && chart.card.type === "chart" && chart.card.metadata.points[0].value).toBe(0);
    const topology = resolver.resolveCard(cards[4]);
    expect(topology.ok && topology.card.type === "topology" && topology.card.metadata.nodes[1].id).toBe("__proto__");
    expect(resolver.resolve({ evidence_id: "evidence-a", path: "/empty" })).toEqual({ ok: true, value: [] });
  });

  it("rejects copied cells, hostile identifiers and foreign/missing/incomplete evidence", () => {
    const resolver = new CanvasReferenceResolver(snapshots);
    const tampered = structuredClone(cards[1]);
    if (tampered.type !== "table") throw new Error("Fixture card must be a table");
    (tampered.metadata.rows[0].cells as Record<string, unknown>).errors = 999;
    expect(resolver.resolveCard(tampered).ok).toBe(false);
    expect(resolver.resolveCard({ ...cards[0], onClick: "alert(1)" } as unknown as CanvasCard).ok).toBe(false);
    for (const path of ["/missing", "/empty/0", "$.devices[0]", "/devices/~2", "/devices/01", "/__proto__", "/constructor", "/devices/0/toString"]) {
      expect(resolver.resolve({ evidence_id: "evidence-a", path }).ok).toBe(false);
    }
    expect(resolver.resolve({ evidence_id: "evidence-a", path: "/devices/0/errors" })).toEqual({ ok: true, value: 0 });
    expect(resolver.resolve({ evidence_id: "evidence-a", path: "/devices/0/note" })).toEqual({ ok: true, value: null });
    expect(resolver.resolve({ evidence_id: "evidence-b", path: "/devices/0/errors" })).toEqual({ ok: true, value: 7 });
    const foreign = { ...snapshots[0], workspace_id: "canvas-tab-2" };
    expect(new CanvasReferenceResolver([foreign]).resolveCard(cards[0]).ok).toBe(false);
    const clipped = { ...snapshots[0], complete: false, data: null, limitation: "capture exceeded bound" };
    expect(new CanvasReferenceResolver([clipped]).resolveCard(cards[0]).ok).toBe(false);
  });

  it("rejects missing, non-JSON or duplicate snapshot data and isolates observed values", () => {
    const ref = { evidence_id: "evidence-a", path: "/devices/0" };
    for (const data of [undefined, { devices: [{ id: undefined }] }, { devices: [Number.NaN] }, { devices: [new Date()] }]) {
      const invalid = { ...snapshots[0], data } as EvidenceSnapshot;
      expect(new CanvasReferenceResolver([invalid]).resolve(ref).ok).toBe(false);
    }
    expect(new CanvasReferenceResolver([snapshots[0], { ...snapshots[0], data: { devices: [] } }]).resolve(ref).ok).toBe(false);
    const input = structuredClone(snapshots[0]);
    const resolver = new CanvasReferenceResolver([input]);
    (input.data as { devices: { id: string }[] }).devices[0].id = "changed after construction";
    const result = resolver.resolve(ref);
    expect(result.ok && (result.value as { id: string }).id).toBe("switch-a");
    if (result.ok) (result.value as { id: string }).id = "changed after resolution";
    expect(resolver.resolve(ref)).toEqual({ ok: true, value: fixture.snapshots[0].data.devices[0] });
  });

  it("rejects malformed runtime snapshots, including truthy non-boolean completeness", () => {
    const ref = { evidence_id: "evidence-a", path: "/devices/0/errors" };
    for (const mutation of [
      { complete: "false" }, { call_id: null }, { collected_at: null },
      { origin: "unknown" }, { parent_refs: [{ evidence_id: 4, path: "" }] },
      { source: { resource: "missing helper" } }, { limitation: 4 }, { calculation: 4 },
    ]) {
      const malformed = { ...snapshots[0], ...mutation } as unknown as EvidenceSnapshot;
      expect(new CanvasReferenceResolver([malformed]).resolve(ref).ok).toBe(false);
    }
  });

  it("keeps agent-authored projections distinct from observations, including attached context", () => {
    const authored = snapshots.map(snapshot => ({ ...snapshot, origin: "agent_authored" as EvidenceSnapshot["origin"] }));
    const resolver = new CanvasReferenceResolver(authored);
    for (const card of cards) {
      const result = resolver.resolveCard(card);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.limitation);
      expect(result.card).toHaveProperty("agent_authored", true);
    }
    const context = new CanvasContextBuilder(cards, authored).build(fixture.request.workspace_id, ["card-1"], 48000);
    expect(context.ok).toBe(true);
    if (context.ok) expect(context.context).toContain('"origin":"agent_authored"');
    const observed = new CanvasReferenceResolver(snapshots).resolveCard(cards[1]);
    expect(observed.ok && "agent_authored" in observed.card).toBe(false);
  });

  it("retains authored provenance through multiple derived ancestors without relabeling observed-only cards", () => {
    const input = structuredClone(snapshots);
    const authored = { ...input[0], evidence_id: "authored-parent", origin: "agent_authored" as const };
    const intermediate = { ...input[0], evidence_id: "intermediate", origin: "derived" as const, parent_refs: [{ evidence_id: authored.evidence_id, path: "" }], calculation: "Agent-supplied projection" };
    input[0] = { ...input[0], origin: "derived", parent_refs: [{ evidence_id: intermediate.evidence_id, path: "" }], calculation: "Second projection" };
    const resolver = new CanvasReferenceResolver([...input, authored, intermediate]);
    const result = resolver.resolveCard(cards[1]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.card.agent_authored).toBe(true);
    const observed = new CanvasReferenceResolver(snapshots).resolveCard(cards[1]);
    expect(observed.ok && "agent_authored" in observed.card).toBe(false);
  });

  it.each(["workspace", "run", "missing", "incomplete", "path"])("rejects %s ancestry before using it as authored provenance", mutation => {
    const input = structuredClone(snapshots);
    const parent: EvidenceSnapshot = { ...input[0], evidence_id: "authored-parent", origin: "agent_authored" };
    input[0] = { ...input[0], origin: "derived", parent_refs: [{ evidence_id: parent.evidence_id, path: mutation === "path" ? "/absent" : "" }], calculation: "Projection" };
    if (mutation === "workspace") parent.workspace_id = "foreign-workspace";
    if (mutation === "run") parent.run_id = "foreign-run";
    if (mutation === "incomplete") { parent.complete = false; parent.limitation = "Unavailable"; }
    const resolver = new CanvasReferenceResolver([...input, ...(mutation === "missing" ? [] : [parent])]);
    expect(resolver.resolveCard(cards[1]).ok).toBe(false);
  });

  it("rejects duplicate graph identifiers and links to absent nodes rather than drawing fake nodes", () => {
    const resolver = new CanvasReferenceResolver(snapshots);
    for (const mutation of ["duplicate", "dangling"]) {
      const topology = structuredClone(cards[4]);
      if (topology.type !== "topology") throw new Error("Fixture topology missing");
      if (mutation === "duplicate") topology.metadata.nodes.push(topology.metadata.nodes[0]);
      else topology.metadata.nodes.pop();
      expect(resolver.resolveCard(topology).ok).toBe(false);
    }
  });

  it("requires matching observed relationship evidence for topology links", () => {
    const resolver = new CanvasReferenceResolver(snapshots);
    const topology = structuredClone(cards[4]);
    if (topology.type !== "topology") throw new Error("Fixture topology missing");
    expect(resolver.resolveCard(topology).ok).toBe(true);
    delete (topology.metadata.links[0] as Partial<typeof topology.metadata.links[0]>).relationship;
    expect(resolver.resolveCard(topology).ok).toBe(false);
    topology.metadata.links[0].relationship = { evidence_id: "evidence-a", path: "/devices/0" };
    expect(resolver.resolveCard(topology).ok).toBe(false);
    topology.metadata.links[0].relationship = { evidence_id: "evidence-a", path: "/missing" };
    expect(resolver.resolveCard(topology).ok).toBe(false);
    const reversed = structuredClone(snapshots[0]);
    (reversed.data as { links: { from: string; to: string }[] }).links[0] = { from: "__proto__", to: "switch-a" };
    expect(new CanvasReferenceResolver([reversed]).resolveCard(cards[4]).ok).toBe(false);
  });

  it("rejects empty projections, non-scalar identifiers and unsupported chart forms", () => {
    const resolver = new CanvasReferenceResolver(snapshots);
    for (const index of [0, 1, 2, 3, 4]) {
      const card = structuredClone(cards[index]);
      if (card.type === "findings") card.metadata.findings = [];
      if (card.type === "table") card.metadata.rows = [];
      if (card.type === "key_value") card.metadata.fields = [];
      if (card.type === "chart") card.metadata.points = [];
      if (card.type === "topology") card.metadata.nodes = [];
      expect(resolver.resolveCard(card).ok).toBe(false);
    }
    const chart = structuredClone(cards[3]);
    if (chart.type !== "chart") throw new Error("Fixture chart missing");
    chart.metadata.form = "scatter" as "bar";
    expect(resolver.resolveCard(chart).ok).toBe(false);
    chart.metadata.form = "bar";
    chart.metadata.points[0].label.path = "/devices/0";
    expect(resolver.resolveCard(chart).ok).toBe(false);
    const topology = structuredClone(cards[4]);
    if (topology.type !== "topology") throw new Error("Fixture topology missing");
    topology.metadata.nodes[0].id.path = "/devices/0";
    expect(resolver.resolveCard(topology).ok).toBe(false);
  });

  it("freezes bounded selected-card values with their original refs and omissions", () => {
    const selection: SelectedContext = fixture.selected_context;
    expect(selection.card_ids).toEqual(["card-0"]);
    expect(selection.values).toEqual([{ ref: { evidence_id: "evidence-a", path: "/devices/0/errors" }, value: 0 }]);
    expect(selection.omitted).toEqual({ count: 1, reason: "bounded selection" });
  });

  it("handles escaped RFC6901 keys as own properties without prototype traversal", () => {
    const snapshot = { ...snapshots[0], data: { "a/b": { "~": false }, "__proto__": "ordinary" } };
    const resolver = new CanvasReferenceResolver([snapshot]);
    expect(resolver.resolve({ evidence_id: "evidence-a", path: "/a~1b/~0" })).toEqual({ ok: true, value: false });
    expect(resolver.resolve({ evidence_id: "evidence-a", path: "/__proto__" }).ok).toBe(false);
  });
});
