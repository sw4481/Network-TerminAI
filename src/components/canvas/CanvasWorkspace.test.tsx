import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { CanvasWorkspace } from "./CanvasWorkspace";
import { CanvasCard as CardView } from "./CanvasCard";
import { CanvasReferenceResolver, type CanvasCard, type EvidenceSnapshot, type ResolvedCanvasCard } from "../../lib/copilotCanvas";
import type { CanvasWorkspaceSnapshot } from "../../lib/tauri";
import { useCopilotCanvas } from "../../state/copilotCanvasStore";
import { useTabs } from "../../state/tabsStore";

const panelFixture = vi.hoisted(() => ({ real: false }));
vi.mock("../../lib/tauri", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/tauri")>(),
  canvasOpenWorkspace: vi.fn(), canvasListWorkspaces: vi.fn(), canvasRenameWorkspace: vi.fn(),
  canvasSaveRun: vi.fn().mockResolvedValue(undefined), canvasSaveEvent: vi.fn().mockResolvedValue(undefined),
  canvasCreateWorkspace: vi.fn(), restoreLastSession: vi.fn(), listTabs: vi.fn().mockResolvedValue([]),
  tabNewApi: vi.fn(), tabNewNetconf: vi.fn(), tabNewEditor: vi.fn(), tabNewSubnet: vi.fn(), terminalDetach: vi.fn(),
  ptyKill: vi.fn(), tabCloseApi: vi.fn(), tabCloseNetconf: vi.fn(), tabCloseEditor: vi.fn(),
  agentReactCodeRun: vi.fn(), agentReactResume: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../hooks/useSessionSave", () => ({ useSessionSave: () => {} }));
vi.mock("../../hooks/usePaneSplit", () => ({ usePaneSplit: () => {} }));
vi.mock("../../hooks/useFanoutShortcuts", () => ({ useFanoutShortcuts: () => {} }));
vi.mock("../../lib/terminalRegistry", () => ({ getOrCreate: vi.fn(), ptyTabIdFor: vi.fn(() => null), dispose: vi.fn(), disposeManaged: vi.fn(), runWhenReady: vi.fn() }));
vi.mock("../../lib/agentNotifications", () => ({ AgentNotifier: class { start() { return Promise.resolve(() => {}); } } }));
vi.mock("../../lib/paneActivity", () => ({ setPaneFocus: vi.fn().mockResolvedValue(undefined), listenPaneActivityUpdated: vi.fn().mockResolvedValue(() => {}), listenAgentSessionUpdated: vi.fn().mockResolvedValue(() => {}), getActiveAgentSessions: vi.fn().mockResolvedValue([]) }));
vi.mock("../GlobalCommandBar", () => ({ GlobalCommandBar: () => null }));
vi.mock("../AgentPanel", async importOriginal => {
  const { AgentPanel } = await importOriginal<typeof import("../AgentPanel")>();
  return { AgentPanel: (props: React.ComponentProps<typeof AgentPanel>) => panelFixture.real ? <AgentPanel {...props} /> : <aside className="agent-panel" aria-label="Mock Architect conversation" data-tab-id={props.tabId} data-canvas-mode={String(!!props.canvasMode)} data-open={String(props.isOpen)} /> };
});
vi.mock("../Terminal", () => ({ Terminal: () => <div>Mock terminal</div> }));
vi.mock("../PaneContainer", () => ({ PaneContainer: () => null }));
vi.mock("../SearchBar", () => ({ SearchBar: () => null }));
vi.mock("../StatusFooter", () => ({ StatusFooter: () => null }));
vi.mock("../UpdateNotification", () => ({ UpdateNotification: () => null }));
vi.mock("../../windows/Settings", () => ({ Settings: () => null }));
vi.mock("../CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("../notebooks/NotebookLibrary", () => ({ NotebookLibrary: () => null }));
vi.mock("../BrowserUrlModal", () => ({ default: () => null }));
vi.mock("../RecentlyClosedModal", () => ({ RecentlyClosedModal: () => null }));
vi.mock("../BlastRadius/BlastRadiusHost", () => ({ BlastRadiusHost: () => null }));
vi.mock("../StateDrawer", () => ({ StateDrawer: () => null }));
vi.mock("../MetadataCard", () => ({ default: () => null }));
vi.mock("../RichInputModal", () => ({ default: () => null }));
vi.mock("../ExecutionDetailDrawer", () => ({ ExecutionDetailDrawer: () => null }));
vi.mock("../HeartbeatTab", () => ({ HeartbeatTab: () => null }));
vi.mock("../KanbanTab", () => ({ KanbanTab: () => null }));
import { canvasCreateWorkspace, canvasListWorkspaces, canvasOpenWorkspace, canvasRenameWorkspace, restoreLastSession, agentReactCodeRun, agentReactResume, ptyKill } from "../../lib/tauri";
import * as terminalRegistry from "../../lib/terminalRegistry";
import { invoke } from "@tauri-apps/api/core";
import { useAgentsStore } from "../../state/agentsStore";
import { useChatStore } from "../../state/chatStore";
import { usePanesStore } from "../../state/panesStore";

// Store persistence queues intentionally outlive presentation resets; each test owns a run.
let fixtureRunNumber = 0;
let fixtureRun = "synthetic-run";
const ref = (path: string, evidence_id = "e1") => ({ evidence_id, path });
const tab = (id = "w1") => ({ id, title: id === "w1" ? "Switch issues" : "Saved investigation", shell_cmd: "", cwd: "", created_at: 0, tab_type: "canvas" as const });
function snapshot(): CanvasWorkspaceSnapshot {
  const evidence: EvidenceSnapshot = { evidence_id: "e1", workspace_id: "w1", run_id: fixtureRun, call_id: "call1", collected_at: "2026-10-25T10:42:00Z", source: { helper: "synthetic.read", resource: "/switches" }, origin: "observed", complete: true, limitation: null, parent_refs: [], calculation: null,
    data: { devices: [{ name: "Duplicate", interface: "Gi1", crc: 1984 }, { name: "Duplicate", interface: "Gi2", crc: 0 }], unavailable: "Authentication failed", event_at: "2026-10-24T10:37:00Z" } };
  const findings = [0, 1].map(index => ({ device: ref(`/devices/${index}/name`), interface: ref(`/devices/${index}/interface`), symptom: index ? "Link transitions" : "CRC increasing", severity: index ? "warning" as const : "critical" as const, cause_assessment: index ? "undetermined" as const : "likely" as const, supporting_refs: [ref(`/devices/${index}`)], contradictory_refs: [ref("/event_at")], unknowns: ["Business impact not established"], remediation_considerations: ["Confirm redundancy; verify fresh counters; retain rollback settings"] }));
  return { tab: tab(), runs: [{ workspace_id: "w1", run_id: fixtureRun, status: "collecting", started_at: "2026-10-25T10:32:00Z", ended_at: null, scope: "Switch fleet", coverage: { assessed: 999, total: 999, unavailable: 0 } }], evidence: [evidence], cards: findings.map((finding, index) => ({ card_id: `c${index}`, workspace_id: "w1", run_id: fixtureRun, created_at: "2026-10-25T10:42:01Z", title: `Finding ${index}`, type: "findings", source_refs: [ref(`/devices/${index}`)], metadata: { findings: [finding] } })), warnings: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function mount(value = snapshot()) {
  vi.mocked(canvasOpenWorkspace).mockResolvedValue(value);
  const view = render(<CanvasWorkspace workspaceId="w1" />);
  await screen.findByRole("heading", { name: "Switch issues" });
  return view;
}
function patch(change: (state: ReturnType<typeof useCopilotCanvas.getState>["workspaces"][string]) => ReturnType<typeof useCopilotCanvas.getState>["workspaces"][string]) {
  act(() => useCopilotCanvas.setState(state => ({ workspaces: { ...state.workspaces, w1: change(state.workspaces.w1) } })));
}
beforeEach(() => {
  vi.clearAllMocks();
  panelFixture.real = false;
  fixtureRun = `synthetic-run-${++fixtureRunNumber}`;
  localStorage.removeItem("ccie.agentWidth");
  useCopilotCanvas.setState({ workspaces: {} });
  useChatStore.setState({ messages: {}, streaming: {}, error: {}, pendingSources: {} });
  useTabs.setState({ tabs: [tab()], activeTabId: "w1", blocks: {} });
  vi.mocked(canvasListWorkspaces).mockResolvedValue([tab(), tab("w2")]);
  vi.mocked(canvasRenameWorkspace).mockResolvedValue(undefined);
});

describe("Canvas evidence board", () => {
  it("shows only the exact completed final with an opening excerpt and focusable native full-answer disclosure", async () => {
    const value = snapshot();
    value.runs[0].status = "completed";
    const response = `Exact opening: findings remain uncertain.\n\n${"Retained detail. ".repeat(50)}\n\nFinal recommendation: verify before acting.`;
    useChatStore.setState({ messages: { "w1::network-architect": [{ id: "live", role: "assistant", content: "Intermediate thoughts must stay in chat", timestamp: Date.parse(value.runs[0].started_at) + 1, canvasFinal: { runId: fixtureRun, response } }] }, streaming: {} });
    await mount(value);
    const summary = screen.getByRole("region", { name: "Architect’s final answer" });
    expect(within(summary).getByText("Opening excerpt — complete opening paragraphs")).toBeInTheDocument();
    expect(summary.querySelector(".canvas-answer-excerpt")?.textContent).toBe("Exact opening: findings remain uncertain.");
    expect(within(summary).getByRole("region", { name: "Final-answer preview; scroll horizontally for wide content" })).toHaveAttribute("tabindex", "0");
    expect(summary).not.toHaveTextContent("Intermediate thoughts");
    const disclosure = within(summary).getByText("Read full answer");
    expect(disclosure.closest("details")).not.toHaveAttribute("open");
    disclosure.focus();
    expect(disclosure).toHaveFocus();
    expect(disclosure.tagName).toBe("SUMMARY");
    // jsdom lacks native Enter activation; the real-browser suite covers keyboard opening.
    await userEvent.setup().click(disclosure);
    expect(disclosure.closest("details")).toHaveAttribute("open");
    expect(within(summary).getByText(/Final recommendation: verify before acting/)).toBeVisible();
    expect(summary.querySelector(".canvas-answer-body")?.textContent).toContain("Retained detail. ".repeat(50).trim());
  });

  it.each(["\n\n", "\r\n\r\n"])("renders complete exact opening paragraphs as safe Markdown with %j boundaries", async boundary => {
    const value = snapshot();
    value.runs[0].status = "completed";
    const opening = `# Exact overview${boundary}**Uncertain finding.** ![Topology unavailable](https://invalid.test/topology.png)`;
    const response = `${opening}${boundary}${"Do not execute without independent verification. ".repeat(20)}`;
    useChatStore.setState({ messages: { "w1::network-architect": [{ id: "m", role: "assistant", content: response, timestamp: Date.now(), canvasFinal: { runId: fixtureRun, response } }] } });
    await mount(value);
    const preview = screen.getByRole("region", { name: "Architect’s final answer" }).querySelector(".canvas-answer-excerpt") as HTMLElement;
    expect(within(preview).getByRole("heading", { name: "Exact overview", level: 3 })).toBeVisible();
    expect(preview.querySelector("strong")?.textContent).toBe("Uncertain finding.");
    expect(preview).toHaveTextContent("Topology unavailable");
    expect(preview).not.toHaveTextContent("Do not execute");
    expect(preview.querySelector("img, script")).toBeNull();
    expect(screen.getByText("Opening excerpt — complete opening paragraphs")).toBeVisible();
  });

  it("explicitly labels a bounded preview when no complete opening paragraph fits", async () => {
    const value = snapshot();
    value.runs[0].status = "completed";
    const response = "Do not execute without confirming redundancy and rollback ".repeat(20);
    useChatStore.setState({ messages: { "w1::network-architect": [{ id: "m", role: "assistant", content: response, timestamp: Date.now(), canvasFinal: { runId: fixtureRun, response } }] } });
    await mount(value);
    const summary = screen.getByRole("region", { name: "Architect’s final answer" });
    expect(within(summary).getByText("Bounded preview — read full answer for complete context and instructions")).toBeVisible();
    expect(summary.querySelector(".canvas-answer-excerpt")?.textContent).toBe(response.trim().slice(0, 480).replace(/\s+\S*$/, ""));
    fireEvent.click(within(summary).getByText("Read full answer"));
    expect(summary.querySelector(".canvas-answer-body")?.textContent).toBe(response.trim());
  });

  it.each(["collecting", "awaiting_approval", "failed", "cancelled", "interrupted"] as const)("never shows a final answer for a %s run", async status => {
    const value = snapshot();
    value.runs[0].status = status;
    useChatStore.setState({ messages: { "w1::network-architect": [{ id: "m", role: "assistant", content: "Nonfinal", timestamp: Date.now(), canvasFinal: { runId: fixtureRun, response: "Do not promote" } }] }, streaming: {} });
    await mount(value);
    expect(screen.queryByRole("region", { name: "Architect’s final answer" })).toBeNull();
  });

  it.each(["unmarked live shell", "different run", "stale saved answer", "foreign bucket", "user", "tool_result", "empty", "streaming"])("does not infer a final from %s", async mode => {
    const value = snapshot();
    value.runs[0].status = "completed";
    const message = { id: "m", role: mode === "user" ? "user" as const : mode === "tool_result" ? "tool_result" as const : "assistant" as const, content: "Narration is not a final", timestamp: Date.parse(value.runs[0].started_at) + 10, ...(mode === "unmarked live shell" ? {} : { canvasFinal: { runId: mode === "different run" ? "other-run" : mode === "stale saved answer" ? null : fixtureRun, response: mode === "empty" ? " \n " : "Do not promote" } }) };
    if (mode === "stale saved answer") message.timestamp -= 20;
    useChatStore.setState({ messages: { [mode === "foreign bucket" ? "other::network-architect" : "w1::network-architect"]: [message] }, streaming: { "w1::network-architect": mode === "streaming" } });
    await mount(value);
    expect(screen.queryByRole("region", { name: "Architect’s final answer" })).toBeNull();
  });

  it("restores only saved exact finals in the latest run interval, including writes after ended_at", async () => {
    const value = snapshot();
    value.runs[0].status = "completed";
    value.runs[0].ended_at = "2026-10-25T10:42:03Z";
    useChatStore.setState({ messages: { "w1::network-architect": [
      { id: "old", role: "assistant", content: "Old", timestamp: Date.parse(value.runs[0].started_at) - 1, canvasFinal: { runId: null, response: "Old" } },
      { id: "saved", role: "assistant", content: "Exact saved final", timestamp: Date.parse(value.runs[0].ended_at) + 7, canvasFinal: { runId: null, response: "Exact saved final" } },
    ] }, streaming: {} });
    await mount(value);
    expect(screen.getByRole("region", { name: "Architect’s final answer" })).toHaveTextContent("Exact saved final");
    patch(state => ({ ...state, runs: [...state.runs, { ...state.runs[0], run_id: "new-run", started_at: "2026-10-25T10:43:00Z", ended_at: null, status: "collecting" }] }));
    expect(screen.queryByRole("region", { name: "Architect’s final answer" })).toBeNull();
    patch(state => ({ ...state, runs: state.runs.map(run => run.run_id === "new-run" ? { ...run, status: "completed" } : run) }));
    expect(screen.queryByRole("region", { name: "Architect’s final answer" })).toBeNull();
  });

  it("renders the full final as inert GFM without executable links, HTML or network images", async () => {
    const value = snapshot();
    value.runs[0].status = "completed";
    const response = '# Exact heading\n\n<script>alert(1)</script>\n\n![remote](https://invalid.test/image.png)\n\n[bad](javascript:alert%281%29) [reference](https://example.test/source)\n\n| Item | Value |\n| --- | --- |\n| Exact | false |';
    useChatStore.setState({ messages: { "w1::network-architect": [{ id: "m", role: "assistant", content: response, timestamp: Date.now(), canvasFinal: { runId: fixtureRun, response } }] }, streaming: {} });
    await mount(value);
    const summary = screen.getByRole("region", { name: "Architect’s final answer" });
    fireEvent.click(within(summary).getByText("Read full answer"));
    const full = within(summary).getByRole("region", { name: "Full final answer; scroll horizontally for wide content" });
    expect(within(full).getByRole("heading", { name: "Exact heading", level: 3 })).toBeVisible();
    expect(full).toHaveTextContent("remote");
    expect(summary.querySelector("script, img")).toBeNull();
    expect(summary.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(within(full).getByRole("link", { name: "reference" })).toHaveAttribute("href", "https://example.test/source");
    expect(within(full).getByRole("table")).toHaveTextContent("false");
  });

  it("keeps every Markdown heading below the answer section heading in preview and full answer", async () => {
    const value = snapshot();
    value.runs[0].status = "completed";
    const response = [1, 2, 3, 4, 5, 6].map(level => `${"#".repeat(level)} Heading ${level}`).join("\n\n");
    useChatStore.setState({ messages: { "w1::network-architect": [{ id: "m", role: "assistant", content: response, timestamp: Date.now(), canvasFinal: { runId: fixtureRun, response } }] } });
    await mount(value);
    const summary = screen.getByRole("region", { name: "Architect’s final answer" });
    fireEvent.click(within(summary).getByText("Read full answer"));
    for (const selector of [".canvas-answer-excerpt", ".canvas-answer-body"]) {
      const content = summary.querySelector(selector) as HTMLElement;
      for (let level = 1; level <= 6; level++) expect(within(content).getByRole("heading", { name: `Heading ${level}`, level: Math.min(level + 2, 6) })).toBeVisible();
      expect(content.querySelector("h1, h2")).toBeNull();
    }
  });

  it("keeps warnings and coverage prominent while routine run details are available on disclosure", async () => {
    const value = snapshot();
    value.warnings = [{ type: "canvas", version: 1, workspace_id: "w1", run_id: fixtureRun, seq: 1, kind: "warning", payload: { limitation: "Synthetic source warning" } }];
    await mount(value);
    expect(screen.getByText("Synthetic source warning")).toBeVisible();
    expect(screen.getByText(/Coverage unknown/)).toBeVisible();
    expect(screen.getByText(/Checks not supplied/)).toBeVisible();
    const disclosure = screen.getByText("Run details");
    expect(disclosure.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(disclosure);
    expect(screen.getByText(/Collection started: 2026-10-25T10:32:00Z/)).toBeVisible();
    expect(screen.getByText("Reported scope: Switch fleet")).toBeVisible();
  });

  it("shows short distinct source groups while disclosing their exact pointers", async () => {
    await mount();
    const groups = screen.getAllByRole("rowheader").filter(node => node.getAttribute("scope") === "rowgroup");
    for (const [index, group] of groups.entries()) {
      expect(within(group).getByText(`Duplicate · Source group ${index + 1}`, { exact: true })).toBeVisible();
      const disclosure = within(group).getByText(`Full source reference — Source group ${index + 1}`);
      expect(disclosure.closest("details")).not.toHaveAttribute("open");
      fireEvent.click(disclosure);
      expect(within(group).getByText(JSON.stringify(["e1", `/devices/${index}/name`]), { exact: true })).toBeVisible();
    }
  });

  it("keeps source group labels and exact references stable when filtering hides earlier groups", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Find findings"), { target: { value: "Link transitions" } });
    expect(screen.getByText("Duplicate · Source group 2", { exact: true })).toBeVisible();
    expect(screen.queryByText("Duplicate · Source group 1", { exact: true })).toBeNull();
    const disclosure = screen.getByText("Full source reference — Source group 2");
    fireEvent.click(disclosure);
    expect(screen.getByText(JSON.stringify(["e1", "/devices/1/name"]), { exact: true })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Find findings"), { target: { value: "" } });
    expect(screen.getByText("Duplicate · Source group 1", { exact: true })).toBeVisible();
    expect(screen.getByText("Duplicate · Source group 2", { exact: true })).toBeVisible();
  });

  it("keeps collection, coverage and grouping source-bound rather than trusting model totals", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Findings so far" })).toBeInTheDocument();
    expect(screen.getByText(/Coverage unknown/)).toBeInTheDocument();
    expect(screen.getByText(/Checks not supplied/)).toBeInTheDocument();
    expect(screen.queryByText(/999/)).toBeNull();
    expect(screen.getByText(/2 findings across 2 source-reference groups/)).toBeInTheDocument();
    const groups = screen.getAllByRole("rowheader").filter(node => node.getAttribute("scope") === "rowgroup");
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain("/devices/0/name");
    expect(groups[1].textContent).toContain("/devices/1/name");
  });

  it("labels authored findings and their inspection as interpretations, never observed problems", async () => {
    const value = snapshot();
    value.evidence[0].origin = "agent_authored" as EvidenceSnapshot["origin"];
    await mount(value);
    expect(screen.getAllByText("Agent-authored summary — not independently verified").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Inspect CRC increasing/ }));
    expect(screen.getByRole("heading", { name: "Reported problem" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Observed problem" })).toBeNull();
    expect(screen.getByText("Agent-authored content")).toBeInTheDocument();
    expect(screen.getByText("Recommendation — not executed")).toBeInTheDocument();
  });

  it("inspects exact evidence and returns focus without changing run state or attached context", async () => {
    await mount();
    const inspect = screen.getByRole("button", { name: /Inspect CRC increasing/ });
    fireEvent.click(inspect);
    expect(screen.getByRole("heading", { name: "Observed problem" })).toBeInTheDocument();
    expect(screen.getByText("Likely cause")).toBeInTheDocument();
    expect(screen.getByText("Recommendation — not executed")).toBeInTheDocument();
    expect(screen.getByText("Observation window not supplied")).toBeInTheDocument();
    expect(screen.getAllByText(/2026-10-25T10:42:00Z/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Business impact not established/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Supporting evidence"));
    expect(screen.getAllByText(/1984/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(useCopilotCanvas.getState().workspaces.w1.selection.attachedCardIds).toEqual(["c0"]);
    fireEvent.click(screen.getByRole("button", { name: /Back to findings/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Inspect CRC increasing/ })).toHaveFocus());
    expect(useCopilotCanvas.getState().workspaces.w1.runs[0].status).toBe("collecting");
    expect(canvasOpenWorkspace).toHaveBeenCalledTimes(1);
  });

  it("cites observed device/interface fields even when the card source list points elsewhere", async () => {
    const value = snapshot();
    value.cards[0].source_refs = [ref("/event_at")];
    await mount(value);
    fireEvent.click(screen.getByRole("button", { name: /Inspect CRC increasing/ }));
    fireEvent.click(screen.getByText("Redacted source"));
    expect(screen.getByText("e1/devices/0/name")).toBeInTheDocument();
    expect(screen.getByText("e1/devices/0/interface")).toBeInTheDocument();
    expect(screen.getAllByText(/synthetic.read/).length).toBeGreaterThan(0);
  });

  it("clears hidden pending selections after filtering but preserves already attached context", async () => {
    await mount();
    fireEvent.click(screen.getByRole("checkbox", { name: /Select Finding 1/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add selected cards to chat/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select Finding 0/ }));
    fireEvent.change(screen.getByLabelText("Find findings"), { target: { value: "Link transitions" } });
    expect(useCopilotCanvas.getState().workspaces.w1.selection).toEqual({ pendingCardIds: [], attachedCardIds: ["c1"] });
    expect(canvasRenameWorkspace).not.toHaveBeenCalled();
  });

  it("does not move the inspected finding when new cards arrive, and retains failed-recheck warnings", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /Inspect CRC increasing/ }));
    const before = structuredClone(useCopilotCanvas.getState().workspaces.w1.evidence);
    const card = { ...snapshot().cards[1], card_id: "c2" };
    await act(async () => { await useCopilotCanvas.getState().accept({ type: "canvas", version: 1, workspace_id: "w1", run_id: fixtureRun, seq: 1, kind: "card", payload: { card, snapshots: [] } }); });
    expect(screen.getByRole("heading", { name: "CRC increasing" })).toBeInTheDocument();
    await act(async () => {
      await useCopilotCanvas.getState().finishRun("w1", fixtureRun, "completed");
      await useCopilotCanvas.getState().beginRun("w1", `${fixtureRun}-recheck`);
      await useCopilotCanvas.getState().finishRun("w1", `${fixtureRun}-recheck`, "failed");
    });
    expect(useCopilotCanvas.getState().workspaces.w1.evidence).toEqual(before);
    expect(screen.getByRole("heading", { name: "CRC increasing" })).toBeInTheDocument();
    expect(screen.getByText(/Previous evidence retained/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Back to findings/ }));
    expect(screen.getByText(/Previous evidence retained/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Inspect/ })[0]).toHaveAccessibleName(/Inspect CRC increasing/);
  });

  it("shows incomplete/empty evidence as limitations, never an all-clear or unreachable claim", async () => {
    const value = snapshot();
    value.cards = [{ ...value.cards[0], card_id: "text", type: "text", title: "Unavailable source", metadata: { body: ref("/unavailable") } }];
    value.runs[0].status = "interrupted";
    await mount(value);
    expect(screen.getByText("Authentication failed")).toBeInTheDocument();
    expect(screen.getByText(/No findings supplied/)).toBeInTheDocument();
    expect(screen.queryByText(/unreachable|all.clear|100%/i)).toBeNull();
    expect(screen.getByText(/Unavailable.*unknown/)).toBeInTheDocument();
  });

  it("warns and retains raw source for unsupported projection and incomplete capture", async () => {
    const value = snapshot();
    value.cards[0] = { ...value.cards[0], type: "text", metadata: { body: ref("/missing") } };
    value.cards = [value.cards[0]];
    value.evidence[0].complete = false;
    value.evidence[0].limitation = "Capture clipped";
    await mount(value);
    expect(screen.getByText(/Unsupported projection: Evidence missing, invalid or incomplete/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Redacted source/));
    expect(screen.getByText(/Capture clipped/)).toBeInTheDocument();
    expect(screen.getByText(/1984/)).toBeInTheDocument();
  });

  it("reopens real saved tabs data-only without creating a duplicate tab", async () => {
    await mount();
    vi.mocked(canvasOpenWorkspace).mockResolvedValue({ ...snapshot(), tab: tab("w2"), runs: [], cards: [], evidence: [] });
    fireEvent.change(screen.getByLabelText("Saved investigations"), { target: { value: "w2" } });
    await waitFor(() => expect(useTabs.getState().activeTabId).toBe("w2"));
    expect(useTabs.getState().tabs.filter(t => t.id === "w2")).toEqual([tab("w2")]);
    expect(canvasOpenWorkspace).toHaveBeenCalledWith("w2");
  });

  it("ignores a saved-open superseded by a later request resolving first", async () => {
    vi.mocked(canvasListWorkspaces).mockResolvedValue([tab(), tab("w2"), { ...tab("w3"), title: "Third investigation" }]);
    await mount();
    const second = deferred<CanvasWorkspaceSnapshot>();
    const third = deferred<CanvasWorkspaceSnapshot>();
    vi.mocked(canvasOpenWorkspace).mockImplementation(id => id === "w2" ? second.promise : third.promise);
    fireEvent.change(screen.getByLabelText("Saved investigations"), { target: { value: "w2" } });
    fireEvent.change(screen.getByLabelText("Saved investigations"), { target: { value: "w3" } });
    await act(async () => third.resolve({ ...snapshot(), tab: tab("w3"), runs: [], cards: [], evidence: [] }));
    expect(useTabs.getState().activeTabId).toBe("w3");
    await act(async () => second.resolve({ ...snapshot(), tab: tab("w2"), runs: [], cards: [], evidence: [] }));
    expect(useTabs.getState().activeTabId).toBe("w3");
    expect(useTabs.getState().tabs.some(item => item.id === "w2")).toBe(false);
  });

  it.each(["switch away and back", "close origin", "unmount"])("does not register or activate a stale saved-open after %s", async action => {
    const view = await mount();
    const pending = deferred<CanvasWorkspaceSnapshot>();
    vi.mocked(canvasOpenWorkspace).mockReturnValue(pending.promise);
    fireEvent.change(screen.getByLabelText("Saved investigations"), { target: { value: "w2" } });
    act(() => {
      if (action === "unmount") view.unmount();
      else if (action === "close origin") useTabs.getState().removeTab("w1");
      else {
        useTabs.getState().addTab({ ...tab("terminal-navigation"), tab_type: "terminal", shell_cmd: "/bin/zsh" });
        useTabs.getState().setActive("w1");
      }
    });
    const active = useTabs.getState().activeTabId;
    await act(async () => pending.resolve({ ...snapshot(), tab: tab("w2"), runs: [], cards: [], evidence: [] }));
    expect(useTabs.getState().activeTabId).toBe(active);
    expect(useTabs.getState().tabs.some(item => item.id === "w2")).toBe(false);
  });

  it.each(["success", "failure"])("protects the rename draft while a real request is pending: %s", async outcome => {
    await mount();
    const pending = deferred<void>();
    vi.mocked(canvasRenameWorkspace).mockReturnValue(pending.promise);
    const input = screen.getByLabelText("Investigation title");
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, "Rename A");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(input).toBeDisabled();
    await user.type(input, "Newer draft B");
    expect(input).toHaveValue("Rename A");
    await act(async () => outcome === "success" ? pending.resolve() : pending.reject(new Error("synthetic deferred rename error")));
    expect(input).toBeEnabled();
    expect(input).toHaveValue("Rename A");
    if (outcome === "failure") {
      expect(screen.getByRole("alert")).toHaveTextContent("synthetic deferred rename error");
      expect(useTabs.getState().tabs[0].title).toBe("Switch issues");
    } else expect(useTabs.getState().tabs[0].title).toBe("Rename A");
    await user.clear(input);
    await user.type(input, "Newer draft B");
    expect(input).toHaveValue("Newer draft B");
  });

  it("inspects assessment-only support and contradiction values with their own per-run provenance", async () => {
    const value = snapshot();
    value.evidence.push({ ...value.evidence[0], evidence_id: "e2", call_id: "support-call", collected_at: "2026-10-25T10:43:00Z", origin: "derived", parent_refs: [ref("/devices/0/crc")], calculation: "Synthetic delta", data: { support: 42 } }, { ...value.evidence[0], evidence_id: "e3", call_id: "contradiction-call", collected_at: "2026-10-25T10:44:00Z", data: { counterexample: false } });
    value.cards = [{ ...value.cards[0], type: "assessment", title: "Assessment", source_refs: [ref("/event_at")], metadata: { narrative: "Synthetic interpretation", supporting_refs: [ref("/support", "e2")], contradictory_refs: [ref("/counterexample", "e3")], unknowns: ["Unknown impact"], remediation_considerations: ["Verify first"] } }];
    await mount(value);
    fireEvent.click(screen.getByText("Supporting evidence"));
    fireEvent.click(screen.getByText("Contradictory evidence"));
    const support = screen.getByText("Supporting evidence").closest("details")!;
    const contradiction = screen.getByText("Contradictory evidence").closest("details")!;
    expect(within(support).getByText("42")).toBeInTheDocument();
    expect(support).toHaveTextContent("Derived");
    expect(support).toHaveTextContent("support-call");
    expect(support).toHaveTextContent("2026-10-25T10:43:00Z");
    expect(contradiction).toHaveTextContent("Observed");
    expect(contradiction).toHaveTextContent("contradiction-call");
    expect(contradiction).toHaveTextContent("2026-10-25T10:44:00Z");
    expect(within(contradiction).getByText("false")).toBeInTheDocument();
  });

  it("labels repeated same-device snapshots as source-reference groups, with separate rowgroups and distinguishable controls", async () => {
    const value = snapshot();
    value.evidence.push({ ...value.evidence[0], evidence_id: "repeat", call_id: "repeat-call", collected_at: "2026-10-25T10:45:00Z" });
    const first = value.cards[0];
    if (first.type !== "findings") throw new Error("Expected fixture findings");
    value.cards.push({ ...first, card_id: "repeated-observation", source_refs: [ref("/devices/0", "repeat")], metadata: { findings: [{ ...first.metadata.findings[0], device: ref("/devices/0/name", "repeat"), interface: ref("/devices/0/interface", "repeat") }] } });
    await mount(value);
    expect(screen.getByText(/3 findings across 3 source-reference groups/)).toBeInTheDocument();
    expect(screen.getByText(/not unique devices/)).toBeInTheDocument();
    const groupRows = screen.getAllByRole("rowheader").filter(node => node.getAttribute("scope") === "rowgroup");
    expect(new Set(groupRows.map(node => node.closest("tbody"))).size).toBe(3);
    const buttons = screen.getAllByRole("button", { name: /Inspect CRC increasing/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute("aria-label")).not.toBe(buttons[1].getAttribute("aria-label"));
    expect(buttons[0]).toHaveAccessibleName(/Duplicate.*Gi1.*e1/);
    expect(buttons[1]).toHaveAccessibleName(/Duplicate.*Gi1.*repeat/);
    const checkboxes = screen.getAllByRole("checkbox");
    expect(new Set(checkboxes.map(node => node.getAttribute("aria-label"))).size).toBe(3);
  });

  it.each(["derived", "execution_output"] as const)("uses neutral source-reference grouping for %s identifiers and retains actual provenance", async origin => {
    const value = snapshot();
    const original = value.evidence[0];
    if (origin === "derived") value.evidence.push({ ...original, evidence_id: "parent" });
    value.evidence[0] = { ...original, origin, parent_refs: origin === "derived" ? [ref("/devices", "parent")] : [], calculation: origin === "derived" ? "Synthetic identifier projection" : null };
    value.runs[0].status = "completed";
    await mount(value);
    expect(screen.getByRole("heading", { name: "Findings by source reference" })).toBeInTheDocument();
    expect(screen.getByText(/2 findings across 2 source-reference groups/)).toBeInTheDocument();
    const groups = screen.getAllByRole("rowheader").filter(node => node.getAttribute("scope") === "rowgroup");
    groups.forEach((node, index) => {
      expect(node).toHaveTextContent(`Duplicate · Source group ${index + 1}`);
      expect(within(node).getByText(`Full source reference — Source group ${index + 1}`).tagName).toBe("SUMMARY");
      expect(node).toHaveTextContent(JSON.stringify(["e1", `/devices/${index}/name`]));
    });
    screen.getAllByRole("checkbox").forEach(node => expect(node).toHaveAccessibleName(/source reference/));
    const inspect = screen.getByRole("button", { name: /Inspect CRC increasing/ });
    expect(inspect).toHaveAccessibleName(/source reference/);
    fireEvent.click(inspect);
    fireEvent.click(screen.getByText("Redacted source"));
    const source = screen.getByText("Redacted source").closest("details")!;
    expect(source).toHaveTextContent(origin === "derived" ? "Derived" : "Execution output");
    expect(source).toHaveTextContent("synthetic.read");
    expect(source).toHaveTextContent("2026-10-25T10:42:00Z");
    expect(source).toHaveTextContent("1984");
  });

  it("exposes a drawn relationship's own retained source even when card sources point elsewhere", async () => {
    const value = snapshot();
    value.evidence.push({ ...value.evidence[0], evidence_id: "relationship-source", call_id: "relationship-call", origin: "agent_authored", data: { from: "Gi1", to: "Gi2" } });
    value.cards = [{ ...value.cards[0], type: "topology", source_refs: [ref("/event_at")], metadata: { nodes: [{ id: ref("/devices/0/interface") }, { id: ref("/devices/1/interface") }], links: [{ from: ref("/devices/0/interface"), to: ref("/devices/1/interface"), relationship: ref("", "relationship-source") }] } }];
    await mount(value);
    fireEvent.click(screen.getByText("Relationship sources", { exact: true }));
    const sources = screen.getByText("Relationship sources", { exact: true }).closest("details")!;
    expect(sources).toHaveTextContent("Agent-authored — not observed");
    expect(sources).toHaveTextContent("relationship-call");
    expect(sources).toHaveTextContent("2026-10-25T10:42:00Z");
    expect(sources).toHaveTextContent('"from": "Gi1"');
    expect(sources).toHaveTextContent('"to": "Gi2"');
  });

  it("exposes rename and evidence-save failure independently without inventing saved state", async () => {
    await mount();
    vi.mocked(canvasRenameWorkspace).mockRejectedValue(new Error("synthetic rename failure"));
    fireEvent.change(screen.getByLabelText("Investigation title"), { target: { value: "New title" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByText(/synthetic rename failure/)).toBeInTheDocument();
    expect(useTabs.getState().tabs[0].title).toBe("Switch issues");
    patch(state => ({ ...state, save: { ...state.save, status: "failed", error: "synthetic disk failure", unsavedCardIds: ["c0"] } }));
    expect(screen.getByText(/Save failed: synthetic disk failure/)).toBeInTheDocument();
    expect(screen.getByText(/Unsaved local evidence/)).toBeInTheDocument();
  });

  it("reports list/open failures visibly", async () => {
    vi.mocked(canvasListWorkspaces).mockRejectedValue(new Error("synthetic list failure"));
    vi.mocked(canvasOpenWorkspace).mockRejectedValue(new Error("synthetic open failure"));
    render(<CanvasWorkspace workspaceId="w1" />);
    expect(await screen.findByText(/synthetic list failure/)).toBeInTheDocument();
    expect(await screen.findByText(/synthetic open failure/)).toBeInTheDocument();
  });
});

describe("Canvas card projections", () => {
  const base = () => ({ ...snapshot().cards[0], card_id: "projection" });
  it("renders exact text as inert Markdown and source-equal table/key-value values", () => {
    const resolver = new CanvasReferenceResolver(snapshot().evidence);
    const resolve = (card: CanvasCard): ResolvedCanvasCard => {
      const result = resolver.resolveCard(card);
      if (!result.ok) throw new Error(result.limitation);
      return result.card;
    };
    const { rerender, container } = render(<CardView card={resolve({ ...base(), type: "text", metadata: { body: ref("/unavailable") } })} />);
    expect(screen.getByText("Authentication failed")).toBeInTheDocument();
    rerender(<CardView card={resolve({ ...base(), type: "key_value", metadata: { fields: [{ label: "CRC", ref: ref("/devices/0/crc") }] } })} />);
    expect(screen.getByText("1984")).toBeInTheDocument();
    rerender(<CardView card={resolve({ ...base(), type: "table", metadata: { columns: [{ key: "crc", label: "CRC" }], rows: [{ cells: { crc: ref("/devices/1/crc") } }] } })} />);
    expect(within(screen.getByRole("table")).getByText("0")).toBeInTheDocument();
    rerender(<CardView card={{ ...base(), type: "text", metadata: { body: '<script>alert("x")</script><img src=x onerror=alert(1)>' } }} />);
    expect(container.querySelector("script, img")).toBeNull();
  });

  it("uses supplied column labels and preserves null, false, zero and structured source values", () => {
    render(<CardView card={{ ...base(), type: "table", metadata: { columns: [{ key: "value", label: "Observed value" }], rows: [null, false, 0, { nested: [0, false, null] }].map(value => ({ cells: { value } })) } }} />);
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Row" })).toHaveAttribute("scope", "col");
    expect(within(table).getAllByRole("rowheader").map(node => node.textContent)).toEqual(["Row 1", "Row 2", "Row 3", "Row 4"]);
    within(table).getAllByRole("rowheader").forEach(node => expect(node).toHaveAttribute("scope", "row"));
    expect(within(table).getByRole("columnheader", { name: "Observed value" })).toHaveAttribute("scope", "col");
    expect(within(table).getByRole("cell", { name: "null" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "false" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "0" })).toBeInTheDocument();
    expect(within(table).getByText(/"nested"/).textContent).toBe(JSON.stringify({ nested: [0, false, null] }, null, 2));
  });

  it("mounts the chart adapter and retains the exact accessible source table", () => {
    render(<CardView card={{ ...base(), type: "chart", metadata: { form: "bar", x_label: "Device", y_label: "CRC", points: [{ label: "Duplicate", value: 1984 }] } }} />);
    expect(screen.getByRole("region", { name: "Finding 0 chart" })).toHaveTextContent(/Tab to the chart/);
    expect(within(screen.getByRole("region", { name: "Finding 0 source values" })).getByRole("table")).toHaveTextContent("1984");
    expect(screen.queryByText(/Quantitative chart adapter unavailable/)).toBeNull();
  });

  it.each([false, true])("draws supplied relationships and isolated endpoints without inventing discovery (authored=%s)", agent_authored => {
    const { container } = render(<CardView card={{ ...base(), type: "topology", agent_authored, metadata: { nodes: [{ id: "a" }, { id: "b" }, { id: "isolated" }], links: [{ from: "a", to: "b", relationship: ref("/relationship") }] } }} />);
    const graph = screen.getByRole("region", { name: "Finding 0 relationship graph" });
    expect(graph.querySelector(".react-flow")).not.toBeNull();
    expect(graph.querySelectorAll(".react-flow__node")).toHaveLength(3);
    expect(graph).toHaveTextContent("isolated");
    expect(screen.getByText(/Layout is illustrative, not physical topology\. No discovery was run/)).toBeInTheDocument();
    const table = screen.getByRole("region", { name: agent_authored ? "Agent-authored relationships" : "Observed relationships" });
    expect(table).toHaveTextContent("a");
    expect(table).toHaveTextContent("b");
    expect(table).toHaveTextContent("e1/relationship");
    expect(container.querySelector("img, script")).toBeNull();
  });

  it("keeps typed graph identifiers distinct and treats hostile-looking labels as inert text", () => {
    const label = '<img src=x onerror=alert(1)>';
    const { container } = render(<CardView card={{ ...base(), type: "topology", metadata: { nodes: [{ id: 1 }, { id: "1" }, { id: "__proto__" }, { id: label }], links: [{ from: 1, to: "1", relationship: ref("/relationship") }] } }} />);
    const graph = screen.getByRole("region", { name: "Finding 0 relationship graph" });
    const nodes = [...graph.querySelectorAll(".react-flow__node")];
    expect(nodes).toHaveLength(4);
    expect(new Set(nodes.map(node => node.getAttribute("data-id"))).size).toBe(4);
    expect(nodes.map(node => node.textContent)).toEqual(["1", '"1"', '"__proto__"', JSON.stringify(label)]);
    expect(nodes.map(node => node.getAttribute("aria-label"))).toEqual(["1", '"1"', '"__proto__"', JSON.stringify(label)]);
    expect(graph).toHaveTextContent(JSON.stringify(label));
    const table = screen.getByRole("table");
    expect(within(table).getByRole("rowheader")).toHaveTextContent(/^1$/);
    expect(within(table).getByRole("cell", { name: '"1"', exact: true })).toBeInTheDocument();
    expect(screen.getByText(/^Supplied endpoints:/)).toHaveTextContent('Supplied endpoints: 1, "1", "__proto__"');
    expect(graph).toHaveTextContent("__proto__");
    expect(container.querySelector("img, script")).toBeNull();
  });
});

// These mount the actual App. Only unrelated surfaces, native events and transport
// are mocked; navigation, Canvas store, TabBar and CanvasWorkspace remain real.
describe("App Canvas main mount", () => {
  const terminal = { id: "terminal-1", title: "zsh", shell_cmd: "/bin/zsh", cwd: "/", created_at: 0, tab_type: "terminal" as const };
  const session = (mixed = false) => ({ id: "session", name: "Synthetic", created_at: 0, active_tab_id: "w1", tabs: [...(mixed ? [terminal] : []), tab()].map(item => ({ ...item, scrollback: [], ai_messages: [] })) });
  beforeEach(() => {
    useTabs.setState({ tabs: [], activeTabId: null, blocks: {} });
    vi.spyOn(usePanesStore.getState(), "loadLayoutForTab").mockResolvedValue(undefined);
    vi.mocked(restoreLastSession).mockResolvedValue(null);
    vi.mocked(canvasOpenWorkspace).mockImplementation(async id => ({ ...snapshot(), tab: tab(id), ...(id === "w1" ? {} : { runs: [], cards: [], evidence: [] }) }));
    vi.mocked(canvasCreateWorkspace).mockResolvedValue(tab());
  });
  it("creates and mounts real Canvas navigation with one chat, reversible divider and state-preserving narrow controls", async () => {
    const { default: App } = await import("../../App");
    render(<App />);
    await waitFor(() => expect(terminalRegistry.getOrCreate).toHaveBeenCalledOnce());
    vi.mocked(terminalRegistry.getOrCreate).mockClear();
    fireEvent.click(screen.getByTitle("More tab types…"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Canvas investigation/ }));
    await screen.findByRole("heading", { name: "Switch issues" });
    expect(canvasCreateWorkspace).toHaveBeenCalledWith("New investigation");
    expect(useTabs.getState().tabs.find(item => item.id === "w1")).toEqual(tab());
    const chat = screen.getByLabelText("Mock Architect conversation");
    expect(document.querySelectorAll(".agent-panel")).toHaveLength(1);
    expect(chat).toHaveAttribute("data-canvas-mode", "true");
    expect(chat).toHaveAttribute("data-tab-id", "w1");
    expect(chat).toHaveAttribute("data-open", "true");
    const grid = document.querySelector(".workspace")!;
    expect(grid).toHaveClass("workspace-canvas");
    const separator = screen.getByRole("separator", { name: "Resize Architect conversation" });
    const start = Number(separator.getAttribute("aria-valuenow"));
    fireEvent.mouseDown(separator, { clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 340 });
    fireEvent.mouseUp(window);
    expect(separator).toHaveAttribute("aria-valuenow", String(start + 40));
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", String(start + 20));
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(grid).toHaveAttribute("data-canvas-pane", "chat");
    fireEvent.click(screen.getByRole("button", { name: "Evidence" }));
    expect(grid).toHaveAttribute("data-canvas-pane", "evidence");
    expect(screen.getByLabelText("Mock Architect conversation")).toBe(chat);
    fireEvent.change(screen.getByLabelText("Saved investigations"), { target: { value: "w2" } });
    await screen.findByRole("heading", { name: "Saved investigation" });
    expect(useTabs.getState().activeTabId).toBe("w2");
    expect(useTabs.getState().tabs.filter(item => item.id === "w2")).toHaveLength(1);
    expect(screen.getByLabelText("Mock Architect conversation")).toBe(chat);
    expect(chat).toHaveAttribute("data-tab-id", "w2");
    const user = userEvent.setup();
    act(() => screen.getByRole("button", { name: "Select Canvas investigation Switch issues" }).focus());
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { name: "Switch issues" });
    act(() => screen.getByRole("button", { name: "Select Canvas investigation Saved investigation" }).focus());
    await user.keyboard(" ");
    await screen.findByRole("heading", { name: "Saved investigation" });
    expect(useTabs.getState().activeTabId).toBe("w2");
    expect(document.querySelectorAll(".agent-panel")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("tab-w2").querySelector(".tab-close")!);
    fireEvent.click(screen.getByTestId("tab-w1").querySelector(".tab-close")!);
    expect(terminalRegistry.getOrCreate).not.toHaveBeenCalled();
    expect(terminalRegistry.dispose).not.toHaveBeenCalled();
    expect(ptyKill).not.toHaveBeenCalled();
    expect(agentReactCodeRun).not.toHaveBeenCalled();
    expect(agentReactResume).not.toHaveBeenCalled();
    expect(chat).toHaveAttribute("data-canvas-mode", "false");
    fireEvent.mouseDown(separator, { clientX: 340 });
    fireEvent.mouseMove(window, { clientX: 380 });
    fireEvent.mouseUp(window);
    expect(separator).toHaveAttribute("aria-valuenow", String(start - 20));
  });

  it.each(["navigate", "away and back", "close origin", "unmount"])("keeps late create success available without activation after %s", async action => {
    const pending = deferred<ReturnType<typeof tab>>();
    vi.mocked(restoreLastSession).mockResolvedValue(session());
    vi.mocked(canvasCreateWorkspace).mockReturnValue(pending.promise);
    const { default: App } = await import("../../App");
    const view = render(<App />);
    await screen.findByRole("heading", { name: "Switch issues" });
    act(() => { useTabs.getState().addTab(terminal); useTabs.getState().setActive("w1"); });
    fireEvent.click(screen.getByTitle("More tab types…"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Canvas investigation/ }));
    if (action === "unmount") view.unmount();
    else if (action === "close origin") fireEvent.click(screen.getByTestId("tab-w1").querySelector(".tab-close")!);
    else {
      fireEvent.click(screen.getByTestId("tab-terminal-1"));
      if (action === "away and back") fireEvent.click(screen.getByRole("button", { name: "Select Canvas investigation Switch issues" }));
    }
    const active = useTabs.getState().activeTabId;
    await act(async () => pending.resolve(tab("created-late")));
    expect(useTabs.getState().activeTabId).toBe(active);
    expect(useTabs.getState().tabs.filter(item => item.id === "created-late")).toHaveLength(action === "unmount" ? 0 : 1);
    expect(terminalRegistry.getOrCreate).not.toHaveBeenCalled();
  });

  it.each(["navigate", "away and back", "close origin", "unmount"])("suppresses a late create rejection after %s", async action => {
    const pending = deferred<ReturnType<typeof tab>>();
    vi.mocked(restoreLastSession).mockResolvedValue(session());
    vi.mocked(canvasCreateWorkspace).mockReturnValue(pending.promise);
    const { default: App } = await import("../../App");
    const view = render(<App />);
    await screen.findByRole("heading", { name: "Switch issues" });
    act(() => { useTabs.getState().addTab(terminal); useTabs.getState().setActive("w1"); });
    fireEvent.click(screen.getByTitle("More tab types…"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Canvas investigation/ }));
    if (action === "unmount") view.unmount();
    else if (action === "close origin") fireEvent.click(screen.getByTestId("tab-w1").querySelector(".tab-close")!);
    else {
      fireEvent.click(screen.getByTestId("tab-terminal-1"));
      if (action === "away and back") fireEvent.click(screen.getByRole("button", { name: "Select Canvas investigation Switch issues" }));
    }
    const active = useTabs.getState().activeTabId;
    await act(async () => pending.reject(new Error("synthetic stale create")));
    expect(useTabs.getState().activeTabId).toBe(active);
    expect(screen.queryByText(/Unable to create Canvas/)).toBeNull();
  });

  it.each(["success", "failure"])("only the newest create request may activate or show errors: older %s", async olderOutcome => {
    const first = deferred<ReturnType<typeof tab>>();
    const latest = deferred<ReturnType<typeof tab>>();
    vi.mocked(restoreLastSession).mockResolvedValue(session());
    vi.mocked(canvasCreateWorkspace).mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    const { default: App } = await import("../../App");
    render(<App />);
    await screen.findByRole("heading", { name: "Switch issues" });
    for (let index = 0; index < 2; index++) {
      fireEvent.click(screen.getByTitle("More tab types…"));
      fireEvent.click(screen.getByRole("menuitem", { name: /Canvas investigation/ }));
    }
    await act(async () => latest.resolve(tab("created-newest")));
    expect(useTabs.getState().activeTabId).toBe("created-newest");
    await act(async () => olderOutcome === "success" ? first.resolve(tab("created-older")) : first.reject(new Error("superseded create")));
    expect(useTabs.getState().activeTabId).toBe("created-newest");
    expect(useTabs.getState().tabs.filter(item => item.id === "created-older")).toHaveLength(olderOutcome === "success" ? 1 : 0);
    expect(screen.queryByText(/Unable to create Canvas/)).toBeNull();
  });

  it("shows a current create failure without changing its originating view", async () => {
    const pending = deferred<ReturnType<typeof tab>>();
    vi.mocked(restoreLastSession).mockResolvedValue(session());
    vi.mocked(canvasCreateWorkspace).mockReturnValue(pending.promise);
    const { default: App } = await import("../../App");
    render(<App />);
    await screen.findByRole("heading", { name: "Switch issues" });
    fireEvent.click(screen.getByTitle("More tab types…"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Canvas investigation/ }));
    await act(async () => pending.reject(new Error("synthetic current create")));
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to create Canvas: Error: synthetic current create");
    expect(useTabs.getState().activeTabId).toBe("w1");
  });

  it("reveals chat only on actual conversation/approval focus and returns denial focus without disrupting evidence updates", async () => {
    panelFixture.real = true;
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    useAgentsStore.setState({ agents: [], activeAgentByTab: {}, pendingMentionByTab: {} });
    useChatStore.setState({ messages: {}, streaming: {}, error: {}, pendingSources: {} });
    vi.mocked(invoke).mockImplementation(async command => command === "agents_list" ? [{ id: "network-architect", name: "Network Architect", description: "", systemPrompt: "", attachedSkills: [], attachedMcpServers: [], attachedTools: [], allowedCommands: [], body: "", path: "/synthetic/architect", executionMode: "react-code" }] : command === "ai_messages_by_tab_agent" ? [] : null);
    vi.mocked(restoreLastSession).mockResolvedValue(session());
    const { default: App } = await import("../../App");
    render(<App />);
    await screen.findByRole("heading", { name: "Switch issues" });
    await screen.findByRole("option", { name: "Network Architect" });
    const grid = document.querySelector(".workspace")!;
    const chatToggle = screen.getByRole("button", { name: "Chat" });
    const user = userEvent.setup();
    act(() => chatToggle.focus());
    await user.keyboard("{Enter}");
    expect(grid).toHaveAttribute("data-canvas-pane", "chat");
    const input = within(screen.getByRole("region", { name: "Architect conversation" })).getByRole("textbox");
    fireEvent.change(input, { target: { value: "Synthetic approved investigation" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(agentReactCodeRun).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Evidence" }));
    fireEvent.click(screen.getByRole("button", { name: /Inspect CRC increasing/ }));
    const card = { ...snapshot().cards[1], card_id: "progressive-app" };
    await act(async () => { await useCopilotCanvas.getState().accept({ type: "canvas", version: 1, workspace_id: "w1", run_id: fixtureRun, seq: 1, kind: "card", payload: { card, snapshots: [] } }); });
    expect(grid).toHaveAttribute("data-canvas-pane", "evidence");
    expect(screen.getByRole("heading", { name: "CRC increasing" })).toBeInTheDocument();
    const onEvent = vi.mocked(agentReactCodeRun).mock.calls[0][0].onEvent;
    await act(async () => onEvent({ type: "iac_approval_request", thread_id: "synthetic-workflow", tool: "cisco_workflows_apply", command: "POST /v1/workflows/create", working_dir: "Cisco Workflows", classification: { tier: "high", params: { method: "POST", path: "/v1/workflows/create", body: { name: "Synthetic only" }, organization_id: "synthetic-org", rationale: "Synthetic only" }, rationale: "Synthetic only", target_org_id: "synthetic-org" } }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
    expect(grid).toHaveAttribute("data-canvas-pane", "chat");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(agentReactResume).toHaveBeenCalledOnce());
    expect(screen.getByRole("heading", { name: "Network Architect conversation" })).toHaveFocus();
    expect(grid).toHaveAttribute("data-canvas-pane", "chat");
    expect(agentReactResume).toHaveBeenCalledWith(expect.objectContaining({ decision: "deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Evidence" }));
    expect(grid).toHaveAttribute("data-canvas-pane", "evidence");
    expect(screen.getByRole("heading", { name: "CRC increasing" })).toBeInTheDocument();
    expect(terminalRegistry.getOrCreate).not.toHaveBeenCalled();
  });

  it.each(["navigate", "close latest", "unmount"])("does not activate late Canvas-only restore after deferred list and %s", async action => {
    const pending = deferred<ReturnType<typeof tab>[]>();
    vi.mocked(restoreLastSession).mockResolvedValue(session());
    vi.mocked(canvasListWorkspaces).mockReturnValue(pending.promise);
    const { default: App } = await import("../../App");
    const view = render(<App />);
    await waitFor(() => expect(canvasListWorkspaces).toHaveBeenCalled());
    if (action === "unmount") view.unmount();
    else act(() => {
      useTabs.getState().addTab({ ...terminal, id: "user-terminal" });
      if (action === "close latest") useTabs.getState().removeTab("user-terminal", false);
    });
    const active = useTabs.getState().activeTabId;
    await act(async () => pending.resolve([tab()]));
    expect(useTabs.getState().activeTabId).toBe(active);
    expect(useTabs.getState().tabs.some(item => item.id === "w1")).toBe(false);
    expect(terminalRegistry.getOrCreate).not.toHaveBeenCalled();
  });

  it.each(["navigate", "close restored", "unmount"])("preserves latest navigation/cancellation after mixed restore layout await: %s", async action => {
    const pending = deferred<void>();
    const saved = session(true);
    saved.tabs.push({ ...saved.tabs[0], id: "terminal-2" });
    vi.mocked(restoreLastSession).mockResolvedValue(saved);
    vi.spyOn(usePanesStore.getState(), "loadLayoutForTab").mockImplementation(id => id === terminal.id ? pending.promise : Promise.resolve());
    const { default: App } = await import("../../App");
    const view = render(<App />);
    await waitFor(() => expect(terminalRegistry.getOrCreate).toHaveBeenCalledOnce());
    if (action === "unmount") view.unmount();
    else act(() => {
      if (action === "close restored") useTabs.getState().removeTab(terminal.id, false);
      else useTabs.getState().addTab({ ...terminal, id: "user-terminal" });
    });
    const active = useTabs.getState().activeTabId;
    await act(async () => pending.resolve());
    expect(useTabs.getState().activeTabId).toBe(active);
    expect(useTabs.getState().tabs.some(item => item.id === "w1")).toBe(false);
    expect(terminalRegistry.getOrCreate).toHaveBeenCalledTimes(action === "unmount" ? 1 : 2);
    expect(useTabs.getState().tabs.some(item => item.id === "terminal-2")).toBe(action !== "unmount");
  });

  it("restores genuine mixed-session terminals without replacing navigation during the Canvas list await", async () => {
    const pending = deferred<ReturnType<typeof tab>[]>();
    vi.mocked(restoreLastSession).mockResolvedValue(session(true));
    vi.mocked(canvasListWorkspaces).mockReturnValue(pending.promise);
    const { default: App } = await import("../../App");
    render(<App />);
    await waitFor(() => expect(canvasListWorkspaces).toHaveBeenCalled());
    act(() => useTabs.getState().addTab({ ...terminal, id: "user-terminal" }));
    await act(async () => pending.resolve([tab()]));
    expect(useTabs.getState().activeTabId).toBe("user-terminal");
    expect(useTabs.getState().tabs.some(item => item.id === terminal.id)).toBe(true);
    expect(useTabs.getState().tabs.some(item => item.id === "w1")).toBe(false);
    expect(terminalRegistry.getOrCreate).toHaveBeenCalledOnce();
  });

  it("uses the same effective Canvas width for display, drag, keyboard and ARIA after resize", async () => {
    // Mocked geometry verifies calculation/state only, not actual CSS or browser layout.
    localStorage.setItem("ccie.agentWidth", "900");
    let width = 1280;
    let resize = () => {};
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 800, width, height: 800, toJSON() {} } as DOMRect;
    });
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: () => void) {}
      observe(element: HTMLElement) { if (element.classList.contains("workspace")) resize = this.callback; }
      unobserve() {}
      disconnect() {}
    });
    try {
      vi.mocked(restoreLastSession).mockResolvedValue(session());
      const { default: App } = await import("../../App");
      render(<App />);
      await screen.findByRole("heading", { name: "Switch issues" });
      const separator = screen.getByRole("separator", { name: "Resize Architect conversation" });
      const grid = document.querySelector(".workspace") as HTMLElement;
      expect(separator).toHaveAttribute("aria-valuemax", "576");
      expect(separator).toHaveAttribute("aria-valuenow", "576");
      expect(grid.style.gridTemplateColumns).toBe("576px 6px minmax(0, 1fr)");
      fireEvent.mouseDown(separator, { clientX: 576 });
      fireEvent.mouseMove(window, { clientX: 536 });
      fireEvent.mouseUp(window);
      expect(separator).toHaveAttribute("aria-valuenow", "536");
      fireEvent.keyDown(separator, { key: "ArrowRight" });
      expect(separator).toHaveAttribute("aria-valuenow", "556");
      fireEvent.keyDown(separator, { key: "End" });
      expect(separator).toHaveAttribute("aria-valuenow", "576");
      act(() => { width = 1000; resize(); });
      expect(separator).toHaveAttribute("aria-valuemax", "450");
      expect(separator).toHaveAttribute("aria-valuenow", "450");
      expect(grid.style.gridTemplateColumns).toBe("450px 6px minmax(0, 1fr)");
      fireEvent.keyDown(separator, { key: "ArrowLeft" });
      expect(separator).toHaveAttribute("aria-valuenow", "430");
      fireEvent.mouseDown(separator, { clientX: 430 });
      fireEvent.mouseMove(window, { clientX: 450 });
      fireEvent.mouseUp(window);
      expect(separator).toHaveAttribute("aria-valuenow", "450");
      fireEvent.keyDown(separator, { key: "Home" });
      expect(separator).toHaveAttribute("aria-valuenow", "220");
    } finally { geometry.mockRestore(); vi.unstubAllGlobals(); }
  });

  it.each([false, true])("restores active saved Canvas data-only, preserving genuine saved terminal restores (mixed=%s)", async mixed => {
    vi.mocked(restoreLastSession).mockResolvedValue(session(mixed));
    const { default: App } = await import("../../App");
    render(<App />);
    await screen.findByRole("heading", { name: "Switch issues" });
    expect(useTabs.getState().activeTabId).toBe("w1");
    expect(terminalRegistry.getOrCreate).toHaveBeenCalledTimes(mixed ? 1 : 0);
    if (mixed) expect(terminalRegistry.getOrCreate).toHaveBeenCalledWith("terminal-1", expect.objectContaining({ preferredTabId: "terminal-1" }));
    expect(agentReactCodeRun).not.toHaveBeenCalled();
    expect(agentReactResume).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".agent-panel")).toHaveLength(1);
  });

  it.each(["missing", "list failure"])("preserves normal fallback when active Canvas is unavailable: %s", async failure => {
    vi.mocked(restoreLastSession).mockResolvedValue(session());
    if (failure === "missing") vi.mocked(canvasListWorkspaces).mockResolvedValue([]);
    else vi.mocked(canvasListWorkspaces).mockRejectedValue(new Error("synthetic catalog failure"));
    const { default: App } = await import("../../App");
    render(<App />);
    await waitFor(() => expect(terminalRegistry.getOrCreate).toHaveBeenCalledOnce());
    expect(useTabs.getState().tabs.some(item => item.tab_type === "canvas")).toBe(false);
    expect(agentReactCodeRun).not.toHaveBeenCalled();
    expect(agentReactResume).not.toHaveBeenCalled();
    expect(canvasListWorkspaces).toHaveBeenCalled();
  });
});
