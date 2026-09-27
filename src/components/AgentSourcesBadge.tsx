/**
 * Plan 12 Phase 5 Task 5.4 — Sources badge.
 *
 * Inline pill rendered under each assistant bubble that carries
 * RAG-retrieved citations. Click toggles the AgentPanel's single
 * drawer instance.
 *
 * Visual contract from `docs/design/rag-sources-drawer.md` §4.1:
 *   "▾ Sources · 3 docs"   (collapsed)
 *   "▴ Sources · 3 docs   open"  (open; suffix muted)
 *
 * The caret is a single Unicode character — no SVG icon.
 */
import { useRef } from "react";

export type AgentSourcesBadgeProps = {
  /** Number of sources cited (sources.length). Singular `1 doc`,
   *  plural `N docs`. */
  count: number;
  /** Whether the AgentPanel's drawer is currently bound to THIS
   *  message's sources. Drives the caret + "open" suffix. */
  isOpen: boolean;
  /** Click handler. Receives the badge button element so the parent
   *  can restore focus to it when the drawer closes. */
  onOpen: (button: HTMLButtonElement) => void;
};

export function AgentSourcesBadge({
  count,
  isOpen,
  onOpen,
}: AgentSourcesBadgeProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const noun = count === 1 ? "doc" : "docs";

  const handleClick = () => {
    if (buttonRef.current) onOpen(buttonRef.current);
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      className={
        "agent-sources-badge" + (isOpen ? " agent-sources-badge--open" : "")
      }
      onClick={handleClick}
      aria-pressed={isOpen}
      aria-label={`Sources, ${count} ${noun}${isOpen ? ", open" : ""}`}
      data-testid="agent-sources-badge"
    >
      <span className="agent-sources-badge-caret" aria-hidden="true">
        {isOpen ? "▴" : "▾"}
      </span>
      <span className="agent-sources-badge-label">
        Sources · {count} {noun}
      </span>
      {isOpen && (
        <span className="agent-sources-badge-suffix" aria-hidden="true">
          open
        </span>
      )}
    </button>
  );
}
