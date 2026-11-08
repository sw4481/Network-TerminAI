import { create } from "zustand";
import { CanvasReferenceResolver } from "../lib/copilotCanvas";
import type { CanvasCard, CanvasEvent, CanvasRun, EvidenceRef, EvidenceSnapshot, JsonValue } from "../lib/copilotCanvas";
import { canvasOpenWorkspace, canvasSaveEvent, canvasSaveRun } from "../lib/tauri";
import type { CanvasWorkspaceSnapshot } from "../lib/tauri";

type View = { filter: string; inspectedCardId: string | null };
type Selection = { pendingCardIds: string[]; attachedCardIds: string[] };
type Workspace = CanvasWorkspaceSnapshot & {
  save: { status: "saving" | "saved" | "failed"; error: string | null; pending: number; unsavedCardIds: string[] };
  limitations: { run_id: string; limitation: string }[];
  view: View;
  selection: Selection;
};
type Store = {
  workspaces: Record<string, Workspace>;
  load: (workspaceId: string) => Promise<void>;
  beginRun: (workspaceId: string, runId: string) => Promise<void>;
  accept: (event: CanvasEvent) => Promise<void>;
  finishRun: (workspaceId: string, runId: string, status: CanvasRun["status"]) => Promise<void>;
  noteLimitation: (workspaceId: string, runId: string, limitation: string) => void;
  setView: (workspaceId: string, view: Partial<View>) => void;
  setSelection: (workspaceId: string, selection: Partial<Selection>) => void;
};
const live = (status: CanvasRun["status"]) => status === "collecting" || status === "awaiting_approval";
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const key = (workspace: string, run: string) => JSON.stringify([workspace, run]);
const references = (value: JsonValue, found: EvidenceRef[] = []): EvidenceRef[] => {
  if (Array.isArray(value)) value.forEach(item => references(item, found));
  else if (value && typeof value === "object") {
    if ("evidence_id" in value && "path" in value) found.push(value as EvidenceRef);
    else Object.values(value).forEach(item => references(item, found));
  }
  return found;
};

export const useCopilotCanvas = create<Store>((set, get) => {
  const queues = new Map<string, { tail: Promise<void>; events: Map<number, string> }>();
  const workspace = (id: string) => {
    const value = get().workspaces[id];
    if (!value) throw new Error("Unknown Canvas workspace");
    return value;
  };
  const update = (id: string, change: (state: Workspace) => Workspace) => set(state => ({
    workspaces: { ...state.workspaces, [id]: change(state.workspaces[id]) },
  }));
  const queue = (id: string, run: string, write: () => Promise<void>) => {
    const queueKey = key(id, run);
    const current = queues.get(queueKey) ?? { tail: Promise.resolve(), events: new Map<number, string>() };
    update(id, state => ({ ...state, save: { ...state.save, pending: state.save.pending + 1, status: state.save.error ? "failed" : "saving" } }));
    const next = current.tail.then(write).then(() => {
      update(id, state => ({ ...state, save: { ...state.save, pending: state.save.pending - 1,
        status: state.save.error ? "failed" : state.save.pending > 1 ? "saving" : "saved" } }));
    }, (error: unknown) => {
      update(id, state => ({ ...state, save: { ...state.save, pending: state.save.pending - 1, status: "failed", error: String(error) } }));
      throw error;
    });
    // Keep a failed chain failed: later status saves must not hide a lost event.
    queues.set(queueKey, { ...current, tail: next });
    void next.catch(() => {}); // Channel consumers see failure in save state even if they cannot await.
    return next;
  };
  return {
    workspaces: {},
    load: async id => {
      const before = get().workspaces[id];
      // A failed write still blocks later writes, but must not block a data-only read.
      const settled = await Promise.allSettled((before?.runs ?? []).map(run => queues.get(key(id, run.run_id))?.tail));
      const reading = get().workspaces[id];
      const snapshot = await canvasOpenWorkspace(id);
      if (snapshot.tab.id !== id || snapshot.tab.tab_type !== "canvas") throw new Error("Foreign Canvas workspace snapshot");
      // Only failed pre-read writes with no persisted run can be failed creations.
      const uncreated = new Set((before?.runs ?? []).filter((run, index) => settled[index].status === "rejected" &&
        !snapshot.runs.some(saved => saved.run_id === run.run_id)).map(run => run.run_id));
      set(state => {
        const current = state.workspaces[id];
        const existing = current && uncreated.size ? { ...current,
          runs: current.runs.filter(run => !uncreated.has(run.run_id)),
          cards: current.cards.filter(card => !uncreated.has(card.run_id)),
          evidence: current.evidence.filter(item => !uncreated.has(item.run_id)),
          warnings: current.warnings.filter(event => !uncreated.has(event.run_id)),
          limitations: current.limitations.filter(item => !uncreated.has(item.run_id)),
          save: { ...current.save, unsavedCardIds: current.save.unsavedCardIds.filter(cardId =>
            !current.cards.some(card => card.card_id === cardId && uncreated.has(card.run_id))) },
        } : current;
        // A live turn (or an update racing this read) remains owned by its initiating workspace.
        const preserve = existing && (current !== reading || existing.runs.some(run => live(run.status)));
        const value: Workspace = preserve ? { ...existing, tab: snapshot.tab,
          save: { ...existing.save, unsavedCardIds: existing.save.unsavedCardIds.filter(cardId => !snapshot.cards.some(card => card.card_id === cardId)) },
        } : {
          ...snapshot, warnings: snapshot.warnings ?? [],
          runs: existing?.save.error ? existing.runs : snapshot.runs,
          limitations: existing?.limitations ?? [],
          save: existing?.save.error ? { ...existing.save, unsavedCardIds: [] } : { status: "saved", error: null, pending: 0, unsavedCardIds: [] },
          view: existing?.view ?? { filter: "", inspectedCardId: null },
          selection: existing?.selection ?? { pendingCardIds: [], attachedCardIds: [] },
        };
        return { workspaces: { ...state.workspaces, [id]: value } };
      });
    },
    beginRun: async (id, runId) => {
      const current = workspace(id);
      if (!runId || current.runs.some(run => run.run_id === runId)) throw new Error("Canvas run already exists or has no ID");
      const run: CanvasRun = { workspace_id: id, run_id: runId, status: "collecting", started_at: new Date().toISOString(), ended_at: null, scope: null, coverage: null };
      queues.set(key(id, runId), { tail: Promise.resolve(), events: new Map() });
      update(id, state => ({ ...state, runs: [...state.runs, run] }));
      await queue(id, runId, () => canvasSaveRun(id, copy(run)));
    },
    accept: async incoming => {
      const event = copy(incoming);
      const id = event.workspace_id, runId = event.run_id;
      const current = workspace(id), run = current.runs.find(run => run.run_id === runId);
      if (!run) throw new Error("Unknown Canvas run");
      const reject: (message: string) => never = message => {
        get().noteLimitation(id,runId,"Canvas presentation was not accepted; network execution was not changed.");
        throw new Error(message);
      };
      if (Object.keys(event).sort().join() !== ["type", "version", "workspace_id", "run_id", "seq", "kind", "payload"].sort().join() ||
          event.type !== "canvas" || event.version !== 1 || !Number.isSafeInteger(event.seq) || event.seq < 1 ||
          !["card", "coverage", "warning"].includes(event.kind) || new TextEncoder().encode(JSON.stringify(event.payload)).length > 2 * 1024 * 1024)
        reject("Invalid Canvas event");
      const queueKey = key(id, runId), known = queues.get(queueKey);
      const encoded = canonical(event), previous = known?.events.get(event.seq);
      if (previous !== undefined) {
        if (previous !== encoded) reject("Conflicting Canvas event sequence");
        return known?.tail;
      }
      if (!live(run.status) || (known && [...known.events.keys()].some(seq => seq >= event.seq))) reject("Finished run or out of order Canvas event");
      let cards = current.cards, evidence = current.evidence, runs = current.runs, warnings = current.warnings;
      let unsavedCardId: string | null = null;
      if (event.kind === "card") {
        const payload = event.payload as unknown as { card: CanvasCard; snapshots: EvidenceSnapshot[] };
        if (!payload || Object.keys(payload).sort().join() !== "card,snapshots" || !Array.isArray(payload.snapshots)) reject("Invalid Canvas card event");
        const { card, snapshots } = payload;
        if (!card || card.workspace_id !== id || card.run_id !== runId || !card.card_id || !/^\d{4}-\d\d-\d\dT.*Z$/.test(card.created_at)) reject("Foreign or invalid Canvas card");
        const byId = new Map(current.evidence.filter(s => s.run_id === runId).map(s => [s.evidence_id, s]));
        for (const s of snapshots) {
          if (!s || s.workspace_id !== id || s.run_id !== runId) reject("Foreign Canvas evidence");
          const old = current.evidence.find(item => item.evidence_id === s.evidence_id) ?? byId.get(s.evidence_id);
          if (old && canonical(old) !== canonical(s)) reject("Conflicting evidence ID");
          byId.set(s.evidence_id, s);
        }
        const resolver = new CanvasReferenceResolver([...byId.values()]);
        for (const s of snapshots) if (!resolver.resolve({ evidence_id: s.evidence_id, path: "" }).ok) reject("Invalid Canvas evidence");
        const valid = resolver.resolveCard(card);
        if (!valid.ok) reject(valid.limitation);
        const old = current.cards.find(item => item.card_id === card.card_id);
        if (old && canonical(old) !== canonical(card)) reject("Conflicting card ID");
        const needed = new Set(references(card as unknown as JsonValue).map(ref => ref.evidence_id));
        const pending: [string, boolean][] = [...needed].map(id => [id, false]);
        const active = new Set<string>(), checked = new Set<string>();
        while (pending.length) {
          const [evidenceId, exit] = pending.pop()!;
          if (exit) { active.delete(evidenceId); checked.add(evidenceId); continue; }
          if (checked.has(evidenceId)) continue;
          if (active.has(evidenceId)) reject("Cyclic Canvas ancestry");
          active.add(evidenceId); pending.push([evidenceId, true]);
          const s = byId.get(evidenceId);
          if (!s) reject("Missing Canvas ancestry");
          for (const parent of s.parent_refs) {
            if (!resolver.resolve(parent).ok || active.has(parent.evidence_id)) reject("Invalid or cyclic Canvas ancestry");
            needed.add(parent.evidence_id); pending.push([parent.evidence_id, false]);
          }
        }
        cards = old ? cards : [...cards, card];
        if (!old) unsavedCardId = card.card_id;
        evidence = [...current.evidence, ...[...needed].filter(evidenceId => !current.evidence.some(s => s.evidence_id === evidenceId)).map(evidenceId => byId.get(evidenceId)!)];
      } else if (event.kind === "coverage") {
        if (!event.payload || Array.isArray(event.payload) || typeof event.payload !== "object") reject("Invalid Canvas coverage");
        const resolver = new CanvasReferenceResolver(current.evidence.filter(s => s.run_id === runId));
        for (const ref of references(event.payload)) if (!resolver.resolve(ref).ok) reject("Unknown Canvas coverage evidence");
        runs = runs.map(run => run.run_id === runId ? { ...run, coverage: event.payload } : run);
      } else {
        if (!event.payload || Array.isArray(event.payload) || typeof event.payload !== "object" || typeof event.payload.limitation !== "string") reject("Invalid Canvas warning");
        warnings = [...warnings, { ...event, payload: { limitation: event.payload.limitation } }];
      }
      update(id, state => ({ ...state, cards, evidence, runs, warnings,
        save: unsavedCardId ? { ...state.save, unsavedCardIds: [...state.save.unsavedCardIds, unsavedCardId] } : state.save,
      }));
      const saved = queue(id, runId, async () => {
        await canvasSaveEvent(id, event);
        if (unsavedCardId) update(id, state => ({ ...state, save: { ...state.save, unsavedCardIds: state.save.unsavedCardIds.filter(cardId => cardId !== unsavedCardId) } }));
      });
      queues.get(queueKey)!.events.set(event.seq, encoded);
      await saved;
    },
    finishRun: async (id, runId, status) => {
      const run = workspace(id).runs.find(run => run.run_id === runId);
      if (!run) throw new Error("Unknown Canvas run");
      if (!live(run.status) && run.status !== status) throw new Error("Finished Canvas run is immutable");
      const next: CanvasRun = { ...run, status, ended_at: live(status) ? null : run.ended_at ?? new Date().toISOString() };
      update(id, state => ({ ...state, runs: state.runs.map(run => run.run_id === runId ? next : run) }));
      await queue(id, runId, () => canvasSaveRun(id, copy(next)));
    },
    noteLimitation: (id, runId, limitation) => {
      if (!workspace(id).runs.some(run => run.run_id === runId)) throw new Error("Unknown Canvas run");
      update(id, state => ({ ...state, limitations: [...state.limitations, { run_id: runId, limitation }] }));
    },
    setView: (id, view) => update(id, state => ({ ...state, view: { ...state.view, ...view } })),
    setSelection: (id, selection) => update(id, state => ({ ...state, selection: { ...state.selection, ...copy(selection) } })),
  };
});
