import { useEffect, useState } from "react";
import { apiListTargets } from "../../lib/tauri";
import type { ApiTargetSummary } from "../../lib/tauri";

/** Sentinel id used when the user wants a blank / raw request. */
export const CUSTOM_TARGET_ID = "__custom__";

type Props = {
  /** Currently-selected target id, or CUSTOM_TARGET_ID. */
  value: string;
  onChange: (id: string) => void;
};

export function TargetPicker({ value, onChange }: Props) {
  const [targets, setTargets] = useState<ApiTargetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiListTargets()
      .then((list) => {
        if (!cancelled) setTargets(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8 }}
      data-testid="api-target-picker"
    >
      <label style={{ color: "#8a8d94", fontSize: 12 }}>Target:</label>
      <select
        data-testid="api-target-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={targets === null && !error}
        style={{
          background: "#1a1d23",
          color: "#e6e1cf",
          border: "1px solid #262a33",
          borderRadius: 4,
          padding: "4px 8px",
          minWidth: 160,
        }}
      >
        <option value={CUSTOM_TARGET_ID}>— Custom (raw) —</option>
        {(targets ?? []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.display_name}
            {t.builtin ? " (builtin)" : ""}
          </option>
        ))}
      </select>
      {error && (
        <span
          data-testid="api-target-error"
          style={{ color: "#f28779", fontSize: 11 }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
