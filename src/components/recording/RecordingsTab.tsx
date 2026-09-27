import { useEffect, useState } from "react";
import { useRecordings } from "../../state/recordingStore";
import { useTabs } from "../../state/tabsStore";
import type { RecordingDto } from "../../lib/recording";
import "./RecordingsTab.css";

function fmtDuration(ms: number): string {
  if (!ms) return "0s";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const KIND_ICONS: Record<string, string> = {
  local: "💻",
  ssh: "🔐",
  netconf: "⚙",
  sidecar: "🐍",
};

export function RecordingsTab() {
  const { list, refreshList, remove } = useRecordings();
  const { addTab } = useTabs();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const onPlay = (rec: RecordingDto) => {
    const tab = {
      id: crypto.randomUUID(),
      title: `Replay · ${new Date(rec.startedAt * 1000).toLocaleTimeString()}`,
      shell_cmd: "",
      cwd: "/",
      created_at: Math.floor(Date.now() / 1000),
      tab_type: "recording-player" as const,
      recordingId: rec.id,
    };
    addTab(tab);
  };

  const onDelete = async (rec: RecordingDto) => {
    if (confirmDeleteId !== rec.id) {
      setConfirmDeleteId(rec.id);
      setTimeout(() => setConfirmDeleteId(null), 4000);
      return;
    }
    setConfirmDeleteId(null);
    await remove(rec.id);
  };

  const showExportError = async (kind: string, error: unknown) => {
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(`Unable to export recording ${kind}: ${String(error)}`, {
      title: "Recording export failed",
      kind: "error",
    });
  };

  const onExportCast = async (rec: RecordingDto) => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: `recording-${rec.id}.cast`,
      filters: [{ name: "asciinema cast", extensions: ["cast"] }],
    });
    if (!path) return;
    const { recording } = await import("../../lib/recording");
    try {
      await recording.export(rec.id, path as string);
    } catch (error) {
      await showExportError("cast", error);
    }
  };

  const onExportText = async (rec: RecordingDto) => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: `recording-${rec.id}.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!path) return;
    const { recording } = await import("../../lib/recording");
    try {
      await recording.exportText(rec.id, path as string);
    } catch (error) {
      await showExportError("text", error);
    }
  };

  return (
    <div className="recordings-tab" data-testid="recordings-tab">
      <div className="recordings-header">
        <h2>Recordings</h2>
        <button className="rec-btn" onClick={() => void refreshList()}>
          Refresh
        </button>
      </div>
      {list.length === 0 ? (
        <div className="recordings-empty">
          Enable recording on a terminal tab to start capturing sessions.
          <br />
          <code>⌘⇧R</code> toggles recording for the active tab.
        </div>
      ) : (
        <ul className="recordings-list">
          {list.map((r) => (
            <li
              key={r.id}
              className="recording-item"
              data-testid={`recording-${r.id}`}
            >
              <span className="rec-kind" aria-hidden>
                {KIND_ICONS[r.sessionKind] ?? "•"}
              </span>
              <div className="rec-body">
                <span className="rec-title">
                  {new Date(r.startedAt * 1000).toLocaleString()}
                  {!r.endedAt && (
                    <span className="rec-live"> · LIVE</span>
                  )}
                </span>
                <span className="rec-meta">
                  {r.sessionKind} · {fmtDuration(r.durationMs)} · {fmtBytes(r.sizeBytes)}
                </span>
              </div>
              <div className="rec-actions">
                <button
                  className="rec-btn"
                  onClick={() => onPlay(r)}
                  disabled={!r.endedAt}
                  data-testid={`recording-play-${r.id}`}
                >
                  Play
                </button>
                <button
                  className="rec-btn"
                  onClick={() => void onExportCast(r)}
                  disabled={!r.endedAt}
                  data-testid={`recording-cast-${r.id}`}
                >
                  Cast
                </button>
                <button
                  className="rec-btn"
                  onClick={() => void onExportText(r)}
                  disabled={!r.endedAt}
                  data-testid={`recording-text-${r.id}`}
                >
                  Text
                </button>
                <button
                  className={`rec-btn ${
                    confirmDeleteId === r.id ? "rec-btn-danger" : ""
                  }`}
                  onClick={() => void onDelete(r)}
                >
                  {confirmDeleteId === r.id ? "Confirm?" : "Delete"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
