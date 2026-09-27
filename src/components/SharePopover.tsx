import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useBlocksStore, type Block } from '../state/blocksStore';
import { exportBlockToMarkdown, exportBlockToJson } from '../lib/notebook';
import './SharePopover.css';

export interface SharePopoverProps {
  block: Block;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}

type FeedbackTone = 'ok' | 'err';
interface Feedback {
  text: string;
  tone: FeedbackTone;
  // When true, the popover should NOT auto-close after this feedback.
  sticky?: boolean;
}

/**
 * Sanitize a command string into a filesystem-safe stem matching the
 * convention used by `downloadNotebook` in `src/lib/notebook.ts`:
 * lowercased, non-alphanumeric runs collapsed to `_`, leading/trailing
 * `_` trimmed. Falls back to "block" when sanitization yields an empty
 * string (e.g. command was all punctuation).
 */
function sanitizeFilename(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return cleaned.length > 0 ? cleaned : 'block';
}

async function copyToClipboard(text: string): Promise<void> {
  // navigator.clipboard is available in the Tauri webview and in jsdom-based
  // tests (when mocked). We don't fall back to a hidden <textarea> because
  // popover usage is gated by a user click (so the gesture token is fresh)
  // and Tauri grants clipboard access in the default window context.
  await navigator.clipboard.writeText(text);
}

export const SharePopover = memo(function SharePopover({
  block,
  anchorRef,
  open,
  onClose,
}: SharePopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const createShare = useBlocksStore((s) => s.createShare);
  const revokeShare = useBlocksStore((s) => s.revokeShare);

  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  // Reset transient state whenever the popover toggles.
  useEffect(() => {
    if (!open) {
      setBusy(false);
      setFeedback(null);
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    }
  }, [open]);

  // Clear any pending auto-close timer on unmount so we don't fire onClose()
  // after the component is gone.
  useEffect(
    () => () => {
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    },
    [],
  );

  // Close on Escape and on click-outside (anywhere outside the popover AND
  // the anchor element — clicks on the anchor itself are the parent's
  // toggle responsibility).
  useEffect(() => {
    if (!open) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      const pop = popoverRef.current;
      const anchor = anchorRef.current;
      const target = e.target as Node | null;
      if (!target) return;
      if (pop && pop.contains(target)) return;
      if (anchor && anchor.contains(target)) return;
      onClose();
    };

    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('mousedown', handleMouseDown, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('mousedown', handleMouseDown, true);
    };
  }, [open, onClose, anchorRef]);

  // After a successful action, briefly show feedback then close. Sticky
  // feedback (errors, "Share revoked" hold) skips the auto-close.
  const finishWith = useCallback(
    (next: Feedback) => {
      setFeedback(next);
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
      if (!next.sticky) {
        // Close on next tick so the success text is visible for a beat. We
        // use a short timer so the user actually sees the ack before the
        // popover disappears.
        feedbackTimerRef.current = window.setTimeout(() => {
          feedbackTimerRef.current = null;
          onClose();
        }, 600);
      }
    },
    [onClose],
  );

  const handleCopyLink = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const shareId = block.shareId ?? (await createShare(block.id));
      const url = `ccie-terminal://block/${shareId}`;
      await copyToClipboard(url);
      finishWith({ text: 'Link copied', tone: 'ok' });
    } catch (err) {
      console.error('Copy link failed:', err);
      setFeedback({ text: 'Copy link failed', tone: 'err', sticky: true });
    } finally {
      setBusy(false);
    }
  }, [block.id, block.shareId, busy, createShare, finishWith]);

  const handleCopyMarkdown = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await copyToClipboard(exportBlockToMarkdown(block));
      finishWith({ text: 'Markdown copied', tone: 'ok' });
    } catch (err) {
      console.error('Copy markdown failed:', err);
      setFeedback({ text: 'Copy markdown failed', tone: 'err', sticky: true });
    } finally {
      setBusy(false);
    }
  }, [block, busy, finishWith]);

  const handleCopyJson = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await copyToClipboard(exportBlockToJson(block));
      finishWith({ text: 'JSON copied', tone: 'ok' });
    } catch (err) {
      console.error('Copy JSON failed:', err);
      setFeedback({ text: 'Copy JSON failed', tone: 'err', sticky: true });
    } finally {
      setBusy(false);
    }
  }, [block, busy, finishWith]);

  const handleExportMarkdown = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const stem = sanitizeFilename(block.command);
      const defaultPath = `${stem}.md`;
      const chosen = await saveDialog({
        defaultPath,
        title: 'Export block as Markdown',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!chosen) {
        // User canceled — just close quietly.
        setBusy(false);
        onClose();
        return;
      }
      await writeTextFile(chosen, exportBlockToMarkdown(block));
      finishWith({ text: 'Saved', tone: 'ok' });
    } catch (err) {
      console.error('Export markdown failed:', err);
      setFeedback({ text: 'Export failed', tone: 'err', sticky: true });
    } finally {
      setBusy(false);
    }
  }, [block, busy, finishWith, onClose]);

  const handleRevoke = useCallback(async () => {
    if (busy || !block.shareId) return;
    setBusy(true);
    setFeedback(null);
    try {
      await revokeShare(block.id);
      finishWith({ text: 'Share revoked', tone: 'ok' });
    } catch (err) {
      console.error('Revoke share failed:', err);
      setFeedback({ text: 'Revoke failed', tone: 'err', sticky: true });
    } finally {
      setBusy(false);
    }
  }, [block.id, block.shareId, busy, finishWith, revokeShare]);

  if (!open) return null;

  const revokeDisabled = !block.shareId || busy;

  return (
    <div
      ref={popoverRef}
      className="share-popover"
      role="menu"
      aria-label="Share block"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="share-popover-title">Share block</div>

      <button
        type="button"
        role="menuitem"
        className="share-popover-item"
        onClick={handleCopyLink}
        disabled={busy}
      >
        <span className="share-popover-glyph" aria-hidden="true">
          🔗
        </span>
        <span className="share-popover-label">Copy link</span>
      </button>

      <button
        type="button"
        role="menuitem"
        className="share-popover-item"
        onClick={handleCopyMarkdown}
        disabled={busy}
      >
        <span className="share-popover-glyph" aria-hidden="true">
          M
        </span>
        <span className="share-popover-label">Copy as Markdown</span>
      </button>

      <button
        type="button"
        role="menuitem"
        className="share-popover-item"
        onClick={handleCopyJson}
        disabled={busy}
      >
        <span className="share-popover-glyph" aria-hidden="true">
          J
        </span>
        <span className="share-popover-label">Copy as JSON</span>
      </button>

      <button
        type="button"
        role="menuitem"
        className="share-popover-item"
        onClick={handleExportMarkdown}
        disabled={busy}
      >
        <span className="share-popover-glyph" aria-hidden="true">
          ⤓
        </span>
        <span className="share-popover-label">Export Markdown…</span>
      </button>

      <div className="share-popover-divider" />

      <button
        type="button"
        role="menuitem"
        className="share-popover-item share-popover-item-danger"
        onClick={handleRevoke}
        disabled={revokeDisabled}
        aria-disabled={revokeDisabled}
        title={
          block.shareId
            ? 'Revoke this block share link'
            : 'No active share link to revoke'
        }
      >
        <span className="share-popover-glyph" aria-hidden="true">
          ⊘
        </span>
        <span className="share-popover-label">Revoke share</span>
      </button>

      {feedback && (
        <div
          className={`share-popover-feedback share-popover-feedback-${feedback.tone}`}
          role="status"
          aria-live="polite"
        >
          {feedback.text}
        </div>
      )}
    </div>
  );
});
