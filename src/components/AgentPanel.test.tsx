import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, ReactEvent } from "../lib/tauri";
import { chatKey, useChatStore } from "../state/chatStore";
import { useAgentsStore } from "../state/agentsStore";

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

describe("AgentPanel", () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    invokeMock.mockReset();
    invokeMock.mockImplementation(mockInvoke);
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
