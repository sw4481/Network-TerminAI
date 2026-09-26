/**
 * Plan 12 Phase 3 — Multi-file tag picker modal.
 *
 * After files are dropped onto the RAG tab (or selected via the file
 * picker), this modal collects per-file titles + a shared tag set
 * before dispatching uploads. Tags apply to ALL pending files; per-row
 * retag lives outside Phase 3.
 *
 * Behavior contract (from `docs/design/rag-settings-tab.md`):
 * - Submit disabled until ≥1 tag selected.
 * - Esc closes; Enter submits when ≥1 tag selected.
 * - Tab cycles within the modal (focus trap is implemented locally —
 *   the dialog ref captures all focusable descendants on mount, wraps
 *   Tab/Shift+Tab at the boundaries, and restores prior focus on
 *   unmount).
 */
import { useEffect, useRef, useState } from "react";
import {
  type RagKind,
  type RagTag,
  type RagTaxonomy,
  TAG_SHAPE_RE,
  isReservedPrefix,
} from "../lib/rag";

export type PendingFile = {
  path: string;
  title: string;
  kind: RagKind;
  bytes: number;
};

export type RagUploadModalProps = {
  files: PendingFile[];
  taxonomy: RagTaxonomy;
  onCancel: () => void;
  onSubmit: (
    files: { path: string; title: string; kind: RagKind }[],
    tags: RagTag[],
  ) => void;
};

const KIND_LABEL: Record<RagKind, string> = {
  pdf: "[ PDF ]",
  md: "[ MD  ]",
  html: "[HTML ]",
  txt: "[ TXT ]",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function RagUploadModal({
  files,
  taxonomy,
  onCancel,
  onSubmit,
}: RagUploadModalProps) {
  const [titles, setTitles] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of files) out[f.path] = f.title;
    return out;
  });
  const [tags, setTags] = useState<Set<RagTag>>(new Set());
  const [showTagError, setShowTagError] = useState(false);
  // User tags: starts as the taxonomy.user list; the inline `+ New tag`
  // input adds to this. Modal-local — the tag becomes real on first
  // upload that includes it (the Rust set_tags writes the row).
  const [userTagPool, setUserTagPool] = useState<string[]>(
    () => taxonomy.user.map((u) => u.tag),
  );
  const [newTagDraft, setNewTagDraft] = useState("");
  const [newTagError, setNewTagError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const validateDraft = (raw: string): string | null => {
    const v = raw.trim();
    if (!v) return null; // Empty draft: no error, just nothing to add.
    if (!TAG_SHAPE_RE.test(v)) {
      return "Lowercase letters, digits, hyphens. Max 32 characters.";
    }
    if (isReservedPrefix(v)) {
      return "That prefix is reserved for vendor tags.";
    }
    return null;
  };

  const commitNewTag = () => {
    const v = newTagDraft.trim();
    if (!v) return;
    const err = validateDraft(v);
    if (err) {
      setNewTagError(err);
      return;
    }
    // Dedup against any existing chip (builtin or user).
    if (
      (taxonomy.builtin as readonly string[]).includes(v) ||
      userTagPool.includes(v)
    ) {
      // Just select the existing chip.
      setTags((prev) => {
        const next = new Set(prev);
        next.add(v);
        return next;
      });
      setNewTagDraft("");
      setNewTagError(null);
      return;
    }
    setUserTagPool((prev) => [...prev, v]);
    setTags((prev) => {
      const next = new Set(prev);
      next.add(v);
      return next;
    });
    setNewTagDraft("");
    setNewTagError(null);
    setShowTagError(false);
  };

  // Esc to cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && tags.size > 0) {
        // Don't double-fire when the user is committing a new tag in
        // the inline + New tag input — that input has its own Enter
        // handler and stops propagation, but guard here too in case a
        // future refactor moves the listener.
        const active = document.activeElement as HTMLElement | null;
        if (active?.dataset?.testid === "rag-modal-new-tag-input") return;
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags]);

  // Focus trap: capture Tab/Shift+Tab at the boundaries so focus can
  // never escape the dialog. Saves the previously-focused element on
  // mount and restores it when the modal unmounts. Implemented inline
  // (no dependency) per docs/design/rag-settings-tab.md §5 #2.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] => {
      const nodes = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      return Array.from(nodes).filter((el) => {
        if (el.hasAttribute("disabled")) return false;
        if (el.getAttribute("aria-hidden") === "true") return false;
        // hidden via the HTML hidden attribute or inline display:none.
        if (el.hasAttribute("hidden")) return false;
        const style = el.style;
        if (style && (style.display === "none" || style.visibility === "hidden")) {
          return false;
        }
        return true;
      });
    };

    // Move focus to the first focusable element (prefer the first
    // tag chip; fall back to the cancel button via focusables[0]).
    const initial = focusables();
    if (initial.length > 0) {
      const tagChip = dialog.querySelector<HTMLButtonElement>(
        "button.rag-modal-tag",
      );
      (tagChip ?? initial[0]).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) {
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
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, []);

  const toggleTag = (t: RagTag) => {
    setTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
    setShowTagError(false);
  };

  const submit = () => {
    if (tags.size === 0) {
      setShowTagError(true);
      return;
    }
    const payload = files
      .map((f) => ({
        path: f.path,
        title: (titles[f.path] || f.title || f.path).trim() || f.path,
        kind: f.kind,
      }))
      .filter((f) => f.title.length > 0);
    onSubmit(payload, Array.from(tags));
  };

  return (
    <div
      className="settings-overlay rag-modal-overlay"
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) onCancel();
      }}
      role="presentation"
    >
      <div
        className="settings-window rag-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Add ${files.length} document${files.length === 1 ? "" : "s"}`}
        ref={dialogRef}
      >
        <div className="rag-modal-header">
          <h2>
            Add {files.length} document{files.length === 1 ? "" : "s"}
          </h2>
          <button
            type="button"
            className="rag-modal-close"
            onClick={onCancel}
            aria-label="Cancel upload"
          >
            ×
          </button>
        </div>

        <div className="rag-modal-body">
          <div className="rag-modal-files">
            {files.map((f) => (
              <div className="rag-modal-file" key={f.path}>
                <span
                  className={`rag-kind rag-kind--${f.kind}`}
                  aria-label={f.kind.toUpperCase()}
                >
                  {KIND_LABEL[f.kind]}
                </span>
                <span className="rag-modal-file-name" title={f.path}>
                  {f.path.split("/").pop() || f.path}
                </span>
                <span className="rag-modal-file-size">
                  {formatBytes(f.bytes)}
                </span>
                <input
                  className="rag-title-input"
                  type="text"
                  value={titles[f.path] ?? ""}
                  onChange={(e) =>
                    setTitles((t) => ({ ...t, [f.path]: e.target.value }))
                  }
                  placeholder="Title"
                  aria-label={`Title for ${f.path}`}
                />
              </div>
            ))}
          </div>

          <div className="rag-modal-tag-section">
            <p className="rag-modal-tag-label">
              Tag the batch (applies to all {files.length}, choose 1+):
            </p>

            <p className="rag-modal-tag-sublabel">Builtin tags</p>
            <div
              className="rag-tag-grid"
              role="group"
              aria-label="Builtin tags"
            >
              {taxonomy.builtin.map((t) => {
                const selected = tags.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    role="button"
                    aria-pressed={selected}
                    className={
                      "rag-tag rag-modal-tag" +
                      (selected ? " rag-tag--selected" : "")
                    }
                    onClick={() => toggleTag(t)}
                  >
                    <span className="rag-tag-glyph" aria-hidden="true">
                      {selected ? "◉" : "⊘"}
                    </span>
                    {t}
                  </button>
                );
              })}
            </div>

            <p className="rag-modal-tag-sublabel">Your tags</p>
            <div
              className="rag-tag-grid"
              role="group"
              aria-label="Your tags"
            >
              {userTagPool.length === 0 && newTagDraft.length === 0 && (
                <span className="rag-modal-empty-user-tags">
                  No custom tags yet — type one below.
                </span>
              )}
              {userTagPool.map((t) => {
                const selected = tags.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    role="button"
                    aria-pressed={selected}
                    className={
                      "rag-tag rag-modal-tag rag-modal-tag--user" +
                      (selected ? " rag-tag--selected" : "")
                    }
                    onClick={() => toggleTag(t)}
                  >
                    <span className="rag-tag-glyph" aria-hidden="true">
                      {selected ? "◉" : "⊘"}
                    </span>
                    {t}
                  </button>
                );
              })}
            </div>

            <div className="rag-modal-new-tag-row">
              <input
                className="rag-modal-new-tag-input"
                type="text"
                value={newTagDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setNewTagDraft(v);
                  setNewTagError(validateDraft(v));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    commitNewTag();
                  }
                }}
                placeholder="+ New tag (e.g. customer-acme)"
                aria-label="Create a new user tag"
                aria-invalid={newTagError ? "true" : undefined}
                data-testid="rag-modal-new-tag-input"
              />
              <button
                type="button"
                className="rag-modal-new-tag-btn"
                onClick={commitNewTag}
                disabled={!newTagDraft.trim() || !!newTagError}
                data-testid="rag-modal-new-tag-add"
              >
                Add
              </button>
            </div>
            {newTagError && (
              <p
                className="rag-modal-tag-error"
                role="alert"
                data-testid="rag-modal-new-tag-error"
              >
                {newTagError}
              </p>
            )}

            <p className="rag-modal-tag-help">
              <span aria-hidden="true">ⓘ </span>
              One tag minimum. Chats see docs tagged for the session's
              vendor + any tagged <code>generic</code>; user tags filter
              further (AND).
            </p>
            {showTagError && (
              <p
                className="rag-modal-tag-error"
                role="alert"
                data-testid="rag-modal-tag-error"
              >
                Pick at least one tag.
              </p>
            )}
          </div>
        </div>

        <div className="rag-modal-actions">
          <button
            type="button"
            className="rag-btn rag-btn--ghost"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rag-btn rag-btn--primary"
            onClick={submit}
            disabled={tags.size === 0}
            data-testid="rag-modal-submit"
          >
            Upload {files.length} doc{files.length === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}
