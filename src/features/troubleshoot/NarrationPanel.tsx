/**
 * Plan 15 Phase 4 — NarrationPanel.
 *
 * Right-side scrollable column. Each entry is a markdown block + an
 * optional row of citation pills. Auto-scrolls to the bottom on new
 * entries unless the user scrolled up (we keep a ref to the last
 * scrollTop and skip auto-scroll when the user is more than 16px above
 * the bottom).
 *
 * Citation pills emit a CustomEvent (`troubleshoot:citation-clicked`)
 * for the Plan 12 RAG modal to pick up. Phase 4 doesn't wire that
 * end-to-end — just exposes the click — because the RAG modal is a
 * Phase 6 follow-up per the plan.
 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  selectActiveRun,
  selectOrderedNarration,
  useTroubleshootStore,
  type NarrationEntry,
} from "./store";
import "./NarrationPanel.css";

const COLLAPSED_LS_KEY = "ccie:troubleshoot.narrationPanelCollapsed";

function loadCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_LS_KEY) === "true";
  } catch {
    return false;
  }
}

export function NarrationPanel() {
  const activeRun = useTroubleshootStore(selectActiveRun);
  const entries = selectOrderedNarration(activeRun);

  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);
  const listRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef = useRef<boolean>(false);
  const lastEntryCountRef = useRef<number>(0);

  // Track scroll state. Auto-scroll only when the user is near the
  // bottom (within 16px) — once they scroll up we leave the scrollTop
  // alone until they manually return.
  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distanceFromBottom > 16;
  };

  useEffect(() => {
    if (collapsed) return;
    if (entries.length === lastEntryCountRef.current) return;
    lastEntryCountRef.current = entries.length;
    if (userScrolledUpRef.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, collapsed]);

  // Listen for "jump to narration" events from StepNode — scroll the
  // matching entry into view and clear any user-scroll lock so the
  // new highlight is visible.
  useEffect(() => {
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<{ stepId: string }>).detail;
      if (!detail?.stepId) return;
      if (collapsed) {
        setCollapsed(false);
        try {
          window.localStorage.setItem(COLLAPSED_LS_KEY, "false");
        } catch {}
      }
      requestAnimationFrame(() => {
        const node = document.querySelector(
          `[data-narration-step="${CSS.escape(detail.stepId)}"]`,
        );
        node?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    };
    document.addEventListener("troubleshoot:jump-narration", onJump);
    return () =>
      document.removeEventListener("troubleshoot:jump-narration", onJump);
  }, [collapsed]);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSED_LS_KEY, String(next));
      } catch {}
      return next;
    });
  };

  const onCitation = (entry: NarrationEntry, citationId: string) => {
    document.dispatchEvent(
      new CustomEvent("troubleshoot:citation-clicked", {
        detail: {
          runId: entry.runId,
          stepId: entry.stepId,
          citationId,
        },
      }),
    );
  };

  if (collapsed) {
    return (
      <div
        className="tb-narration"
        data-collapsed="true"
        data-testid="tb-narration-panel"
      >
        <div className="tb-narration-header">
          <button
            type="button"
            className="tb-narration-toggle"
            onClick={toggle}
            aria-label="Expand narration panel"
            data-testid="tb-narration-toggle"
          >
            ◂
          </button>
        </div>
        <div
          className="tb-narration-collapsed-rail"
          onClick={toggle}
          aria-hidden
        >
          Narration ▸
        </div>
      </div>
    );
  }

  return (
    <aside
      className="tb-narration"
      data-collapsed="false"
      data-testid="tb-narration-panel"
    >
      <div className="tb-narration-header">
        <span>Narration</span>
        <button
          type="button"
          className="tb-narration-toggle"
          onClick={toggle}
          aria-label="Collapse narration panel"
          data-testid="tb-narration-toggle"
        >
          ▸
        </button>
      </div>
      <div
        className="tb-narration-list"
        ref={listRef}
        onScroll={handleScroll}
        data-testid="tb-narration-list"
      >
        {entries.length === 0 ? (
          <div className="tb-narration-empty" data-testid="tb-narration-empty">
            No narration yet — start a run to see commentary.
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.stepId}
              className="tb-narration-entry"
              data-narration-step={entry.stepId}
              data-testid={`tb-narration-${entry.stepId}`}
            >
              <div className="tb-narration-entry-header">
                <span>
                  #{entry.stepIdx ?? "—"} · {entry.stepId}
                </span>
              </div>
              <div className="tb-narration-entry-body">
                <ReactMarkdown>
                  {entry.text || "_(no narration text)_"}
                </ReactMarkdown>
              </div>
              {entry.citations.length > 0 && (
                <div className="tb-narration-citations">
                  {entry.citations.map((c) => (
                    <button
                      type="button"
                      key={c}
                      className="tb-narration-citation"
                      onClick={() => onCitation(entry, c)}
                      data-testid={`tb-narration-citation-${c}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
