import type { ChangeSnapshot } from "../lib/changeVerify";
import "./PreCheckRunner.css";

interface PreCheckRunnerProps {
  running: boolean;
  snapshot: ChangeSnapshot | null;
  onRun: () => void;
  onStartChange: () => void;
}

export function PreCheckRunner({
  running,
  snapshot,
  onRun,
  onStartChange,
}: PreCheckRunnerProps) {
  if (snapshot) {
    return (
      <div className="pre-check-runner">
        <div className="pre-check-complete">
          <div className="pre-check-header">
            <span className="pre-check-icon">✓</span>
            <span>Pre-check complete</span>
          </div>
          <div className="pre-check-results">
            {snapshot.results.map((result, idx) => (
              <div key={idx} className="pre-check-result-item">
                <span className="result-check">✓</span>
                <span className="result-command">{result.command}</span>
              </div>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="start-change-btn"
          onClick={onStartChange}
        >
          Start Change
        </button>
      </div>
    );
  }

  if (running) {
    return (
      <div className="pre-check-runner">
        <div className="pre-check-running">
          <div className="spinner" />
          <span>Running pre-check...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="pre-check-runner">
      <div className="pre-check-prompt">
        <p>Run pre-check to capture the current network state.</p>
      </div>
      <button type="button" className="run-pre-check-btn" onClick={onRun}>
        Run Pre-Check
      </button>
    </div>
  );
}
