import { useState } from "react";

interface Props {
  onSubmit: (cronExpr: string) => void;
  onCancel: () => void;
}

const PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every 15 minutes", cron: "0 */15 * * * *" },
  { label: "Hourly", cron: "0 0 * * * *" },
  { label: "Every 4 hours", cron: "0 0 */4 * * *" },
  { label: "Nightly at 2am", cron: "0 0 2 * * *" },
  { label: "Weekdays at 8am", cron: "0 0 8 * * 1-5" },
];

export function ScheduleEditor({ onSubmit, onCancel }: Props) {
  const [cron, setCron] = useState(PRESETS[1].cron);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const trimmed = cron.trim();
    if (!trimmed) {
      setError("Cron expression required");
      return;
    }
    // Loose syntactic check: 5–7 whitespace-separated fields.
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5 || parts.length > 7) {
      setError(
        "Cron expression must have 5–7 fields (sec? min hour day month weekday year?)",
      );
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgb(var(--backdrop-rgb) / 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          width: 480,
          background: "var(--surface-overlay)",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
          color: "var(--text-primary)",
          fontFamily: "Menlo, monospace",
          padding: 16,
        }}
        onClick={(e) => e.stopPropagation()}
        data-testid="schedule-editor"
      >
        <h3 style={{ margin: 0, fontSize: 14, marginBottom: 12 }}>
          Schedule drift check
        </h3>
        <label
          style={{
            fontSize: 11,
            color: "var(--text-secondary)",
            display: "block",
            marginBottom: 4,
          }}
        >
          Cron expression (6 fields: sec min hour day month weekday)
        </label>
        <input
          type="text"
          value={cron}
          onChange={(e) => {
            setCron(e.target.value);
            setError(null);
          }}
          style={{
            width: "100%",
            background: "var(--app-canvas)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: "6px 8px",
            fontFamily: "inherit",
            fontSize: 12,
            marginBottom: 12,
          }}
          data-testid="schedule-cron"
        />
        <div
          style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}
        >
          Or pick a preset:
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: 12,
          }}
        >
          {PRESETS.map((p) => (
            <button
              key={p.cron}
              onClick={() => setCron(p.cron)}
              style={{
                background: "var(--surface-2)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: "4px 10px",
                fontFamily: "inherit",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        {error && (
          <div
            style={{
              color: "var(--text-primary)",
              fontSize: 11,
              marginBottom: 8,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              background: "transparent",
              color: "var(--text-primary)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "6px 12px",
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            style={{
              background: "var(--accent-subtle)",
              color: "var(--text-inverse)",
              border: "none",
              borderRadius: 4,
              padding: "6px 14px",
              fontFamily: "inherit",
              cursor: "pointer",
            }}
            data-testid="schedule-submit"
          >
            Schedule
          </button>
        </div>
      </div>
    </div>
  );
}
