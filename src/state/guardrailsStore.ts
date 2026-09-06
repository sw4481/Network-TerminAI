import { create } from "zustand";
import type { Tier } from "../lib/guardrails";
import { recordDecision } from "../lib/guardrails";

export interface PendingDecision {
  pendingId: string;
  tier: Exclude<Tier, "T0">;
  command: string;
  reasoning: string;
  vendor: string;
  platform: string;
  sessionId: string;
  ruleId: string | null;
  /**
   * Resolved by the modal layer: `proceed` -> caller goes ahead; `cancel`
   * -> caller aborts. The Promise returned by `enqueueAndAwait` resolves
   * after the choice is audited; an audit failure resolves as `cancel`.
   */
  resolver: (action: "proceed" | "cancel") => void;
}

interface GuardrailsState {
  pending: PendingDecision[];
  /** Push a new pending decision and return a Promise that resolves once
   *  the user has chosen proceed/cancel. The audit row is written on
   *  proceed automatically. */
  enqueueAndAwait: (
    p: Omit<PendingDecision, "resolver">,
  ) => Promise<"proceed" | "cancel">;
  /** Pop the front pending decision off the queue (called by the modal
   *  after it has invoked the resolver). */
  shift: () => void;
  /** Resolve the front pending decision with the given action and write
   *  the audit row. */
  resolve: (action: "proceed" | "cancel") => Promise<void>;
}

const tierToInt: Record<Exclude<Tier, "T0">, number> = {
  T1: 1,
  T2: 2,
  T3: 3,
  Ambiguous: 1,
};

export const useGuardrailsStore = create<GuardrailsState>((set, get) => ({
  pending: [],
  enqueueAndAwait: (p) =>
    new Promise<"proceed" | "cancel">((resolve) => {
      const entry: PendingDecision = { ...p, resolver: resolve };
      set((s) => ({ pending: [...s.pending, entry] }));
    }),
  shift: () =>
    set((s) => ({
      pending: s.pending.slice(1),
    })),
  resolve: async (action) => {
    const head = get().pending[0];
    if (!head) return;
    const decisionLabel = mapDecisionLabel(head.tier, action);
    let resolution = action;
    try {
      await recordDecision({
        sessionId: head.sessionId,
        command: head.command,
        tier: tierToInt[head.tier],
        ruleId: head.ruleId,
        decision: decisionLabel,
        userAction: action,
        reasoning: head.reasoning,
      });
    } catch (e) {
      console.warn("guardrails: failed to record decision", e);
      resolution = "cancel";
    }
    head.resolver(resolution);
    get().shift();
  },
}));

function mapDecisionLabel(tier: Exclude<Tier, "T0">, action: "proceed" | "cancel"): string {
  if (action === "cancel") return "denied";
  switch (tier) {
    case "T1":
      return "confirmed";
    case "T2":
      return "typed_confirmed";
    case "T3":
      return "admin_override";
    case "Ambiguous":
      return "ambiguous";
  }
}
