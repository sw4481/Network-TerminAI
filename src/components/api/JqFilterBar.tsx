import { useEffect, useState } from "react";

type Props = {
  /** Current filter expression (committed). */
  value: string;
  /** Called with the debounced value. */
  onChange: (v: string) => void;
  /** When present, the filter failed to parse/evaluate; shown as tooltip. */
  error?: string | null;
  placeholder?: string;
};

/**
 * Small filter input with a 150 ms debounce. Uses an internal "draft" state
 * so the parent store only updates after the user pauses typing — keeps
 * the table + pretty-printed body from thrashing on every keystroke.
 */
export function JqFilterBar({ value, onChange, error, placeholder }: Props) {
  const [draft, setDraft] = useState(value);

  // Sync external changes (e.g. clearing via a button) into the draft.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onChange(draft), 150);
    return () => clearTimeout(t);
  }, [draft, value, onChange]);

  const isErr = Boolean(error);
  return (
    <div
      data-testid="api-jq-filter-bar"
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      <span style={{ color: "#8a8d94", fontSize: 11, whiteSpace: "nowrap" }}>
        filter:
      </span>
      <input
        data-testid="api-jq-filter"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder ?? "$.[*].id   (JSONPath)"}
        title={error ?? undefined}
        style={{
          flex: 1,
          background: "#0f1114",
          color: "#e6e1cf",
          border: `1px solid ${isErr ? "#f28779" : "#262a33"}`,
          borderRadius: 4,
          padding: "4px 8px",
          fontFamily: "Menlo, monospace",
          fontSize: 12,
        }}
      />
      {draft && (
        <button
          data-testid="api-jq-filter-clear"
          onClick={() => {
            setDraft("");
            onChange("");
          }}
          style={{
            background: "transparent",
            color: "#8a8d94",
            border: "none",
            cursor: "pointer",
            fontSize: 14,
          }}
          title="Clear filter"
        >
          ×
        </button>
      )}
      {isErr && (
        <span
          data-testid="api-jq-filter-error"
          style={{
            color: "#f28779",
            fontSize: 11,
            fontFamily: "Menlo, monospace",
            maxWidth: 260,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
