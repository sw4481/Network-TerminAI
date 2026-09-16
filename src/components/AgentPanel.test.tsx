import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

type FakeResult = Array<{ transcript: string }> & { isFinal: boolean };
type FakeResultEvent = { results: FakeResult[] };

class FakeSpeechRecognition {
  static latest: FakeSpeechRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onresult: ((event: FakeResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();

  constructor() {
    FakeSpeechRecognition.latest = this;
  }

  emitResults(segments: Array<{ text: string; isFinal: boolean }>) {
    const results = segments.map(({ text, isFinal }) =>
      Object.assign([{ transcript: text }], { isFinal }),
    );
    this.onresult?.({ results });
  }

  emitError(error: string) {
    this.onerror?.({ error });
  }
}

const speechRecognitionDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "SpeechRecognition",
);
const webkitSpeechRecognitionDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "webkitSpeechRecognition",
);

function setSpeechRecognitionConstructor(
  name: "SpeechRecognition" | "webkitSpeechRecognition",
  value: unknown,
) {
  Object.defineProperty(window, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function installFakeSpeechRecognition() {
  setSpeechRecognitionConstructor("webkitSpeechRecognition", FakeSpeechRecognition);
}

function restoreSpeechRecognitionConstructors() {
  for (const [name, descriptor] of [
    ["SpeechRecognition", speechRecognitionDescriptor],
    ["webkitSpeechRecognition", webkitSpeechRecognitionDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(window, name, descriptor);
    else Reflect.deleteProperty(window, name);
  }
}

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

describe("AgentPanel", () => {
  beforeEach(() => {
    FakeSpeechRecognition.latest = null;
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
    useChatStore.setState({
      messages: {},
      streaming: {},
      error: {},
      pendingSources: {},
    });
  });

  afterEach(() => {
    restoreSpeechRecognitionConstructors();
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
    installFakeSpeechRecognition();
    const user = userEvent.setup();
    render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await user.type(screen.getByRole("textbox"), "check");
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));

    expect(screen.getByRole("button", { name: "Stop voice dictation" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");

    act(() => {
      FakeSpeechRecognition.latest?.emitResults([
        { text: "interface status", isFinal: false },
      ]);
    });
    expect(screen.getByRole("textbox")).toHaveValue("check interface status");

    await user.click(screen.getByRole("button", { name: "Stop voice dictation" }));
    expect(screen.getByRole("textbox")).not.toHaveAttribute("readonly");
    expect(screen.getByRole("textbox")).toHaveValue("check interface status");
    expect(screen.getByText("Dictation stopped. Review the message before sending."))
      .toHaveAttribute("role", "status");
    expect(
      invokeMock.mock.calls.some(([command]) => command === "agent_chat_stream"),
    ).toBe(false);
  });

  it("clears the stopped dictation status when sending", async () => {
    installFakeSpeechRecognition();
    const user = userEvent.setup();
    render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await user.type(screen.getByRole("textbox"), "check");
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    act(() => {
      FakeSpeechRecognition.latest?.emitResults([
        { text: "interface status", isFinal: false },
      ]);
    });
    await user.click(screen.getByRole("button", { name: "Stop voice dictation" }));

    expect(screen.getByText("Dictation stopped. Review the message before sending."))
      .toHaveAttribute("role", "status");

    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.queryByText("Dictation stopped. Review the message before sending."))
        .not.toBeInTheDocument();
    });
  });

  it("does not submit with Enter while dictation is listening", async () => {
    installFakeSpeechRecognition();
    const user = userEvent.setup();
    render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await user.type(screen.getByRole("textbox"), "check");
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    act(() => {
      FakeSpeechRecognition.latest?.emitResults([
        { text: "interface status", isFinal: false },
      ]);
    });

    expect(screen.getByRole("button", { name: "Stop voice dictation" }))
      .toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");

    expect(screen.getByRole("textbox")).toHaveValue("check interface status");
    expect(screen.getByRole("button", { name: "Stop voice dictation" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(
      invokeMock.mock.calls.some(([command]) => command === "agent_chat_stream"),
    ).toBe(false);
  });

  it("disables the microphone while streaming and without a tab", async () => {
    installFakeSpeechRecognition();
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

  it("shows unsupported speech status while retaining a usable textarea", async () => {
    setSpeechRecognitionConstructor("SpeechRecognition", undefined);
    setSpeechRecognitionConstructor("webkitSpeechRecognition", undefined);
    render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await screen.findByRole("combobox", { name: "Active agent for this tab" });
    expect(
      screen.getByText("Speech input is unavailable in this WebView; typing still works."),
    ).toHaveAttribute("role", "status");
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("textbox")).not.toHaveAttribute("readonly");
  });

  it("shows a permission error and clears the pressed microphone state", async () => {
    installFakeSpeechRecognition();
    const user = userEvent.setup();
    render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await screen.findByRole("combobox", { name: "Active agent for this tab" });
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    act(() => {
      FakeSpeechRecognition.latest?.emitError("not-allowed");
    });

    expect(
      screen.getByText("Microphone or speech recognition permission was denied."),
    ).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Start voice dictation" }))
      .toHaveAttribute("aria-pressed", "false");
  });

  it("cancels recognition and ignores late results when the panel closes", async () => {
    installFakeSpeechRecognition();
    const user = userEvent.setup();
    const { rerender } = render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await user.type(screen.getByRole("textbox"), "check");
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    const fake = FakeSpeechRecognition.latest;

    rerender(<AgentPanel tabId="tab-voice" isOpen={false} onToggle={() => {}} />);
    act(() => {
      fake?.emitResults([{ text: "late words", isFinal: false }]);
    });
    rerender(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    expect(fake?.abort).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox")).toHaveValue("check");
  });

  it("aborts recognition when the panel unmounts", async () => {
    installFakeSpeechRecognition();
    const user = userEvent.setup();
    const { unmount } = render(<AgentPanel tabId="tab-voice" isOpen onToggle={() => {}} />);

    await screen.findByRole("combobox", { name: "Active agent for this tab" });
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    unmount();

    expect(FakeSpeechRecognition.latest?.abort).toHaveBeenCalledOnce();
  });
});
