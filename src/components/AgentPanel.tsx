import { Fragment, useId, useState, useRef, useEffect, FormEvent, KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChatStore, chatKey } from "../state/chatStore";
import { useAgentsStore } from "../state/agentsStore";
import { useCopilotCanvas } from "../state/copilotCanvasStore";
import { CanvasContextBuilder, type CanvasRequest, type CanvasRun } from "../lib/copilotCanvas";
import { useTabs } from "../state/tabsStore";
import { useRagStore } from "../state/ragStore";
import { usePanesStore } from "../state/panesStore";
import { useTerminalConnectionStore } from "../state/terminalConnectionStore";
import * as terminalRegistry from "../lib/terminalRegistry";
import {
  parseTerminalAttachmentRequest,
  resolveTerminalAttachment,
} from "../lib/terminalAgentAttachment";
import {
  agentChatStream,
  agentsList,
  agentSessionSet,
  agentSessionGet,
  agentApproveTool,
  agentChatCancel,
  aiMessagesByTabAgent,
  saveAiMessage,
  aiClearMessages,
  agentReactRun,
  agentCodeExecRun,
  agentReactCodeRun,
  agentReactContinue,
  agentReactResume,
  agentTerminalPreviewFixEdit,
  agentTerminalApproveFix,
  agentTerminalCancel,
  dictationStart,
  dictationStop,
  dictationCancel,
  type CodeExecEvent,
  type ReactEvent,
  type TerminalFixBatch,
  type TerminalFixPreview,
  type TerminalInvestigationPlan,
} from "../lib/tauri";
import { IaCApprovalModal, type IaCApprovalRequest } from "./IaCApprovalModal";
import { ZabbixApprovalModal, type ZabbixApprovalRequest } from "./ZabbixApprovalModal";
import { WorkflowsApprovalModal, type WorkflowsApprovalRequest } from "./WorkflowsApprovalModal";
import { TerminalFixApprovalModal } from "./TerminalFixApprovalModal";
import { useDiagramStore } from "../state/diagramStore";
import { CodeBlock } from "./CodeBlock";
import { ChatHistoryBrowser } from "./ChatHistoryBrowser";
import { AgentSourcesBadge } from "./AgentSourcesBadge";
import { AgentSourcesDrawer } from "./AgentSourcesDrawer";
import { PromptLibraryManager } from "./PromptLibraryManager";
import { useAiChatPreferences } from "../hooks/useAiChatPreferences";
import {
  AgentWorkingIndicator,
  shouldRenderAgentMessage,
} from "./AgentWorkingIndicator";
import "./AgentSourcesDrawer.css";

interface CodeBlockState {
  id: string;
  code: string;
  collapsed: boolean;
  status: "executing" | "success" | "error" | "retrying";
  output?: string;
  error?: string;
  attempt?: number;
}

type TerminalActionState = {
  planStepId: string;
  command: string;
  purpose: string;
  status: "running" | "success" | "error";
  result?: Record<string, unknown>;
};

// Default agent for a new tab: the orchestrator, not bare "general".
const DEFAULT_AGENT_ID = "network-architect";

// Presentational display names. Known agents get a curated label (proper
// acronyms/casing); anything else falls back to Title-Casing each word,
// splitting on hyphens/underscores/spaces.
const AGENT_DISPLAY_OVERRIDES: Record<string, string> = {
  "network-architect": "Network Architect",
  aci: "ACI",
  "catalyst-center": "Catalyst Center",
  "cisco-xdr": "Cisco XDR",
  cml: "CML",
  fmc: "FMC",
  gnmi: "gNMI",
  iac: "IAC",
  iosxe_translate: "IOS-XE Translate",
  ise: "ISE",
  meraki: "Meraki",
  proxmox: "Proxmox",
  pyats: "pyATS",
  "secure-endpoint": "Secure Endpoint",
  splunk: "Splunk",
  stealthwatch: "Stealthwatch",
  thousandeyes: "ThousandEyes",
};

const agentDisplayName = (nameOrId: string, id?: string): string => {
  const key = (id || nameOrId || "").toLowerCase();
  if (AGENT_DISPLAY_OVERRIDES[key]) return AGENT_DISPLAY_OVERRIDES[key];
  return (nameOrId || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
};

// Prepackaged (bundled) agent ids — the directory names under bundled-agents/.
// Used to split the dropdown into "Prepackaged" vs "User Agents". Anything not
// in this set (and not network-architect/general) is a user-created agent.
const PREPACKAGED_AGENT_IDS = new Set<string>([
  "aci",
  "catalyst-center",
  "cisco-workflows",
  "cisco-xdr",
  "cml",
  "fmc",
  "gnmi",
  "iac",
  "iosxe_translate",
  "ise",
  "meraki",
  "mist",
  "network-architect",
  "proxmox",
  "pyats",
  "secure-endpoint",
  "splunk",
  "stealthwatch",
  "thousandeyes",
  "topolograph",
  "grafana",
  "zabbix",
  "prometheus",
  "netbox",
  "sketchfab",
  "devnet",
  "fwrule",
]);

type ReactCodeTurn = {
  tabId: string;
  agentId: string | null;
  settled: boolean;
  paused: boolean;
  invocation: number;
  canvas?: CanvasRequest;
};

type AgentPanelProps = {
  tabId: string | null;
  isOpen: boolean;
  onToggle: () => void;
  canvasMode?: boolean;
};

export function AgentPanel({ tabId, isOpen, onToggle, canvasMode = false }: AgentPanelProps) {
  const [input, setInput] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [dictationStatus, setDictationStatus] = useState("");
  const dictationTabRef = useRef(tabId);
  const [terminalAttachRequested, setTerminalAttachRequested] = useState(false);
  const [terminalLeaseId, setTerminalLeaseId] = useState<string | null>(null);
  const [terminalPlan, setTerminalPlan] = useState<TerminalInvestigationPlan | null>(null);
  const [terminalActions, setTerminalActions] = useState<TerminalActionState[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const promptsPanelId = useId();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const agentToggleRef = useRef<HTMLButtonElement>(null);
  const canvasHeadingRef = useRef<HTMLHeadingElement>(null);
  const streamedGenerationRef = useRef<Record<string, boolean>>({});
  const reactCodeTurns = useRef<Record<string, ReactCodeTurn>>({});
  const canvasWorkspace = useCopilotCanvas(s => canvasMode && tabId ? s.workspaces[tabId] : undefined);
  const { preferences: aiChatPreferences } = useAiChatPreferences();

  // Agents store — must resolve BEFORE the chat key so the key reflects the active agent
  const agents = useAgentsStore((s) => s.agents);
  const setAgents = useAgentsStore((s) => s.setAgents);
  const activeAgentForTab = useAgentsStore((s) =>
    !canvasMode && tabId ? s.activeAgentByTab[tabId] ?? DEFAULT_AGENT_ID : DEFAULT_AGENT_ID
  );
  const setActiveAgent = useAgentsStore((s) => s.setActiveAgent);

  // Composite in-memory bucket key: separates conversation per (tab, agent).
  const bucketKey = tabId ? chatKey(tabId, activeAgentForTab) : null;
  const currentTurn = bucketKey ? reactCodeTurns.current[bucketKey] : undefined;
  const awaitingCheckpoint = Boolean(currentTurn?.paused && !currentTurn.settled);
  // agentId to persist to DB (null = general chat row)
  const persistAgentId: string | null =
    activeAgentForTab && activeAgentForTab !== "general" ? activeAgentForTab : null;

  const messages =
    useChatStore((s) => (bucketKey ? s.messages[bucketKey] : undefined)) || [];
  const streaming = useChatStore((s) =>
    bucketKey ? s.streaming[bucketKey] : false
  );
  const error = useChatStore((s) => (bucketKey ? s.error[bucketKey] : null));

  const addMessage = useChatStore((s) => s.addMessage);
  const appendToken = useChatStore((s) => s.appendToken);
  const setStreaming = useChatStore((s) => s.setStreaming);
  const setError = useChatStore((s) => s.setError);
  const clearError = useChatStore((s) => s.clearError);
  const updateToolMessage = useChatStore((s) => s.updateToolMessage);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const clearMessagesAction = useChatStore((s) => s.clearMessages);
  const attachSourcesToInProgress = useChatStore(
    (s) => s.attachSourcesToInProgress
  );

  // Plan 12 Phase 5 — pull vendor/platform from the tab metadata so
  // the agent_chat_stream command can drive RAG retrieval. When the
  // active tab has neither field set (the default for terminal tabs
  // until vendor inference lands), both pass through as undefined and
  // the backend skips RAG entirely.
  const tabVendor = useTabs((s) =>
    tabId ? s.tabs.find((t) => t.id === tabId)?.vendor : undefined
  );
  const tabPlatform = useTabs((s) =>
    tabId ? s.tabs.find((t) => t.id === tabId)?.platform : undefined
  );

  // RAG user-tags follow-up — read active user tags for this tab.
  // Mirrors AgentSourcesDrawer's pattern: select the whole map, then
  // derive the array outside the selector to avoid returning a fresh
  // `[]` that would trip React 19's useSyncExternalStore tear-check.
  const EMPTY_TAGS: string[] = [];
  const activeUserTagsMap = useRagStore((s) => s.activeUserTagsByTab);
  const activeUserTags: string[] = tabId
    ? activeUserTagsMap[tabId] ?? EMPTY_TAGS
    : EMPTY_TAGS;

  // Code execution blocks state for agents with executionMode === "code"
  const [codeBlocks, setCodeBlocks] = useState<CodeBlockState[]>([]);
  const [continuationByBucket, setContinuationByBucket] = useState<
    Record<string, string>
  >({});
  const continuationThreadId = bucketKey
    ? continuationByBucket[bucketKey] ?? null
    : null;

  // IaC Phase 2 — pending approval gate. When the agent pauses on a gated
  // iac_apply, the modal mounts with this request + the turn's bucket key so
  // resumed events land in the conversation that started them.
  const [iacApproval, setIacApproval] = useState<
    {
      request: IaCApprovalRequest;
      threadId: string;
      bucketKey: string;
      streamOutput: boolean;
      turn?: ReactCodeTurn;
    } | null
  >(null);
  const [zabbixApproval, setZabbixApproval] = useState<{request: ZabbixApprovalRequest; threadId: string; bucketKey: string; streamOutput: boolean; turn?: ReactCodeTurn} | null>(null);
  const [workflowsApproval, setWorkflowsApproval] = useState<{ request: WorkflowsApprovalRequest; threadId: string; bucketKey: string; streamOutput: boolean; turn?: ReactCodeTurn } | null>(null);
  const [terminalFixApproval, setTerminalFixApproval] = useState<{
    threadId: string;
    preview: TerminalFixPreview;
    bucketKey: string;
    streamOutput: boolean;
    edited: boolean;
    turn?: ReactCodeTurn;
  } | null>(null);

  // Which assistant message's Sources drawer is currently open.
  // `null` = no drawer open. Cleared on new turn submit per design
  // spec §6 #10.
  const [openSourcesForMessageId, setOpenSourcesForMessageId] = useState<
    string | null
  >(null);
  // Set once when the badge appears so the aria-live region announces
  // exactly one "N sources cited" per turn.
  const [sourcesAnnouncement, setSourcesAnnouncement] = useState<string>("");
  // Ref to the badge button that opened the drawer, so we can restore
  // focus when the drawer closes (design spec §6 #1).
  const openingBadgeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const tabChanged = dictationTabRef.current !== tabId;
    dictationTabRef.current = tabId;
    if (streaming || !tabId || !isOpen || tabChanged) {
      if (isListening) dictationCancel().catch(() => {});
      setIsListening(false);
      setDictationStatus("");
    }
  }, [streaming, tabId, isOpen, isListening]);

  // Load agents list on first mount + hydrate per-tab binding from DB
  useEffect(() => {
    agentsList()
      .then((list) => setAgents(list))
      .catch(() => {});
  }, [setAgents]);

  useEffect(() => {
    if (!tabId || canvasMode) return;
    agentSessionGet(tabId)
      .then((row) => {
        if (row) setActiveAgent(tabId, row.agentId);
      })
      .catch(() => {});
  }, [tabId, canvasMode, setActiveAgent]);

  // Lazy-load history for the active (tab, agent) bucket when it's first shown
  // OR after an explicit Clear (we use `${key}#loaded` flag to avoid re-hydrating
  // freshly-added messages on every render).
  const hydratedRef = useRef<Set<string>>(new Set());
  const [historySettled, setHistorySettled] = useState<Record<string, boolean>>({});
  const awaitingCanvasHistory = canvasMode && !!bucketKey && !historySettled[bucketKey];
  useEffect(() => {
    if (!tabId || !bucketKey) return;
    // If we already have messages in-memory (e.g., user just sent a message in
    // this bucket), don't clobber them with a DB fetch — only hydrate ONCE per bucket.
    if (hydratedRef.current.has(bucketKey)) return;
    hydratedRef.current.add(bucketKey);
    const finishHydration = () => setHistorySettled(current => ({ ...current, [bucketKey]: true }));
    // A remounted Canvas may already own a live shell; do not fetch duplicate saved IDs.
    if (canvasMode && useChatStore.getState().messages[bucketKey]?.length) {
      finishHydration();
      return;
    }
    aiMessagesByTabAgent(tabId, persistAgentId)
      .then((rows) => {
        if (rows.length === 0) return;
        loadMessages(
          bucketKey,
          rows.map((r) => ({
            id: r.id,
            role: r.role as "user" | "assistant",
            content: r.content,
            timestamp: r.timestamp,
            ...(canvasMode && r.role === "assistant" ? { canvasFinal: { runId: null, response: r.content } } : {}),
          }))
        );
      })
      .catch(() => {})
      .finally(finishHydration);
  }, [tabId, bucketKey, persistAgentId, loadMessages, canvasMode]);

  const handleAgentChange = async (newAgentId: string) => {
    if (!tabId || canvasMode) return;
    setActiveAgent(tabId, newAgentId);
    try {
      await agentSessionSet(tabId, newAgentId);
    } catch (e) {
      console.error("Failed to persist agent session:", e);
    }
  };

  const handleClearChat = async () => {
    if (!tabId || !bucketKey) return;
    const label =
      activeAgentForTab === "general"
        ? "this general chat"
        : `the conversation with ${activeAgentForTab}`;
    if (!confirm(`Clear ${label} for this tab? This cannot be undone.`)) return;
    // Clear in-memory immediately
    clearMessagesAction(bucketKey);
    // Allow re-hydration next time (in case we add a stash-on-clear flow later)
    hydratedRef.current.delete(bucketKey);
    // Mark bucket as freshly loaded so the hydrate effect won't re-pull deleted rows
    hydratedRef.current.add(bucketKey);
    try {
      await aiClearMessages(tabId, persistAgentId);
    } catch (e) {
      console.error("Failed to clear chat:", e);
      setError(bucketKey, e instanceof Error ? e.message : "Failed to clear");
    }
  };

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streaming]);

  // Listen for "Ask AI about selection" events from Terminal context menu
  useEffect(() => {
    const handleAskAboutSelection = (e: Event) => {
      const customEvent = e as CustomEvent<{ selection: string }>;
      const selection = customEvent.detail.selection;
      // Open the panel if it's closed
      if (!isOpen) onToggle();
      // Prefill the input with a prompt that includes the selection
      const prompt = `Explain this terminal output:\n\n\`\`\`\n${selection}\n\`\`\``;
      setInput(prompt);
      // Focus the input
      setTimeout(() => {
        inputRef.current?.focus();
        // Scroll the textarea to the bottom
        if (inputRef.current) {
          inputRef.current.scrollTop = inputRef.current.scrollHeight;
        }
      }, 100);
    };
    window.addEventListener("ccie:ask-ai-about-selection", handleAskAboutSelection);
    return () => {
      window.removeEventListener("ccie:ask-ai-about-selection", handleAskAboutSelection);
    };
  }, [isOpen, onToggle]);

  // Listen for "invoke agent" events from Terminal (/agent-name command or right-click)
  useEffect(() => {
    const handleInvokeAgent = (e: Event) => {
      const customEvent = e as CustomEvent<{
        agentId: string;
        message?: string;
        selection?: string;
        autoSend?: boolean;
        attachTerminal?: boolean;
      }>;
      const { agentId, message, selection, autoSend, attachTerminal } = customEvent.detail;
      if (!tabId || (canvasMode && agentId !== DEFAULT_AGENT_ID)) return;
      if (!isOpen) onToggle();
      // Set active agent for this tab (in-memory + persist)
      setActiveAgent(tabId, agentId);
      setTerminalAttachRequested(Boolean(attachTerminal));
      agentSessionSet(tabId, agentId).catch((err) =>
        console.error("Failed to persist agent session:", err)
      );
      // Build input text
      let text = message ?? "";
      if (selection) {
        text =
          (text ? text + "\n\n" : "") +
          `Context:\n\`\`\`\n${selection}\n\`\`\``;
      }
      if (autoSend && text.trim()) {
        // Bypass the input state race — send directly.
        handleSend(text);
      } else {
        setInput(text);
        setTimeout(() => {
          inputRef.current?.focus();
          if (inputRef.current) {
            inputRef.current.scrollTop = inputRef.current.scrollHeight;
          }
        }, 100);
      }
    };
    window.addEventListener("ccie:invoke-agent", handleInvokeAgent);
    return () => {
      window.removeEventListener("ccie:invoke-agent", handleInvokeAgent);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, canvasMode, isOpen, onToggle, setActiveAgent, awaitingCanvasHistory]);

  // Listen for "prefill agent input" events from API tab context menu
  useEffect(() => {
    const handlePrefillInput = (e: Event) => {
      const customEvent = e as CustomEvent<{
        tabId: string;
        agentId: string;
        message: string;
      }>;
      const { tabId: eventTabId, agentId, message } = customEvent.detail;
      // Only respond if this is the target tab
      if (!tabId || tabId !== eventTabId || (canvasMode && agentId !== DEFAULT_AGENT_ID)) return;
      if (!isOpen) onToggle();
      // Set active agent for this tab
      setActiveAgent(tabId, agentId);
      agentSessionSet(tabId, agentId).catch((err) =>
        console.error("Failed to persist agent session:", err)
      );
      // Prefill the input
      setInput(message);
      setTimeout(() => {
        inputRef.current?.focus();
        if (inputRef.current) {
          inputRef.current.scrollTop = inputRef.current.scrollHeight;
        }
      }, 100);
    };
    window.addEventListener("ccie:prefill-agent-input", handlePrefillInput);
    return () => {
      window.removeEventListener("ccie:prefill-agent-input", handlePrefillInput);
    };
  }, [tabId, canvasMode, isOpen, onToggle, setActiveAgent]);

  // ── Code block helpers for code-execution agents ──
  const addCodeBlock = (code: string) => {
    setCodeBlocks((prev) => [
      ...prev,
      {
        id: `cb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        code,
        collapsed: true, // Default to collapsed
        status: "executing",
      },
    ]);
  };

  const updateLastCodeBlock = (patch: Partial<Omit<CodeBlockState, "id">>) => {
    setCodeBlocks((prev) => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = { ...updated[updated.length - 1], ...patch };
      return updated;
    });
  };

  const clearCodeBlocks = () => {
    setCodeBlocks([]);
  };

  const saveCanvasStatus = (turn: ReactCodeTurn | undefined, status: CanvasRun["status"]) =>
    turn?.canvas
      ? useCopilotCanvas.getState().finishRun(turn.canvas.workspace_id, turn.canvas.run_id, status).catch(() => {})
      : Promise.resolve(); // Canvas save errors remain visible in workspace.save, not network errors.

  // Shared ReACT-Code event handler — used by both the initial run and a
  // resumed (post-approval) run so events land in the same conversation bucket.
  const handleReactCodeEvent = (
    event: ReactEvent,
    keyForTurn: string,
    streamOutput: boolean,
    turn?: ReactCodeTurn,
    invocation?: number,
  ) => {
    if (turn && turn.invocation !== invocation) return;
    if (event.type === "canvas_limitation") {
      if (turn?.canvas) useCopilotCanvas.getState().noteLimitation(turn.canvas.workspace_id, turn.canvas.run_id, event.limitation);
      return;
    }
    if (turn?.settled) return;
    if (event.type === "canvas") {
      if (turn?.canvas) {
        if (event.workspace_id === turn.canvas.workspace_id && event.run_id === turn.canvas.run_id)
          void useCopilotCanvas.getState().accept(event).catch(() => {});
        else useCopilotCanvas.getState().noteLimitation(turn.canvas.workspace_id, turn.canvas.run_id, "Canvas presentation ownership mismatch; network execution was not changed.");
      }
      return;
    }
    if (event.type === "terminal_control_started") {
      setTerminalLeaseId(event.lease_id);
    } else if (event.type === "terminal_investigation_plan") {
      setTerminalPlan(event.plan);
    } else if (event.type === "terminal_command_start") {
      setTerminalActions((current) => [
        ...current,
        {
          planStepId: event.plan_step_id,
          command: event.command,
          purpose: event.purpose,
          status: "running",
        },
      ]);
    } else if (event.type === "terminal_command_result") {
      setTerminalActions((current) => {
        const next = [...current];
        let index = -1;
        for (let candidate = next.length - 1; candidate >= 0; candidate -= 1) {
          if (next[candidate].command === event.command && next[candidate].status === "running") {
            index = candidate;
            break;
          }
        }
        const value: TerminalActionState = {
          planStepId: event.plan_step_id,
          command: event.command,
          purpose: index >= 0 ? next[index].purpose : "Diagnostic evidence",
          status: event.success ? "success" : "error",
          result: event.result,
        };
        if (index >= 0) next[index] = value;
        else next.push(value);
        return next;
      });
    } else if (event.type === "terminal_fix_approval_request") {
      if (turn) turn.paused = true;
      void saveCanvasStatus(turn, "awaiting_approval");
      setTerminalFixApproval({
        threadId: event.thread_id,
        preview: event.preview,
        bucketKey: keyForTurn,
        streamOutput,
        turn,
        edited: false,
      });
    } else if (event.type === "terminal_lease_ended") {
      setTerminalLeaseId(null);
      appendToken(keyForTurn, `\n_Terminal control ended: ${event.reason}._\n`);
    } else if (event.type === "continuation_available") {
      if (turn) turn.paused = true;
      void saveCanvasStatus(turn, "awaiting_approval");
      setContinuationByBucket((current) => ({
        ...current,
        [keyForTurn]: event.thread_id,
      }));
    } else if (event.type === "token") {
      appendToken(keyForTurn, event.text);
      streamedGenerationRef.current[keyForTurn] = true;
    } else if (event.type === "thought_start") {
      // Guard whitespace-only thoughts so steps never render blank.
      const thoughtText = event.thought?.trim() || `Step ${event.step}`;
      // In streamed mode the model's pre-tool text has already been rendered.
      // Keep the existing labelled step as a fallback for providers that do
      // not expose token deltas.
      if (!streamOutput || !streamedGenerationRef.current[keyForTurn]) {
        appendToken(keyForTurn, `\n**[Step ${event.step}]** ${thoughtText}\n`);
      }
      streamedGenerationRef.current[keyForTurn] = false;
    } else if (event.type === "tool_call" && event.name === "execute_python_code") {
      const code = (event.args as { code?: string })?.code || "";
      addCodeBlock(code);
    } else if (event.type === "tool_result") {
      streamedGenerationRef.current[keyForTurn] = false;
      if (event.success) {
        updateLastCodeBlock({ status: "success", output: event.result });
      } else {
        updateLastCodeBlock({ status: "error", error: event.result });
      }
    } else if (event.type === "diagram") {
      useDiagramStore.getState().addDiagram(event);
      window.dispatchEvent(new CustomEvent("ccie:open-diagram-panel"));
    } else if (event.type === "final") {
      if (turn) {
        if (turn.canvas) {
          const runId = turn.canvas.run_id;
          useChatStore.setState(state => ({ messages: { ...state.messages,
            [keyForTurn]: (state.messages[keyForTurn] ?? []).map(message =>
              message.role === "assistant" && message.canvasFinal?.runId === runId
                ? { ...message, canvasFinal: { runId, response: event.response } } : message),
          } }));
        }
        turn.settled = true;
        void saveCanvasStatus(turn, "completed");
        if (event.response.trim()) void saveAiMessage({
          tabId: turn.tabId, agentId: turn.agentId, role: "assistant",
          content: event.response, timestamp: Date.now(),
        }).catch(saveError => setError(keyForTurn, `Answer save failed: ${String(saveError)}`));
      }
      setContinuationByBucket((current) => {
        const next = { ...current };
        delete next[keyForTurn];
        return next;
      });
      if (!streamOutput || !streamedGenerationRef.current[keyForTurn]) {
        appendToken(keyForTurn, event.response);
      }
      delete streamedGenerationRef.current[keyForTurn];
      setStreaming(keyForTurn, false);
    } else if (event.type === "error") {
      if (turn && !turn.paused) {
        turn.settled = true;
        void saveCanvasStatus(turn, "failed");
      }
      delete streamedGenerationRef.current[keyForTurn];
      setError(keyForTurn, event.message);
      setStreaming(keyForTurn, false);
    } else if (event.type === "iac_approval_request") {
      if (event.tool === "zabbix") {
        setZabbixApproval({ threadId:event.thread_id, bucketKey:keyForTurn, streamOutput, turn, request:{ method:event.command, params:event.classification?.params ?? {}, rationale:event.classification?.rationale ?? "", risk:event.classification?.tier ?? "high" } });
      } else if (event.tool === "cisco_workflows_apply") {
        const params = event.classification?.params as Record<string, unknown> | undefined;
        if (!params || typeof params !== "object" || Array.isArray(params) ||
            typeof params.method !== "string" || typeof params.path !== "string") {
          handleReactCodeEvent({ type: "error", message: "Workflow approval preview unavailable; no change was approved." }, keyForTurn, streamOutput, turn, invocation);
          return;
        }
        const targetOrgId = event.classification?.target_org_id;
        if (!targetOrgId?.trim()) {
          handleReactCodeEvent({ type: "error", message: "Workflow approval pinned organization ID unavailable; no change was approved." }, keyForTurn, streamOutput, turn, invocation);
          return;
        }
        setWorkflowsApproval({
          threadId: event.thread_id,
          bucketKey: keyForTurn,
          streamOutput,
          turn,
          request: {
            tier: event.classification?.tier ?? "high",
            method: params.method,
            path: params.path,
            organizationId: targetOrgId,
            params,
            rationale: event.classification?.rationale ||
              (typeof params.rationale === "string" ? params.rationale : ""),
          },
        });
      } else {
        // Agent paused on a gated apply — surface the approval modal. Streaming
        // stays "on" (the turn isn't finished); resume continues it.
        const tier = event.classification?.tier ?? "high";
        setIacApproval({
          threadId: event.thread_id,
          bucketKey: keyForTurn,
          streamOutput,
          turn,
          request: {
            command: event.command,
            workingDir: event.working_dir,
            gitBranch: "",
            blastRadius: tier,
            plannedChanges: {
              toCreate: Array((event.classification?.create as number) || 0).fill({
                resourceType: "resource",
                resourceName: "(see plan)",
              }),
              toUpdate: Array((event.classification?.update as number) || 0).fill({
                resourceType: "resource",
                resourceName: "(see plan)",
              }),
              toDestroy: Array((event.classification?.destroy as number) || 0).fill({
                resourceType: "resource",
                resourceName: "(see plan)",
              }),
            },
          },
        });
      }
      if (turn) turn.paused = true;
      void saveCanvasStatus(turn, "awaiting_approval");
    }
  };

  const handleTerminalReviewEdit = async (batch: TerminalFixBatch) => {
    const pending = terminalFixApproval;
    if (!pending) return;
    try {
      const preview = await agentTerminalPreviewFixEdit({
        leaseId: pending.preview.lease_id,
        batch,
      });
      setTerminalFixApproval({ ...pending, preview, edited: true });
    } catch (reviewError) {
      setError(
        pending.bucketKey,
        reviewError instanceof Error ? reviewError.message : String(reviewError),
      );
    }
  };

  const handleTerminalFixDecision = async (
    decision: "approve" | "deny",
    batch?: TerminalFixBatch,
  ) => {
    const pending = terminalFixApproval;
    setTerminalFixApproval(null);
    if (!pending || pending.turn?.settled) return;
    const invocation = pending.turn ? ++pending.turn.invocation : undefined;
    if (pending.turn) pending.turn.paused = false;
    await saveCanvasStatus(pending.turn, "collecting");
    if (pending.turn && (pending.turn.settled || pending.turn.invocation !== invocation)) return;
    try {
      if (decision === "deny") {
        await agentTerminalCancel(pending.preview.lease_id);
        appendToken(pending.bucketKey, "\n_Rejected — no switch changes were made._\n");
        await agentReactResume({
          threadId: pending.threadId,
          decision: "deny",
          streamOutput: pending.streamOutput,
          onEvent: (event) => handleReactCodeEvent(
            event,
            pending.bucketKey,
            pending.streamOutput,
            pending.turn,
            invocation,
          ),
        });
        return;
      }

      if (!batch) throw new Error("approved terminal fix batch is missing");
      await agentTerminalApproveFix({
        leaseId: pending.preview.lease_id,
        digest: pending.preview.digest,
        batch,
      });
      appendToken(pending.bucketKey, "\n_Approved — applying the exact reviewed batch._\n");
      await agentReactResume({
        threadId: pending.threadId,
        decision: pending.edited ? "edit" : "approve",
        editedAction: pending.edited
          ? { name: "terminal_apply_fix", args: batch }
          : undefined,
        streamOutput: pending.streamOutput,
        onEvent: (event) => handleReactCodeEvent(
          event,
          pending.bucketKey,
          pending.streamOutput,
          pending.turn,
          invocation,
        ),
      });
    } catch (approvalError) {
      handleReactCodeEvent({ type: "error", message: approvalError instanceof Error ? approvalError.message : String(approvalError) }, pending.bucketKey, pending.streamOutput, pending.turn, invocation);
    } finally {
      if (!pending.turn || (reactCodeTurns.current[pending.bucketKey] === pending.turn && pending.turn.invocation === invocation)) setStreaming(pending.bucketKey, false);
    }
  };

  // Resume an interrupted IaC apply after the user decides in the modal.
  const handleIacDecision = async (decision: "approve" | "deny") => {
    const pending = iacApproval;
    setIacApproval(null);
    if (!pending || pending.turn?.settled) return;
    const invocation = pending.turn ? ++pending.turn.invocation : undefined;
    if (pending.turn) pending.turn.paused = false;
    await saveCanvasStatus(pending.turn, "collecting");
    if (pending.turn && (pending.turn.settled || pending.turn.invocation !== invocation)) return;
    appendToken(
      pending.bucketKey,
      decision === "approve"
        ? `\n_Approved — applying ${pending.request.command}..._\n`
        : `\n_Denied — ${pending.request.command} was not applied._\n`
    );
    try {
      await agentReactResume({
        threadId: pending.threadId,
        decision,
        streamOutput: pending.streamOutput,
        onEvent: (event) => handleReactCodeEvent(
          event,
          pending.bucketKey,
          pending.streamOutput,
          pending.turn,
          invocation,
        ),
      });
    } catch (e) {
      handleReactCodeEvent({ type: "error", message: e instanceof Error ? e.message : String(e) }, pending.bucketKey, pending.streamOutput, pending.turn, invocation);
    } finally {
      if (!pending.turn || (reactCodeTurns.current[pending.bucketKey] === pending.turn && pending.turn.invocation === invocation)) setStreaming(pending.bucketKey, false);
    }
  };
  const handleZabbixDecision = async (decision: "approve" | "deny") => {
    const pending=zabbixApproval; setZabbixApproval(null); if(!pending || pending.turn?.settled)return;
    const invocation = pending.turn ? ++pending.turn.invocation : undefined;
    if (pending.turn) pending.turn.paused = false;
    await saveCanvasStatus(pending.turn, "collecting");
    if (pending.turn && (pending.turn.settled || pending.turn.invocation !== invocation)) return;
    try { await agentReactResume({threadId:pending.threadId,decision,streamOutput:pending.streamOutput,onEvent:(event)=>handleReactCodeEvent(event,pending.bucketKey,pending.streamOutput,pending.turn,invocation)}); }
    catch(e){handleReactCodeEvent({type:"error",message:e instanceof Error?e.message:String(e)},pending.bucketKey,pending.streamOutput,pending.turn,invocation);} finally {if (!pending.turn || (reactCodeTurns.current[pending.bucketKey] === pending.turn && pending.turn.invocation === invocation)) setStreaming(pending.bucketKey,false);}
  };
  const handleWorkflowsDecision = async (decision: "approve" | "deny") => {
    const pending = workflowsApproval;
    if (!pending || pending.turn?.settled) return;
    const invocation = pending.turn ? ++pending.turn.invocation : undefined;
    setWorkflowsApproval(null);
    if (pending.turn) pending.turn.paused = false;
    await saveCanvasStatus(pending.turn, "collecting");
    if (pending.turn && (pending.turn.settled || pending.turn.invocation !== invocation)) return;
    setStreaming(pending.bucketKey, true);
    try {
      await agentReactResume({
        threadId: pending.threadId,
        decision,
        streamOutput: pending.streamOutput,
        onEvent: (event) => handleReactCodeEvent(event, pending.bucketKey, pending.streamOutput, pending.turn, invocation),
      });
    } catch (error) {
      handleReactCodeEvent({ type: "error", message: error instanceof Error ? error.message : String(error) }, pending.bucketKey, pending.streamOutput, pending.turn, invocation);
    }
  };

  const handleDictationToggle = async () => {
    setDictationStatus("");
    if (isListening) {
      setIsListening(false);
      try {
        const transcript = (await dictationStop()).trim();
        if (transcript) {
          setInput((current) => `${current}${current && !/\s$/.test(current) ? " " : ""}${transcript}`);
        }
        setDictationStatus("Dictation stopped. Review the message before sending.");
      } catch (error) {
        setDictationStatus(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    try {
      await dictationStart();
      setIsListening(true);
      setDictationStatus("Listening… click the microphone to stop.");
    } catch (error) {
      setDictationStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSend = async (e?: FormEvent | string) => {
    setDictationStatus("");
    // If called with a string, treat as an override message (bypasses the input state race)
    let userMessage: string;
    if (typeof e === "string") {
      userMessage = e.trim();
    } else {
      e?.preventDefault();
      userMessage = input.trim();
    }
    const terminalRequest = parseTerminalAttachmentRequest(
      userMessage,
      terminalAttachRequested,
    );
    userMessage = terminalRequest.message;
    if (!userMessage || !tabId || !bucketKey || streaming || awaitingCanvasHistory) return;
    const existingTurn = reactCodeTurns.current[bucketKey];
    if (existingTurn && !existingTurn.settled) return;

    if (terminalRequest.requested && activeAgentForTab !== "network-architect") {
      setError(bucketKey, "Terminal attachment is available only to Network Architect.");
      return;
    }

    let terminalAttachment = null;
    if (terminalRequest.requested) {
      try {
        const panes = usePanesStore.getState();
        const connections = useTerminalConnectionStore.getState();
        const byTerminalId = { ...connections.byTerminalId };
        for (const [backendId, terminalId] of Object.entries(
          connections.terminalIdByBackendPtyId,
        )) {
          const connection = connections.byTerminalId[terminalId];
          if (connection) byTerminalId[backendId] = connection;
        }
        terminalAttachment = resolveTerminalAttachment({
          agentId: activeAgentForTab,
          requested: true,
          focusedPaneId: panes.focusedPaneId,
          layout: panes.layoutsByTab.get(tabId),
          connectionsByTerminalId: byTerminalId,
          backendPtyIdFor: (terminalId) =>
            terminalRegistry.ptyTabIdFor(terminalId)
            ?? connections.get(terminalId)?.backend_pty_id
            ?? (terminalId.startsWith("pending-") ? null : terminalId),
        });
      } catch (attachError) {
        setError(
          bucketKey,
          attachError instanceof Error ? attachError.message : String(attachError),
        );
        return;
      }
    }

    // Snapshot the bucket key for this turn — if the user switches agents mid-turn,
    // events must still land in the conversation that started them.
    const keyForTurn = bucketKey;
    const persistForTurn = { tabId, agentId: persistAgentId };
    const turn: ReactCodeTurn = { ...persistForTurn, settled: false, paused: false, invocation: 0 };
    const invocation = turn.invocation;
    const streamOutputForTurn = aiChatPreferences.streamLlmOutput;
    streamedGenerationRef.current[keyForTurn] = false;

    // Snapshot prior conversation BEFORE this turn's messages are added, so the
    // agent has multi-turn context (e.g. a network the user already named).
    // Only user/assistant turns with real content; cap to the last N to keep
    // token cost bounded on local models.
    const HISTORY_WINDOW = 10;
    const history = messages
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          m.content.trim().length > 0
      )
      .slice(-HISTORY_WINDOW)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    let requestMessage = userMessage;
    let contextAttribution = "";
    if (canvasMode) {
      const workspace = useCopilotCanvas.getState().workspaces[tabId];
      if (!workspace || agents.find(agent => agent.id === DEFAULT_AGENT_ID)?.executionMode !== "react-code") {
        setError(keyForTurn, "Canvas workspace or Network Architect is not loaded; nothing sent.");
        return;
      }
      const ids = workspace.selection.attachedCardIds;
      turn.canvas = { workspace_id: tabId, run_id: crypto.randomUUID() };
      if (ids.length) {
        // Stay within the existing bounded-output ceiling; never enlarge a model/transport limit.
        const available = Math.max(0, 48_000 - userMessage.length - history.reduce((size, item) => size + item.content.length, 0));
        const context = new CanvasContextBuilder(workspace.cards, workspace.evidence).build(tabId, ids, available);
        if (!context.ok) { setError(keyForTurn, context.limitation); return; }
        turn.canvas.selection = context.selection;
        requestMessage += context.context;
        contextAttribution = `Attached Canvas evidence: ${context.selection.card_ids.map(id => workspace.cards.find(card => card.card_id === id)?.title ?? id).join(", ")}.`;
        if (context.selection.omitted) contextAttribution += ` ${context.selection.omitted.count} omitted: ${context.selection.omitted.reason}.`;
      }
      reactCodeTurns.current[keyForTurn] = turn;
      setStreaming(keyForTurn, true);
      try {
        await useCopilotCanvas.getState().beginRun(turn.canvas.workspace_id, turn.canvas.run_id);
      } catch {
        turn.settled = true;
        setStreaming(keyForTurn, false);
        return; // The workspace exposes the independent save error; no network dispatch.
      }
      if (turn.settled) return; // Stop during initial save must not dispatch a delayed run.
      useCopilotCanvas.getState().setSelection(tabId, { attachedCardIds: [] });
    }

    setInput("");
    setTerminalAttachRequested(false);
    setTerminalPlan(null);
    setTerminalActions([]);
    setTerminalLeaseId(null);
    clearError(keyForTurn);
    setContinuationByBucket((current) => {
      const next = { ...current };
      delete next[keyForTurn];
      return next;
    });
    // Plan 12 Phase 5 design spec §6 #10 — auto-collapse any open
    // citations drawer on new turn submit.
    setOpenSourcesForMessageId(null);
    setSourcesAnnouncement("");

    // Add user message (persisted)
    addMessage(
      keyForTurn,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: userMessage,
        timestamp: Date.now(),
      },
      persistForTurn
    );

    if (contextAttribution) addMessage(keyForTurn, {
      id: `context-${turn.canvas!.run_id}`, role: "tool_result", content: contextAttribution, timestamp: Date.now(),
    });

    // Add empty assistant message for streaming (persisted — we'll save the final text at Done)
    addMessage(
      keyForTurn,
      {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        ...(turn.canvas ? { canvasFinal: { runId: turn.canvas.run_id, response: "" } } : {}),
      }
      // intentionally don't persist the empty shell; when streaming ends, the content
      // will be persisted at "done" below.
    );

    setStreaming(keyForTurn, true);

    // Check if the agent has attached_tools - if so, use ReACT loop
    const selectedAgent = agents.find((a) => a.id === activeAgentForTab);
    const hasAttachedTools =
      selectedAgent && selectedAgent.attachedTools && selectedAgent.attachedTools.length > 0;
    const isCodeExecAgent = selectedAgent?.executionMode === "code";
    const isReactCodeAgent = selectedAgent?.executionMode === "react-code";

    console.log("[AgentPanel] Agent detection:", {
      activeAgentForTab,
      selectedAgent: selectedAgent?.id,
      hasAttachedTools,
      toolCount: selectedAgent?.attachedTools?.length,
      executionMode: selectedAgent?.executionMode,
    });

    try {
      if (isReactCodeAgent) {
        // ReACT loop with code execution tool — agent reasons, writes code, observes, iterates
        console.log("[AgentPanel] Using agentReactCodeRun for", activeAgentForTab);
        clearCodeBlocks();
        reactCodeTurns.current[keyForTurn] = turn;
        await agentReactCodeRun({
          agentId: activeAgentForTab,
          message: requestMessage,
          history,
          streamOutput: streamOutputForTurn,
          terminalAttachment,
          ...(turn.canvas ? { canvas: turn.canvas } : {}),
          onEvent: (event) => handleReactCodeEvent(
            event,
            keyForTurn,
            streamOutputForTurn,
            turn,
            invocation,
          ),
        });
        if (reactCodeTurns.current[keyForTurn] === turn && turn.invocation === invocation) setStreaming(keyForTurn, false);
      } else if (isCodeExecAgent) {
        // Code execution agent — runs code, observes results, iterates
        console.log("[AgentPanel] Using agentCodeExecRun for", activeAgentForTab);
        clearCodeBlocks();
        await agentCodeExecRun(activeAgentForTab, userMessage, (event: CodeExecEvent) => {
          console.log("[AgentPanel] CodeExec event:", event);

          if (event.type === "code_start") {
            addCodeBlock(event.code);
          } else if (event.type === "code_result") {
            if (event.success) {
              updateLastCodeBlock({ status: "success", output: event.output });
            } else {
              updateLastCodeBlock({ status: "error", error: event.output });
            }
          } else if (event.type === "code_error") {
            updateLastCodeBlock({
              status: "retrying",
              error: event.error,
              attempt: event.attempt,
            });
          } else if (event.type === "diagram") {
            useDiagramStore.getState().addDiagram(event);
            window.dispatchEvent(new CustomEvent("ccie:open-diagram-panel"));
          } else if (event.type === "final") {
            appendToken(keyForTurn, event.response);
            setStreaming(keyForTurn, false);
          } else if (event.type === "error") {
            setError(keyForTurn, event.message);
            setStreaming(keyForTurn, false);
          }
        }, history);
        // If streaming wasn't already cleared by final/error events, clear now
        setStreaming(keyForTurn, false);
      } else if (hasAttachedTools) {
        // ReACT agent with tool catalog
        console.log("[AgentPanel] Using agentReactRun for", activeAgentForTab);
        console.log("[AgentPanel] Agent has", selectedAgent?.attachedTools?.length, "tools");
        let streamedCurrentGeneration = false;
        await agentReactRun({
          agentId: activeAgentForTab,
          message: userMessage,
          history,
          streamOutput: streamOutputForTurn,
          onEvent: (event) => {
            console.log("[AgentPanel] ReACT event:", event);

            // Map ReACT events to chat events
            if (event.type === "token") {
              appendToken(keyForTurn, event.text);
              streamedCurrentGeneration = true;
            } else if (event.type === "final") {
              if (!streamOutputForTurn || !streamedCurrentGeneration) {
                appendToken(keyForTurn, event.response);
              }
              streamedCurrentGeneration = false;
            } else if (event.type === "tool_call") {
              streamedCurrentGeneration = false;
              addMessage(keyForTurn, {
                id: `tool-${Date.now()}`,
                role: "tool_proposed",
                content: `Tool: ${event.name}`,
                timestamp: Date.now(),
                toolCallId: event.name,
                toolKind: "tool",
                toolPayload: event.args as Record<string, unknown>,
                toolAllowed: true,
                toolStatus: "done",
              });
            } else if (event.type === "tool_result") {
              streamedCurrentGeneration = false;
              // Don't append raw tool result - LLM will format it in the final response
            } else if (event.type === "thought_start") {
              // Optional: show thinking
            } else if (event.type === "error") {
              setError(keyForTurn, event.message);
            }
          },
        });
        // Mark as done
        setStreaming(keyForTurn, false);
      } else {
        // Regular chat stream
        await agentChatStream({
        tabId,
        message: userMessage,
        vendor: tabVendor,
        platform: tabPlatform,
        userTags: activeUserTags,
        onEvent: (event) => {
          if (event.type === "token") {
            appendToken(keyForTurn, event.text);
          } else if (event.type === "sources") {
            // Plan 12 Phase 5 — attach to the in-progress assistant
            // message; the chatStore handles the
            // sources-event-before-bubble race via pendingSources.
            attachSourcesToInProgress(keyForTurn, event.chunks);
            const n = event.chunks.length;
            if (n > 0) {
              setSourcesAnnouncement(
                `${n} source${n === 1 ? "" : "s"} cited`
              );
            }
          } else if (event.type === "tool_proposed") {
            addMessage(keyForTurn, {
              id: `tool-proposed-${event.tool_call_id}`,
              role: "tool_proposed",
              content: "",
              timestamp: Date.now(),
              toolCallId: event.tool_call_id,
              toolKind: event.kind,
              toolPayload: event.payload,
              toolAllowed: event.allowed,
              toolStatus: "pending",
            });
          } else if (event.type === "tool_result") {
            updateToolMessage(keyForTurn, event.tool_call_id, {
              toolStatus: "done",
            });
            addMessage(keyForTurn, {
              id: `tool-result-${event.tool_call_id}`,
              role: "tool_result",
              content: event.output_preview,
              timestamp: Date.now(),
              toolCallId: event.tool_call_id,
              exitCode: event.exit_code,
            });
            // After a tool result, the agent will produce more tokens — give it a
            // fresh assistant bubble so streaming doesn't back-fill the earlier one.
            addMessage(keyForTurn, {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: "",
              timestamp: Date.now(),
            });
          } else if (event.type === "done") {
            setStreaming(keyForTurn, false);
            // Persist the final assistant text turn (latest assistant message in bucket).
            const msgs = useChatStore.getState().messages[keyForTurn] || [];
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "assistant" && msgs[i].content.trim()) {
                // Fire-and-forget DB save; the id is new-per-session so the DB row
                // is idempotent only per-session. That's acceptable for now.
                void (async () => {
                  try {
                    const { saveAiMessage } = await import("../lib/tauri");
                    await saveAiMessage({
                      tabId: persistForTurn.tabId,
                      role: "assistant",
                      content: msgs[i].content,
                      timestamp: msgs[i].timestamp,
                      agentId: persistForTurn.agentId,
                    });
                  } catch {
                    /* ignore */
                  }
                })();
                break;
              }
            }
          } else if (event.type === "error") {
            setError(keyForTurn, event.message);
            setStreaming(keyForTurn, false);
          }
        },
      });
      } // end if/else for hasAttachedTools
    } catch (err) {
      const ownsBucket = !isReactCodeAgent || (reactCodeTurns.current[keyForTurn] === turn && turn.invocation === invocation && !turn.settled);
      if (!ownsBucket) return;
      if (!turn.settled && !turn.paused) { turn.settled = true; void saveCanvasStatus(turn, "failed"); }
      console.error("[AgentPanel] Error in handleSend:", err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[AgentPanel] Error message:", errorMsg);
      delete streamedGenerationRef.current[keyForTurn];
      setError(keyForTurn, `Agent error: ${errorMsg}`);
      setStreaming(keyForTurn, false);
    }
  };

  const handleToolApproval = async (
    toolCallId: string,
    action: "run" | "reject",
    editedPayload?: Record<string, unknown>
  ) => {
    if (!tabId || !bucketKey) return;
    updateToolMessage(bucketKey, toolCallId, {
      toolStatus: action === "run" ? "run" : "rejected",
      ...(editedPayload ? { toolPayload: editedPayload } : {}),
    });
    try {
      await agentApproveTool({ toolCallId, action, editedPayload });
    } catch (err) {
      console.error("Approval failed:", err);
      if (bucketKey) {
        setError(bucketKey, err instanceof Error ? err.message : "Approval failed");
      }
    }
  };

  const handleStop = async () => {
    if (!tabId || !bucketKey) return;
    const turn = reactCodeTurns.current[bucketKey];
    if (turn && !turn.settled) {
      turn.settled = true;
      void saveCanvasStatus(turn, "cancelled");
    }
    try {
      if (terminalLeaseId) await agentTerminalCancel(terminalLeaseId);
      await agentChatCancel(tabId);
    } catch (err) {
      console.error("Cancel failed:", err);
    }
    // Optimistically clear the streaming flag so the UI reverts to Send.
    // The backend will also emit a Done event, which is idempotent.
    setStreaming(bucketKey, false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isListening) handleSend();
    }
  };

  const handleUsePrompt = (body: string) => {
    const next = !input.trim()
      ? body
      : window.confirm("Append this saved prompt to your current draft? Cancel replaces it.")
        ? `${input.trimEnd()}\n\n${body}`
        : body;
    setInput(next);
    setPromptsOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleRetry = async () => {
    if (!tabId || !bucketKey) return;
    if (continuationThreadId) {
      const threadId = continuationThreadId;
      const turn = reactCodeTurns.current[bucketKey];
      if (turn?.settled) {
        setContinuationByBucket((current) => {
          const next = { ...current };
          delete next[bucketKey];
          return next;
        });
        return;
      }
      clearError(bucketKey);
      const invocation = turn ? ++turn.invocation : undefined;
      if (turn) turn.paused = false;
      await saveCanvasStatus(turn, "collecting");
      if (turn && (turn.settled || turn.invocation !== invocation)) return;
      setContinuationByBucket((current) => {
        const next = { ...current };
        delete next[bucketKey];
        return next;
      });
      setStreaming(bucketKey, true);
      try {
        await agentReactContinue({
          threadId,
          streamOutput: aiChatPreferences.streamLlmOutput,
          onEvent: (event) => handleReactCodeEvent(
            event,
            bucketKey,
            aiChatPreferences.streamLlmOutput,
            turn,
            invocation,
          ),
        });
      } catch (continuationError) {
        handleReactCodeEvent({ type: "error", message: continuationError instanceof Error ? continuationError.message : String(continuationError) }, bucketKey, aiChatPreferences.streamLlmOutput, turn, invocation);
      } finally {
        if (!turn || (reactCodeTurns.current[bucketKey] === turn && turn.invocation === invocation)) setStreaming(bucketKey, false);
      }
      return;
    }
    clearError(bucketKey);
    // Find the last user message and retry
    const lastUserMsg = messages
      .slice()
      .reverse()
      .find((m) => m.role === "user");
    if (lastUserMsg) {
      setInput(lastUserMsg.content);
      inputRef.current?.focus();
    }
  };

  return (
    <div className={`agent-panel ${isOpen ? "open" : "collapsed"}`}>
      {!canvasMode && <button ref={agentToggleRef} className="agent-toggle" onClick={onToggle} title="Toggle AI Chat">
        {isOpen ? "›" : "‹"}
      </button>}

      {/* IaC Phase 2 — approval gate for agent-initiated terraform/ansible applies. */}
      <ZabbixApprovalModal request={zabbixApproval?.request ?? null} onApprove={() => handleZabbixDecision("approve")} onDeny={() => handleZabbixDecision("deny")} />
      {workflowsApproval && (
        <WorkflowsApprovalModal
          request={workflowsApproval.request}
          onApprove={() => handleWorkflowsDecision("approve")}
          onDeny={() => handleWorkflowsDecision("deny")}
          returnFocusRef={canvasMode ? canvasHeadingRef : agentToggleRef}
        />
      )}
      {iacApproval && (
      <IaCApprovalModal
          request={iacApproval.request}
          onApprove={() => handleIacDecision("approve")}
          onCancel={() => handleIacDecision("deny")}
        />
      )}

      {terminalFixApproval && (
        <TerminalFixApprovalModal
          preview={terminalFixApproval.preview}
          onReviewEdit={handleTerminalReviewEdit}
          onApprove={(batch) => handleTerminalFixDecision("approve", batch)}
          onReject={() => handleTerminalFixDecision("deny")}
        />
      )}

      {isOpen && (
        <div className="agent-content">
          <div className="agent-header">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <h3 ref={canvasHeadingRef} tabIndex={canvasMode ? -1 : undefined}>{canvasMode ? "Network Architect conversation" : "AI Chat"}</h3>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  type="button"
                  className="chat-clear-btn"
                  onClick={() => setPromptsOpen((open) => !open)}
                  title="Create, edit, and reuse saved prompts"
                  aria-expanded={promptsOpen}
                  aria-controls={promptsOpen ? promptsPanelId : undefined}
                >
                  📝 Prompts
                </button>
                <button
                  type="button"
                  className="chat-clear-btn"
                  onClick={() => setHistoryOpen(true)}
                  title="Browse all past conversations"
                >
                  🕘 History
                </button>
                <button
                  type="button"
                  className="chat-clear-btn"
                  onClick={handleClearChat}
                  disabled={!tabId || messages.length === 0 || streaming}
                  title={
                    streaming
                      ? "Stop the agent before clearing"
                      : messages.length === 0
                      ? "Nothing to clear"
                      : "Clear this conversation"
                  }
                >
                  🗑 Clear
                </button>
              </div>
            </div>
            <select
              value={activeAgentForTab}
              onChange={(e) => handleAgentChange(e.target.value)}
              disabled={!tabId || canvasMode}
              title="Active agent for this tab"
              style={{
                marginTop: "6px",
                width: "100%",
                padding: "6px 8px",
                background: "var(--surface-chrome)",
                border: "1px solid var(--border-default)",
                borderRadius: "4px",
                color: "var(--text-primary)",
                fontSize: "12px",
              }}
            >
              {/* Order: Network-Architect (default) → General → Prepackaged → User Agents */}
              {agents
                .filter((a) => a.id === DEFAULT_AGENT_ID)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {agentDisplayName(a.name, a.id)}
                  </option>
                ))}
              <option value="general">General (no persona)</option>
              {(() => {
                const prepackaged = agents.filter(
                  (a) => a.id !== DEFAULT_AGENT_ID && PREPACKAGED_AGENT_IDS.has(a.id)
                );
                const userAgents = agents.filter(
                  (a) => a.id !== DEFAULT_AGENT_ID && !PREPACKAGED_AGENT_IDS.has(a.id)
                );
                return (
                  <>
                    {prepackaged.length > 0 && (
                      <optgroup label="Prepackaged">
                        {prepackaged.map((a) => (
                          <option key={a.id} value={a.id}>
                            {agentDisplayName(a.name, a.id)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {userAgents.length > 0 && (
                      <optgroup label="User Agents">
                        {userAgents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {agentDisplayName(a.name, a.id)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </>
                );
              })()}
            </select>
            {promptsOpen && <div id={promptsPanelId}><PromptLibraryManager compact onUse={handleUsePrompt} /></div>}
          </div>

          <div className="agent-messages">
            {messages.length === 0 && (
              <div className="agent-empty">
                <p>Ask a question about your terminal session.</p>
              </div>
            )}

            {messages.map((msg, msgIndex) => {
              // Render code blocks BEFORE the last assistant message
              const isLastAssistantMsg =
                msg.role === "assistant" &&
                msgIndex === messages.length - 1 &&
                codeBlocks.length > 0;
              const isEmptyAssistantMsg =
                !shouldRenderAgentMessage(msg.role, msg.content);

              return (
                <Fragment key={msg.id}>
                  {isLastAssistantMsg && (
                    <div className="agent-code-blocks">
                      {codeBlocks.map((block) => (
                        <CodeBlock
                          key={block.id}
                          code={block.code}
                          collapsed={block.collapsed}
                          status={block.status}
                          output={block.output}
                          error={block.error}
                          attempt={block.attempt}
                        />
                      ))}
                    </div>
                  )}

                  {msg.role === "tool_proposed" ? (
                    <ToolProposalCard
                      key={msg.id}
                      message={msg}
                      onApprove={handleToolApproval}
                    />
                  ) : msg.role === "tool_result" ? (
                    <div key={msg.id} className="agent-message tool-result">
                      <div className="tool-result-header">
                        <span className="tool-result-label">
                          Tool result
                          {msg.exitCode !== null && msg.exitCode !== undefined
                            ? ` (exit ${msg.exitCode})`
                            : ""}
                        </span>
                      </div>
                      <pre className="tool-result-body">{msg.content}</pre>
                    </div>
                  ) : isEmptyAssistantMsg ? null : (
                    <div key={msg.id} className={`agent-message ${msg.role}`}>
                      <div className="agent-message-content">
                        {msg.role === "user" ? (
                          <p>{msg.content}</p>
                        ) : (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              code(props) {
                                const { children, className, ...rest } = props;
                                const isInline = !className?.includes("language-");
                                return isInline ? (
                                  <code className={className} {...rest}>
                                    {children}
                                  </code>
                                ) : (
                                  <div className="code-block">
                                    <pre>
                                      <code className={className} {...rest}>
                                        {children}
                                      </code>
                                    </pre>
                                    <button
                                      className="copy-btn"
                                      onClick={() => {
                                        navigator.clipboard.writeText(String(children));
                                      }}
                                      title="Copy code"
                                    >
                                      Copy
                                    </button>
                                  </div>
                                );
                              },
                            }}
                          >
                            {msg.content}
                          </ReactMarkdown>
                        )}
                      </div>
                      {msg.role === "assistant" &&
                        msg.sources &&
                        msg.sources.length > 0 && (
                          <AgentSourcesBadge
                            count={msg.sources.length}
                            isOpen={openSourcesForMessageId === msg.id}
                            onOpen={(btn) => {
                              openingBadgeRef.current = btn;
                              setOpenSourcesForMessageId(msg.id);
                            }}
                          />
                        )}
                    </div>
                  )}
                </Fragment>
              );
            })}

            {terminalPlan && (
              <section className="terminal-investigation-card" aria-label="Terminal investigation plan">
                <strong>Investigation plan</strong>
                <p>{terminalPlan.objective}</p>
                <ol>{terminalPlan.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                <small>Success: {terminalPlan.success_criteria.join("; ")}</small>
              </section>
            )}

            {terminalActions.length > 0 && (
              <section className="terminal-action-list" aria-label="Terminal actions">
                {terminalActions.map((action, index) => (
                  <div className={`terminal-action-card ${action.status}`} key={`${action.command}-${index}`}>
                    <span>{action.status === "running" ? "Running" : action.status === "success" ? "Passed" : "Stopped"}</span>
                    <code>{action.command}</code>
                    <small>{action.purpose}</small>
                  </div>
                ))}
              </section>
            )}

            {streaming && (
              <AgentWorkingIndicator />
            )}
            {awaitingCheckpoint && <p role="status">Awaiting approval or continuation for this conversation.</p>}

            {canvasWorkspace?.save.error && <p role="status">Canvas save failed: {canvasWorkspace.save.error}. Network execution was not changed.{canvasWorkspace.save.unsavedCardIds.length > 0 ? ` ${canvasWorkspace.save.unsavedCardIds.length} cards are not saved.` : ""}</p>}
            {canvasWorkspace?.limitations.map((notice, index) => <p role="status" key={`${notice.run_id}-${index}`}>{notice.limitation}</p>)}

            {error && (
              <div className="agent-error">
                <p>Error: {error}</p>
                <button onClick={handleRetry}>
                  {continuationThreadId ? "Continue from last step" : "Retry"}
                </button>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className="agent-dictation-status" role="status" aria-live="polite">
            {dictationStatus}
          </div>
          {canvasWorkspace && canvasWorkspace.selection.attachedCardIds.length > 0 && <div aria-label="Attached Canvas evidence">
            {canvasWorkspace.selection.attachedCardIds.map(id => {
              const title = canvasWorkspace.cards.find(card => card.card_id === id)?.title ?? id;
              return <button type="button" key={id} aria-label={`Remove attached evidence ${title}`} onClick={() => {
                const current = useCopilotCanvas.getState().workspaces[canvasWorkspace.tab.id];
                useCopilotCanvas.getState().setSelection(canvasWorkspace.tab.id, { attachedCardIds: current.selection.attachedCardIds.filter(cardId => cardId !== id) });
              }}>{title} — Remove</button>;
            })}
          </div>}
          <form className="agent-input" onSubmit={handleSend} aria-busy={awaitingCanvasHistory}>
            {activeAgentForTab === "network-architect" && (
              <button
                type="button"
                className={`terminal-attach-chip ${terminalAttachRequested ? "active" : ""}`}
                aria-pressed={terminalAttachRequested}
                onClick={() => setTerminalAttachRequested((current) => !current)}
                disabled={streaming || awaitingCheckpoint || !tabId}
                title="Allow Network Architect to use the focused verified SSH terminal for this turn"
              >
                {terminalAttachRequested ? "Terminal attached" : "Attach terminal"}
              </button>
            )}
            <button
              type="button"
              className={`mic-btn ${isListening ? "listening" : ""}`}
              aria-label={isListening ? "Stop voice dictation" : "Start voice dictation"}
              aria-pressed={isListening}
              onClick={handleDictationToggle}
              disabled={streaming || awaitingCheckpoint || !tabId}
              title="Dictate into the agent message"
            >
              🎙
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your terminal..."
              disabled={streaming || awaitingCheckpoint || !tabId}
              readOnly={isListening}
              rows={2}
            />
            {streaming ? (
              <button
                type="button"
                className="stop-btn"
                onClick={handleStop}
                title="Stop the agent"
              >
                ■ Stop
              </button>
            ) : (
              <button type="submit" disabled={!input.trim() || !tabId || isListening || awaitingCheckpoint || awaitingCanvasHistory} title={awaitingCanvasHistory ? "Loading saved conversation…" : undefined}>
                Send
              </button>
            )}
          </form>
        </div>
      )}
      <ChatHistoryBrowser
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
      />
      {/* Plan 12 Phase 5 — single drawer instance bound to the
          currently-open message's sources. */}
      {(() => {
        const openMsg = openSourcesForMessageId
          ? messages.find((m) => m.id === openSourcesForMessageId)
          : undefined;
        return (
          <AgentSourcesDrawer
            open={openSourcesForMessageId !== null}
            sources={openMsg?.sources ?? []}
            tabId={tabId}
            onClose={() => {
              setOpenSourcesForMessageId(null);
              // Restore focus to the opening badge per design spec §6 #1.
              if (openingBadgeRef.current) {
                openingBadgeRef.current.focus();
              }
            }}
          />
        );
      })()}
      {/* Aria-live region for "N sources cited" announcements. */}
      <div
        role="status"
        aria-live="polite"
        className="sr-only"
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          margin: "-1px",
          padding: 0,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          border: 0,
        }}
      >
        {sourcesAnnouncement}
      </div>
    </div>
  );
}

// ===========================================================================
// ToolProposalCard — inline approval UI for shell/MCP tool calls
// ===========================================================================

function ToolProposalCard({
  message,
  onApprove,
}: {
  message: import("../state/chatStore").Message;
  onApprove: (
    toolCallId: string,
    action: "run" | "reject",
    editedPayload?: Record<string, unknown>
  ) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState<string>(
    message.toolKind === "shell"
      ? String((message.toolPayload as Record<string, unknown>)?.cmd ?? "")
      : JSON.stringify(message.toolPayload ?? {}, null, 2)
  );
  const status = message.toolStatus ?? "pending";
  const isShell = message.toolKind === "shell";
  const isTool = message.toolKind === "tool"; // ReACT API tool
  const payload = message.toolPayload ?? {};
  const cmdPreview = isShell
    ? String((payload as Record<string, unknown>).cmd ?? "")
    : isTool
    ? message.toolCallId || "API Tool" // Use tool name for ReACT tools
    : `${(payload as Record<string, unknown>).server}.${
        (payload as Record<string, unknown>).tool
      }`;
  const reason =
    (payload as Record<string, unknown>).reason ||
    (payload as Record<string, unknown>).why ||
    "";
  const isPending = status === "pending";

  const handleRun = () => {
    if (!message.toolCallId) return;
    // Always send a concrete payload — Rust's execute_shell_tool reads cmd from it.
    const effectivePayload = editing
      ? isShell
        ? { ...(payload as Record<string, unknown>), cmd: editedText }
        : safeParseJSON(editedText, payload as Record<string, unknown>)
      : (payload as Record<string, unknown>);
    onApprove(message.toolCallId, "run", effectivePayload);
  };
  const handleReject = () => {
    if (!message.toolCallId) return;
    onApprove(message.toolCallId, "reject");
  };

  return (
    <div
      className={`tool-proposal ${status} ${isPending && !message.toolAllowed ? "warn" : ""}`}
    >
      <div className="tool-proposal-header">
        <span className="tool-proposal-kind">
          {isShell ? "🖥 Shell command" : isTool ? `🔧 Tool: ${cmdPreview}` : `🔌 MCP: ${cmdPreview}`}
        </span>
        {isPending && !message.toolAllowed && (
          <span
            className="tool-proposal-warn"
            title="This command is not on the agent's allowlist"
          >
            ⚠ not in allowlist
          </span>
        )}
      </div>

      {editing && isShell ? (
        <input
          type="text"
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          className="tool-proposal-edit-input"
        />
      ) : editing && !isShell ? (
        <textarea
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          rows={6}
          className="tool-proposal-edit-input"
        />
      ) : (
        <pre className="tool-proposal-cmd">{cmdPreview}</pre>
      )}

      {reason && !editing && (
        <p className="tool-proposal-reason">
          <span className="muted">Reason:</span> {String(reason)}
        </p>
      )}

      {isPending && (
        <div className="tool-proposal-actions">
          <button className="primary" onClick={handleRun}>
            {editing ? "Run edited" : "Run"}
          </button>
          <button className="secondary" onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel edit" : "Edit"}
          </button>
          <button className="secondary" onClick={handleReject}>
            Reject
          </button>
        </div>
      )}
      {!isPending && (
        <div className="tool-proposal-status muted">
          {status === "run" && "Running…"}
          {status === "done" && "✓ Done"}
          {status === "rejected" && "✗ Rejected"}
        </div>
      )}
    </div>
  );
}

function safeParseJSON(
  s: string,
  fallback: Record<string, unknown>
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
}
