import { useState } from "react";
import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings as Settings,
} from "./MonacoEditor";
import "./EditorSettings.css";

type EditorSettingsProps = {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onReset?: () => void;
  onClose: () => void;
};

export function EditorSettingsPanel({
  settings,
  onSave,
  onReset,
  onClose,
}: EditorSettingsProps) {
  const [local, setLocal] = useState<Settings>(settings);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setLocal((s) => ({ ...s, [key]: value }));

  const handleSave = () => {
    onSave(local);
    onClose();
  };

  const handleReset = () => {
    setLocal(DEFAULT_EDITOR_SETTINGS);
    onReset?.();
  };

  return (
    <div
      className="editor-settings-panel"
      data-testid="editor-settings"
      role="dialog"
      aria-label="Editor settings"
    >
      <div className="settings-header">
        <h3>Editor Settings</h3>
        <button onClick={onClose} className="close-button" aria-label="Close">
          ✕
        </button>
      </div>

      <div className="settings-body">
        <div className="setting-row">
          <label htmlFor="font-size">Font Size</label>
          <input
            id="font-size"
            type="number"
            min={10}
            max={28}
            value={local.fontSize}
            onChange={(e) =>
              update("fontSize", clamp(parseInt(e.target.value, 10) || 14, 10, 28))
            }
          />
        </div>

        <div className="setting-row">
          <label htmlFor="tab-size">Tab Size</label>
          <input
            id="tab-size"
            type="number"
            min={1}
            max={8}
            value={local.tabSize}
            onChange={(e) =>
              update("tabSize", clamp(parseInt(e.target.value, 10) || 2, 1, 8))
            }
          />
        </div>

        <div className="setting-row">
          <label htmlFor="word-wrap">Word Wrap</label>
          <select
            id="word-wrap"
            value={local.wordWrap}
            onChange={(e) => update("wordWrap", e.target.value as "on" | "off")}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </div>

        <div className="setting-row checkbox">
          <label>
            <input
              type="checkbox"
              checked={local.minimap}
              onChange={(e) => update("minimap", e.target.checked)}
            />
            Show Minimap
          </label>
        </div>

        <div className="setting-row checkbox">
          <label>
            <input
              type="checkbox"
              checked={local.lineNumbers}
              onChange={(e) => update("lineNumbers", e.target.checked)}
            />
            Show Line Numbers
          </label>
        </div>

        <div className="setting-row checkbox">
          <label>
            <input
              type="checkbox"
              checked={local.renderWhitespace}
              onChange={(e) => update("renderWhitespace", e.target.checked)}
            />
            Render Whitespace
          </label>
        </div>

        <div className="setting-row checkbox">
          <label>
            <input
              type="checkbox"
              checked={local.columnSelection}
              onChange={(event) =>
                update("columnSelection", event.target.checked)
              }
            />
            Column Selection
          </label>
        </div>
      </div>

      <div className="settings-footer">
        <button onClick={handleReset} className="secondary">
          Reset
        </button>
        <div className="footer-spacer" />
        <button onClick={onClose}>Cancel</button>
        <button onClick={handleSave} className="primary">
          Save
        </button>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
