import React, { useEffect, useRef, useState } from 'react';
import './BrowserUrlModal.css';

interface BrowserUrlModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (url: string) => void;
}

/**
 * URL entry modal for opening a browser window. We use an inline modal rather
 * than window.prompt() because window.prompt is blocked in the Tauri webview
 * (returns null) — see FanoutGroupsPanel / IntentEditor for the same pattern.
 */
const BrowserUrlModal: React.FC<BrowserUrlModalProps> = ({ isOpen, onClose, onSubmit }) => {
  const [url, setUrl] = useState('https://');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setUrl('https://');
      // Focus the input once the modal renders.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (trimmed && trimmed !== 'https://') {
      onSubmit(trimmed);
      onClose();
    }
  };

  return (
    <div className="browser-url-modal-overlay" onClick={onClose} data-testid="browser-url-modal">
      <div className="browser-url-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Open Browser Window</h3>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
            placeholder="https://example.com"
            data-testid="browser-url-input"
          />
          <div className="browser-url-modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" data-testid="browser-url-open">
              Open
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default BrowserUrlModal;
