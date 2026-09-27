/**
 * Helpers for the "Ask AI about selected code" feature.
 *
 * Fires the same `ccie:prefill-agent-input` custom event the API panel uses
 * (see src/components/api/PipeMenu.tsx:195). AgentPanel listens for it in
 * src/components/AgentPanel.tsx:234 and prefills its input with `message`,
 * routed to the right tab + agent bucket.
 */

export type AskAiAction = "explain" | "fix" | "refactor" | "ask";

type PromptContext = {
  selection: string;
  language: string;
  filePath: string | null;
};

type PromptBuilder = (ctx: PromptContext) => string;

const TEMPLATES: Record<AskAiAction, PromptBuilder> = {
  explain: ({ selection, language, filePath }) =>
    [
      "Explain what this code does, step by step. Mention any non-obvious behavior or edge cases.",
      filePath ? `File: \`${filePath}\`` : null,
      codeBlock(selection, language),
    ]
      .filter(Boolean)
      .join("\n\n"),

  fix: ({ selection, language, filePath }) =>
    [
      "Find and fix any bugs or errors in this code. Show the corrected version and explain each change.",
      filePath ? `File: \`${filePath}\`` : null,
      codeBlock(selection, language),
    ]
      .filter(Boolean)
      .join("\n\n"),

  refactor: ({ selection, language, filePath }) =>
    [
      "Refactor this code for clarity and idiomatic style. Preserve behavior. Explain the changes.",
      filePath ? `File: \`${filePath}\`` : null,
      codeBlock(selection, language),
    ]
      .filter(Boolean)
      .join("\n\n"),

  // "Custom ask" leaves the user to write the question; we just include the
  // code block so they don't have to paste it themselves.
  ask: ({ selection, language, filePath }) =>
    [
      filePath ? `Context from \`${filePath}\`:` : "Context:",
      codeBlock(selection, language),
    ].join("\n\n"),
};

export const ACTION_LABELS: Record<AskAiAction, string> = {
  explain: "Ask AI: Explain",
  fix: "Ask AI: Fix",
  refactor: "Ask AI: Refactor",
  ask: "Ask AI…",
};

export type DispatchAskAiArgs = {
  tabId: string;
  action: AskAiAction;
  selection: string;
  language: string;
  filePath: string | null;
  agentId?: string;
};

export function dispatchAskAi(args: DispatchAskAiArgs): void {
  const { tabId, action, selection, language, filePath, agentId } = args;
  if (!selection.trim()) return;

  const message = TEMPLATES[action]({ selection, language, filePath });
  const event = new CustomEvent("ccie:prefill-agent-input", {
    detail: {
      tabId,
      agentId: agentId ?? "general",
      message,
    },
  });
  window.dispatchEvent(event);
}

function codeBlock(code: string, language: string): string {
  // Monaco emits "plaintext" for unknown types; strip it so the block renders
  // clean in the chat.
  const fence = language && language !== "plaintext" ? language : "";
  return `\`\`\`${fence}\n${code}\n\`\`\``;
}
