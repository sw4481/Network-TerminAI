import { useState } from "react";
import "./PasswordPromptModal.css";

interface PasswordPromptModalProps {
  isOpen: boolean;
  connectionName: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function PasswordPromptModal({
  isOpen,
  connectionName,
  onSubmit,
  onCancel,
}: PasswordPromptModalProps) {
  const [password, setPassword] = useState("");

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password) {
      onSubmit(password);
      setPassword(""); // Clear for next time
    }
  };

  const handleCancel = () => {
    setPassword("");
    onCancel();
  };

  return (
    <div className="password-prompt-overlay" onClick={handleCancel}>
      <div
        className="password-prompt-modal"
        onClick={(e) => e.stopPropagation()}
        data-testid="password-prompt-modal"
      >
        <div className="password-prompt-header">
          <h3>SSH Password Required</h3>
          <button
            className="password-prompt-close"
            onClick={handleCancel}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="password-prompt-form">
          <p className="password-prompt-message">
            Enter password for <strong>{connectionName}</strong>:
          </p>

          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            className="password-prompt-input"
            data-testid="password-input"
          />

          <div className="password-prompt-actions">
            <button
              type="button"
              onClick={handleCancel}
              className="password-prompt-btn secondary"
              data-testid="password-cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!password}
              className="password-prompt-btn primary"
              data-testid="password-submit"
            >
              Connect
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
