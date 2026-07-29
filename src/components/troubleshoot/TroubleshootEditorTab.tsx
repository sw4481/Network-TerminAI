/**
 * Plan 15 Phase 6 — Host page for the playbook editor surface.
 *
 * Sits alongside `TroubleshootTab` so the Monaco editor never has to
 * mount inside the troubleshoot run page (keeps the hot path lean).
 * Wired via App.tsx + the `menu:troubleshoot_editor` event.
 */
import { PlaybookEditor } from "../../features/troubleshoot/PlaybookEditor";

export interface TroubleshootEditorTabProps {
  tabId: string;
  /** Optional id pre-selected via deep link; null = blank. */
  initialPlaybookId?: string | null;
}

export function TroubleshootEditorTab({
  tabId,
  initialPlaybookId = null,
}: TroubleshootEditorTabProps) {
  return (
    <div
      data-testid="troubleshoot-editor-tab"
      data-tab-id={tabId}
      style={{ height: "100%", display: "flex", flexDirection: "column" }}
    >
      <PlaybookEditor initialPlaybookId={initialPlaybookId} />
    </div>
  );
}
