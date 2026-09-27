import { useGuardrailsStore } from "../../state/guardrailsStore";
import { OneClickModal } from "./OneClickModal";
import { TypedConfirmModal } from "./TypedConfirmModal";
import { MaintenanceWindowModal } from "./MaintenanceWindowModal";

/**
 * Single mount point that renders the appropriate modal for the head of
 * the pending-decision queue. Mounted once at the top of the React tree
 * (in `App.tsx`) so any code path can `enqueueAndAwait` and the user
 * resolves it via the same surface.
 *
 * Tier 0 commands never reach this host — they auto-approve in
 * `classifyAndAutoApprove` and trigger a `<ToastAutoApproved>` at the
 * call site (e.g., the agent panel).
 */
export function BlastRadiusHost() {
  const head = useGuardrailsStore((s) => s.pending[0] ?? null);
  const resolve = useGuardrailsStore((s) => s.resolve);

  if (!head) return null;

  switch (head.tier) {
    case "T1":
      return (
        <OneClickModal
          command={head.command}
          reasoning={head.reasoning}
          vendor={head.vendor}
          platform={head.platform}
          onProceed={() => resolve("proceed")}
          onCancel={() => resolve("cancel")}
        />
      );
    case "T2":
    case "Ambiguous":
      return (
        <TypedConfirmModal
          command={head.command}
          reasoning={head.reasoning}
          vendor={head.vendor}
          platform={head.platform}
          tier={head.tier}
          onProceed={() => resolve("proceed")}
          onCancel={() => resolve("cancel")}
        />
      );
    case "T3":
      return (
        <MaintenanceWindowModal
          command={head.command}
          reasoning={head.reasoning}
          vendor={head.vendor}
          platform={head.platform}
          onProceed={() => resolve("proceed")}
          onCancel={() => resolve("cancel")}
        />
      );
    default:
      return null;
  }
}
