import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, ReactEvent } from "../lib/tauri";
import { chatKey, useChatStore } from "../state/chatStore";
import { useAgentsStore } from "../state/agentsStore";
import { useCopilotCanvas } from "../state/copilotCanvasStore";
import type { CanvasCard, CanvasEvent, CanvasRun, EvidenceSnapshot } from "../lib/copilotCanvas";
import fixture from "../../tests/fixtures/copilot_canvas/v1.json";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (value: unknown) => void;
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { AgentPanel } from "./AgentPanel";

const agent = (id: string): Agent => ({
  id,
  name: id,
  description: "",
  systemPrompt: "",
  attachedSkills: [],
  attachedMcpServers: [],
  attachedTools: [],
  allowedCommands: [],
  body: "",
  path: `/agents/${id}`,
});

function mockInvoke(command: string) {
  if (command === "agents_list") {
    return Promise.resolve([
      agent("network-architect"),
      agent("topolograph"),
      { ...agent("cisco-workflows"), executionMode: "react-code" as const },
      agent("custom-agent"),
    ]);
  }
  if (command === "dictation_start") return Promise.resolve(null);
  if (command === "dictation_stop") return Promise.resolve("interface status");
  if (command === "prompt_library_get") {
    return Promise.resolve({
      schemaVersion: 1,
      revision: 0,
      prompts: [{
        id: "p1",
        title: "Explain interfaces",
        category: "Troubleshooting",
        body: "Explain this output.",
        createdAt: 1,
        updatedAt: 1,
      }],
    });
  }
  if (command === "prompt_library_set") return Promise.resolve(null);
  return Promise.resolve(null);
}

const workflowApprovalClassification = {
    tier: "high" as const,
    params: {
      method: "POST",
      path: "/v1/workflows/create",
      body: { actions: [{ name: "check link", on_failure: null }], inputs: ["interface", "vlan"] },
      query_params: { dry_run: false, labels: ["alpha", "beta"], next: null },
      organization_id: "org-synthetic-42",
      rationale: "Create a synthetic workflow to check a link",
    },
    rationale: "Create a synthetic workflow to check a link",
    target_org_id: "org-synthetic-42",
};
const workflowApprovalEvent: Extract<ReactEvent, { type: "iac_approval_request" }> = {
  type: "iac_approval_request",
  thread_id: "synthetic-thread-workflows",
  tool: "cisco_workflows_apply",
  command: "POST /v1/workflows/create",
  working_dir: "Cisco Workflows",
  classification: workflowApprovalClassification,
};

async function emitWorkflowApproval(event: ReactEvent = workflowApprovalEvent, beforeEvent?: () => void) {
  const user = userEvent.setup();
  render(<AgentPanel tabId="tab-workflows" isOpen onToggle={() => {}} />);
  const selector = await screen.findByRole("combobox", { name: "Active agent for this tab" });
  await user.selectOptions(selector, "cisco-workflows");
  await user.type(screen.getByRole("textbox"), "Create my workflow");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === "agent_react_code_run")).toBe(true));
  const [, args] = invokeMock.mock.calls.find(([command]) => command === "agent_react_code_run")!;
  const channel = (args as { onEvent: { onmessage: (event: ReactEvent) => void } }).onEvent;
  beforeEvent?.();
  act(() => channel.onmessage(event));
  return user;
}

const canvasSnapshot = (id = "canvas-tab-1") => ({
  tab: { id, title: "Synthetic 2026-10-25", tab_type: "canvas" as const, shell_cmd: "", cwd: "", created_at: 1792929600 },
  runs: [{ workspace_id: id, run_id: "run-1", status: "completed", started_at: "2026-10-25T12:00:00Z", ended_at: "2026-10-25T12:00:03Z", scope: null, coverage: null }] as CanvasRun[],
  cards: fixture.cards.map((spec, index) => ({ ...spec, card_id: `card-${index}`, workspace_id: id, run_id: "run-1", created_at: "2026-10-25T12:00:02Z" })) as CanvasCard[],
  evidence: fixture.snapshots.map(snapshot => ({ ...snapshot, workspace_id: id })) as EvidenceSnapshot[],
});
const channelFor = (command: string) => {
  const calls = invokeMock.mock.calls.filter(([name]) => name === command);
  return calls[calls.length - 1][1].onEvent as { onmessage: (event: ReactEvent) => void };
};
const canvasInvoke = (command: string, args: { workspaceId?: string }) => {
  if (command === "agents_list") return Promise.resolve([
    { ...agent("network-architect"), executionMode: "react-code" },
    { ...agent("cisco-workflows"), executionMode: "react-code" },
  ]);
  if (command === "canvas_open_workspace") return Promise.resolve(canvasSnapshot(args.workspaceId));
  if (command === "ai_messages_by_tab_agent") return Promise.resolve([]);
  return mockInvoke(command);
};
async function openCanvas() {
  invokeMock.mockImplementation(canvasInvoke);
  await useCopilotCanvas.getState().load("canvas-tab-1");
  const user = userEvent.setup();
  const view = render(<AgentPanel tabId="canvas-tab-1" canvasMode isOpen onToggle={() => {}} />);
  await screen.findByRole("option", { name: "Network Architect" });
  return { user, ...view };
}
async function sendCanvas(user: ReturnType<typeof userEvent.setup>, text = "Check synthetic switch") {
  await user.type(screen.getByRole("textbox"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(invokeMock.mock.calls.some(([name]) => name === "agent_react_code_run")).toBe(true));
  return channelFor("agent_react_code_run");
}

describe("AgentPanel", () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    invokeMock.mockReset();
    invokeMock.mockImplementation(mockInvoke);
    useCopilotCanvas.setState({ workspaces: {} });
    localStorage.removeItem("ccie.aiChatPreferences.v1");
    useAgentsStore.setState({
      agents: [],
      activeAgentByTab: {},
      pendingMentionByTab: {},
    });
    useChatStore.setState({
      messages: {},
      streaming: {},
      error: {},
      pendingSources: {},
    });
  });

  it("returns Canvas approval focus to its visible conversation heading without a collapse control", async () => {
    const { user } = await openCanvas();
    const channel = await sendCanvas(user);
    act(() => channel.onmessage(workflowApprovalEvent));
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Deny" }));
    await act(async () => { channelFor("agent_react_resume").onmessage({ type: "final", response: "Synthetic denied change" }); });
    expect(screen.queryByTitle("Toggle AI Chat")).toBeNull();
    expect(screen.getByRole("heading", { name: "Network Architect conversation" })).toHaveFocus();
    expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_resume")).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("agent_react_resume", expect.objectContaining({ decision: "deny" }));
  });

  it("saves the final react-code answer once to its initiating conversation and reloads it, never partial tokens", async () => {
    const saved: { id: string; tabId: string; agentId: string; role: string; content: string; timestamp: number }[] = [];
    invokeMock.mockImplementation((command, args) => {
      if (command === "agents_list") return Promise.resolve([{ ...agent("network-architect"), executionMode: "react-code" }]);
      if (command === "save_ai_message") { saved.push({ id: `saved-${saved.length}`, ...args }); return Promise.resolve("saved"); }
      if (command === "ai_messages_by_tab_agent") return Promise.resolve(saved.filter(row => row.tabId === args.tabId && row.agentId === args.agentId));
      return mockInvoke(command);
    });
    const user = userEvent.setup();
    const view = render(<AgentPanel tabId="synthetic-origin" isOpen onToggle={() => {}} />);
    await screen.findByRole("option", { name: "Network Architect" });
    await user.type(screen.getByRole("textbox"), "Synthetic investigation 2026-10-25");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const [, args] = invokeMock.mock.calls.find(([command]) => command === "agent_react_code_run")!;
    const channel = args.onEvent as { onmessage: (event: ReactEvent) => void };
    act(() => channel.onmessage({ type: "token", text: "Partial reasoning" }));
    expect(saved.filter(row => row.role === "assistant")).toEqual([]);
    view.rerender(<AgentPanel tabId="synthetic-other" isOpen onToggle={() => {}} />);
    act(() => {
      channel.onmessage({ type: "final", response: "Completed synthetic answer" });
      channel.onmessage({ type: "final", response: "Completed synthetic answer" });
    });
    await waitFor(() => expect(saved.filter(row => row.role === "assistant")).toEqual([
      expect.objectContaining({ tabId: "synthetic-origin", agentId: "network-architect", content: "Completed synthetic answer" }),
    ]));
    expect(useChatStore.getState().messages[chatKey("synthetic-other", "network-architect")] ?? []).toEqual([]);
    view.unmount();
    useChatStore.setState({ messages: {} });
    render(<AgentPanel tabId="synthetic-origin" isOpen onToggle={() => {}} />);
    expect(await screen.findByText("Completed synthetic answer")).toBeInTheDocument();
  });

  it.each([false, true])("captures Canvas final metadata only at the real final, on the owned assistant without changing chat text (stream=%s)", async stream => {
    localStorage.setItem("ccie.aiChatPreferences.v1", JSON.stringify({ streamLlmOutput: stream }));
    const { user, rerender } = await openCanvas();
    const channel = await sendCanvas(user);
    const key = chatKey("canvas-tab-1", "network-architect");
    const runId = invokeMock.mock.calls.find(([name]) => name === "agent_react_code_run")![1].canvas.run_id;
    act(() => {
      channel.onmessage({ type: "thought_start", step: 1, thought: "Intermediate investigation" });
      if (stream) channel.onmessage({ type: "token", text: "Streamed narration is not the exact final" });
    });
    const before = useChatStore.getState().messages[key].find(message => message.role === "assistant")!;
    expect(before.canvasFinal).toEqual({ runId, response: "" });
    rerender(<AgentPanel tabId="ordinary-other" isOpen onToggle={() => {}} />);
    const response = "Exact final\n\nUncertainty and rollback preserved.";
    act(() => {
      channel.onmessage({ type: "final", response });
      channel.onmessage({ type: "final", response: "Duplicate must not replace" });
    });
    const assistant = useChatStore.getState().messages[key].find(message => message.id === before.id)!;
    expect(assistant.content).toBe(before.content + (stream ? "" : response));
    expect(assistant.canvasFinal).toEqual({ runId, response });
    expect(useChatStore.getState().messages[chatKey("ordinary-other", "network-architect")] ?? []).toEqual([]);
    expect(invokeMock.mock.calls.filter(([name, args]) => name === "save_ai_message" && args.role === "assistant").map(([, args]) => args.content)).toEqual([response]);
  });

  it("marks only Canvas hydrated assistant rows as saved exact finals without a second fetch", async () => {
    invokeMock.mockImplementation((command, args) => command === "ai_messages_by_tab_agent" ? Promise.resolve([
      { id: "saved-user", role: "user", content: "Question", timestamp: 1792929600100 },
      { id: "saved-answer", role: "assistant", content: "Exact saved final", timestamp: 1792929603001 },
    ]) : canvasInvoke(command, args));
    const view = render(<AgentPanel tabId="canvas-history" canvasMode isOpen onToggle={() => {}} />);
    await screen.findByText("Exact saved final");
    const rows = useChatStore.getState().messages[chatKey("canvas-history", "network-architect")];
    expect(rows[0].canvasFinal).toBeUndefined();
    expect(rows[1].canvasFinal).toEqual({ runId: null, response: "Exact saved final" });
    expect(invokeMock.mock.calls.filter(([name]) => name === "ai_messages_by_tab_agent")).toHaveLength(1);
    view.rerender(<AgentPanel tabId="ordinary-history" isOpen onToggle={() => {}} />);
    await waitFor(() => expect(useChatStore.getState().messages[chatKey("ordinary-history", "network-architect")]).toHaveLength(2));
    expect(useChatStore.getState().messages[chatKey("ordinary-history", "network-architect")].every(message => message.canvasFinal === undefined)).toBe(true);
  });

  it.each(["success", "error"])("gates Canvas Send until saved history settles with %s, then retains history and completes the new run", async outcome => {
    const savedRows = [
      { id: "saved-user", role: "user", content: "Earlier question", timestamp: 1 },
      { id: "saved-answer", role: "assistant", content: "Earlier exact final", timestamp: 2 },
    ];
    let resolveHistory!: (rows: typeof savedRows) => void;
    let rejectHistory!: (error: Error) => void;
    const history = new Promise<typeof savedRows>((resolve, reject) => { resolveHistory = resolve; rejectHistory = reject; });
    invokeMock.mockImplementation((command, args) => command === "ai_messages_by_tab_agent" ? history : canvasInvoke(command, args));
    await useCopilotCanvas.getState().load("canvas-tab-1");
    render(<AgentPanel tabId="canvas-tab-1" canvasMode isOpen onToggle={() => {}} />);
    await screen.findByRole("option", { name: "Network Architect" });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "New question after history");
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await user.click(send);
    expect(invokeMock.mock.calls.some(([name]) => name === "agent_react_code_run" || name === "save_ai_message" || name === "canvas_save_run")).toBe(false);
    await act(async () => {
      if (outcome === "success") resolveHistory(savedRows);
      else rejectHistory(new Error("Synthetic history read failed"));
    });
    await waitFor(() => expect(send).toBeEnabled());
    const key = chatKey("canvas-tab-1", "network-architect");
    if (outcome === "success") expect(useChatStore.getState().messages[key]).toEqual([
      savedRows[0], { ...savedRows[1], canvasFinal: { runId: null, response: savedRows[1].content } },
    ]);
    await user.click(send);
    await waitFor(() => expect(invokeMock.mock.calls.some(([name]) => name === "agent_react_code_run")).toBe(true));
    const args = invokeMock.mock.calls.find(([name]) => name === "agent_react_code_run")![1];
    expect(args.history).toEqual(outcome === "success" ? savedRows.map(({ role, content }) => ({ role, content })) : []);
    act(() => channelFor("agent_react_code_run").onmessage({ type: "final", response: "Exact new final" }));
    const rows = useChatStore.getState().messages[key];
    expect(rows).toHaveLength(outcome === "success" ? 4 : 2);
    if (outcome === "success") expect(rows.slice(0, 2).map(row => row.content)).toEqual(savedRows.map(row => row.content));
    expect(rows.at(-1)?.canvasFinal).toEqual({ runId: args.canvas.run_id, response: "Exact new final" });
    expect(invokeMock.mock.calls.filter(([name]) => name === "ai_messages_by_tab_agent")).toHaveLength(1);
  });

  it.each(["Enter", "form", "autoSend"])("guards Canvas %s submission while history is pending, including bypassing a disabled button", async route => {
    let resolveHistory!: (rows: []) => void;
    const history = new Promise<[]>(resolve => { resolveHistory = resolve; });
    invokeMock.mockImplementation((command, args) => command === "ai_messages_by_tab_agent" ? history : canvasInvoke(command, args));
    await useCopilotCanvas.getState().load("canvas-tab-1");
    render(<AgentPanel tabId="canvas-tab-1" canvasMode isOpen onToggle={() => {}} />);
    await screen.findByRole("option", { name: "Network Architect" });
    const user = userEvent.setup();
    const input = screen.getByRole("textbox");
    await user.type(input, "Keep this draft");
    if (route === "Enter") await user.keyboard("{Enter}");
    else if (route === "form") await act(async () => { fireEvent.submit(input.closest("form")!); });
    else await act(async () => { window.dispatchEvent(new CustomEvent("ccie:invoke-agent", { detail: { agentId: "network-architect", message: "Automatic question", autoSend: true } })); });
    const dispatchedWhilePending = invokeMock.mock.calls.some(([name]) => name === "agent_react_code_run" || name === "save_ai_message" || name === "canvas_save_run");
    expect(dispatchedWhilePending).toBe(false);
    expect(useChatStore.getState().error[chatKey("canvas-tab-1", "network-architect")]).toBeFalsy();
    expect(input).toHaveValue("Keep this draft");
    await act(async () => { resolveHistory([]); await history; });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    if (route === "autoSend") {
      act(() => window.dispatchEvent(new CustomEvent("ccie:invoke-agent", { detail: { agentId: "network-architect", message: "Automatic question after history", autoSend: true } })));
      await waitFor(() => expect(invokeMock.mock.calls.some(([name]) => name === "agent_react_code_run")).toBe(true));
      expect(invokeMock.mock.calls.find(([name]) => name === "agent_react_code_run")![1].message).toBe("Automatic question after history");
    }
  });

  it("does not gate ordinary chat Send on pending saved history", async () => {
    let resolveHistory!: (rows: []) => void;
    const history = new Promise<[]>(resolve => { resolveHistory = resolve; });
    invokeMock.mockImplementation((command, args) => command === "ai_messages_by_tab_agent" ? history : canvasInvoke(command, args));
    render(<AgentPanel tabId="ordinary-pending-history" isOpen onToggle={() => {}} />);
    await screen.findByRole("option", { name: "Network Architect" });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "Ordinary question");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(invokeMock.mock.calls.some(([name]) => name === "agent_react_code_run")).toBe(true);
    await act(async () => { resolveHistory([]); await history; });
  });

  it("preserves an in-memory Canvas final on remount instead of duplicating its persisted row with a different id", async () => {
    const key = chatKey("canvas-history", "network-architect");
    const message = { id: "live-id", role: "assistant" as const, content: "Live narration and final", timestamp: 100, canvasFinal: { runId: "owned-run", response: "Exact saved final" } };
    useChatStore.setState({ messages: { [key]: [message] } });
    invokeMock.mockImplementation((command, args) => command === "ai_messages_by_tab_agent"
      ? Promise.resolve([{ id: "different-saved-id", role: "assistant", content: "Exact saved final", timestamp: 101 }]) : canvasInvoke(command, args));
    render(<AgentPanel tabId="canvas-history" canvasMode isOpen onToggle={() => {}} />);
    await screen.findByRole("option", { name: "Network Architect" });
    expect(useChatStore.getState().messages[key]).toEqual([message]);
  });

  it("leaves ordinary Architect arguments exactly unchanged and adds no Canvas calls", async () => {
    invokeMock.mockImplementation(canvasInvoke);
    const user = userEvent.setup();
    render(<AgentPanel tabId="ordinary" isOpen onToggle={() => {}} />);
    await screen.findByRole("option", { name: "Network Architect" });
    await user.type(screen.getByRole("textbox"), "Ordinary question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(invokeMock).toHaveBeenCalledWith("agent_react_code_run", {
      agentId: "network-architect", message: "Ordinary question", history: [], streamOutput: false,
      terminalAttachment: null, onEvent: expect.any(Object),
    });
    expect(invokeMock.mock.calls.some(([name]) => name.startsWith("canvas_"))).toBe(false);
  });

  it("pins only Canvas to Architect and awaits its run save before dispatch", async () => {
    useAgentsStore.setState({ activeAgentByTab: { "canvas-tab-1": "cisco-workflows" } });
    const { user } = await openCanvas();
    expect(screen.getByRole("combobox", { name: "Active agent for this tab" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Active agent for this tab" })).toHaveValue("network-architect");
    let release!: () => void;
    const saving = new Promise<void>(resolve => { release = resolve; });
    invokeMock.mockImplementation((command, args) => command === "canvas_save_run" ? saving : canvasInvoke(command, args));
    await user.type(screen.getByRole("textbox"), "Synthetic canvas question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(invokeMock.mock.calls.some(([name]) => name === "canvas_save_run")).toBe(true));
    expect(invokeMock.mock.calls.some(([name]) => name === "agent_react_code_run")).toBe(false);
    await act(async () => { release(); await saving; });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("agent_react_code_run", expect.objectContaining({
      agentId: "network-architect", canvas: { workspace_id: "canvas-tab-1", run_id: expect.any(String) },
    })));
    expect(useAgentsStore.getState().activeAgentByTab["canvas-tab-1"]).toBe("cisco-workflows");
  });

  it("attaches removable single/multiple explicit chips without sending, keeping context out of saved user prose", async () => {
    const { user } = await openCanvas();
    act(() => useCopilotCanvas.getState().setSelection("canvas-tab-1", { pendingCardIds: ["card-0"], attachedCardIds: ["card-2", "card-1"] }));
    await user.click(screen.getByRole("button", { name: "Remove attached evidence Interfaces" }));
    expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].selection).toEqual({ pendingCardIds: ["card-0"], attachedCardIds: ["card-2"] });
    expect(invokeMock.mock.calls.some(([name]) => /agent_react_(code_run|resume)/.test(name))).toBe(false);
    const channel = await sendCanvas(user, "Why this port?");
    const first = invokeMock.mock.calls.find(([name]) => name === "agent_react_code_run")![1];
    expect(first.canvas.selection.card_ids).toEqual(["card-2"]);
    expect(first.canvas.selection.values).toContainEqual({ ref: { evidence_id: "evidence-a", path: "/devices/0/enabled" }, value: false });
    expect(first.message).toContain("Attached Canvas evidence");
    expect(first.message).toContain("2026-10-25T12:00:00Z");
    expect(invokeMock).toHaveBeenCalledWith("save_ai_message", expect.objectContaining({ role: "user", content: "Why this port?", tabId: "canvas-tab-1", agentId: "network-architect" }));
    act(() => channel.onmessage({ type: "final", response: "First answer" }));
    act(() => useCopilotCanvas.getState().setSelection("canvas-tab-1", { attachedCardIds: ["card-1", "card-2"] }));
    await sendCanvas(user, "Compare both");
    const second = invokeMock.mock.calls.filter(([name]) => name === "agent_react_code_run")[1][1];
    expect(second.canvas.selection.card_ids).toEqual(["card-1", "card-2"]);
    expect(second.history).toEqual([{ role: "user", content: "Why this port?" }, { role: "assistant", content: "First answer" }]);
    expect(second.canvas.workspace_id).toBe("canvas-tab-1");
  });

  it("rejects over-budget attachments visibly without sending or raising the context bound", async () => {
    const { user } = await openCanvas();
    const state = useCopilotCanvas.getState().workspaces["canvas-tab-1"];
    const large: EvidenceSnapshot = { ...state.evidence[0], evidence_id: "large", data: "x".repeat(48000) };
    const card: CanvasCard = { ...state.cards[5], card_id: "large", source_refs: [{ evidence_id: "large", path: "" }], type: "text", metadata: { body: { evidence_id: "large", path: "" } } };
    act(() => useCopilotCanvas.setState({ workspaces: { "canvas-tab-1": { ...state, cards: [...state.cards, card], evidence: [...state.evidence, large], selection: { pendingCardIds: [], attachedCardIds: ["large"] } } } }));
    await user.type(screen.getByRole("textbox"), "Explain selected");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Selected evidence.*context budget/i)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([name]) => /agent_react_code_run|canvas_save_run|save_ai_message/.test(name))).toBe(false);
    expect(screen.getByRole("textbox")).toHaveValue("Explain selected");
  });

  it("keeps approval/resume, presentation-only notices, event/status saves and final answers on the initiating workspace", async () => {
    const { user, rerender } = await openCanvas();
    const channel = await sendCanvas(user);
    const request = invokeMock.mock.calls.find(([name]) => name === "agent_react_code_run")![1].canvas;
    act(() => {
      channel.onmessage({ type: "canvas_limitation", limitation: "Synthetic first presentation notice" });
      channel.onmessage(workflowApprovalEvent);
    });
    await waitFor(() => expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].runs.slice(-1)[0]?.status).toBe("awaiting_approval"));
    await act(async () => { await useCopilotCanvas.getState().load("other-canvas"); });
    rerender(<AgentPanel tabId="other-canvas" canvasMode isOpen onToggle={() => {}} />);
    expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_resume")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Approve exact change" }));
    const resume = channelFor("agent_react_resume");
    let release!: () => void;
    const saving = new Promise<void>(resolve => { release = resolve; });
    invokeMock.mockImplementation((command, args) => command === "canvas_save_event" ? saving : canvasInvoke(command, args));
    const event: CanvasEvent = { type: "canvas", version: 1, workspace_id: request.workspace_id, run_id: request.run_id, seq: 1, kind: "warning", payload: { limitation: "Persisted synthetic warning" } };
    act(() => {
      resume.onmessage({ type: "canvas_limitation", limitation: "Synthetic resumed presentation notice" });
      resume.onmessage(event);
      resume.onmessage({ type: "final", response: "Synthetic resumed answer" });
      resume.onmessage({ type: "canvas_limitation", limitation: "Synthetic late presentation notice" });
    });
    await waitFor(() => expect(invokeMock.mock.calls.some(([name]) => name === "canvas_save_event")).toBe(true));
    expect(invokeMock.mock.calls.filter(([name, args]) => name === "canvas_save_run" && args.run.status === "completed")).toHaveLength(0);
    await act(async () => { release(); await saving; });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("canvas_save_run", expect.objectContaining({ workspaceId: "canvas-tab-1", run: expect.objectContaining({ run_id: request.run_id, status: "completed" }) })));
    expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].limitations).toEqual([
      { run_id: request.run_id, limitation: "Synthetic first presentation notice" },
      { run_id: request.run_id, limitation: "Synthetic resumed presentation notice" },
      { run_id: request.run_id, limitation: "Synthetic late presentation notice" },
    ]);
    expect(invokeMock.mock.calls.filter(([name]) => name === "canvas_save_event")).toHaveLength(1);
    expect(useCopilotCanvas.getState().workspaces["other-canvas"].limitations).toEqual([]);
    expect(useCopilotCanvas.getState().workspaces["other-canvas"].runs).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("save_ai_message", expect.objectContaining({ tabId: "canvas-tab-1", agentId: "network-architect", content: "Synthetic resumed answer" }));
  });

  it("fails closed on initial save failure without dispatch, with a visible independent Canvas save error", async () => {
    const { user } = await openCanvas();
    invokeMock.mockImplementation((command, args) => command === "canvas_save_run" ? Promise.reject(new Error("Synthetic disk full")) : canvasInvoke(command, args));
    await user.type(screen.getByRole("textbox"), "Check synthetic");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Canvas save failed.*Synthetic disk full/)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([name]) => name === "agent_react_code_run")).toBe(false);
  });

  it.each(["error", "cancel"] as const)("records %s without completing partial text and ignores a late final", async (mode) => {
    const { user } = await openCanvas();
    let release!: () => void;
    const running = new Promise<void>(resolve => { release = resolve; });
    invokeMock.mockImplementation((command, args) => command === "agent_react_code_run" ? running : canvasInvoke(command, args));
    const channel = await sendCanvas(user);
    act(() => channel.onmessage({ type: "token", text: "Incomplete synthetic response" }));
    if (mode === "cancel") await user.click(screen.getByRole("button", { name: /Stop/ }));
    else act(() => channel.onmessage({ type: "error", message: "Synthetic network failure" }));
    act(() => channel.onmessage({ type: "final", response: "Late final must not be saved" }));
    await act(async () => { release(); await running; });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("canvas_save_run", expect.objectContaining({ run: expect.objectContaining({ status: mode === "cancel" ? "cancelled" : "failed" }) })));
    expect(invokeMock.mock.calls.filter(([name, args]) => name === "save_ai_message" && args.role === "assistant")).toHaveLength(0);
    expect(useChatStore.getState().messages[chatKey("canvas-tab-1", "network-architect")].find(message => message.role === "assistant")?.canvasFinal?.response).toBe("");
    if (mode === "cancel") expect(invokeMock).toHaveBeenCalledWith("agent_chat_cancel", { tabId: "canvas-tab-1" });
  });

  it("does not let an older transport completion stop the newer turn in the same conversation", async () => {
    const { user } = await openCanvas();
    const releases: (() => void)[] = [];
    invokeMock.mockImplementation((command, args) => command === "agent_react_code_run"
      ? new Promise<void>(resolve => { releases.push(resolve); }) : canvasInvoke(command, args));
    const first = await sendCanvas(user, "First synthetic request");
    act(() => first.onmessage({ type: "final", response: "First final" }));
    const second = await sendCanvas(user, "Second synthetic request");
    await act(async () => { releases[0](); await Promise.resolve(); });
    const stillRunning = useChatStore.getState().streaming[chatKey("canvas-tab-1", "network-architect")];
    act(() => second.onmessage({ type: "final", response: "Second final" }));
    await act(async () => { releases[1](); await Promise.resolve(); });
    expect(stillRunning).toBe(true);
  });

  it("does not let an older transport rejection fail or stop a newer turn in the same conversation", async () => {
    const { user } = await openCanvas();
    let rejectFirst!: (error: Error) => void;
    let finishSecond!: () => void;
    let calls = 0;
    invokeMock.mockImplementation((command, args) => {
      if (command !== "agent_react_code_run") return canvasInvoke(command, args);
      calls += 1;
      return calls === 1
        ? new Promise<void>((_resolve, reject) => { rejectFirst = reject; })
        : new Promise<void>(resolve => { finishSecond = resolve; });
    });
    const first = await sendCanvas(user, "First request before late rejection");
    act(() => first.onmessage({ type: "final", response: "Completed first answer" }));
    const firstRunId = invokeMock.mock.calls.find(([name]) => name === "agent_react_code_run")![1].canvas.run_id;
    const second = await sendCanvas(user, "Second request must remain active");
    await act(async () => { rejectFirst(new Error("Synthetic late transport rejection")); await Promise.resolve(); });
    const state = useChatStore.getState();
    const secondStreaming = state.streaming[chatKey("canvas-tab-1", "network-architect")];
    const secondError = state.error[chatKey("canvas-tab-1", "network-architect")];
    const firstStatus = useCopilotCanvas.getState().workspaces["canvas-tab-1"].runs.find(run => run.run_id === firstRunId)?.status;
    act(() => second.onmessage({ type: "final", response: "Completed second answer" }));
    await act(async () => { finishSecond(); await Promise.resolve(); });
    expect(secondStreaming).toBe(true);
    expect(secondError).toBeNull();
    expect(firstStatus).toBe("completed");
    expect(invokeMock.mock.calls.filter(([name, args]) => name === "save_ai_message" && args.role === "assistant").map(([, args]) => args.content)).toEqual(["Completed first answer", "Completed second answer"]);
  });

  it.each(["approval", "continuation"] as const)("blocks a replacement send after a pending %s checkpoint returns, then resumes its original turn", async (checkpoint) => {
    const { user, rerender } = await openCanvas();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    invokeMock.mockImplementation((command, args) => command === "agent_react_code_run" ? pending : canvasInvoke(command, args));
    const channel = await sendCanvas(user, "Original paused request");
    act(() => {
      if (checkpoint === "approval") channel.onmessage(workflowApprovalEvent);
      else {
        channel.onmessage({ type: "continuation_available", thread_id: "synthetic-paused-checkpoint", reason: "step_limit" });
        channel.onmessage({ type: "error", message: "Synthetic checkpoint limit" });
      }
    });
    await act(async () => { release(); await pending; });
    expect(useChatStore.getState().streaming[chatKey("canvas-tab-1", "network-architect")]).toBe(false);
    act(() => window.dispatchEvent(new CustomEvent("ccie:prefill-agent-input", { detail: {
      tabId: "canvas-tab-1", agentId: "network-architect", message: "Must not replace paused request",
    } })));
    act(() => screen.getByRole("textbox").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    act(() => screen.getByRole("textbox").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    act(() => window.dispatchEvent(new CustomEvent("ccie:invoke-agent", { detail: {
      agentId: "network-architect", message: "Must not replace paused request", autoSend: true,
    } })));
    await act(async () => { await Promise.resolve(); });
    expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_code_run")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByText("Awaiting approval or continuation for this conversation.")).toHaveAttribute("role", "status");
    rerender(<AgentPanel tabId="other-conversation" isOpen onToggle={() => {}} />);
    await user.type(screen.getByRole("textbox"), "Different conversation remains usable");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_code_run")).toHaveLength(2));
    act(() => channelFor("agent_react_code_run").onmessage({ type: "final", response: "Other conversation answer" }));
    rerender(<AgentPanel tabId="canvas-tab-1" canvasMode isOpen onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_resume")).toHaveLength(0);
    if (checkpoint === "approval") await user.click(screen.getByRole("button", { name: "Approve exact change" }));
    else await user.click(screen.getByRole("button", { name: "Continue from last step" }));
    const resumed = channelFor("agent_react_resume");
    act(() => {
      resumed.onmessage({ type: "token", text: "Original resumed token" });
      resumed.onmessage({ type: "final", response: "Original completed answer" });
    });
    expect(useChatStore.getState().messages[chatKey("canvas-tab-1", "network-architect")].filter(message => message.role === "user").map(message => message.content)).toEqual(["Original paused request"]);
    expect(invokeMock.mock.calls.filter(([name, args]) => name === "save_ai_message" && args.tabId === "canvas-tab-1" && args.role === "assistant").map(([, args]) => args.content)).toEqual(["Original completed answer"]);
    expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_resume")).toHaveLength(1);
  });

  it.each([
    { name: "missing params", classification: { ...workflowApprovalClassification, params: null } },
    { name: "missing method", classification: { ...workflowApprovalClassification, params: { path: "/v1/workflows/create" } } },
    { name: "missing path", classification: { ...workflowApprovalClassification, params: { method: "POST" } } },
    { name: "missing pinned organization", classification: { ...workflowApprovalClassification, target_org_id: undefined } },
    { name: "blank pinned organization", classification: { ...workflowApprovalClassification, target_org_id: "  " } },
  ])("fails a non-resumable Workflows preview with $name without locking the conversation", async ({ name, classification }) => {
    const { user } = await openCanvas();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    invokeMock.mockImplementation((command, args) => command === "agent_react_code_run" ? pending : canvasInvoke(command, args));
    const channel = await sendCanvas(user, "Inspect synthetic workflow");
    const request = invokeMock.mock.calls.find(([command]) => command === "agent_react_code_run")![1].canvas;
    const message = name.includes("organization")
      ? "Workflow approval pinned organization ID unavailable; no change was approved."
      : "Workflow approval preview unavailable; no change was approved.";
    act(() => channel.onmessage({ ...workflowApprovalEvent, classification }));
    await act(async () => { release(); await pending; });

    expect(screen.getByText(`Error: ${message}`)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Awaiting approval or continuation for this conversation.")).not.toBeInTheDocument();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("canvas_save_run", expect.objectContaining({
      workspaceId: "canvas-tab-1", run: expect.objectContaining({ run_id: request.run_id, status: "failed" }),
    })));
    expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].runs.find(run => run.run_id === request.run_id)?.status).toBe("failed");
    expect(invokeMock.mock.calls.filter(([command, args]) => command === "canvas_save_run" && args.run.status === "awaiting_approval")).toHaveLength(0);
    expect(useChatStore.getState().streaming[chatKey("canvas-tab-1", "network-architect")]).toBe(false);
    expect(screen.getByRole("textbox")).toBeEnabled();
    await user.type(screen.getByRole("textbox"), "A separate request, not approval");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.getByText(`Error: ${message}`)).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => command === "agent_react_code_run")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => /agent_react_resume|agent_react_continue|agent_terminal_approve_fix/.test(command))).toHaveLength(0);
    expect(invokeMock.mock.calls.filter(([command, args]) => command === "save_ai_message" && args.role === "assistant")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === "agent_react_code_run")).toHaveLength(2));
    expect(invokeMock.mock.calls.filter(([command]) => command === "agent_react_resume")).toHaveLength(0);
  });

  it("does not dispatch after Stop during initial run persistence", async () => {
    const { user } = await openCanvas();
    let release!: () => void;
    const saving = new Promise<void>(resolve => { release = resolve; });
    invokeMock.mockImplementation((command, args) => command === "canvas_save_run" ? saving : canvasInvoke(command, args));
    await user.type(screen.getByRole("textbox"), "Check synthetic");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(screen.getByRole("button", { name: /Stop/ }));
    await act(async () => { release(); await saving; });
    await waitFor(() => expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].save.pending).toBe(0));
    expect(invokeMock.mock.calls.some(([name]) => name === "agent_react_code_run")).toBe(false);
    expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].runs.slice(-1)[0].status).toBe("cancelled");
  });

  it("records a rejected resume on its original run, without saving a partial answer", async () => {
    const { user, rerender } = await openCanvas();
    const channel = await sendCanvas(user);
    act(() => channel.onmessage(workflowApprovalEvent));
    rerender(<AgentPanel tabId="ordinary-other" isOpen onToggle={() => {}} />);
    invokeMock.mockImplementation((command, args) => command === "agent_react_resume" ? Promise.reject(new Error("Synthetic resume rejected")) : canvasInvoke(command, args));
    await user.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].runs.slice(-1)[0].status).toBe("failed"));
    expect(useChatStore.getState().error[chatKey("canvas-tab-1", "network-architect")]).toContain("Synthetic resume rejected");
    expect(invokeMock.mock.calls.filter(([name, args]) => name === "save_ai_message" && args.role === "assistant")).toHaveLength(0);
  });

  it("continues only the existing explicit checkpoint with captured Canvas and answer ownership", async () => {
    const { user, rerender } = await openCanvas();
    const channel = await sendCanvas(user);
    const request = invokeMock.mock.calls.find(([name]) => name === "agent_react_code_run")![1].canvas;
    act(() => {
      channel.onmessage({ type: "continuation_available", thread_id: "synthetic-step-limit", reason: "step_limit" });
      channel.onmessage({ type: "error", message: "Synthetic step limit" });
    });
    rerender(<AgentPanel tabId="ordinary-other" isOpen onToggle={() => {}} />);
    rerender(<AgentPanel tabId="canvas-tab-1" canvasMode isOpen onToggle={() => {}} />);
    expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_resume")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Continue from last step" }));
    const resume = channelFor("agent_react_resume");
    act(() => {
      resume.onmessage({ type: "canvas_limitation", limitation: "Synthetic continued notice" });
      resume.onmessage({ type: "final", response: "Synthetic continued answer" });
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("save_ai_message", expect.objectContaining({ tabId: "canvas-tab-1", agentId: "network-architect", content: "Synthetic continued answer" })));
    expect(invokeMock).toHaveBeenCalledWith("agent_react_resume", expect.objectContaining({ threadId: "synthetic-step-limit", decision: "continue" }));
    expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].limitations).toContainEqual({ run_id: request.run_id, limitation: "Synthetic continued notice" });
    expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].runs.slice(-1)[0].status).toBe("completed");
  });

  it("keeps the original Canvas checkpoint resumable when its initial native invocation rejects", async () => {
    const { user } = await openCanvas();
    const priorCards = useCopilotCanvas.getState().workspaces["canvas-tab-1"].cards;
    const priorEvidence = useCopilotCanvas.getState().workspaces["canvas-tab-1"].evidence;
    let rejectRun!: (error: Error) => void;
    const running = new Promise<void>((_resolve, reject) => { rejectRun = reject; });
    invokeMock.mockImplementation((command, args) => command === "agent_react_code_run" ? running : canvasInvoke(command, args));
    const channel = await sendCanvas(user, "Original checkpoint request");
    const request = invokeMock.mock.calls.find(([name]) => name === "agent_react_code_run")![1].canvas;
    await act(async () => {
      channel.onmessage({ type: "continuation_available", thread_id: "synthetic-rejected-checkpoint", reason: "step_limit" });
      channel.onmessage({ type: "error", message: "Synthetic preserved checkpoint" });
      rejectRun(new Error("Synthetic preserved checkpoint"));
      await Promise.resolve();
    });
    expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].runs.slice(-1)[0].status).toBe("awaiting_approval");
    expect(screen.getByRole("textbox")).toBeDisabled();
    let finishResume!: () => void;
    const resuming = new Promise<void>(resolve => { finishResume = resolve; });
    invokeMock.mockImplementation((command, args) => command === "agent_react_resume" ? resuming : canvasInvoke(command, args));
    await user.click(screen.getByRole("button", { name: "Continue from last step" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("agent_react_resume", expect.objectContaining({ threadId: "synthetic-rejected-checkpoint", decision: "continue" })));
    const collecting = useCopilotCanvas.getState().workspaces["canvas-tab-1"];
    expect(collecting.runs.slice(-1)[0]).toMatchObject({ workspace_id: request.workspace_id, run_id: request.run_id, status: "collecting" });
    expect(collecting.cards).toEqual(priorCards);
    expect(collecting.evidence).toEqual(priorEvidence);
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
    await act(async () => {
      channelFor("agent_react_resume").onmessage({ type: "final", response: "Original checkpoint completed" });
      finishResume();
      await resuming;
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("canvas_save_run", expect.objectContaining({
      workspaceId: request.workspace_id, run: expect.objectContaining({ run_id: request.run_id, status: "completed" }),
    })));
    expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_code_run")).toHaveLength(1);
    expect(useChatStore.getState().messages[chatKey("canvas-tab-1", "network-architect")].filter(message => message.role === "user").map(message => message.content)).toEqual(["Original checkpoint request"]);
  });

  it.each(["resolve", "reject", "late error"] as const)("keeps Continue owned when its original native invocation sends a late %s", async outcome => {
    const { user } = await openCanvas();
    let finishOriginal!: () => void;
    let rejectOriginal!: (error: Error) => void;
    const original = new Promise<void>((resolve, reject) => { finishOriginal = resolve; rejectOriginal = reject; });
    let finishResume!: () => void;
    const resuming = new Promise<void>(resolve => { finishResume = resolve; });
    invokeMock.mockImplementation((command, args) => command === "agent_react_code_run" ? original
      : command === "agent_react_resume" ? resuming : canvasInvoke(command, args));
    const channel = await sendCanvas(user, "Original invocation still pending");
    const request = invokeMock.mock.calls.find(([name]) => name === "agent_react_code_run")![1].canvas;
    act(() => {
      channel.onmessage({ type: "continuation_available", thread_id: "synthetic-pending-original", reason: "step_limit" });
      channel.onmessage({ type: "error", message: "Synthetic preserved checkpoint" });
    });
    await user.click(screen.getByRole("button", { name: "Continue from last step" }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_resume")).toHaveLength(1));
    await act(async () => {
      if (outcome === "resolve") finishOriginal();
      else if (outcome === "reject") rejectOriginal(new Error("Synthetic original invocation rejection"));
      else channel.onmessage({ type: "error", message: "Synthetic original duplicate error" });
      await Promise.resolve();
    });
    const key = chatKey("canvas-tab-1", "network-architect");
    const stillStreaming = useChatStore.getState().streaming[key];
    const continuedError = useChatStore.getState().error[key];
    const continuedStatus = useCopilotCanvas.getState().workspaces["canvas-tab-1"].runs.slice(-1)[0].status;
    await act(async () => {
      channelFor("agent_react_resume").onmessage({ type: "final", response: "Original continued invocation completed" });
      finishResume();
      if (outcome === "late error") finishOriginal();
      await resuming;
    });
    expect(stillStreaming).toBe(true);
    expect(continuedError).toBeNull();
    expect(continuedStatus).toBe("collecting");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("canvas_save_run", expect.objectContaining({
      workspaceId: request.workspace_id, run: expect.objectContaining({ run_id: request.run_id, status: "completed" }),
    })));
    expect(invokeMock.mock.calls.filter(([name, args]) => name === "save_ai_message" && args.role === "assistant").map(([, args]) => args.content)).toEqual(["Original continued invocation completed"]);
  });

  it("keeps approval resume owned when its original invocation rejects after the decision", async () => {
    const { user } = await openCanvas();
    let rejectOriginal!: (error: Error) => void;
    const original = new Promise<void>((_resolve, reject) => { rejectOriginal = reject; });
    let finishResume!: () => void;
    const resuming = new Promise<void>(resolve => { finishResume = resolve; });
    invokeMock.mockImplementation((command, args) => command === "agent_react_code_run" ? original
      : command === "agent_react_resume" ? resuming : canvasInvoke(command, args));
    const channel = await sendCanvas(user, "Original approval invocation still pending");
    act(() => channel.onmessage(workflowApprovalEvent));
    await user.click(screen.getByRole("button", { name: "Approve exact change" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("agent_react_resume", expect.objectContaining({ decision: "approve" })));
    await act(async () => {
      channel.onmessage({ type: "error", message: "Synthetic old approval invocation error" });
      rejectOriginal(new Error("Synthetic old approval invocation rejection"));
      await Promise.resolve();
    });
    const key = chatKey("canvas-tab-1", "network-architect");
    const stillStreaming = useChatStore.getState().streaming[key];
    const resumedError = useChatStore.getState().error[key];
    await act(async () => {
      channelFor("agent_react_resume").onmessage({ type: "final", response: "Approved invocation completed" });
      finishResume();
      await resuming;
    });
    expect(stillStreaming).toBe(true);
    expect(resumedError).toBeNull();
    await waitFor(() => expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].runs.slice(-1)[0].status).toBe("completed"));
  });

  it("keeps a repeated checkpoint on rejected Continue without replacing its latest thread", async () => {
    const { user } = await openCanvas();
    const channel = await sendCanvas(user);
    act(() => {
      channel.onmessage({ type: "continuation_available", thread_id: "synthetic-first-checkpoint", reason: "step_limit" });
      channel.onmessage({ type: "error", message: "Synthetic first checkpoint" });
    });
    let rejectResume!: (error: Error) => void;
    const resuming = new Promise<void>((_resolve, reject) => { rejectResume = reject; });
    invokeMock.mockImplementation((command, args) => command === "agent_react_resume" ? resuming : canvasInvoke(command, args));
    await user.click(screen.getByRole("button", { name: "Continue from last step" }));
    const resumed = channelFor("agent_react_resume");
    await act(async () => {
      resumed.onmessage({ type: "continuation_available", thread_id: "synthetic-next-checkpoint", reason: "step_limit" });
      resumed.onmessage({ type: "error", message: "Synthetic next checkpoint" });
      rejectResume(new Error("Synthetic next checkpoint"));
      await Promise.resolve();
    });
    expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].runs.slice(-1)[0].status).toBe("awaiting_approval");
    invokeMock.mockImplementation(canvasInvoke);
    await user.click(screen.getByRole("button", { name: "Continue from last step" }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_resume").slice(-1)[0][1]).toMatchObject({ threadId: "synthetic-next-checkpoint", decision: "continue" }));
    await act(async () => {
      channelFor("agent_react_resume").onmessage({ type: "final", response: "Repeated checkpoint completed" });
      await Promise.resolve();
    });
    await waitFor(() => expect(invokeMock.mock.calls.filter(([name, args]) => name === "canvas_save_run" && args.run.status === "completed")).toHaveLength(1));
    expect(invokeMock.mock.calls.filter(([name, args]) => name === "canvas_save_run" && args.run.status === "failed")).toHaveLength(0);
  });

  it.each(["error-before-reject", "reject-before-error"] as const)("does not offer an unusable Continue after a genuine terminal resume error: %s", async order => {
    const { user } = await openCanvas();
    const channel = await sendCanvas(user, "Request before terminal resume error");
    act(() => {
      channel.onmessage({ type: "continuation_available", thread_id: "synthetic-terminal-checkpoint", reason: "step_limit" });
      channel.onmessage({ type: "error", message: "Synthetic checkpoint" });
    });
    let rejectResume!: (error: Error) => void;
    const resuming = new Promise<void>((_resolve, reject) => { rejectResume = reject; });
    invokeMock.mockImplementation((command, args) => command === "agent_react_resume" ? resuming : canvasInvoke(command, args));
    await user.click(screen.getByRole("button", { name: "Continue from last step" }));
    if (order === "error-before-reject") act(() => channelFor("agent_react_resume").onmessage({ type: "error", message: "Synthetic terminal resume failure" }));
    await act(async () => {
      rejectResume(new Error("Synthetic terminal resume failure"));
      await Promise.resolve();
    });
    if (order === "reject-before-error") act(() => channelFor("agent_react_resume").onmessage({ type: "error", message: "Synthetic terminal resume failure" }));
    expect(screen.queryByRole("button", { name: "Continue from last step" })).not.toBeInTheDocument();
    expect(screen.getByText("Error: Synthetic terminal resume failure")).toBeInTheDocument();
    expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].runs.slice(-1)[0].status).toBe("failed");
    act(() => channelFor("agent_react_resume").onmessage({ type: "final", response: "Late invalid completion" }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("textbox")).toHaveValue("Request before terminal resume error");
    expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_resume")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([name, args]) => name === "save_ai_message" && args.role === "assistant")).toHaveLength(0);
  });

  it.each(["resolve", "reject"] as const)("does not let a late Continue %s overwrite a newer Canvas turn", async outcome => {
    const { user } = await openCanvas();
    const channel = await sendCanvas(user, "Original continued request");
    act(() => {
      channel.onmessage({ type: "continuation_available", thread_id: "synthetic-late-checkpoint", reason: "step_limit" });
      channel.onmessage({ type: "error", message: "Synthetic checkpoint" });
    });
    let finishResume!: () => void;
    let rejectResume!: (error: Error) => void;
    const resuming = new Promise<void>((resolve, reject) => { finishResume = resolve; rejectResume = reject; });
    let finishSecond!: () => void;
    const secondRunning = new Promise<void>(resolve => { finishSecond = resolve; });
    invokeMock.mockImplementation((command, args) => command === "agent_react_resume" ? resuming
      : command === "agent_react_code_run" ? secondRunning : canvasInvoke(command, args));
    await user.click(screen.getByRole("button", { name: "Continue from last step" }));
    act(() => channelFor("agent_react_resume").onmessage({ type: "final", response: "Original continued answer" }));
    const second = await sendCanvas(user, "Newer request must remain active");
    await act(async () => {
      if (outcome === "reject") rejectResume(new Error("Synthetic stale Continue rejection"));
      else finishResume();
      await Promise.resolve();
    });
    const state = useChatStore.getState();
    const stillStreaming = state.streaming[chatKey("canvas-tab-1", "network-architect")];
    const newerError = state.error[chatKey("canvas-tab-1", "network-architect")];
    act(() => second.onmessage({ type: "final", response: "Newer request completed" }));
    await act(async () => { finishSecond(); await secondRunning; });
    expect(stillStreaming).toBe(true);
    expect(newerError).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue from last step" })).not.toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([name, args]) => name === "save_ai_message" && args.role === "assistant").map(([, args]) => args.content)).toEqual(["Original continued answer", "Newer request completed"]);
  });

  it("keeps a failed card save separate from successful network completion and a saved final answer", async () => {
    const { user } = await openCanvas();
    const channel = await sendCanvas(user);
    const request = invokeMock.mock.calls.find(([name]) => name === "agent_react_code_run")![1].canvas;
    invokeMock.mockImplementation((command, args) => command === "canvas_save_event" ? Promise.reject(new Error("Synthetic card disk failure")) : canvasInvoke(command, args));
    const card: CanvasCard = { ...canvasSnapshot().cards[2], run_id: request.run_id, card_id: "new-card", source_refs: [{ evidence_id: "new-evidence", path: "/devices/0" }], type: "key_value", metadata: { fields: [{ label: "Enabled", ref: { evidence_id: "new-evidence", path: "/devices/0/enabled" } }] } };
    const snapshot = { ...fixture.snapshots[0], run_id: request.run_id, evidence_id: "new-evidence" };
    act(() => {
      channel.onmessage({ type: "canvas", version: 1, workspace_id: "canvas-tab-1", run_id: request.run_id, seq: 1, kind: "card", payload: { card, snapshots: [snapshot] } } as unknown as CanvasEvent);
      channel.onmessage({ type: "final", response: "Network investigation succeeded" });
    });
    expect(await screen.findByText(/Canvas save failed.*Synthetic card disk failure/)).toBeInTheDocument();
    expect(useCopilotCanvas.getState().workspaces["canvas-tab-1"].save.unsavedCardIds).toEqual(["new-card"]);
    expect(invokeMock.mock.calls.filter(([name, args]) => name === "canvas_save_run" && args.run.status === "completed")).toHaveLength(0);
    expect(invokeMock.mock.calls.filter(([name]) => name === "agent_react_code_run")).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("save_ai_message", expect.objectContaining({ content: "Network investigation succeeded", role: "assistant" }));
    expect(useChatStore.getState().error[chatKey("canvas-tab-1", "network-architect")]).toBeNull();
  });

  it("shows final-answer save errors without saving partial text or changing another conversation", async () => {
    const { user, rerender } = await openCanvas();
    const channel = await sendCanvas(user);
    invokeMock.mockImplementation((command, args) => command === "save_ai_message" ? Promise.reject(new Error("Synthetic answer disk failure")) : canvasInvoke(command, args));
    rerender(<AgentPanel tabId="ordinary-other" isOpen onToggle={() => {}} />);
    act(() => channel.onmessage({ type: "final", response: "Final answer only" }));
    await waitFor(() => expect(useChatStore.getState().error[chatKey("canvas-tab-1", "network-architect")]).toMatch(/Answer save failed.*Synthetic answer disk failure/));
    expect(useChatStore.getState().error[chatKey("ordinary-other", "network-architect")]).toBeUndefined();
    rerender(<AgentPanel tabId="canvas-tab-1" canvasMode isOpen onToggle={() => {}} />);
    expect(screen.getByText(/Answer save failed/)).toBeInTheDocument();
  });

  it("lists Topolograph as Prepackaged and not as a User Agent", async () => {
    render(<AgentPanel tabId={null} isOpen onToggle={() => {}} />);

    const selector = await screen.findByRole("combobox", {
      name: "Active agent for this tab",
    });
    const prepackaged = within(selector).getByRole("group", { name: "Prepackaged" });
    const userAgents = within(selector).getByRole("group", { name: "User Agents" });

    expect(within(prepackaged).getByRole("option", { name: "Topolograph" })).toBeInTheDocument();
    expect(within(userAgents).queryByRole("option", { name: "Topolograph" })).not.toBeInTheDocument();
  });

  it("lists Cisco Workflows as a selectable Prepackaged agent", async () => {
    const user = userEvent.setup();
    render(<AgentPanel tabId="tab-workflows" isOpen onToggle={() => {}} />);

    const selector = await screen.findByRole("combobox", {
      name: "Active agent for this tab",
    });
    const prepackaged = within(selector).getByRole("group", { name: "Prepackaged" });
    const userAgents = within(selector).getByRole("group", { name: "User Agents" });
    const option = within(prepackaged).getByRole("option", { name: "Cisco Workflows" });

    expect(option).toHaveValue("cisco-workflows");
    expect(within(userAgents).queryByRole("option", { name: "Cisco Workflows" })).not.toBeInTheDocument();
    await user.selectOptions(selector, option);
    expect(selector).toHaveValue("cisco-workflows");
    expect(invokeMock).toHaveBeenCalledWith("agent_session_set", expect.objectContaining({ agentId: "cisco-workflows" }));
  });

  it("reviews the exact Workflows mutation and resumes only after explicit approval", async () => {
    const user = await emitWorkflowApproval();
    const dialog = screen.getByRole("dialog", { name: "Cisco Workflows change requires approval" });

    expect(within(dialog).getByText("POST")).toBeInTheDocument();
    expect(within(dialog).getByText("/v1/workflows/create")).toBeInTheDocument();
    expect(within(dialog).getByText("HIGH")).toHaveClass("iac-approval-badge", "tier-high");
    expect(dialog.querySelector(".iac-approval-modal")).toHaveClass("tier-high");
    expect(within(dialog).getByText("Organization ID")).toBeInTheDocument();
    expect(within(dialog).getByText("org-synthetic-42")).toBeInTheDocument();
    expect(dialog.querySelector("pre")?.textContent).toBe(JSON.stringify(workflowApprovalEvent.classification.params, null, 2));
    expect(within(dialog).getByText("Create a synthetic workflow to check a link")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "IaC operation requires approval" })).not.toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command]) => command === "agent_react_resume")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Approve exact change" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("agent_react_resume", expect.objectContaining({
      threadId: "synthetic-thread-workflows",
      decision: "approve",
      editedAction: null,
    })));
    expect(screen.queryByRole("dialog", { name: "Cisco Workflows change requires approval" })).not.toBeInTheDocument();
  });

  it("reviews the exact DELETE preview at destructive risk, without approving on display", async () => {
    const deleteParams = {
      method: "DELETE",
      path: "/v1/workflows/synthetic-workflow-42",
      organization_id: "org-synthetic-42",
      query_params: { force: false, label: "deletion test" },
      body: null,
      rationale: "Delete a synthetic workflow",
    };
    await emitWorkflowApproval({
      ...workflowApprovalEvent,
      command: "DELETE /v1/workflows/synthetic-workflow-42",
      classification: {
        tier: "destructive",
        params: deleteParams,
        target_org_id: "org-synthetic-42",
        rationale: deleteParams.rationale,
      },
    });
    const dialog = screen.getByRole("dialog", { name: "Cisco Workflows change requires approval" });

    expect(within(dialog).getByText("DELETE")).toBeInTheDocument();
    expect(within(dialog).getByText(deleteParams.path)).toBeInTheDocument();
    expect(within(dialog).getByText("org-synthetic-42")).toBeInTheDocument();
    expect(dialog.querySelector("pre")?.textContent).toBe(JSON.stringify(deleteParams, null, 2));
    expect(within(dialog).getByText(deleteParams.rationale)).toBeInTheDocument();
    expect(within(dialog).getByText("DESTRUCTIVE")).toHaveClass("iac-approval-badge", "tier-destructive");
    expect(dialog.querySelector(".iac-approval-modal")).toHaveClass("tier-destructive");
    expect(within(dialog).getByRole("button", { name: "Deny" })).toHaveFocus();
    expect(invokeMock.mock.calls.some(([command]) => command === "agent_react_resume")).toBe(false);
  });

  it("denies a Workflows mutation without approving or opening IaC", async () => {
    const user = await emitWorkflowApproval();
    const dialog = screen.getByRole("dialog", { name: "Cisco Workflows change requires approval" });
    expect(invokeMock.mock.calls.some(([command]) => command === "agent_react_resume")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("agent_react_resume", expect.objectContaining({
      threadId: "synthetic-thread-workflows",
      decision: "deny",
      editedAction: null,
    })));
    expect(screen.queryByRole("dialog", { name: "Cisco Workflows change requires approval" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "IaC operation requires approval" })).not.toBeInTheDocument();
  });

  it("sends a Workflows deny rather than approve when the review is escaped", async () => {
    const user = await emitWorkflowApproval();
    const dialog = screen.getByRole("dialog", { name: "Cisco Workflows change requires approval" });
    expect(within(dialog).getByRole("button", { name: "Deny" })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Approve exact change" })).toHaveFocus();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("agent_react_resume", expect.objectContaining({
      threadId: "synthetic-thread-workflows",
      decision: "deny",
      editedAction: null,
    })));
    expect(invokeMock.mock.calls.filter(([command]) => command === "agent_react_resume")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Cisco Workflows change requires approval" })).not.toBeInTheDocument();
  });

  it("restores focus to the chat toggle when the paused turn replaces Stop with disabled Send", async () => {
    const bucket = chatKey("tab-workflows", "cisco-workflows");
    const user = await emitWorkflowApproval(workflowApprovalEvent, () => {
      act(() => useChatStore.getState().setStreaming(bucket, true));
      const stop = screen.getByRole("button", { name: /Stop/ });
      stop.focus();
      expect(stop).toHaveFocus();
    });
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
    invokeMock.mockImplementation((command, args) => {
      if (command === "agent_react_resume") {
        (args as { onEvent: { onmessage: (event: ReactEvent) => void } }).onEvent.onmessage({
          type: "error", message: "Synthetic resume failure",
        });
        return Promise.resolve(null);
      }
      return mockInvoke(command);
    });

    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByTitle("Toggle AI Chat")).toHaveFocus();
    expect(invokeMock).toHaveBeenCalledWith("agent_react_resume", expect.objectContaining({
      threadId: "synthetic-thread-workflows",
      decision: "deny",
    }));
  });

  it("keeps focus on the stable chat toggle when final arrives after Deny", async () => {
    const bucket = chatKey("tab-workflows", "cisco-workflows");
    const user = await emitWorkflowApproval(workflowApprovalEvent, () => {
      act(() => useChatStore.getState().setStreaming(bucket, true));
      const stop = screen.getByRole("button", { name: /Stop/ });
      stop.focus();
      expect(stop).toHaveFocus();
    });
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(screen.queryByRole("dialog", { name: "Cisco Workflows change requires approval" })).not.toBeInTheDocument();
    const [, resume] = invokeMock.mock.calls.find(([command]) => command === "agent_react_resume")!;
    expect(resume).toEqual(expect.objectContaining({ threadId: "synthetic-thread-workflows", decision: "deny" }));
    const channel = (resume as { onEvent: { onmessage: (event: ReactEvent) => void } }).onEvent;
    act(() => channel.onmessage({ type: "final", response: "Synthetic final answer" }));

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByTitle("Toggle AI Chat")).toHaveFocus();
    expect(invokeMock.mock.calls.filter(([command]) => command === "agent_react_resume")).toHaveLength(1);
  });

  it("does not route a malformed Workflows preview through the IaC approval fallback", async () => {
    await emitWorkflowApproval({
      ...workflowApprovalEvent,
      classification: { tier: "high", params: null },
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/Workflow approval preview unavailable; no change was approved/)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command]) => command === "agent_react_resume")).toBe(false);
  });

  it("does not allow approval if the pinned organization ID is missing", async () => {
    await emitWorkflowApproval({
      ...workflowApprovalEvent,
      classification: {
        tier: "high",
        params: workflowApprovalClassification.params,
        rationale: workflowApprovalClassification.rationale,
      },
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/pinned organization ID unavailable; no change was approved/i)).toBeInTheDocument();
    expect(invokeMock.mock.calls.some(([command]) => command === "agent_react_resume")).toBe(false);
  });

  it("keeps the Workflows approval route on a second paused mutation", async () => {
    const user = await emitWorkflowApproval();
    await user.click(within(screen.getByRole("dialog", { name: "Cisco Workflows change requires approval" }))
      .getByRole("button", { name: "Approve exact change" }));
    const [, resume] = invokeMock.mock.calls.find(([command]) => command === "agent_react_resume")!;
    const channel = (resume as { onEvent: { onmessage: (event: ReactEvent) => void } }).onEvent;

    act(() => channel.onmessage({ ...workflowApprovalEvent, thread_id: "synthetic-thread-second" }));
    const dialog = screen.getByRole("dialog", { name: "Cisco Workflows change requires approval" });
    expect(screen.queryByRole("heading", { name: "IaC operation requires approval" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("agent_react_resume", expect.objectContaining({
      threadId: "synthetic-thread-second",
      decision: "deny",
    })));
  });

  it("keeps existing Zabbix requests on their original approval path", async () => {
    await emitWorkflowApproval({
      ...workflowApprovalEvent,
      tool: "zabbix",
      command: "host.update",
      classification: { tier: "high", params: { hostid: "synthetic-host" }, rationale: "Update test host" },
    });
    expect(screen.getByRole("heading", { name: "Zabbix change requires approval" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "IaC operation requires approval" })).not.toBeInTheDocument();
  });

  it("keeps existing IaC requests on their original approval path", async () => {
    await emitWorkflowApproval({
      ...workflowApprovalEvent,
      tool: "terraform",
      command: "terraform apply",
      working_dir: "/synthetic/iac",
      classification: { tier: "high", create: 1 },
    });
    expect(screen.getByRole("heading", { name: "IaC operation requires approval" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cisco Workflows change requires approval" })).not.toBeInTheDocument();
  });

  it("inserts a saved prompt into the draft", async () => {
    const user = userEvent.setup();
    render(<AgentPanel tabId="tab-prompts" isOpen onToggle={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Prompts/ }));
    await screen.findByText("Explain interfaces");
    await user.click(screen.getByRole("button", { name: "Use prompt Explain interfaces" }));

    expect(screen.getByRole("textbox")).toHaveValue("Explain this output.");
  });

  it("dictates into the draft and stops without submitting it", async () => {
    const user = userEvent.setup();
    render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await user.type(screen.getByRole("textbox"), "check");
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));

    expect(screen.getByRole("button", { name: "Stop voice dictation" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.getByText("Listening… click the microphone to stop."))
      .toHaveAttribute("role", "status");

    await user.click(screen.getByRole("button", { name: "Stop voice dictation" }));

    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("check interface status"));
    expect(screen.getByRole("textbox")).not.toHaveAttribute("readonly");
    expect(screen.getByText("Dictation stopped. Review the message before sending."))
      .toHaveAttribute("role", "status");
    expect(invokeMock).toHaveBeenCalledWith("dictation_start");
    expect(invokeMock).toHaveBeenCalledWith("dictation_stop");
    expect(
      invokeMock.mock.calls.some(([command]) => command === "agent_chat_stream"),
    ).toBe(false);
  });

  it("clears the stopped dictation status when sending", async () => {
    const user = userEvent.setup();
    render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await user.type(screen.getByRole("textbox"), "check");
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    await user.click(screen.getByRole("button", { name: "Stop voice dictation" }));

    await screen.findByText("Dictation stopped. Review the message before sending.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.queryByText("Dictation stopped. Review the message before sending."))
        .not.toBeInTheDocument();
    });
  });

  it("does not submit with Enter while dictation is listening", async () => {
    const user = userEvent.setup();
    render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await user.type(screen.getByRole("textbox"), "check");
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));

    expect(screen.getByRole("button", { name: "Stop voice dictation" }))
      .toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");

    expect(screen.getByRole("textbox")).toHaveValue("check");
    expect(screen.getByRole("button", { name: "Stop voice dictation" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(
      invokeMock.mock.calls.some(([command]) => command === "agent_chat_stream"),
    ).toBe(false);
  });

  it("disables the microphone while streaming and without a tab", async () => {
    const { rerender } = render(<AgentPanel tabId={null} isOpen onToggle={() => {}} />);

    await screen.findByRole("combobox", { name: "Active agent for this tab" });
    expect(screen.getByRole("button", { name: "Start voice dictation" })).toBeDisabled();

    act(() => {
      useChatStore.setState({
        streaming: { [chatKey("tab-voice", "network-architect")]: true },
      });
    });
    rerender(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    expect(screen.getByRole("button", { name: "Start voice dictation" })).toBeDisabled();
  });

  it("shows dictation start errors while retaining a usable textarea", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "dictation_start") return Promise.reject("No microphone is available.");
      return mockInvoke(command);
    });
    const user = userEvent.setup();
    render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await screen.findByRole("combobox", { name: "Active agent for this tab" });
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));

    expect(screen.getByText("No microphone is available.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("textbox")).not.toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Start voice dictation" }))
      .toHaveAttribute("aria-pressed", "false");
  });

  it("cancels native dictation when the panel closes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await screen.findByRole("combobox", { name: "Active agent for this tab" });
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    rerender(<AgentPanel tabId="tab-voice" isOpen={false} onToggle={() => {}} />);

    expect(invokeMock).toHaveBeenCalledWith("dictation_cancel");
  });
});
