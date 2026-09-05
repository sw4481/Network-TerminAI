import type { ClassifyResponse, recordDecision } from "../../lib/guardrails";
import type { PendingDecision } from "../../state/guardrailsStore";
import type { TerminalConnectionState } from "../../state/terminalConnectionStore";

export interface CiscoSelectionTarget {
  terminalId: string;
  backendPtyId: string;
  displayName: string;
  vendor: "cisco";
  platform: string;
}

interface TerminalConnectionSnapshot {
  byTerminalId: Record<string, TerminalConnectionState>;
}

type ApprovalRequest = Omit<PendingDecision, "resolver">;
type RecordDecision = typeof recordDecision;

export interface SendSelectionToCiscoArgs {
  selection: string;
  target: CiscoSelectionTarget;
  sessionId: string;
  classify: (
    vendor: string,
    platform: string,
    command: string,
  ) => Promise<ClassifyResponse>;
  record: RecordDecision;
  write: (backendPtyId: string, data: Uint8Array) => Promise<unknown>;
  approve: (request: ApprovalRequest) => Promise<"proceed" | "cancel">;
  getCurrentTarget: (terminalId: string) => TerminalConnectionState | null;
}

let nextPendingId = 1;

export function listConnectedCiscoTargets(
  state: TerminalConnectionSnapshot,
): CiscoSelectionTarget[] {
  return Object.values(state.byTerminalId)
    .filter(
      (connection) =>
        connection.vendor === "cisco" &&
        connection.lifecycle === "connected" &&
        connection.backend_pty_id.trim().length > 0,
    )
    .map((connection) => ({
      terminalId: connection.terminal_id,
      backendPtyId: connection.backend_pty_id,
      displayName: connection.display_name,
      vendor: "cisco" as const,
      platform: connection.platform,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function sendSelectionToCisco(
  args: SendSelectionToCiscoArgs,
): Promise<"sent" | "cancelled"> {
  const commands = args.selection.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
  if (commands.length === 0) return "cancelled";

  try {
    const classified: Array<{ command: string; result: ClassifyResponse }> = [];
    for (const command of commands) {
      classified.push({
        command,
        result: await args.classify(args.target.vendor, args.target.platform, command),
      });
    }

    for (const { command, result } of classified) {
      if (result.tier === "T0") continue;
      const action = await args.approve({
        pendingId: `cisco-selection-${nextPendingId++}`,
        tier: result.tier,
        command,
        reasoning: result.reasoning,
        vendor: args.target.vendor,
        platform: args.target.platform,
        sessionId: args.sessionId,
        ruleId: result.rule_id,
      });
      if (action === "cancel") return "cancelled";
    }

    for (const { command, result } of classified) {
      if (result.tier !== "T0") continue;
      await args.record({
        sessionId: args.sessionId,
        command,
        tier: 0,
        ruleId: result.rule_id,
        decision: "auto_approved",
        userAction: "proceed",
        reasoning: result.reasoning,
      });
    }

    const current = args.getCurrentTarget(args.target.terminalId);
    if (
      current?.terminal_id !== args.target.terminalId ||
      current.backend_pty_id !== args.target.backendPtyId ||
      current.lifecycle !== "connected" ||
      current.vendor !== "cisco"
    ) {
      return "cancelled";
    }

    await args.write(args.target.backendPtyId, new TextEncoder().encode(args.selection));
    return "sent";
  } catch {
    return "cancelled";
  }
}
