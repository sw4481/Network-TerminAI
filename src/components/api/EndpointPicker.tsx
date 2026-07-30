import { useMemo, useState } from "react";
import type { ApiEndpoint } from "../../lib/tauri";

type Props = {
  endpoints: ApiEndpoint[];
  /** Currently-selected endpoint id, or null. */
  value: string | null;
  onChange: (endpoint: ApiEndpoint | null) => void;
};

/** Color-code HTTP method pills the way Postman/Insomnia do. */
function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "var(--status-success)";
    case "POST":
      return "var(--accent)";
    case "PUT":
      return "var(--status-warning)";
    case "PATCH":
      return "var(--text-primary)";
    case "DELETE":
      return "var(--status-danger)";
    default:
      return "var(--text-secondary)";
  }
}

export function EndpointPicker({ endpoints, value, onChange }: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return endpoints;
    return endpoints.filter((e) => {
      return (
        e.name.toLowerCase().includes(q) ||
        e.path.toLowerCase().includes(q) ||
        e.method.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [endpoints, query]);

  return (
    <div
      data-testid="api-endpoint-picker"
      style={{ display: "flex", flexDirection: "column", gap: 6, minHeight: 0 }}
    >
      <input
        data-testid="api-endpoint-search"
        placeholder="Search endpoints…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          background: "var(--app-canvas)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-default)",
          borderRadius: 4,
          padding: "4px 8px",
          fontFamily: "Menlo, monospace",
          fontSize: 12,
        }}
      />
      <div
        data-testid="api-endpoint-list"
        style={{
          display: "flex",
          flexDirection: "column",
          maxHeight: 220,
          overflowY: "auto",
          border: "1px solid var(--border-default)",
          borderRadius: 4,
          background: "var(--app-canvas)",
        }}
      >
        {filtered.length === 0 && (
          <div
            style={{
              padding: 10,
              color: "var(--text-muted)",
              fontSize: 12,
              fontFamily: "Menlo, monospace",
            }}
            data-testid="api-endpoint-empty"
          >
            No endpoints match.
          </div>
        )}
        {filtered.map((e) => {
          const selected = e.id === value;
          return (
            <button
              key={e.id}
              data-testid={`api-endpoint-row-${e.id}`}
              onClick={() => onChange(e)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 10px",
                background: selected ? "var(--surface-3)" : "transparent",
                border: "none",
                borderBottom: "1px solid var(--surface-2)",
                cursor: "pointer",
                textAlign: "left",
                color: "var(--text-primary)",
                fontFamily: "Menlo, monospace",
                fontSize: 12,
              }}
            >
              <span
                style={{
                  color: methodColor(e.method),
                  fontWeight: 700,
                  width: 52,
                  flexShrink: 0,
                }}
              >
                {e.method}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                  {e.name}
                </div>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {e.path}
                </div>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
