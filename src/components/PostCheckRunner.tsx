import { useState } from "react";
import "./PostCheckRunner.css";

interface PostCheckRunnerProps {
  running: boolean;
  onRun: (notes: string) => void;
}

export function PostCheckRunner({ running, onRun }: PostCheckRunnerProps) {
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const handleRun = () => {
    onRun(notes.trim() || "");
  };

  if (running) {
    return (
      <div className="post-check-runner">
        <div className="post-check-running">
          <div className="spinner" />
          <span>Running post-check...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="post-check-runner">
      <div className="post-check-prompt">
        <p>Make your changes, then run the post-check to verify.</p>
      </div>

      <div className="post-check-notes-field">
        <label htmlFor="change-notes">Change Notes</label>
        <textarea
          id="change-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Describe what you changed..."
          rows={4}
        />
      </div>

      <label className="post-check-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span>I have made the change</span>
      </label>

      <button
        type="button"
        className="run-post-check-btn"
        onClick={handleRun}
        disabled={!confirmed}
      >
        Run Post-Check
      </button>
    </div>
  );
}
