import type { RunStatus } from "../../lib/runnableNotebook";

interface Props {
  status: RunStatus | "idle";
  canResumeFromFailure: boolean;
  onRun: () => void;
  onStop: () => void;
  onResume: () => void;
}

export function NotebookToolbar({
  status,
  canResumeFromFailure,
  onRun,
  onStop,
  onResume,
}: Props) {
  const isRunning = status === "running" || status === "paused";
  return (
    <div className="notebook-toolbar" role="toolbar" aria-label="Notebook controls">
      <button
        type="button"
        className="toolbar-btn primary"
        onClick={onRun}
        disabled={isRunning}
        data-testid="toolbar-run"
        aria-label="Run notebook"
      >
        ▶ Run
      </button>
      <button
        type="button"
        className="toolbar-btn"
        onClick={onStop}
        disabled={!isRunning}
        data-testid="toolbar-stop"
        aria-label="Stop run"
      >
        ■ Stop
      </button>
      <button
        type="button"
        className="toolbar-btn"
        onClick={onResume}
        disabled={!canResumeFromFailure && status !== "paused"}
        data-testid="toolbar-resume"
        aria-label="Resume from failure"
      >
        ↺ Resume
      </button>
    </div>
  );
}
