import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import Fuse from "fuse.js";
import {
  iconForKind,
  labelForKind,
  paletteRecordUse,
  paletteSearch,
  parseCategoryPrefix,
  type PaletteHit,
  type PaletteScope,
} from "../lib/palette";
import { formatTimeAgo } from "../lib/formatTimeAgo";
import "./CommandPalette.css";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Currently focused tab — used when scope = "tab". Optional so existing
   *  call sites without scope context still work. */
  activeTabId?: string | null;
  /** Currently active NETCONF/SSH device — used when scope = "device". */
  activeDeviceId?: string | null;
}

/** Static, always-available palette actions that aren't backed by the command
 *  history DB — so they're discoverable even on a fresh install. */
const STATIC_ACTIONS: PaletteHit[] = [
  {
    kind: "command",
    target_id: "agents:compose-input",
    title: "Compose Input to Agent",
    subtitle: "Open a multi-line composer and send it to the focused pane",
    score: 0,
    recency_boost: 0,
    frequency_boost: 0,
    meta: {},
  },
  {
    kind: "command",
    target_id: "iac:get-started-pipelines",
    title: "Get Started with Pipelines",
    subtitle: "Guided walkthrough — build your first CI/CD pipeline",
    score: 0,
    recency_boost: 0,
    frequency_boost: 0,
    meta: {},
  },
];

const SCOPES: PaletteScope[] = ["tab", "device", "global"];
const SCOPE_LABEL: Record<PaletteScope, string> = {
  tab: "Tab",
  device: "Device",
  global: "Global",
};

export function CommandPalette({
  open,
  onClose,
  activeTabId = null,
  activeDeviceId = null,
}: CommandPaletteProps) {
  const [rawQuery, setRawQuery] = useState("");
  const [scope, setScope] = useState<PaletteScope>("global");
  const [hits, setHits] = useState<PaletteHit[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { kindFilter, searchText } = useMemo(
    () => parseCategoryPrefix(rawQuery),
    [rawQuery],
  );

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setRawQuery("");
      setSelectedIndex(0);
      setHits([]);
    }
  }, [open]);

  // Debounced server fan-out. 80ms keeps typing fluid while still throttling
  // SQL round-trips when the user is hammering keys.
  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      let cancelled = false;
      setLoading(true);
      paletteSearch({
        query: searchText,
        scope,
        activeTabId,
        activeDeviceId,
        kindFilter,
        limit: 50,
      })
        .then((rows) => {
          if (!cancelled) {
            setHits(rows);
            setSelectedIndex(0);
          }
        })
        .catch((err) => {
          console.error("palette_search failed:", err);
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, 80);
    return () => clearTimeout(handle);
  }, [open, searchText, scope, kindFilter, activeTabId, activeDeviceId]);

  // Client-side Fuse re-rank. Only applied when the user has typed a query;
  // empty queries display server-provided order (which is recency-sorted in
  // Phase 3, last_used_at).
  const fuse = useMemo(
    () =>
      new Fuse(hits, {
        keys: [
          { name: "title", weight: 0.7 },
          { name: "subtitle", weight: 0.2 },
          { name: "meta.tags", weight: 0.1 },
        ],
        threshold: 0.35,
        includeScore: true,
        ignoreLocation: true,
      }),
    [hits],
  );

  // Static actions surface when the scope isn't device-specific and either the
  // query is empty or loosely matches the title — so a fresh install can still
  // discover them without a command-history row.
  const staticHits = useMemo(() => {
    if (scope === "device") return [];
    if (kindFilter !== null && kindFilter !== "command") return [];
    const q = searchText.trim().toLowerCase();
    if (q.length === 0) return STATIC_ACTIONS;
    return STATIC_ACTIONS.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        (a.subtitle ?? "").toLowerCase().includes(q),
    );
  }, [scope, kindFilter, searchText]);

  const ranked: PaletteHit[] = useMemo(() => {
    const base =
      searchText.trim().length === 0
        ? hits
        : fuse.search(searchText).map((r) => r.item);
    return [...staticHits, ...base];
  }, [searchText, fuse, hits, staticHits]);

  // Per-kind action dispatcher. Keyed by event name so each kind owns its
  // routing without having to plumb callbacks through every parent.
  const dispatchAction = useCallback(
    (hit: PaletteHit) => {
      switch (hit.kind) {
        case "command":
          if (hit.target_id === "agents:compose-input") {
            window.dispatchEvent(
              new CustomEvent("ccie:open-rich-input", { detail: { paneId: null } }),
            );
            break;
          }
          if (hit.target_id === "iac:get-started-pipelines") {
            window.dispatchEvent(new CustomEvent("ccie:start-pipeline-onboarding"));
            break;
          }
          window.dispatchEvent(
            new CustomEvent("ccie:execute-command", {
              detail: { command: hit.title },
            }),
          );
          break;
        case "workflow":
          window.dispatchEvent(
            new CustomEvent("ccie:run-workflow", {
              detail: { workflowId: hit.target_id },
            }),
          );
          break;
        case "notebook":
          window.dispatchEvent(
            new CustomEvent("ccie:open-notebook", {
              detail: { notebookId: hit.target_id },
            }),
          );
          break;
        case "device":
          window.dispatchEvent(
            new CustomEvent("ccie:open-device", {
              detail: { deviceId: hit.target_id },
            }),
          );
          break;
        case "block":
          window.dispatchEvent(
            new CustomEvent("ccie:scroll-to-block", {
              detail: {
                blockId: hit.target_id,
                tabId: (hit.meta as { tab_id?: string }).tab_id,
              },
            }),
          );
          break;
        case "ssh":
          window.dispatchEvent(
            new CustomEvent("ccie:open-ssh-connection", {
              detail: { connectionId: hit.target_id },
            }),
          );
          break;
      }
    },
    [],
  );

  const pick = useCallback(
    async (hit: PaletteHit) => {
      // Record-on-pick BEFORE dispatch so a thrown handler doesn't lose the
      // usage row (the next palette open would otherwise miss the recency
      // boost).
      try {
        await paletteRecordUse(hit.kind, hit.target_id);
      } catch (err) {
        console.warn("palette_record_use failed:", err);
      }
      dispatchAction(hit);
      onClose();
    },
    [dispatchAction, onClose],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Cmd+1/2/3 (or Ctrl on Linux/Win) → scope toggle.
    if ((e.metaKey || e.ctrlKey) && (e.key === "1" || e.key === "2" || e.key === "3")) {
      e.preventDefault();
      const idx = parseInt(e.key, 10) - 1;
      setScope(SCOPES[idx]);
      return;
    }

    // Backspace at position 0 with an active kindFilter → drop the chip.
    if (
      e.key === "Backspace" &&
      kindFilter !== null &&
      inputRef.current?.selectionStart === 0 &&
      inputRef.current?.selectionEnd === 0
    ) {
      e.preventDefault();
      setRawQuery("");
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, ranked.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = ranked[selectedIndex];
      if (hit) void pick(hit);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div
        className="palette-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <div className="palette-scope" role="tablist" aria-label="Search scope">
          {SCOPES.map((s, idx) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              onClick={() => setScope(s)}
              data-shortcut={`⌘${idx + 1}`}
            >
              {SCOPE_LABEL[s]}
              <span className="palette-scope-shortcut">⌘{idx + 1}</span>
            </button>
          ))}
        </div>

        <div className="palette-search">
          <span className="search-icon" aria-hidden>
            ⌘K
          </span>
          {kindFilter !== null && (
            <span
              className="palette-kind-chip"
              data-testid="palette-kind-chip"
              aria-label={`Filtered to ${labelForKind(kindFilter)}`}
            >
              {iconForKind(kindFilter)} {labelForKind(kindFilter)}
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type to search — use >c, >w, >n, >d, >b, >s to filter"
            autoFocus
            aria-autocomplete="list"
            aria-controls="palette-results"
          />
        </div>

        <div className="palette-results" id="palette-results" role="listbox">
          {loading && ranked.length === 0 ? (
            <div className="no-results">Searching…</div>
          ) : ranked.length === 0 ? (
            <div className="no-results">
              {searchText.length === 0
                ? "No recent picks yet — start typing to search commands, blocks, workflows, notebooks, devices, and SSH"
                : "No results found"}
            </div>
          ) : (
            ranked.map((hit, index) => (
              <div
                key={`${hit.kind}-${hit.target_id}`}
                className={`palette-item ${index === selectedIndex ? "selected" : ""}`}
                onClick={() => void pick(hit)}
                onMouseEnter={() => setSelectedIndex(index)}
                role="option"
                aria-selected={index === selectedIndex}
              >
                <span className="item-icon" aria-hidden>
                  {iconForKind(hit.kind)}
                </span>
                <div className="item-content">
                  <div className="item-title">{hit.title}</div>
                  {hit.subtitle && (
                    <div className="item-subtitle">{hit.subtitle}</div>
                  )}
                </div>
                <span className="palette-item-kind">
                  {labelForKind(hit.kind)}
                </span>
                {(() => {
                  const meta = hit.meta as {
                    use_count?: number;
                    last_used_at?: number;
                  };
                  if (!meta.use_count) return null;
                  const ago =
                    typeof meta.last_used_at === "number"
                      ? formatTimeAgo(meta.last_used_at)
                      : null;
                  return (
                    <span className="palette-item-meta">
                      {ago ? `${ago} · ` : ""}
                      {meta.use_count}×
                    </span>
                  );
                })()}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
