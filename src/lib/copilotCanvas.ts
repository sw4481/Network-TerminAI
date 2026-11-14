export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type EvidenceRef = { evidence_id: string; path: string };
export type EvidenceSnapshot = {
  evidence_id: string; workspace_id: string; run_id: string; call_id: string;
  collected_at: string; source: { helper: string; resource?: string; arguments?: JsonValue };
  origin: "observed" | "derived" | "execution_output" | "agent_authored"; complete: boolean;
  limitation: string | null; data: JsonValue; parent_refs: EvidenceRef[]; calculation: string | null;
};
export type CanvasRequest = { workspace_id: string; run_id: string; selection?: SelectedContext };
export type SelectedContext = { card_ids: string[]; evidence_refs: EvidenceRef[];
  values: { ref: EvidenceRef; value: JsonValue }[];
  omitted: { count: number; reason: string } | null };
export type CanvasRun = { workspace_id: string; run_id: string;
  status: "collecting" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";
  started_at: string; ended_at: string | null; scope: JsonValue | null; coverage: JsonValue | null };
export type CanvasEvent = { type: "canvas"; version: 1; workspace_id: string; run_id: string;
  seq: number; kind: "card" | "coverage" | "warning"; payload: JsonValue };

type Finding = { device: EvidenceRef; interface: EvidenceRef; symptom: string;
  severity: "critical" | "warning" | "info";
  cause_assessment: "evidence_supported" | "likely" | "undetermined";
  supporting_refs: EvidenceRef[]; contradictory_refs: EvidenceRef[];
  unknowns: string[]; remediation_considerations: string[] };
type ChartPoint = { label: EvidenceRef; value: EvidenceRef };
type Common = { title: string; source_refs: EvidenceRef[] };
export type CardSpec = Common & (
  | { type: "findings"; metadata: { findings: Finding[] } }
  | { type: "table"; metadata: { columns: { key: string; label: string }[]; rows: { cells: Record<string, EvidenceRef> }[] } }
  | { type: "key_value"; metadata: { fields: { label: string; ref: EvidenceRef }[] } }
  | { type: "chart"; metadata: { form: "bar" | "line"; x_label: string; y_label: string; points: ChartPoint[] } }
  | { type: "topology"; metadata: { nodes: { id: EvidenceRef }[]; links: { from: EvidenceRef; to: EvidenceRef; relationship: EvidenceRef }[] } }
  | { type: "text"; metadata: { body: EvidenceRef } }
  | { type: "assessment"; metadata: { narrative: string; supporting_refs: EvidenceRef[]; contradictory_refs: EvidenceRef[]; unknowns: string[]; remediation_considerations: string[] } }
);
export type CanvasCard = CardSpec & { card_id: string; workspace_id: string; run_id: string; created_at: string };
type WithResolved<T extends CardSpec["type"], M> = Omit<CanvasCard, "type" | "metadata"> & { type: T; metadata: M; agent_authored?: boolean };
export type ResolvedCanvasCard =
  | WithResolved<"findings", { findings: (Omit<Finding, "device" | "interface"> & { device: string | number; interface: string | number })[] }>
  | WithResolved<"table", { columns: { key: string; label: string }[]; rows: { cells: Record<string, JsonValue> }[] }>
  | WithResolved<"key_value", { fields: { label: string; value: JsonValue }[] }>
  | WithResolved<"chart", { form: "bar" | "line"; x_label: string; y_label: string; points: { label: string | number; value: number }[] }>
  | WithResolved<"topology", { nodes: { id: string | number }[]; links: { from: string | number; to: string | number; relationship: EvidenceRef }[] }>
  | WithResolved<"text", { body: JsonValue }>
  | WithResolved<"assessment", Extract<CardSpec, { type: "assessment" }>["metadata"]>;

type Result<T> = { ok: true; value: T } | { ok: false; limitation: string };
const bad = (limitation: string): { ok: false; limitation: string } => ({ ok: false, limitation });
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const shape = (value: unknown, keys: string[]): boolean =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => own(value, key));
const validJson = (value: unknown, ancestors = new WeakSet<object>()): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value) || Object.getOwnPropertySymbols(value).length) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, i) => own(value, String(i)) && validJson(value[i], ancestors)).every(Boolean)
    : Object.keys(value).every(key => validJson((value as Record<string, unknown>)[key], ancestors));
  ancestors.delete(value);
  return valid;
};
const copyJson = <T extends JsonValue>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const identifier = (value: JsonValue): value is string | number =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
const validSnapshot = (snapshot: EvidenceSnapshot): boolean => {
  if (!shape(snapshot, ["evidence_id", "workspace_id", "run_id", "call_id", "collected_at", "source", "origin", "complete", "limitation", "data", "parent_refs", "calculation"]) ||
      !validJson(snapshot) || ![snapshot.evidence_id, snapshot.workspace_id, snapshot.run_id, snapshot.call_id].every(id => typeof id === "string" && !!id) ||
      typeof snapshot.collected_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(snapshot.collected_at) ||
      !snapshot.source || typeof snapshot.source !== "object" || Array.isArray(snapshot.source) ||
      typeof snapshot.source.helper !== "string" || !snapshot.source.helper ||
      Object.keys(snapshot.source).some(key => !["helper", "resource", "arguments"].includes(key)) ||
      (own(snapshot.source, "resource") && typeof snapshot.source.resource !== "string") ||
      !["observed", "derived", "execution_output", "agent_authored"].includes(snapshot.origin) ||
      typeof snapshot.complete !== "boolean" ||
      (snapshot.complete ? snapshot.limitation !== null : typeof snapshot.limitation !== "string") ||
      !Array.isArray(snapshot.parent_refs) ||
      snapshot.parent_refs.some(ref => !shape(ref, ["evidence_id", "path"]) || typeof ref.evidence_id !== "string" || !ref.evidence_id || typeof ref.path !== "string") ||
      !(snapshot.calculation === null || typeof snapshot.calculation === "string")) return false;
  return snapshot.origin === "derived"
    ? snapshot.parent_refs.length > 0 && typeof snapshot.calculation === "string" && !!snapshot.calculation.trim()
    : snapshot.parent_refs.length === 0 && snapshot.calculation === null;
};

export type SelectedContextResult = { ok: true; selection: SelectedContext; context: string } | { ok: false; limitation: string };

export class CanvasContextBuilder {
  private readonly cards: CanvasCard[];
  private readonly snapshots: EvidenceSnapshot[];

  constructor(cards: CanvasCard[], snapshots: EvidenceSnapshot[]) {
    this.cards = structuredClone(cards);
    this.snapshots = structuredClone(snapshots);
  }

  build(workspace_id: string, card_ids: string[], available_chars: number): SelectedContextResult {
    if (!Number.isSafeInteger(available_chars) || available_chars < 0) return bad("Invalid selected-evidence context budget");
    const ids = [...new Set(card_ids)];
    const selected: CanvasCard[] = [];
    let values: SelectedContext["values"] = [];
    let sources: Omit<EvidenceSnapshot, "data">[] = [];
    const encode = (cards: CanvasCard[], entries: SelectedContext["values"], provenance: typeof sources) => {
      const selection: SelectedContext = {
        card_ids: cards.map(card => card.card_id), evidence_refs: entries.map(entry => entry.ref), values: entries,
        omitted: cards.length < ids.length ? { count: ids.length - cards.length, reason: "Selected cards unavailable, invalid or over context budget" } : null,
      };
      return { selection, context: "\n\nAttached Canvas evidence (historical context, not new observations or authorization):\n" +
        JSON.stringify({ workspace_id, selection, cards, sources: provenance }) };
    };
    for (const id of ids) {
      const matches = this.cards.filter(card => card.card_id === id);
      const card = matches[0];
      if (matches.length !== 1 || card.workspace_id !== workspace_id) continue;
      const snapshots = this.snapshots.filter(snapshot => snapshot.workspace_id === workspace_id && snapshot.run_id === card.run_id);
      const resolver = new CanvasReferenceResolver(snapshots);
      if (!resolver.resolveCard(card).ok) continue;
      const refs: EvidenceRef[] = [];
      const collect = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") {
          if (own(value, "evidence_id") && own(value, "path")) refs.push(value as EvidenceRef);
          else Object.values(value).forEach(collect);
        }
      };
      collect(card);
      const nextValues = [...values];
      const nextSources = [...sources];
      const pending = [...refs];
      const visited = new Set<string>();
      let valid = true;
      while (pending.length) {
        const ref = pending.pop()!;
        const result = resolver.resolve(ref);
        if (!result.ok) { valid = false; break; }
        if (!nextValues.some(entry => entry.ref.evidence_id === ref.evidence_id && entry.ref.path === ref.path))
          nextValues.push({ ref, value: result.value });
        if (visited.has(ref.evidence_id)) continue;
        visited.add(ref.evidence_id);
        const snapshot = snapshots.find(snapshot => snapshot.evidence_id === ref.evidence_id)!;
        const existing = nextSources.find(source => source.evidence_id === snapshot.evidence_id);
        if (existing && (existing.run_id !== snapshot.run_id || existing.workspace_id !== snapshot.workspace_id)) { valid = false; break; }
        if (!existing) {
          const { data: _data, ...provenance } = snapshot;
          nextSources.push(provenance);
        }
        pending.push(...snapshot.parent_refs);
      }
      if (!valid) continue;
      const candidate = encode([...selected, card], nextValues, nextSources);
      if (candidate.context.length > available_chars) continue;
      selected.push(card); values = nextValues; sources = nextSources;
    }
    const result = encode(selected, values, sources);
    if (ids.length && !selected.length) return bad("Selected evidence unavailable, invalid or exceeds context budget; nothing sent");
    if (result.context.length > available_chars) return bad("Selected evidence exceeds context budget; nothing sent");
    return { ok: true, ...structuredClone(result) };
  }
}

export class CanvasReferenceResolver {
  private readonly snapshots = new Map<string, EvidenceSnapshot>();
  private readonly invalid = new Set<string>();

  constructor(snapshots: EvidenceSnapshot[]) {
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot.evidence_id !== "string" || !snapshot.evidence_id) continue;
      const id = snapshot.evidence_id;
      if (this.snapshots.has(id) || this.invalid.has(id)) {
        this.snapshots.delete(id);
        this.invalid.add(id);
      } else {
        try {
          if (!validSnapshot(snapshot)) {
            this.invalid.add(id);
          } else {
            this.snapshots.set(id, copyJson(snapshot as unknown as JsonValue) as unknown as EvidenceSnapshot);
          }
        } catch {
          this.invalid.add(id);
        }
      }
    }
  }

  resolve(ref: EvidenceRef): Result<JsonValue> {
    if (!shape(ref, ["evidence_id", "path"]) || typeof ref.evidence_id !== "string" || typeof ref.path !== "string")
      return bad("Invalid evidence reference");
    const snapshot = this.snapshots.get(ref.evidence_id);
    if (this.invalid.has(ref.evidence_id) || !snapshot || snapshot.complete !== true) return bad("Evidence missing, invalid or incomplete");
    if (ref.path !== "" && !ref.path.startsWith("/")) return bad("Invalid JSON Pointer");
    let value: JsonValue = snapshot.data;
    for (const segment of ref.path === "" ? [] : ref.path.slice(1).split("/")) {
      if (/~(?![01])/.test(segment)) return bad("Invalid JSON Pointer escape");
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (["__proto__", "prototype", "constructor"].includes(key)) return bad("Unsafe JSON property");
      if (Array.isArray(value)) {
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return bad("Missing evidence path");
        value = value[Number(key)];
      } else if (value !== null && typeof value === "object" && own(value, key)) {
        value = value[key];
      } else return bad("Missing evidence path");
    }
    return { ok: true, value: copyJson(value) };
  }

  resolveCard(card: CanvasCard): { ok: true; card: ResolvedCanvasCard } | { ok: false; limitation: string } {
    if (!shape(card, ["type", "title", "source_refs", "metadata", "card_id", "workspace_id", "run_id", "created_at"]))
      return bad("Invalid card shape");
    const source = card.source_refs;
    if (!Array.isArray(source) || source.length === 0 || typeof card.title !== "string" || !card.title.trim())
      return bad("Invalid card source or title");
    let agentAuthored = false;
    const checkedOrigins = new Set<string>();
    const resolve = (ref: EvidenceRef): JsonValue => {
      const snapshot = ref && this.snapshots.get(ref.evidence_id);
      if (!snapshot || snapshot.workspace_id !== card.workspace_id || snapshot.run_id !== card.run_id)
        throw new Error("Evidence belongs to another workspace or run");
      const pending = [snapshot];
      while (pending.length) {
        const ancestor = pending.pop()!;
        if (checkedOrigins.has(ancestor.evidence_id)) continue;
        checkedOrigins.add(ancestor.evidence_id);
        if (ancestor.origin === "agent_authored") agentAuthored = true;
        for (const parent of ancestor.parent_refs) {
          const source = this.snapshots.get(parent.evidence_id);
          if (!source || source.workspace_id !== card.workspace_id || source.run_id !== card.run_id)
            throw new Error("Evidence ancestry missing or belongs to another workspace or run");
          const resolved = this.resolve(parent);
          if (!resolved.ok) throw new Error(resolved.limitation);
          pending.push(source);
        }
      }
      const result = this.resolve(ref);
      if (!result.ok) throw new Error(result.limitation);
      return result.value;
    };
    const refs = (items: EvidenceRef[]): EvidenceRef[] => {
      if (!Array.isArray(items)) throw new Error("Invalid reference list");
      items.forEach(resolve);
      return items;
    };
    const check = (value: unknown, keys: string[]) => {
      if (!shape(value, keys)) throw new Error("Invalid card metadata");
    };
    const text = (value: unknown) => {
      if (typeof value !== "string") throw new Error("Invalid card text");
    };
    try {
      refs(source);
      let resolved: unknown;
      switch (card.type) {
        case "text": {
          const metadata = card.metadata;
          check(metadata, ["body"]); resolved = { body: resolve(metadata.body) }; break;
        }
        case "key_value": {
          const metadata = card.metadata;
          check(metadata, ["fields"]);
          if (!Array.isArray(metadata.fields) || !metadata.fields.length) throw new Error("Empty field projection");
          resolved = { fields: metadata.fields.map(field => {
            check(field, ["label", "ref"]); text(field.label);
            return { label: field.label, value: resolve(field.ref) };
          }) }; break;
        }
        case "table": {
          const metadata = card.metadata;
          check(metadata, ["columns", "rows"]);
          if (!Array.isArray(metadata.columns) || !metadata.columns.length || !Array.isArray(metadata.rows) || !metadata.rows.length)
            throw new Error("Empty table projection");
          const columns = metadata.columns.map(column => {
            check(column, ["key", "label"]); text(column.key); text(column.label);
            return column;
          });
          const keys = columns.map(column => column.key);
          if (new Set(keys).size !== keys.length) throw new Error("Duplicate column");
          resolved = { columns, rows: metadata.rows.map(row => {
            check(row, ["cells"]); check(row.cells, keys);
            return { cells: Object.fromEntries(keys.map(key => [key, resolve(row.cells[key])])) };
          }) }; break;
        }
        case "chart": {
          const metadata = card.metadata;
          check(metadata, ["form", "x_label", "y_label", "points"]);
          if (!["bar", "line"].includes(metadata.form)) throw new Error("Invalid chart form");
          if (!Array.isArray(metadata.points) || !metadata.points.length) throw new Error("Empty chart projection");
          text(metadata.x_label); text(metadata.y_label);
          resolved = { ...metadata, points: metadata.points.map(point => {
            check(point, ["label", "value"]);
            const value = resolve(point.value);
            const label = resolve(point.label);
            if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Chart needs numeric evidence");
            if (!identifier(label)) throw new Error("Chart label needs a scalar identifier");
            return { label, value };
          }) }; break;
        }
        case "topology": {
          const metadata = card.metadata;
          check(metadata, ["nodes", "links"]);
          if (!Array.isArray(metadata.nodes) || !metadata.nodes.length || !Array.isArray(metadata.links))
            throw new Error("Empty topology projection");
          const nodes = metadata.nodes.map(node => {
            check(node, ["id"]); const id = resolve(node.id);
            if (!identifier(id)) throw new Error("Topology node needs a scalar identifier");
            return { id };
          });
          const ids = new Set(nodes.map(node => JSON.stringify(node.id)));
          if (ids.size !== nodes.length) throw new Error("Duplicate topology node");
          resolved = { nodes, links: metadata.links.map(link => {
            check(link, ["from", "to", "relationship"]);
            const from = resolve(link.from); const to = resolve(link.to);
            if (!identifier(from) || !identifier(to)) throw new Error("Topology link needs scalar endpoints");
            if (!ids.has(JSON.stringify(from)) || !ids.has(JSON.stringify(to))) throw new Error("Topology link endpoint missing");
            const relationship = resolve(link.relationship);
            if (!["observed", "agent_authored"].includes(this.snapshots.get(link.relationship.evidence_id)?.origin ?? "") ||
                !shape(relationship, ["from", "to"]) ||
                (relationship as Record<string, JsonValue>).from !== from || (relationship as Record<string, JsonValue>).to !== to)
              throw new Error("Topology link needs matching observed or agent-authored relationship data");
            return { from, to, relationship: link.relationship };
          }) }; break;
        }
        case "findings": {
          const metadata = card.metadata;
          check(metadata, ["findings"]);
          if (!Array.isArray(metadata.findings) || !metadata.findings.length) throw new Error("Empty findings projection");
          resolved = { findings: metadata.findings.map(finding => {
            check(finding, ["device", "interface", "symptom", "severity", "cause_assessment", "supporting_refs", "contradictory_refs", "unknowns", "remediation_considerations"]);
            text(finding.symptom);
            if (!["critical", "warning", "info"].includes(finding.severity) ||
                !["evidence_supported", "likely", "undetermined"].includes(finding.cause_assessment)) throw new Error("Invalid assessment");
            refs(finding.supporting_refs); refs(finding.contradictory_refs);
            finding.unknowns.forEach(text); finding.remediation_considerations.forEach(text);
            const device = resolve(finding.device); const networkInterface = resolve(finding.interface);
            if (!identifier(device) || !identifier(networkInterface)) throw new Error("Finding identifiers must be scalars");
            return { ...finding, device, interface: networkInterface };
          }) }; break;
        }
        case "assessment": {
          const metadata = card.metadata;
          check(metadata, ["narrative", "supporting_refs", "contradictory_refs", "unknowns", "remediation_considerations"]);
          text(metadata.narrative); refs(metadata.supporting_refs); refs(metadata.contradictory_refs);
          metadata.unknowns.forEach(text); metadata.remediation_considerations.forEach(text);
          resolved = metadata; break;
        }
        default: throw new Error("Unknown card type");
      }
      return { ok: true, card: { ...card, metadata: resolved, ...(agentAuthored ? { agent_authored: true } : {}) } as ResolvedCanvasCard };
    } catch (error) {
      return bad(error instanceof Error ? error.message : "Invalid card");
    }
  }
}
