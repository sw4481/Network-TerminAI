import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { USER_GUIDE_MD } from "./content/userGuide";
import { QUICK_START_MD } from "./content/quickStart";
import { SHORTCUTS_MD } from "./content/shortcuts";
import { ABOUT_MD } from "./content/about";
import "./HelpModal.css";

export type HelpSection = "user-guide" | "quick-start" | "shortcuts" | "about";

interface HelpModalProps {
  /** Initial section to show; switches when prop changes. */
  section: HelpSection;
  onClose: () => void;
}

interface SectionDef {
  id: HelpSection;
  label: string;
  blurb: string;
  body: string;
}

const SECTIONS: SectionDef[] = [
  {
    id: "user-guide",
    label: "User Guide",
    blurb: "Full reference for every shipped feature.",
    body: USER_GUIDE_MD,
  },
  {
    id: "quick-start",
    label: "Quick Start",
    blurb: "Productive in five minutes.",
    body: QUICK_START_MD,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    blurb: "Comprehensive keyboard reference.",
    body: SHORTCUTS_MD,
  },
  {
    id: "about",
    label: "About",
    blurb: "Version, features, and credits.",
    body: ABOUT_MD,
  },
];

/**
 * Lightweight substring search over a markdown body. Returns true when every
 * whitespace-delimited token in `query` is present (case-insensitive) in
 * `body`. We deliberately avoid pulling in fuse.js for this — it is dynamic
 * imported elsewhere and the corpus here is tiny.
 */
function bodyMatches(body: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const tokens = q.split(/\s+/g);
  const lower = body.toLowerCase();
  return tokens.every((t) => lower.includes(t));
}

export function HelpModal({ section, onClose }: HelpModalProps) {
  const [active, setActive] = useState<HelpSection>(section);
  const [search, setSearch] = useState("");
  const contentRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Track parent-driven section changes (e.g. menu → help_open → "shortcuts").
  useEffect(() => {
    setActive(section);
  }, [section]);

  // Esc-to-close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Reset scroll when active section changes.
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [active]);

  // Focus the search box on open so Cmd+/ "type to filter" works without a click.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // If the active section is filtered out by search, switch to the first visible.
  useEffect(() => {
    if (search && !visibleSections.find((s) => s.id === active) && visibleSections[0]) {
      setActive(visibleSections[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const visibleSections = useMemo(() => {
    if (!search.trim()) return SECTIONS;
    return SECTIONS.filter(
      (s) =>
        bodyMatches(s.label, search) ||
        bodyMatches(s.blurb, search) ||
        bodyMatches(s.body, search),
    );
  }, [search]);

  const activeBody =
    SECTIONS.find((s) => s.id === active)?.body ?? USER_GUIDE_MD;

  return (
    <div
      className="help-modal-overlay"
      onClick={onClose}
      data-testid="help-modal-overlay"
    >
      <div
        className="help-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="TerminAI Help"
        data-testid="help-modal"
      >
        <div className="help-modal-header">
          <h2>Help</h2>
          <input
            ref={searchRef}
            type="search"
            className="help-modal-search"
            placeholder="Search help…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="help-modal-search"
            aria-label="Search help content"
          />
          <button
            className="help-modal-close"
            onClick={onClose}
            aria-label="Close help"
          >
            ✕
          </button>
        </div>

        <div className="help-modal-body">
          <nav
            className="help-modal-sidebar"
            data-testid="help-modal-sidebar"
            aria-label="Help sections"
          >
            {visibleSections.length === 0 && (
              <div className="help-modal-empty">No matching sections.</div>
            )}
            {visibleSections.map((s) => (
              <button
                key={s.id}
                className={
                  "help-modal-nav-item" +
                  (s.id === active ? " help-modal-nav-item--active" : "")
                }
                onClick={() => setActive(s.id)}
                data-testid={`help-nav-${s.id}`}
                aria-current={s.id === active ? "page" : undefined}
              >
                <span className="help-modal-nav-label">{s.label}</span>
                <span className="help-modal-nav-blurb">{s.blurb}</span>
              </button>
            ))}
          </nav>

          <div
            className="help-modal-content"
            ref={contentRef}
            data-testid={`help-content-${active}`}
          >
            <ReactMarkdown>{activeBody}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}
