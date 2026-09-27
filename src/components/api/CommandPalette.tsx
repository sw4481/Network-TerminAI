import { useEffect, useMemo, useState } from "react";
import {
  apiGetTarget,
  apiListSavedRequests,
  apiListTargets,
  type ApiEndpoint,
  type ApiSavedRequest,
  type ApiTargetManifest,
  type ApiTargetSummary,
} from "../../lib/tauri";
import {
  applyEndpointToState,
  applySavedRequestToState,
  useApiRunner,
} from "../../state/apiRunnerStore";

type PaletteEntry =
  | {
      kind: "endpoint";
      id: string; // composite: `${target}:${endpointId}`
      target: ApiTargetSummary;
      endpoint: ApiEndpoint;
      haystack: string;
    }
  | {
      kind: "saved";
      id: string;
      saved: ApiSavedRequest;
      haystack: string;
    };

type Props = {
  tabId: string;
  open: boolean;
  onClose: () => void;
};

/** Simple case-insensitive substring fuzzy score — higher is better. */
function score(haystack: string, needle: string): number {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let idx = 0;
  let last = -1;
  let score = 0;
  for (let i = 0; i < n.length; i++) {
    const c = n[i];
    idx = h.indexOf(c, last + 1);
    if (idx === -1) return 0;
    // Adjacent matches score higher than spread-out matches.
    if (last >= 0 && idx === last + 1) score += 2;
    else score += 1;
    last = idx;
  }
  return score;
}

/**
 * Cmd/Ctrl-K palette that indexes:
 *   * every endpoint across every target (lazy-loaded on open),
 *   * every saved request.
 * Enter selects; Esc closes; up/down move.
 */
export function CommandPalette({ tabId, open, onClose }: Props) {
  const [entries, setEntries] = useState<PaletteEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const patch = useApiRunner((s) => s.patch);
  const ensure = useApiRunner((s) => s.ensure);

  // Reset on open and lazy-load entries.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setCursor(0);
    setErr(null);
    let cancelled = false;
    (async () => {
      try {
        const [targets, saved] = await Promise.all([
          apiListTargets(),
          apiListSavedRequests(),
        ]);
        // Pull each target's full manifest+endpoints in parallel.
        const detailSettled = await Promise.allSettled(
          targets.map((t) => apiGetTarget(t.id).then((d) => ({ t, d }))),
        );
        if (cancelled) return;
        const all: PaletteEntry[] = [];
        for (const r of detailSettled) {
          if (r.status !== "fulfilled") continue;
          const { t, d } = r.value;
          for (const e of d.endpoints) {
            all.push({
              kind: "endpoint",
              id: `${t.id}:${e.id}`,
              target: t,
              endpoint: e,
              haystack: `${t.display_name} ${e.method} ${e.name} ${e.path}`,
            });
          }
        }
        for (const s of saved) {
          all.push({
            kind: "saved",
            id: `saved:${s.id}`,
            saved: s,
            haystack: `★ ${s.name} ${s.method} ${s.url}`,
          });
        }
        setEntries(all);
      } catch (err) {
        if (!cancelled) {
          setErr(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const results = useMemo(() => {
    if (!entries) return [];
    const scored = entries
      .map((e) => ({ e, s: score(e.haystack, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.slice(0, 50).map((x) => x.e);
  }, [entries, q]);

  useEffect(() => {
    if (cursor >= results.length) setCursor(0);
  }, [results, cursor]);

  const choose = async (entry: PaletteEntry) => {
    try {
      const cur = useApiRunner.getState().tabs[tabId] ?? ensure(tabId);
      if (entry.kind === "saved") {
        const next = applySavedRequestToState(cur, entry.saved);
        patch(tabId, next);
      } else {
        // Fetch the fresh manifest so base_url + headers are accurate.
        const detail = await apiGetTarget(entry.target.id);
        const next = applyEndpointToState(
          cur,
          detail.manifest,
          entry.endpoint,
        );
        patch(tabId, next);
      }
      onClose();
    } catch (err) {
      setErr(err instanceof Error ? err.message : String(err));
    }
  };

  if (!open) return null;

  return (
    <div
      data-testid="api-cmdk"
      role="dialog"
      aria-label="Command palette"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgb(var(--backdrop-rgb) / 0.6)",
        zIndex: 40,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
      }}
    >
      <div
        style={{
          width: 580,
          maxWidth: "90vw",
          background: "var(--surface-2)",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
          overflow: "hidden",
          color: "var(--text-primary)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <input
          data-testid="api-cmdk-input"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, Math.max(0, results.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const entry = results[cursor];
              if (entry) void choose(entry);
            }
          }}
          placeholder="meraki list orgs   ★ saved-name   ..."
          style={{
            background: "var(--app-canvas)",
            color: "var(--text-primary)",
            border: "none",
            borderBottom: "1px solid var(--border-default)",
            padding: "10px 12px",
            fontFamily: "Menlo, monospace",
            fontSize: 13,
            outline: "none",
          }}
        />
        {err && (
          <div
            data-testid="api-cmdk-error"
            style={{ color: "var(--status-danger)", fontSize: 11, padding: 6 }}
          >
            {err}
          </div>
        )}
        <div
          data-testid="api-cmdk-results"
          style={{ maxHeight: "60vh", overflowY: "auto" }}
        >
          {entries === null && (
            <div style={{ padding: 10, color: "var(--text-muted)", fontSize: 11 }}>
              Loading…
            </div>
          )}
          {entries !== null && results.length === 0 && (
            <div
              data-testid="api-cmdk-empty"
              style={{ padding: 10, color: "var(--text-muted)", fontSize: 11 }}
            >
              No matches.
            </div>
          )}
          {results.map((r, i) => (
            <button
              key={r.id}
              data-testid={`api-cmdk-row-${r.id}`}
              onMouseDown={(e) => {
                e.preventDefault();
                void choose(r);
              }}
              onMouseEnter={() => setCursor(i)}
              style={{
                display: "flex",
                gap: 10,
                width: "100%",
                padding: "6px 12px",
                background: i === cursor ? "var(--surface-3)" : "transparent",
                border: "none",
                color: "var(--text-primary)",
                textAlign: "left",
                fontFamily: "Menlo, monospace",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {r.kind === "endpoint" ? (
                <>
                  <span style={{ width: 60, color: "var(--text-secondary)" }}>
                    {r.target.display_name}
                  </span>
                  <span
                    style={{
                      width: 52,
                      color: methodColor(r.endpoint.method),
                      fontWeight: 700,
                    }}
                  >
                    {r.endpoint.method}
                  </span>
                  <span style={{ flex: 1 }}>{r.endpoint.name}</span>
                  <span style={{ color: "var(--text-muted)" }}>{r.endpoint.path}</span>
                </>
              ) : (
                <>
                  <span style={{ width: 60, color: "var(--status-warning)" }}>★ saved</span>
                  <span
                    style={{
                      width: 52,
                      color: methodColor(r.saved.method),
                      fontWeight: 700,
                    }}
                  >
                    {r.saved.method}
                  </span>
                  <span style={{ flex: 1 }}>{r.saved.name}</span>
                  <span
                    style={{
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: 240,
                    }}
                  >
                    {r.saved.url}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function methodColor(m: string): string {
  switch (m.toUpperCase()) {
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

// Suppress a lint warning about unused imports; `ApiTargetManifest` is
// referenced by the inferred return type of `apiGetTarget`.
export type _ImplicitManifestUse = ApiTargetManifest;
