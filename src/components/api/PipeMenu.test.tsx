import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { PipeMenu, rowsToCsv } from "./PipeMenu";
import { chatKey, useChatStore } from "../../state/chatStore";
import { useAgentsStore } from "../../state/agentsStore";

// --- rowsToCsv ---------------------------------------------------------

describe("rowsToCsv", () => {
  it("emits one CSV row per object in an array-of-objects", () => {
    const csv = rowsToCsv([
      { id: 1, name: "a" },
      { id: 2, name: "b,c" },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("id,name");
    expect(lines[1]).toBe("1,a");
    // Comma in value gets RFC4180-quoted.
    expect(lines[2]).toBe(`2,"b,c"`);
  });

  it("handles heterogeneous keys (union in first-seen order)", () => {
    const csv = rowsToCsv([
      { id: 1, name: "a" },
      { id: 2, status: "online" },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("id,name,status");
    expect(lines[1]).toBe("1,a,");
    expect(lines[2]).toBe("2,,online");
  });

  it("escapes quotes in values", () => {
    const csv = rowsToCsv([{ note: 'he said "hi"' }]);
    expect(csv).toContain(`"he said ""hi"""`);
  });

  it("scalars / non-object arrays produce a single 'value' column", () => {
    const csv = rowsToCsv([1, 2, 3]);
    expect(csv).toBe("value\n1\n2\n3");
  });

  it("nested objects as cell values get JSON-stringified", () => {
    const csv = rowsToCsv([{ id: 1, coords: { lat: 1, lng: 2 } }]);
    expect(csv).toContain('"{""lat"":1,""lng"":2}"');
  });
});

// --- PipeMenu component ------------------------------------------------

const listPipeTargetsMock = vi.fn();
const apiPipeToTerminalMock = vi.fn();
const apiPipeToAiMock = vi.fn();
const agentsListMock = vi.fn();
const agentSessionSetMock = vi.fn();

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    listPipeTargets: (...args: unknown[]) => listPipeTargetsMock(...args),
    apiPipeToTerminal: (...args: unknown[]) => apiPipeToTerminalMock(...args),
    apiPipeToAi: (...args: unknown[]) => apiPipeToAiMock(...args),
    agentsList: (...args: unknown[]) => agentsListMock(...args),
    agentSessionSet: (...args: unknown[]) => agentSessionSetMock(...args),
  };
});

function target(partial: Partial<import("./PipeMenu").PipeTarget> = {}) {
  return {
    sourceTabId: "api-tab-1",
    value: "hello",
    label: "message",
    x: 100,
    y: 120,
    ...partial,
  };
}

describe("PipeMenu", () => {
  beforeEach(() => {
    listPipeTargetsMock.mockReset();
    apiPipeToTerminalMock.mockReset();
    apiPipeToAiMock.mockReset();
    agentsListMock.mockReset();
    agentSessionSetMock.mockReset();
    apiPipeToTerminalMock.mockResolvedValue(undefined);
    apiPipeToAiMock.mockResolvedValue("msg-1");
    agentsListMock.mockResolvedValue([]);
    agentSessionSetMock.mockResolvedValue(undefined);
    // Wipe cross-test state from the Zustand stores — otherwise tests
    // that set activeAgentByTab leak into later tests that expect
    // "no active agent".
    act(() => {
      useAgentsStore.setState({ activeAgentByTab: {} });
      useChatStore.setState({ messages: {}, streaming: {}, error: {} });
    });
  });

  it("renders nothing when target is null", () => {
    const { container } = render(
      <PipeMenu target={null} onClose={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders every tab returned by listPipeTargets as a pipe target", async () => {
    // listPipeTargets is the backend command that filters to terminals with
    // a live PTY — the PipeMenu just trusts what it returns.
    listPipeTargetsMock.mockResolvedValue([
      {
        id: "t1",
        title: "zsh",
        shell_cmd: "/bin/zsh",
        cwd: "/",
        created_at: 0,
        tab_type: "terminal",
      },
    ]);
    render(<PipeMenu target={target()} onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-pipe-to-terminal-t1")).toBeDefined(),
    );
  });

  it("does NOT render a terminal row for a tab missing from listPipeTargets", async () => {
    // Simulates a stale DB row whose PTY exited without a clean close —
    // the backend now filters it out, so the menu must not render it.
    listPipeTargetsMock.mockResolvedValue([]);
    render(<PipeMenu target={target()} onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-pipe-no-terminals")).toBeDefined(),
    );
    expect(screen.queryByTestId(/api-pipe-to-terminal-/)).toBeNull();
  });

  it("labels terminal tabs with shell-basename + index, not the raw title", async () => {
    // Without this formatting, every `/bin/zsh` tab renders as `/bin/zsh`
    // and the user can't tell them apart. Labels should be `zsh #1`, `zsh #2`, etc.
    listPipeTargetsMock.mockResolvedValue([
      {
        id: "t1",
        title: "/bin/zsh",
        shell_cmd: "/bin/zsh",
        cwd: "/",
        created_at: 0,
        tab_type: "terminal",
      },
      {
        id: "t2",
        title: "/bin/zsh",
        shell_cmd: "/bin/zsh",
        cwd: "/",
        created_at: 1,
        tab_type: "terminal",
      },
    ]);
    render(<PipeMenu target={target()} onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-pipe-to-terminal-t1")).toBeDefined(),
    );
    const t1 = screen.getByTestId("api-pipe-to-terminal-t1");
    const t2 = screen.getByTestId("api-pipe-to-terminal-t2");
    expect(t1.textContent).toContain("zsh #1");
    expect(t2.textContent).toContain("zsh #2");
    // Full shell path is in the tooltip so users can still disambiguate.
    expect((t1 as HTMLElement).title).toContain("/bin/zsh");
  });

  it("sendToTerminal calls apiPipeToTerminal with the selected tab id", async () => {
    listPipeTargetsMock.mockResolvedValue([
      {
        id: "t1",
        title: "zsh",
        shell_cmd: "/bin/zsh",
        cwd: "/",
        created_at: 0,
        tab_type: "terminal",
      },
    ]);
    const onClose = vi.fn();
    render(<PipeMenu target={target({ value: "echo hi" })} onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-pipe-to-terminal-t1")).toBeDefined(),
    );
    fireEvent.click(screen.getByTestId("api-pipe-to-terminal-t1"));
    await waitFor(() => {
      expect(apiPipeToTerminalMock).toHaveBeenCalledWith({
        tabId: "t1",
        text: "echo hi",
      });
    });
  });

  it("Copy as CSV writes to the clipboard", async () => {
    listPipeTargetsMock.mockResolvedValue([]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });
    render(
      <PipeMenu
        target={target({
          value: [
            { id: 1, name: "a" },
            { id: 2, name: "b" },
          ],
        })}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("api-pipe-copy-csv")).toBeDefined(),
    );
    fireEvent.click(screen.getByTestId("api-pipe-copy-csv"));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain("id,name");
  });

  it("Send to AI dispatches a prefill-agent-input event with the prompt+snippet", async () => {
    listPipeTargetsMock.mockResolvedValue([]);
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("ccie:prefill-agent-input", handler);
    try {
      render(
        <PipeMenu
          target={target({ value: { device: "switch-1" }, label: "device" })}
          onClose={() => {}}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("api-pipe-to-ai")).toBeDefined(),
      );
      fireEvent.click(screen.getByTestId("api-pipe-to-ai"));
      await waitFor(() => expect(events).toHaveLength(1));
      const detail = events[0].detail as {
        tabId: string;
        agentId: string;
        message: string;
      };
      expect(detail.tabId).toBe("api-tab-1");
      expect(detail.message).toContain("switch-1");
      expect(detail.message).toContain("device");
    } finally {
      window.removeEventListener("ccie:prefill-agent-input", handler);
    }
  });

  it("shows 'no open terminal tabs' when no terminals exist", async () => {
    listPipeTargetsMock.mockResolvedValue([]);
    render(<PipeMenu target={target()} onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-pipe-no-terminals")).toBeDefined(),
    );
  });

  describe("Send to AI — agent routing", () => {
    const termTab = {
      id: "term-1",
      title: "zsh",
      shell_cmd: "/bin/zsh",
      cwd: "/",
      created_at: 0,
      tab_type: "terminal" as const,
    };

    it("does NOT render any 'route to another tab' section, even with open terminals", async () => {
      // The AgentPanel only renders the ACTIVE tab's bucket, so piping
      // into a different tab's bucket never surfaces to the user without
      // a manual tab switch. That option was removed — the only
      // AI destinations are this tab's general chat + this tab's agents.
      listPipeTargetsMock.mockResolvedValue([termTab]);
      agentsListMock.mockResolvedValue([
        {
          id: "net-ops",
          name: "Net Ops",
          description: "",
          systemPrompt: "",
          attachedSkills: [],
          attachedMcpServers: [],
          allowedCommands: [],
          body: "",
          path: "",
        },
      ]);
      render(<PipeMenu target={target()} onClose={() => {}} />);
      // Self-scoped rows are rendered…
      await waitFor(() =>
        expect(screen.getByTestId("api-pipe-to-ai-self-net-ops")).toBeDefined(),
      );
      // …but NOTHING matching the old cross-tab routing test-ids.
      expect(screen.queryByTestId("api-pipe-ai-tab-term-1")).toBeNull();
      expect(screen.queryByTestId("api-pipe-to-ai-term-1-general")).toBeNull();
      expect(screen.queryByTestId("api-pipe-to-ai-term-1-net-ops")).toBeNull();
    });

    it("'Send to AI panel (this tab)' routes to the source tab's bucket via prefill event", async () => {
      act(() => {
        useChatStore.setState({ messages: {}, streaming: {}, error: {} });
      });
      listPipeTargetsMock.mockResolvedValue([termTab]);
      agentsListMock.mockResolvedValue([]);
      const events: CustomEvent[] = [];
      const handler = (e: Event) => events.push(e as CustomEvent);
      window.addEventListener("ccie:prefill-agent-input", handler);
      try {
        render(
          <PipeMenu
            target={target({ value: "hello", label: "greeting" })}
            onClose={() => {}}
          />,
        );
        await waitFor(() =>
          expect(screen.getByTestId("api-pipe-to-ai")).toBeDefined(),
        );
        fireEvent.click(screen.getByTestId("api-pipe-to-ai"));
        await waitFor(() => expect(events).toHaveLength(1));
        expect((events[0].detail as { tabId: string }).tabId).toBe("api-tab-1");
        expect((events[0].detail as { agentId: string }).agentId).toBe("general");
      } finally {
        window.removeEventListener("ccie:prefill-agent-input", handler);
      }
    });

    it("lists this tab's agents AS TOP-LEVEL options, auto-switching the panel when picked", async () => {
      act(() => {
        useChatStore.setState({ messages: {}, streaming: {}, error: {} });
        useAgentsStore.setState({ activeAgentByTab: {} });
      });
      listPipeTargetsMock.mockResolvedValue([]);
      agentsListMock.mockResolvedValue([
        {
          id: "dot1x",
          name: "802.1x debugger",
          description: "Troubleshoots 802.1x auth",
          systemPrompt: "",
          attachedSkills: [],
          attachedMcpServers: [],
          allowedCommands: [],
          body: "",
          path: "",
        },
      ]);
      const events: CustomEvent[] = [];
      const handler = (e: Event) => events.push(e as CustomEvent);
      window.addEventListener("ccie:prefill-agent-input", handler);
      try {
        render(<PipeMenu target={target()} onClose={() => {}} />);
        await waitFor(() =>
          expect(screen.getByTestId("api-pipe-to-ai-self-dot1x")).toBeDefined(),
        );
        fireEvent.click(screen.getByTestId("api-pipe-to-ai-self-dot1x"));
        await waitFor(() => expect(events).toHaveLength(1));
        const detail = events[0].detail as { tabId: string; agentId: string };
        expect(detail.tabId).toBe("api-tab-1");
        expect(detail.agentId).toBe("dot1x");
        // Active agent for this tab is switched so the panel renders dot1x.
        expect(
          useAgentsStore.getState().activeAgentByTab["api-tab-1"],
        ).toBe("dot1x");
      } finally {
        window.removeEventListener("ccie:prefill-agent-input", handler);
      }
    });

    it("dispatches an event whose message embeds the picked label and value", async () => {
      // The AgentPanel listens for `ccie:prefill-agent-input` and prefills
      // the input box. The contract: the event's `message` includes both
      // the picked `label` and the picked value so the LLM has full
      // context when the user hits send.
      act(() => {
        useChatStore.setState({ messages: {}, streaming: {}, error: {} });
      });
      listPipeTargetsMock.mockResolvedValue([]);
      agentsListMock.mockResolvedValue([]);
      const events: CustomEvent[] = [];
      const handler = (e: Event) => events.push(e as CustomEvent);
      window.addEventListener("ccie:prefill-agent-input", handler);
      try {
        render(
          <PipeMenu
            target={target({ value: { id: "L_9" }, label: "orgId" })}
            onClose={() => {}}
          />,
        );
        await waitFor(() =>
          expect(screen.getByTestId("api-pipe-to-ai")).toBeDefined(),
        );
        fireEvent.click(screen.getByTestId("api-pipe-to-ai"));
        await waitFor(() => expect(events).toHaveLength(1));
        const detail = events[0].detail as { message: string };
        expect(detail.message).toContain("orgId");
        expect(detail.message).toContain("L_9");
      } finally {
        window.removeEventListener("ccie:prefill-agent-input", handler);
      }
    });

    it("falls back to the API tab's own chat when no terminal tabs exist", async () => {
      listPipeTargetsMock.mockResolvedValue([]);
      agentsListMock.mockResolvedValue([]);
      const events: CustomEvent[] = [];
      const handler = (e: Event) => events.push(e as CustomEvent);
      window.addEventListener("ccie:prefill-agent-input", handler);
      try {
        render(
          <PipeMenu
            target={target({ value: { id: "L_9" }, label: "orgId" })}
            onClose={() => {}}
          />,
        );
        await waitFor(() =>
          expect(screen.getByTestId("api-pipe-to-ai")).toBeDefined(),
        );
        fireEvent.click(screen.getByTestId("api-pipe-to-ai"));
        await waitFor(() => expect(events).toHaveLength(1));
        const detail = events[0].detail as { tabId: string; agentId: string };
        expect(detail.tabId).toBe("api-tab-1");
        expect(detail.agentId).toBe("general");
      } finally {
        window.removeEventListener("ccie:prefill-agent-input", handler);
      }
    });
  });
});
