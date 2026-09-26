import { useEffect, useRef, useState } from 'react';
import { ptyWrite } from '../lib/tauri';
import { usePanesStore } from '../state/panesStore';
import { useTabs } from '../state/tabsStore';
import { ptyTabIdFor } from '../lib/terminalRegistry';
import './RichInputModal.css';

/**
 * Warp-style rich input composer. Opened by the `ccie:open-rich-input` event
 * (from the toolbelt's Compose button, the menu accelerator, or the palette).
 * A multi-line textarea; on Send it writes the text plus a trailing newline to
 * the target pane's PTY, then closes. ⌘↵ sends, Esc cancels.
 */
export default function RichInputModal() {
  const [open, setOpen] = useState(false);
  const [targetPane, setTargetPane] = useState<string | null>(null);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { paneId: string | null } | undefined;
      let paneId = detail?.paneId ?? null;
      if (!paneId) {
        const tabId = useTabs.getState().activeTabId;
        if (tabId) {
          const terminalId = usePanesStore.getState().resolveRecordingTerminalId(tabId);
          paneId = ptyTabIdFor(terminalId) ?? terminalId;
        }
      }
      setTargetPane(paneId);
      setText('');
      setOpen(true);
    };
    window.addEventListener('ccie:open-rich-input', onOpen);
    return () => window.removeEventListener('ccie:open-rich-input', onOpen);
  }, []);

  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  if (!open) return null;

  const close = () => {
    setOpen(false);
    setText('');
  };

  const send = () => {
    if (targetPane && text.length > 0) {
      void ptyWrite(targetPane, new TextEncoder().encode(text + '\n')).catch(() => {});
    }
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="rich-input-overlay" onMouseDown={close}>
      <div className="rich-input-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="rich-input-header">Compose input</div>
        <textarea
          ref={ref}
          className="rich-input-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={6}
          placeholder="Type multi-line input; ⌘↵ to send, Esc to cancel"
        />
        <div className="rich-input-footer">
          <button type="button" className="rich-input-btn" onClick={close}>
            Cancel
          </button>
          <button type="button" className="rich-input-btn rich-input-btn--primary" onClick={send}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
