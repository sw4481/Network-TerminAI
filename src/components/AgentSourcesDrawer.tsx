/**
 * Plan 12 Phase 5 Task 5.4 — Sources drawer.
 *
 * Slide-out drawer (360px) anchored to the right edge of AgentPanel
 * that shows the chunk cards behind the active assistant turn's
 * Sources badge.
 *
 * Behavior contract (from `docs/design/rag-sources-drawer.md`):
 * - Esc closes; click on overlay closes; click on panel does NOT.
 * - Focus trap: Tab/Shift+Tab cycles within `[×]` → Copy buttons →
 *   loops back to `[×]`. Initial focus goes to `[×]`.
 * - Each chunk card shows: title / tag chips / `Chunk N / TOTAL · sim
 *   N.NN` / monospace text with amber 2px left border / `[ Copy ]`.
 * - Copy: clipboard write → flashes `[ Copied ]` in amber for 1.2s.
 *   On failure, flashes `[ Copy failed ]` in danger for 1.2s.
 * - Similarity is `clamp(1 - distance, 0, 1)` formatted to 2 decimals.
 * - Empty state: defensive copy with a pointer to the RAG library.
 * - Honors `prefers-reduced-motion: reduce` (animation skipped).
 */
import { useEffect, useRef, useState } from "react";
import type { RetrievedChunk } from "../lib/rag";
import { useRagStore } from "../state/ragStore";
import { useTabs } from "../state/tabsStore";

export type AgentSourcesDrawerProps = {
  open: boolean;
  sources: RetrievedChunk[];
  onClose: () => void;
  /**
   * Active tab id, used to scope user-tag toggles in the
   * "Active tags" section. `null` disables toggles + auto-derived
   * vendor chips (the empty-state still renders so the user knows
   * where to add tags).
   */
  tabId: string | null;
};

const COPY_FLASH_MS = 1200;

/** Stable reference for the "no active user tags" case so the
 *  selector below doesn't return a fresh array every render and
 *  trip React's useSyncExternalStore tear detector. */
const EMPTY_TAGS: string[] = [];

function formatSimilarity(distance: number): string {
  // Distance is cosine in [0, 1] (or near-edge negatives for very
  // aligned vectors). Convert to similarity and clamp for display
  // purposes — never expose raw distance to engineers used to
  // similarity scores.
  const sim = 1 - distance;
  const clamped = Math.max(0, Math.min(1, sim));
  return clamped.toFixed(2);
}

export function AgentSourcesDrawer({
  open,
  sources,
  onClose,
  tabId,
}: AgentSourcesDrawerProps) {
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Active-tags section state. `taxonomy.user` is what's currently
  // tagged on documents in the library; we render those as toggleable
  // chips. `vendor`/`platform` are read-only auto-derived chips and
  // come from the tab metadata.
  //
  // The selectors below return either scalars (string|null) or the
  // already-stable array reference held in the store. Returning a
  // fresh `[]` from the selector would loop the React 19 useSyncExternalStore
  // tear-check, so we fall back to a module-level EMPTY_TAGS sentinel.
  const taxonomy = useRagStore((s) => s.taxonomy);
  const activeUserTagsMap = useRagStore((s) => s.activeUserTagsByTab);
  const activeUserTags: string[] = tabId
    ? activeUserTagsMap[tabId] ?? EMPTY_TAGS
    : EMPTY_TAGS;
  const toggleActiveUserTag = useRagStore((s) => s.toggleActiveUserTag);
  const vendor = useTabs((s) =>
    tabId ? s.tabs.find((t) => t.id === tabId)?.vendor ?? null : null,
  );
  const platform = useTabs((s) =>
    tabId ? s.tabs.find((t) => t.id === tabId)?.platform ?? null : null,
  );

  // Esc closes. Listen at the window level so the drawer responds
  // even when focus is on a Copy button (which doesn't bubble Esc to
  // the drawer ref otherwise).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus trap — same pattern as RagUploadModal (see
  // `docs/design/rag-sources-drawer.md` §6 #2). Captures the
  // previously-focused element on open and restores it on close (the
  // parent also calls `.focus()` on the badge for explicit fallback).
  useEffect(() => {
    if (!open) return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] => {
      const nodes = drawer.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      return Array.from(nodes).filter((el) => {
        if (el.hasAttribute("disabled")) return false;
        if (el.getAttribute("aria-hidden") === "true") return false;
        if (el.hasAttribute("hidden")) return false;
        return true;
      });
    };

    // Initial focus: the close button is always present and gives the
    // user a clear escape route.
    const closeBtn = drawer.querySelector<HTMLButtonElement>(
      ".agent-sources-close",
    );
    closeBtn?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !drawer.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    drawer.addEventListener("keydown", onKeyDown);
    return () => {
      drawer.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        // Best-effort restore. The badge `onClose` handler also
        // attempts a focus restore — whichever runs first wins.
        previouslyFocused.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="agent-sources-overlay"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
      role="presentation"
    >
      <div
        ref={drawerRef}
        className="agent-sources-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Sources for this answer"
        onClick={(e) => e.stopPropagation()}
        data-testid="agent-sources-drawer"
      >
        <div className="agent-sources-header">
          <h3 className="agent-sources-title">Sources</h3>
          <span className="agent-sources-count">
            {sources.length === 0
              ? "no chunks"
              : `${sources.length} chunk${sources.length === 1 ? "" : "s"} pinned to this answer`}
          </span>
          <button
            type="button"
            className="agent-sources-close"
            onClick={onClose}
            aria-label="Close sources drawer"
          >
            ×
          </button>
        </div>

        <div className="agent-sources-body">
          {sources.length === 0 ? (
            <div className="agent-source-empty">
              <p className="agent-source-empty-title">
                No sources for this turn.
              </p>
              <p className="agent-source-empty-body">
                The assistant answered without retrieving any documents.
                Check the RAG library to ensure docs are tagged for the
                active session vendor.
              </p>
            </div>
          ) : (
            sources.map((chunk) => (
              <ChunkCard key={chunk.chunk_id} chunk={chunk} />
            ))
          )}

          {/* Active tags — read-only vendor chips (auto-derived from
              the tab) + toggleable user-tag chips (sourced from the
              cached taxonomy). The vendor row is hidden when both
              vendor and platform are null since `generic` alone has
              no meaningful information value. */}
          <section className="agent-sources-active-tags">
            <h4 className="agent-sources-active-tags-title">Active tags</h4>
            {vendor || platform ? (
              <div
                className="agent-sources-active-tags-row"
                aria-label="Vendor tags (auto-derived)"
              >
                {vendor && (
                  <span className="rag-tag rag-tag--readonly">{vendor}</span>
                )}
                {platform && (
                  <span className="rag-tag rag-tag--readonly">{platform}</span>
                )}
                <span className="rag-tag rag-tag--readonly">generic</span>
              </div>
            ) : null}

            {taxonomy.user.length === 0 ? (
              <p className="agent-sources-empty-tags">
                Tag uploads in <em>Settings → RAG</em> to filter chats by
                your own tags.
              </p>
            ) : (
              <div
                className="agent-sources-active-tags-row"
                role="group"
                aria-label="User tags"
              >
                {taxonomy.user.map((u) => {
                  const selected = activeUserTags.includes(u.tag);
                  return (
                    <button
                      type="button"
                      key={u.tag}
                      aria-pressed={selected}
                      disabled={tabId === null}
                      className={
                        "rag-tag rag-tag--user" +
                        (selected ? " rag-tag--selected" : "")
                      }
                      onClick={() => {
                        if (tabId !== null) toggleActiveUserTag(tabId, u.tag);
                      }}
                      data-testid={`agent-sources-user-tag-${u.tag}`}
                    >
                      {u.tag}{" "}
                      <span className="rag-tag-count">({u.usage_count})</span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="agent-sources-active-tags-help">
              Vendor tags use OR; your tags use AND.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

type CopyState = "idle" | "copied" | "failed";

function ChunkCard({ chunk }: { chunk: RetrievedChunk }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  // Track the pending copy-flash timer so we can (a) reset it if the
  // user mashes Copy repeatedly and (b) clear it on unmount — otherwise
  // closing the drawer within 1.2s of a copy fires `setState` on an
  // unmounted component and prints a React warning.
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(chunk.text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setCopyState("idle");
    }, COPY_FLASH_MS);
  };

  // Chunk N / TOTAL — TOTAL isn't carried by RetrievedChunk; the
  // design uses chunk_idx + 1 as a one-indexed display, but the spec
  // says to keep zero-indexing to stay consistent with the rest of
  // the catalog. Show `Chunk <chunk_idx>` and elide the "/ TOTAL"
  // when it isn't available.
  const meta = `Chunk ${chunk.chunk_idx}  ·  sim ${formatSimilarity(chunk.distance)}`;

  return (
    <div className="agent-source-card" data-testid="agent-source-card">
      <div className="agent-source-title" title={chunk.document_title}>
        {chunk.document_title}
      </div>
      <div className="agent-source-tags">
        {chunk.tags.map((t) => (
          <span key={t} className="rag-tag rag-tag--selected">
            <span className="rag-tag-glyph" aria-hidden="true">◉</span>
            {t}
          </span>
        ))}
      </div>
      <div className="agent-source-meta">{meta}</div>
      <pre className="agent-source-text">{chunk.text}</pre>
      <div className="agent-source-actions">
        <button
          type="button"
          className={
            "agent-source-copy" +
            (copyState === "copied" ? " agent-source-copy--copied" : "") +
            (copyState === "failed" ? " agent-source-copy--failed" : "")
          }
          onClick={handleCopy}
          data-testid="agent-source-copy"
        >
          {copyState === "copied"
            ? "[ Copied ]"
            : copyState === "failed"
              ? "[ Copy failed ]"
              : "[ Copy ]"}
        </button>
      </div>
    </div>
  );
}
