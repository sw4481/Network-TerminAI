import { invoke } from "@tauri-apps/api/core";

export type Tier = "T0" | "T1" | "T2" | "T3" | "Ambiguous";

export interface ClassifyResponse {
  tier: Tier;
  rule_id: string | null;
  reasoning: string;
}

export interface GuardrailRule {
  id: string;
  name: string;
  vendor: string;
  platform: string;
  pattern_regex: string;
  tier: number;
  reason: string;
  enabled: boolean;
  builtin: boolean;
}

export interface DecisionRow {
  id: string;
  session_id: string;
  command: string;
  tier: number;
  rule_id: string | null;
  decision: string;
  user_action: string | null;
  reasoning: string;
  decided_at: number;
}

export interface TestRegexResult {
  matched: boolean;
  error: string | null;
}

export interface ImportReport {
  imported: number;
  skipped_builtin: number;
  errors: string[];
}

export interface ImpactSummary {
  affected_neighbors: string[];
  affected_prefixes: string[];
  notes: string[];
  topology_available: boolean;
}

export const classifyCommand = (vendor: string, platform: string, command: string) =>
  invoke<ClassifyResponse>("guardrail_classify", {
    args: { vendor, platform, command },
  });

export const recordDecision = (args: {
  sessionId: string;
  command: string;
  tier: number;
  ruleId: string | null;
  decision: string;
  userAction: string | null;
  reasoning: string;
}) =>
  invoke<string>("guardrail_record_decision", {
    args: {
      session_id: args.sessionId,
      command: args.command,
      tier: args.tier,
      rule_id: args.ruleId,
      decision: args.decision,
      user_action: args.userAction,
      reasoning: args.reasoning,
    },
  });

export const decisionsList = (params: {
  sessionId?: string | null;
  limit?: number;
  offset?: number;
}) =>
  invoke<DecisionRow[]>("guardrail_decisions_list", {
    sessionId: params.sessionId ?? null,
    limit: params.limit ?? 200,
    offset: params.offset ?? 0,
  });

export const rulesList = () => invoke<GuardrailRule[]>("guardrail_rules_list");

export const ruleUpsert = (rule: GuardrailRule) =>
  invoke<string>("guardrail_rule_upsert", { rule });

export const ruleDelete = (id: string) =>
  invoke<void>("guardrail_rule_delete", { id });

export const ruleSetEnabled = (id: string, enabled: boolean) =>
  invoke<void>("guardrail_rule_set_enabled", { id, enabled });

export const rulesetReload = () =>
  invoke<number>("guardrail_ruleset_reload");

export const testRegex = (pattern: string, input: string) =>
  invoke<TestRegexResult>("guardrail_test_regex", { pattern, input });

export const rulesExport = () => invoke<string>("guardrail_rules_export");

export const rulesImport = (json: string) =>
  invoke<ImportReport>("guardrail_rules_import", { json });

export const impactSummary = (vendor: string, platform: string, command: string) =>
  invoke<ImpactSummary>("guardrail_impact_summary", { vendor, platform, command });

export const secondOpinion = (vendor: string, platform: string, command: string) =>
  invoke<{ tier: Tier; reasoning: string }>("guardrail_second_opinion", {
    vendor,
    platform,
    command,
  });

/** CSV export helper for the audit log viewer. Pure function, no DOM. */
export function decisionsToCsv(rows: DecisionRow[]): string {
  const header = [
    "id",
    "session_id",
    "command",
    "tier",
    "rule_id",
    "decision",
    "user_action",
    "reasoning",
    "decided_at",
  ];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.session_id,
        r.command,
        r.tier,
        r.rule_id ?? "",
        r.decision,
        r.user_action ?? "",
        r.reasoning,
        new Date(r.decided_at * 1000).toISOString(),
      ]
        .map(escape)
        .join(","),
    );
  }
  return lines.join("\n");
}

/**
 * Classify a command and, if Tier 0, record an auto-approval decision in
 * one round-trip. Returns the classification so callers can decide what
 * to do next (proceed for T0, raise modal for T1+/Ambiguous).
 */
export async function classifyAndAutoApprove(args: {
  vendor: string;
  platform: string;
  command: string;
  sessionId: string;
}): Promise<ClassifyResponse> {
  const result = await classifyCommand(args.vendor, args.platform, args.command);
  if (result.tier === "T0") {
    await recordDecision({
      sessionId: args.sessionId,
      command: args.command,
      tier: 0,
      ruleId: result.rule_id,
      decision: "auto_approved",
      userAction: "proceed",
      reasoning: result.reasoning,
    });
  }
  return result;
}

/**
 * Heuristic to determine whether an RPC payload represents a CLI-wrapped
 * command (and should be classified) or a pure NETCONF read (which should
 * short-circuit to T0 without even calling the classifier).
 */
export function isPureNetconfRead(rpcXml: string): boolean {
  const lower = rpcXml.toLowerCase();
  if (lower.includes("<exec-command")) return false; // CLI wrapper
  if (lower.includes("<edit-config")) return false;
  if (lower.includes("<copy-config")) return false;
  if (lower.includes("<delete-config")) return false;
  if (lower.includes("<commit")) return false;
  if (
    lower.includes("<get-config") ||
    lower.includes("<get/>") ||
    lower.includes("<get>") ||
    lower.includes("<get ")
  ) {
    return true;
  }
  return false;
}
