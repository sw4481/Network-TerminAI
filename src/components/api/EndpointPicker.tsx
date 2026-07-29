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
      return "#6bd968";
    case "POST":
      return "#5ccfe6";
    case "PUT":
      return "#ffb454";
    case "PATCH":
      return "#d4bfff";
    case "DELETE":
      return "#f28779";
    default:
      return "#8a8d94";
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
          background: "#0f1114",
          color: "#e6e1cf",
          border: "1px solid #262a33",
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
          border: "1px solid #262a33",
          borderRadius: 4,
          background: "#0f1114",
        }}
      >
        {filtered.length === 0 && (
          <div
            style={{
              padding: 10,
              color: "#6c7380",
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
                background: selected ? "#262a33" : "transparent",
                border: "none",
                borderBottom: "1px solid #1a1d23",
                cursor: "pointer",
                textAlign: "left",
                color: "#e6e1cf",
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
                <div style={{ color: "#e6e1cf", fontWeight: 600 }}>
                  {e.name}
                </div>
                <div
                  style={{
                    color: "#8a8d94",
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
