import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../tests/fixtures/copilot_canvas/v1.json";
import type { CanvasCard, CanvasEvent, CanvasRun, EvidenceSnapshot } from "../lib/copilotCanvas";
import { useCopilotCanvas } from "./copilotCanvasStore";
import { agentReactCodeRun, agentReactResume, canvasCreateWorkspace, canvasListWorkspaces, canvasOpenWorkspace, canvasRenameWorkspace } from "../lib/tauri";
import type { ReactEvent } from "../lib/tauri";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as { onmessage: ((event: unknown) => void) | null }[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke, Channel: class { onmessage = null; constructor() { ipc.channels.push(this); } } }));
const tab = { id: "canvas-tab-1", title: "Synthetic", tab_type: "canvas" as const, shell_cmd: "", cwd: "", created_at: 1792929600 };
const snapshot = () => ({ tab, runs: [] as CanvasRun[], evidence: [] as EvidenceSnapshot[], cards: [] as CanvasCard[] });
function event(index = 0, workspace = tab.id, run = "run-1"): CanvasEvent {
  const card = { ...fixture.cards[index], card_id: `card-${index}`, workspace_id: workspace, run_id: run, created_at: "2026-10-25T12:00:02Z" };
  const snapshots = fixture.snapshots.map(s => ({ ...s, workspace_id: workspace, run_id: run }));
  return JSON.parse(JSON.stringify({ type: "canvas", version: 1, workspace_id: workspace, run_id: run, seq: index + 1, kind: "card", payload: { card, snapshots } })) as CanvasEvent;
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
  useCopilotCanvas.setState({ workspaces: {} }); ipc.invoke.mockReset(); ipc.channels.length = 0;
  ipc.invoke.mockImplementation(async (command: string) => command === "canvas_open_workspace" ? snapshot() : undefined);
});

describe("Canvas persistence store", () => {
  it("loads saved data only, including interrupted status, without execution or automatic resume", async () => {
    ipc.invoke.mockResolvedValueOnce({ ...snapshot(), runs: [{ workspace_id: tab.id, run_id: "restored", status: "interrupted", started_at: "2026-10-25T12:00:00Z", ended_at: "2026-10-25T12:01:00Z", scope: null, coverage: null }] });
    await useCopilotCanvas.getState().load(tab.id);
    const state = useCopilotCanvas.getState().workspaces[tab.id];
    expect(state.runs[0].status).toBe("interrupted"); expect(state.save.status).toBe("saved");
    expect(ipc.invoke.mock.calls.map(c => c[0])).toEqual(["canvas_open_workspace"]);
  });

  it("awaits run creation, preserves fixture fields, queues events before terminal status", async () => {
    await useCopilotCanvas.getState().load(tab.id);
    const creation = deferred(); const savedEvent = deferred();
    ipc.invoke.mockImplementation(async (command: string) => {
      if (command === "canvas_save_run" && ipc.invoke.mock.calls.filter(c => c[0] === command).length === 1) await creation.promise;
      if (command === "canvas_save_event") await savedEvent.promise;
    });
    const begin = useCopilotCanvas.getState().beginRun(tab.id, "run-1");
    const accepted = useCopilotCanvas.getState().accept(event());
    const finish = useCopilotCanvas.getState().finishRun(tab.id, "run-1", "completed");
    await Promise.resolve();
    expect(ipc.invoke.mock.calls.map(c => c[0])).toEqual(["canvas_open_workspace", "canvas_save_run"]);
    creation.resolve(); await begin; await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("canvas_save_event", { workspaceId: tab.id, event: event() }));
    expect(ipc.invoke.mock.calls.filter(c => c[0] === "canvas_save_run")).toHaveLength(1);
    savedEvent.resolve(); await accepted; await finish;
    const state = useCopilotCanvas.getState().workspaces[tab.id];
    expect(state.cards[0]).toEqual((event().payload as { card: CanvasCard }).card);
    expect(state.evidence).toEqual([fixture.snapshots[0]]);
    expect(state.runs[0].status).toBe("completed"); expect(state.save.status).toBe("saved");
    expect(ipc.invoke.mock.calls.map(c => c[0])).toEqual(["canvas_open_workspace", "canvas_save_run", "canvas_save_event", "canvas_save_run"]);
  });

  it("separates view/selection/run/save state across workspace switches and delayed saves", async () => {
    await useCopilotCanvas.getState().load(tab.id);
    useCopilotCanvas.getState().setView(tab.id, { filter: "errors", inspectedCardId: "card-0" });
    useCopilotCanvas.getState().setSelection(tab.id, { pendingCardIds: ["card-0"], attachedCardIds: [] });
    await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    const delay = deferred(); ipc.invoke.mockImplementation(async command => command === "canvas_open_workspace" ? { ...snapshot(), tab: { ...tab, id: "other" } } : delay.promise);
    const saving = useCopilotCanvas.getState().accept(event());
    await useCopilotCanvas.getState().load("other"); delay.resolve(); await saving;
    const a = useCopilotCanvas.getState().workspaces[tab.id], b = useCopilotCanvas.getState().workspaces.other;
    expect(a.view).toEqual({ filter: "errors", inspectedCardId: "card-0" });
    expect(a.selection).toEqual({ pendingCardIds: ["card-0"], attachedCardIds: [] });
    expect(b.cards).toEqual([]); expect(b.runs).toEqual([]); expect(b.view.inspectedCardId).toBeNull();
  });

  it("makes duplicates idempotent and rejects conflicting delivery, unknown runs and foreign evidence", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    await useCopilotCanvas.getState().accept(event()); await useCopilotCanvas.getState().accept(event());
    expect(ipc.invoke.mock.calls.filter(c => c[0] === "canvas_save_event")).toHaveLength(1);
    const conflict = event(); (conflict.payload as { card: CanvasCard }).card.title = "Conflicting";
    await expect(useCopilotCanvas.getState().accept(conflict)).rejects.toThrow();
    await expect(useCopilotCanvas.getState().accept(event(0,tab.id,"unknown"))).rejects.toThrow();
    const foreign = event(1); (foreign.payload as { snapshots: EvidenceSnapshot[] }).snapshots[0].workspace_id = "other";
    await expect(useCopilotCanvas.getState().accept(foreign)).rejects.toThrow();
    await useCopilotCanvas.getState().finishRun(tab.id,"run-1","completed");
    await expect(useCopilotCanvas.getState().accept(event(1))).rejects.toThrow();
    expect(useCopilotCanvas.getState().workspaces[tab.id].cards).toHaveLength(1);
  });

  it("rejects conflicting snapshots inside one batch and cyclic derived ancestry before saving", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    const conflict = event();
    const batch = (conflict.payload as { snapshots: EvidenceSnapshot[] }).snapshots;
    batch.push({ ...batch[0], data: { ...(batch[0].data as Record<string, unknown>), changed: true } as EvidenceSnapshot["data"] });
    await expect(useCopilotCanvas.getState().accept(conflict)).rejects.toThrow();
    const cyclic = event(); const snapshots = (cyclic.payload as { snapshots: EvidenceSnapshot[] }).snapshots;
    snapshots[0] = { ...snapshots[0], origin: "derived", parent_refs: [{ evidence_id: "evidence-b", path: "" }], calculation: "Synthetic" };
    snapshots[1] = { ...snapshots[1], origin: "derived", parent_refs: [{ evidence_id: "evidence-a", path: "" }], calculation: "Synthetic" };
    await expect(useCopilotCanvas.getState().accept(cyclic)).rejects.toThrow();
    expect(ipc.invoke.mock.calls.filter(c => c[0] === "canvas_save_event")).toHaveLength(0);
  });

  it("exposes a save failure independently, retaining evidence and blocking a false saved completion", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    ipc.invoke.mockRejectedValueOnce(new Error("synthetic disk failure"));
    await expect(useCopilotCanvas.getState().accept(event())).rejects.toThrow("synthetic disk failure");
    let state = useCopilotCanvas.getState().workspaces[tab.id];
    expect(state.cards).toHaveLength(1); expect(state.runs[0].status).toBe("collecting");
    expect(state.save.status).toBe("failed"); expect(state.save.error).toContain("synthetic disk failure");
    await expect(useCopilotCanvas.getState().finishRun(tab.id,"run-1","completed")).rejects.toThrow();
    state = useCopilotCanvas.getState().workspaces[tab.id]; expect(state.save.status).toBe("failed");
    expect(ipc.invoke.mock.calls.filter(c => c[0] === "canvas_save_run")).toHaveLength(1);
  });

  it("reopens persisted prior evidence after a failed recheck without claiming optimistic cards were restored", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    await useCopilotCanvas.getState().accept(event()); await useCopilotCanvas.getState().finishRun(tab.id,"run-1","completed");
    await useCopilotCanvas.getState().beginRun(tab.id,"recheck");
    const saved = useCopilotCanvas.getState().workspaces[tab.id];
    const persisted = { tab, runs: saved.runs, cards: saved.cards, evidence: saved.evidence, warnings: saved.warnings };
    const unsaved = JSON.parse(JSON.stringify(event(1,tab.id,"recheck")).replace(/evidence-a/g,"recheck-a").replace(/evidence-b/g,"recheck-b")) as CanvasEvent;
    ipc.invoke.mockImplementation(async command => {
      if (command === "canvas_open_workspace") return persisted;
      if (command === "canvas_save_event") throw new Error("synthetic recheck save failure");
    });
    await expect(useCopilotCanvas.getState().accept(unsaved)).rejects.toThrow("synthetic recheck save failure");
    await expect(useCopilotCanvas.getState().finishRun(tab.id,"recheck","failed")).rejects.toThrow();
    await expect(useCopilotCanvas.getState().load(tab.id)).resolves.toBeUndefined();
    const restored = useCopilotCanvas.getState().workspaces[tab.id];
    expect(restored.cards).toEqual(persisted.cards); expect(restored.evidence).toEqual(persisted.evidence);
    expect(restored.runs.find(run => run.run_id === "recheck")?.status).toBe("failed");
    expect(restored.save.status).toBe("failed"); expect(restored.save.error).toContain("synthetic recheck save failure");
    expect(ipc.invoke.mock.calls.filter(c => c[0] === "canvas_open_workspace")).toHaveLength(2);
    expect(ipc.invoke.mock.calls.some(c => /agent|pty|resume/.test(c[0] as string))).toBe(false);
    await expect(useCopilotCanvas.getState().finishRun(tab.id,"recheck","failed")).rejects.toThrow();
  });

  it("allows a read after terminal-save failure without clearing the failure or reopening writes", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    await useCopilotCanvas.getState().accept(event());
    const saved = useCopilotCanvas.getState().workspaces[tab.id];
    ipc.invoke.mockRejectedValueOnce(new Error("synthetic status save failure"));
    await expect(useCopilotCanvas.getState().finishRun(tab.id,"run-1","failed")).rejects.toThrow();
    ipc.invoke.mockResolvedValueOnce({ tab, runs: saved.runs, evidence: saved.evidence, cards: saved.cards, warnings: [] });
    await expect(useCopilotCanvas.getState().load(tab.id)).resolves.toBeUndefined();
    const restored = useCopilotCanvas.getState().workspaces[tab.id];
    expect(restored.cards).toEqual(saved.cards); expect(restored.runs[0].status).toBe("failed");
    expect(restored.save.status).toBe("failed"); expect(restored.save.error).toContain("synthetic status save failure");
    const writes = ipc.invoke.mock.calls.filter(c => c[0] === "canvas_save_run").length;
    await expect(useCopilotCanvas.getState().finishRun(tab.id,"run-1","failed")).rejects.toThrow();
    expect(ipc.invoke.mock.calls.filter(c => c[0] === "canvas_save_run")).toHaveLength(writes);
  });

  it("distinguishes unsaved live cards from restored evidence and preserves ownership during a racing read", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    const persistedRuns = useCopilotCanvas.getState().workspaces[tab.id].runs;
    ipc.invoke.mockRejectedValueOnce(new Error("synthetic live save failure"));
    await expect(useCopilotCanvas.getState().accept(event())).rejects.toThrow();
    const delay = deferred();
    ipc.invoke.mockImplementation(async command => { if (command === "canvas_open_workspace") { await delay.promise; return { ...snapshot(), runs: persistedRuns }; } });
    const loading = useCopilotCanvas.getState().load(tab.id);
    void loading.catch(() => {});
    await vi.waitFor(() => expect(ipc.invoke.mock.calls.filter(c => c[0] === "canvas_open_workspace")).toHaveLength(2));
    await expect(useCopilotCanvas.getState().accept(event(1))).rejects.toThrow();
    delay.resolve(); await loading;
    const state = useCopilotCanvas.getState().workspaces[tab.id];
    expect(state.runs[0].status).toBe("collecting"); expect(state.cards).toHaveLength(2);
    expect(state.save.status).toBe("failed"); expect(state.save.unsavedCardIds).toEqual(["card-0","card-1"]);
  });

  it("roundtrips all seven fixture cards without overwriting snapshots and retains prior evidence on failed recheck", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    for (let i = 0; i < 7; i++) await useCopilotCanvas.getState().accept(event(i));
    const original = useCopilotCanvas.getState().workspaces[tab.id];
    expect(original.cards).toEqual(Array.from({ length: 7 }, (_, i) => (event(i).payload as { card: CanvasCard }).card));
    expect(original.evidence).toEqual(fixture.snapshots);
    await useCopilotCanvas.getState().finishRun(tab.id,"run-1","completed");
    await useCopilotCanvas.getState().beginRun(tab.id,"recheck");
    await useCopilotCanvas.getState().finishRun(tab.id,"recheck","failed");
    expect(useCopilotCanvas.getState().workspaces[tab.id].cards).toEqual(original.cards);
    expect(useCopilotCanvas.getState().workspaces[tab.id].evidence).toEqual(original.evidence);
  });

  it("does not report run creation ready or send later saves when initial persistence fails", async () => {
    await useCopilotCanvas.getState().load(tab.id);
    ipc.invoke.mockRejectedValueOnce(new Error("synthetic creation failure"));
    await expect(useCopilotCanvas.getState().beginRun(tab.id,"run-1")).rejects.toThrow("synthetic creation failure");
    await expect(useCopilotCanvas.getState().accept(event())).rejects.toThrow("synthetic creation failure");
    expect(useCopilotCanvas.getState().workspaces[tab.id].save.status).toBe("failed");
    expect(ipc.invoke.mock.calls.map(c => c[0])).toEqual(["canvas_open_workspace","canvas_save_run"]);
  });

  it("reconciles a never-created run on reopen without hiding the save failure or reserving its ID", async () => {
    await useCopilotCanvas.getState().load(tab.id);
    ipc.invoke.mockRejectedValueOnce(new Error("synthetic creation failure"));
    const beginning = useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    const accepted = expect(useCopilotCanvas.getState().accept(event())).rejects.toThrow("synthetic creation failure");
    await expect(beginning).rejects.toThrow("synthetic creation failure"); await accepted;
    expect(useCopilotCanvas.getState().workspaces[tab.id].cards).toHaveLength(1);
    await useCopilotCanvas.getState().load(tab.id);
    const reopened = useCopilotCanvas.getState().workspaces[tab.id];
    expect(reopened.runs).toEqual([]); expect(reopened.cards).toEqual([]); expect(reopened.evidence).toEqual([]);
    expect(reopened.save.status).toBe("failed"); expect(reopened.save.error).toContain("synthetic creation failure");
    expect(reopened.save.unsavedCardIds).toEqual([]); expect(reopened.save.pending).toBe(0);
    expect(ipc.invoke.mock.calls.map(call => call[0])).toEqual(["canvas_open_workspace","canvas_save_run","canvas_open_workspace"]);
    await expect(useCopilotCanvas.getState().beginRun(tab.id,"run-1")).resolves.toBeUndefined();
    expect(useCopilotCanvas.getState().workspaces[tab.id].runs).toHaveLength(1);
    expect(useCopilotCanvas.getState().workspaces[tab.id].save.status).toBe("failed");
    expect(ipc.invoke.mock.calls.filter(call => call[0] === "canvas_save_run")).toHaveLength(2);
  });

  it("removes only the confirmed failed creation while preserving a new run racing the read", async () => {
    await useCopilotCanvas.getState().load(tab.id);
    ipc.invoke.mockRejectedValueOnce(new Error("synthetic creation failure"));
    await expect(useCopilotCanvas.getState().beginRun(tab.id,"never-created")).rejects.toThrow();
    const delay = deferred();
    ipc.invoke.mockImplementation(async command => { if (command === "canvas_open_workspace") { await delay.promise; return snapshot(); } });
    const loading = useCopilotCanvas.getState().load(tab.id);
    await vi.waitFor(() => expect(ipc.invoke.mock.calls.filter(call => call[0] === "canvas_open_workspace")).toHaveLength(2));
    await useCopilotCanvas.getState().beginRun(tab.id,"new-live");
    await useCopilotCanvas.getState().accept(event(0,tab.id,"new-live"));
    delay.resolve(); await loading;
    const reopened = useCopilotCanvas.getState().workspaces[tab.id];
    expect(reopened.runs.map(run => run.run_id)).toEqual(["new-live"]);
    expect(reopened.runs[0].status).toBe("collecting"); expect(reopened.cards).toHaveLength(1);
    expect(reopened.cards[0].run_id).toBe("new-live"); expect(reopened.save.unsavedCardIds).toEqual([]);
    expect(reopened.save.status).toBe("failed"); expect(reopened.save.error).toContain("synthetic creation failure");
    expect(ipc.invoke.mock.calls.some(call => /agent|pty|resume/.test(call[0] as string))).toBe(false);
  });

  it("does not let a load racing live events overwrite current run or card state", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    const delay = deferred(); ipc.invoke.mockImplementation(async command => { if (command === "canvas_open_workspace") { await delay.promise; return snapshot(); } });
    const loading = useCopilotCanvas.getState().load(tab.id);
    await vi.waitFor(() => expect(ipc.invoke.mock.calls.filter(c => c[0] === "canvas_open_workspace")).toHaveLength(2));
    await useCopilotCanvas.getState().accept(event()); delay.resolve(); await loading;
    expect(useCopilotCanvas.getState().workspaces[tab.id].cards).toHaveLength(1);
    expect(useCopilotCanvas.getState().workspaces[tab.id].runs[0].status).toBe("collecting");
  });

  it("rejects unknown coverage evidence before it can be mistaken for assessed coverage", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    const coverage: CanvasEvent = { type: "canvas", version: 1, workspace_id: tab.id, run_id: "run-1", seq: 1, kind: "coverage", payload: { assessed_refs: [{ evidence_id: "foreign", path: "" }] } };
    await expect(useCopilotCanvas.getState().accept(coverage)).rejects.toThrow();
    expect(useCopilotCanvas.getState().workspaces[tab.id].runs[0].coverage).toBeNull();
    expect(ipc.invoke.mock.calls.filter(c => c[0] === "canvas_save_event")).toHaveLength(0);
  });

  it("accepts a producer-compatible near-limit payload even when its enclosing event exceeds 2 MiB", async () => {
    const runId = "00000000-0000-4000-8000-000000000002";
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,runId);
    const near = event(0,tab.id,runId);
    const payload = near.payload as unknown as { card: CanvasCard; snapshots: EvidenceSnapshot[] };
    payload.snapshots = payload.snapshots.slice(0,1);
    const data = payload.snapshots[0].data as Record<string, string>;
    data.padding = "";
    // The producer's default JSON spacing fits within this 128-byte headroom.
    data.padding = "x".repeat(2 * 1024 * 1024 - 128 - new TextEncoder().encode(JSON.stringify(payload)).length);
    expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(near)).length).toBeGreaterThan(2 * 1024 * 1024);
    await useCopilotCanvas.getState().accept(near);
    const state = useCopilotCanvas.getState().workspaces[tab.id];
    expect(state.cards).toEqual([payload.card]); expect(state.evidence).toEqual(payload.snapshots);
    expect(state.save.status).toBe("saved"); expect(state.save.unsavedCardIds).toEqual([]);
    expect(ipc.invoke).toHaveBeenCalledWith("canvas_save_event", { workspaceId: tab.id, event: near });
  });

  it("keeps a local validation rejection visible without persisting a warning or failing network execution", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    const oversized: CanvasEvent = { type: "canvas", version: 1, workspace_id: tab.id, run_id: "run-1", seq: 1, kind: "warning", payload: { limitation: "x".repeat(2 * 1024 * 1024) } };
    await expect(useCopilotCanvas.getState().accept(oversized)).rejects.toThrow();
    const state = useCopilotCanvas.getState().workspaces[tab.id];
    expect(state.limitations).toEqual([{ run_id: "run-1", limitation: "Canvas presentation was not accepted; network execution was not changed." }]);
    expect(state.warnings).toEqual([]); expect(state.runs[0].status).toBe("collecting"); expect(state.save.status).toBe("saved");
    expect(ipc.invoke.mock.calls.filter(call => call[0] === "canvas_save_event")).toHaveLength(0);
  });

  it("retains warning and coverage separately without fabricating counts or persisting warning snapshots", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    const coverage: CanvasEvent = { type: "canvas", version: 1, workspace_id: tab.id, run_id: "run-1", seq: 1, kind: "coverage", payload: { denominator: null, assessed_refs: [] } };
    const warning: CanvasEvent = { ...coverage, seq: 2, kind: "warning", payload: { limitation: "Inventory unavailable" } };
    await useCopilotCanvas.getState().accept(coverage); await useCopilotCanvas.getState().accept(warning);
    const state = useCopilotCanvas.getState().workspaces[tab.id];
    expect(state.runs[0].coverage).toEqual(coverage.payload); expect(state.warnings).toEqual([warning]); expect(state.evidence).toEqual([]);
  });
});

describe("Canvas transport uses the existing channel", () => {
  it("keeps ordinary arguments unchanged and forwards optional Canvas data verbatim", async () => {
    const onEvent = vi.fn(); await agentReactCodeRun({ agentId: "network-architect", message: "Synthetic", onEvent });
    expect(ipc.invoke.mock.calls[0][1]).not.toHaveProperty("canvas");
    const canvas = { ...fixture.request, selection: fixture.selected_context };
    await agentReactCodeRun({ agentId: "network-architect", message: "Synthetic", canvas, onEvent });
    expect(ipc.invoke.mock.calls[1][1]).toMatchObject({ canvas });
    ipc.channels[1].onmessage?.(event()); expect(onEvent).toHaveBeenCalledWith(event());
    expect(ipc.invoke.mock.calls.map(c => c[0])).toEqual(["agent_react_code_run", "agent_react_code_run"]);
  });
  it("surfaces presentation-only rejection notices on both existing run/resume channels in captured context", async () => {
    await useCopilotCanvas.getState().load(tab.id); await useCopilotCanvas.getState().beginRun(tab.id,"run-1");
    ipc.invoke.mockResolvedValueOnce({ ...snapshot(), tab: { ...tab, id: "other" } });
    await useCopilotCanvas.getState().load("other"); await useCopilotCanvas.getState().beginRun("other","other-run");
    const before = ipc.invoke.mock.calls.length; const observed = vi.fn();
    const onEvent = (incoming: ReactEvent) => {
      observed(incoming);
      if (incoming.type === "canvas_limitation") useCopilotCanvas.getState().noteLimitation(tab.id,"run-1",incoming.limitation);
    };
    await agentReactCodeRun({ agentId: "network-architect", message: "Synthetic", canvas: { workspace_id: tab.id, run_id: "run-1" }, onEvent });
    await agentReactResume({ threadId: "synthetic-thread", decision: "approve", onEvent });
    const limitation = "Canvas presentation was not accepted; network execution was not changed.";
    for (const channel of ipc.channels) {
      channel.onmessage?.({ type: "canvas_limitation", limitation, workspace_id: "other", run_id: "other-run" });
      channel.onmessage?.({ type: "tool_result", success: true, result: "Synthetic successful discovery" });
      channel.onmessage?.({ type: "final", response: "Synthetic complete" });
    }
    const state = useCopilotCanvas.getState().workspaces[tab.id];
    expect(state.limitations).toEqual([{ run_id: "run-1", limitation }, { run_id: "run-1", limitation }]);
    expect(state.warnings).toEqual([]); expect(state.runs[0].status).toBe("collecting"); expect(state.save.status).toBe("saved");
    expect(useCopilotCanvas.getState().workspaces.other.limitations).toEqual([]);
    expect(() => useCopilotCanvas.getState().noteLimitation(tab.id,"other-run",limitation)).toThrow("Unknown Canvas run");
    expect(observed).toHaveBeenCalledTimes(6);
    expect(ipc.invoke.mock.calls.slice(before).map(call => call[0])).toEqual(["agent_react_code_run","agent_react_resume"]);
    await useCopilotCanvas.getState().load(tab.id);
    expect(useCopilotCanvas.getState().workspaces[tab.id].limitations).toEqual(state.limitations);
  });

  it("exposes persisted workspace create/list/open/rename wrappers without terminal calls", async () => {
    ipc.invoke.mockResolvedValueOnce(tab).mockResolvedValueOnce([tab]).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(undefined);
    expect(await canvasCreateWorkspace("Synthetic")).toEqual(tab);
    expect(await canvasListWorkspaces()).toEqual([tab]);
    expect((await canvasOpenWorkspace(tab.id)).tab).toEqual(tab); await canvasRenameWorkspace(tab.id,"Renamed");
    expect(ipc.invoke.mock.calls).toEqual([["canvas_create_workspace", { title: "Synthetic" }], ["canvas_list_workspaces"], ["canvas_open_workspace", { workspaceId: tab.id }], ["canvas_rename_workspace", { workspaceId: tab.id, title: "Renamed" }]]);
  });
});
