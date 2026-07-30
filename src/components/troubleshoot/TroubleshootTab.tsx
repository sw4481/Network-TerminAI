/**
 * Plan 15 Phase 4 — TroubleshootTab.
 *
 * Top-level page that orchestrates the picker / canvas / narration
 * panel / control bar / awaiting-user modal / conclusion banner.
 *
 * This component owns the four `troubleshoot:*` Tauri event listeners
 * and forwards each event into the Zustand store. The pattern matches
 * `RecordingsTab` and `TopologyTab` — there is no central event bus,
 * each tab subscribes/teardowns on mount/unmount.
 */
import { useEffect } from "react";
import { listen, emit } from "@tauri-apps/api/event";

import { ControlBar } from "../../features/troubleshoot/ControlBar";
import { TreeCanvas } from "../../features/troubleshoot/TreeCanvas";
import { NarrationPanel } from "../../features/troubleshoot/NarrationPanel";
import { ConclusionBanner } from "../../features/troubleshoot/ConclusionBanner";
import { AwaitingUserModal } from "../../features/troubleshoot/AwaitingUserModal";
import { PlaybookPicker } from "../../features/troubleshoot/PlaybookPicker";
import { useTroubleshootStore } from "../../features/troubleshoot/store";
import type {
  ConclusionEvent,
  NarrationEvent,
  StatusEvent,
  StepUpdateEvent,
  UserPromptEvent,
} from "../../features/troubleshoot/api";
import "./TroubleshootTab.css";

export interface TroubleshootTabProps {
  tabId: string;
}

export function TroubleshootTab({ tabId }: TroubleshootTabProps) {
  const applyStepEvent = useTroubleshootStore((s) => s.applyStepEvent);
  const applyStatusEvent = useTroubleshootStore((s) => s.applyStatusEvent);
  const applyNarrationEvent = useTroubleshootStore(
    (s) => s.applyNarrationEvent,
  );
  const applyConclusionEvent = useTroubleshootStore(
    (s) => s.applyConclusionEvent,
  );
  const applyUserPromptEvent = useTroubleshootStore(
    (s) => s.applyUserPromptEvent,
  );

  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(
      listen<StepUpdateEvent>("troubleshoot:step_update", (e) =>
        applyStepEvent(e.payload),
      ),
    );
    unlistens.push(
      listen<StatusEvent>("troubleshoot:status", (e) =>
        applyStatusEvent(e.payload),
      ),
    );
    unlistens.push(
      listen<NarrationEvent>("troubleshoot:narration", (e) =>
        applyNarrationEvent(e.payload),
      ),
    );
    unlistens.push(
      listen<ConclusionEvent>("troubleshoot:conclusion", (e) =>
        applyConclusionEvent(e.payload),
      ),
    );
    unlistens.push(
      listen<UserPromptEvent>("troubleshoot:user_prompt", (e) =>
        applyUserPromptEvent(e.payload),
      ),
    );

    return () => {
      unlistens.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [
    applyStepEvent,
    applyStatusEvent,
    applyNarrationEvent,
    applyConclusionEvent,
    applyUserPromptEvent,
  ]);

  return (
    <div
      className="troubleshoot-tab"
      data-testid="troubleshoot-tab"
      data-tab-id={tabId}
    >
      <ControlBar />
      <ConclusionBanner />
      <div
        style={{
          padding: "6px 12px",
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={() => {
            emit("menu:troubleshoot_editor").catch((err) =>
              console.error("[TroubleshootTab] Failed to emit editor event:", err),
            );
          }}
          data-testid="tb-tab-open-editor"
          style={{
            background: "var(--surface-2)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: "4px 10px",
            fontSize: 11,
            cursor: "pointer",
          }}
          title="Edit playbooks (Plan 15 Phase 6)"
        >
          Edit Playbooks
        </button>
      </div>
      <div className="troubleshoot-tab__body">
        <PlaybookPicker tabId={tabId} />
        <TreeCanvas />
        <NarrationPanel />
      </div>
      <AwaitingUserModal />
    </div>
  );
}
