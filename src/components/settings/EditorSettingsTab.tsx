import { useState } from "react";
import { useZedMode } from "../editor/ZedModeProvider";
import type { EditorMode } from "../../lib/tauri";
import "./EditorSettingsTab.css";

export default function EditorSettingsTab() {
  const { mode, vimEnabled, setMode, setVimEnabled } = useZedMode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectMode = async (nextMode: EditorMode) => {
    if (nextMode === mode) return;
    setBusy(true);
    setError(null);
    try {
      await setMode(nextMode);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleVim = async (enabled: boolean) => {
    setError(null);
    try {
      await setVimEnabled(enabled);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section className="editor-settings-tab" data-testid="editor-settings-tab">
      <header>
        <h2>Editor</h2>
        <p>Choose the editor experience used by all code editor tabs.</p>
      </header>

      <div className="editor-settings-section">
        <h3>Editor style</h3>
        <div className="editor-style-picker" role="group" aria-label="Editor style">
          <button
            type="button"
            aria-pressed={mode === "monaco"}
            disabled={busy}
            data-testid="editor-mode-monaco"
            onClick={() => void selectMode("monaco")}
          >
            Monaco (classic)
          </button>
          <button
            type="button"
            aria-pressed={mode === "zed"}
            disabled={busy}
            data-testid="editor-mode-zed"
            onClick={() => void selectMode("zed")}
          >
            Zed Mode
          </button>
        </div>
        <p className="editor-settings-help">
          Changes apply immediately. Zed Mode keeps Monaco and adds Zed-style
          theme, chrome, keybindings, and optional Vim editing.
        </p>
      </div>

      <div className="editor-settings-section">
        <label className="editor-vim-toggle">
          <span>
            <strong>Vim mode</strong>
            <small>Enable modal editing inside Zed Mode editors.</small>
          </span>
          <input
            type="checkbox"
            aria-label="Vim mode"
            checked={vimEnabled}
            disabled={mode !== "zed"}
            onChange={(event) => void toggleVim(event.target.checked)}
          />
        </label>
      </div>

      {error && <div className="editor-settings-error" role="alert">{error}</div>}
    </section>
  );
}
