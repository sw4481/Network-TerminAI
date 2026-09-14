import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../lib/tauri";
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

describe("AgentPanel agent ownership groups", () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    const agents = [agent("network-architect"), agent("topolograph"), agent("custom-agent")];
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "agents_list") return Promise.resolve(agents);
      return Promise.resolve(null);
    });
    useAgentsStore.setState({
      agents: [],
      activeAgentByTab: {},
      pendingMentionByTab: {},
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
});
