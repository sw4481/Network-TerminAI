import { getAllLeafPanes, type PaneNode } from "../state/panesStore";
import type { TerminalConnectionState } from "../state/terminalConnectionStore";

export type TerminalAttachment = {
  backendPtyId: string;
  terminalId: string;
  source: "saved_ssh" | "manual_ssh";
  connectionId?: string;
  displayName?: string;
  vendor?: string;
  platform?: string;
};

export function parseTerminalAttachmentRequest(
  input: string,
  chipEnabled: boolean,
): { message: string; requested: boolean } {
  const prefix = /^\/terminal(?:\s+|$)/i;
  const prefixed = prefix.test(input);
  return {
    message: prefixed ? input.replace(prefix, "").trim() : input.trim(),
    requested: chipEnabled || prefixed,
  };
}

export function resolveTerminalAttachment(args: {
  agentId: string;
  requested: boolean;
  focusedPaneId: string | null;
  layout: PaneNode | undefined;
  connectionsByTerminalId: Record<string, TerminalConnectionState>;
  backendPtyIdFor: (terminalId: string) => string | null;
}): TerminalAttachment | null {
  if (!args.requested || args.agentId !== "network-architect") return null;
  if (!args.focusedPaneId || !args.layout) {
    throw new Error("Attach Terminal requires a focused terminal pane.");
  }

  const pane = getAllLeafPanes(args.layout).find((leaf) => leaf.id === args.focusedPaneId);
  if (!pane) throw new Error("The focused terminal pane is no longer available.");

  const connection = args.connectionsByTerminalId[pane.terminalId];
  if (connection && connection.lifecycle !== "connected") {
    throw new Error("Attach Terminal requires a connected SSH terminal.");
  }

  const backendPtyId = args.backendPtyIdFor(pane.terminalId);
  if (!backendPtyId) throw new Error("The focused terminal has no active backend PTY.");

  if (!connection) {
    return {
      backendPtyId,
      terminalId: pane.terminalId,
      source: "manual_ssh",
    };
  }

  return {
    backendPtyId,
    terminalId: pane.terminalId,
    source: "saved_ssh",
    connectionId: connection.connection_id,
    displayName: connection.display_name,
    vendor: connection.vendor,
    platform: connection.platform,
  };
}
