import { useState, useEffect, useRef } from "react";
import { createSnapshot } from "../lib/structured";
import "./SnapshotPinDialog.css";

interface Props {
  blockId: string;
  defaultName?: string;
  onClose: () => void;
  onPinned?: (id: number, name: string) => void;
}

export function SnapshotPinDialog({ blockId, defaultName, onClose, onPinned }: Props) {
  const [name, setName] = useState(defaultName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const id = await createSnapshot(blockId, name.trim());
      onPinned?.(id, name.trim());
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  return (
    <div className="snapshot-pin-overlay" onClick={onClose}>
      <form
        className="snapshot-pin-dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        data-testid="snapshot-pin-dialog"
      >
        <h3>Pin Snapshot</h3>
        <p>Save the current parsed output for later comparison.</p>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. before-config-change"
          data-testid="snapshot-pin-name"
        />
        {error && <div className="snapshot-pin-error">{error}</div>}
        <div className="snapshot-pin-actions">
          <button type="button" onClick={onClose} className="structured-btn">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || saving}
            className="structured-btn primary"
            data-testid="snapshot-pin-save"
          >
            {saving ? "Saving…" : "Pin"}
          </button>
        </div>
      </form>
    </div>
  );
}
