import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../lib/tauri";
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
      agent("custom-agent"),
    ]);
  }
  if (command === "dictation_start") return Promise.resolve(null);
  if (command === "dictation_stop") return Promise.resolve("interface status");
  return Promise.resolve(null);
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
