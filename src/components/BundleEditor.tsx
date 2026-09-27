import { useState, useEffect } from "react";
import type { CheckBundle } from "../lib/changeVerify";
import "./BundleEditor.css";

interface BundleEditorProps {
  vendor: string;
  platform: string;
  existing?: CheckBundle;
  onSave: (
    name: string,
    description: string | null,
    commands: string[],
  ) => Promise<void>;
  onCancel: () => void;
}

export function BundleEditor({
  vendor,
  platform,
  existing,
  onSave,
  onCancel,
}: BundleEditorProps) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [commandsText, setCommandsText] = useState(
    existing?.commands.join("\n") ?? "",
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDescription(existing.description ?? "");
      setCommandsText(existing.commands.join("\n"));
    }
  }, [existing]);

  const handleSave = async () => {
    if (!name.trim()) {
      alert("Bundle name is required");
      return;
    }

    const commands = commandsText
      .split("\n")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    if (commands.length === 0) {
      alert("At least one command is required");
      return;
    }

    setSaving(true);
    try {
      await onSave(name.trim(), description.trim() || null, commands);
    } catch (error) {
      console.error("Failed to save bundle:", error);
      alert("Failed to save bundle");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bundle-editor-overlay">
      <div className="bundle-editor-modal">
        <div className="bundle-editor-header">
          <h2>{existing ? "Edit Bundle" : "Create Bundle"}</h2>
          <button
            type="button"
            className="close-btn"
            onClick={onCancel}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="bundle-editor-body">
          <div className="bundle-editor-field">
            <label htmlFor="bundle-name">Name</label>
            <input
              id="bundle-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Pre-Upgrade Checks"
            />
          </div>
          <div className="bundle-editor-field">
            <label htmlFor="bundle-description">Description (optional)</label>
            <textarea
              id="bundle-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this bundle check?"
              rows={3}
            />
          </div>
          <div className="bundle-editor-field">
            <label htmlFor="bundle-commands">
              Commands (one per line)
            </label>
            <textarea
              id="bundle-commands"
              value={commandsText}
              onChange={(e) => setCommandsText(e.target.value)}
              placeholder="show ip interface brief&#10;show running-config&#10;show version"
              rows={10}
            />
          </div>
          <div className="bundle-editor-meta">
            <span>Vendor: {vendor}</span>
            <span>Platform: {platform}</span>
          </div>
        </div>
        <div className="bundle-editor-footer">
          <button
            type="button"
            className="secondary"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
