import { useEffect, useState } from "react";
import { useZedMode } from "../editor/ZedModeProvider";
import type { EditorMode } from "../../lib/tauri";
import { useAppearance } from "../../theme/AppearanceProvider";
import type { AppearanceSettingsV1, EditorThemeId } from "../../theme/types";
import "./EditorSettingsTab.css";

export default function EditorSettingsTab() {
  const { mode, vimEnabled, setMode, setVimEnabled } = useZedMode();
  const {
    settings: appearanceSettings,
    error: appearanceProviderError,
    isSaving: appearanceSaving,
    previewSettings,
    saveSettingsPatch,
  } = useAppearance();
  const [appearanceDraft, setAppearanceDraft] = useState(appearanceSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setAppearanceDraft(appearanceSettings), [appearanceSettings]);

  const previewEditorTheme = (editorTheme: EditorThemeId) => {
    if (appearanceSaving) return;
    const next: AppearanceSettingsV1 = { ...appearanceDraft, editorTheme };
    setAppearanceDraft(next);
    previewSettings(next);
  };

  const saveEditorAppearance = async () => {
    if (appearanceSaving) return;
    setError(null);
    try {
      await saveSettingsPatch({ editorTheme: appearanceDraft.editorTheme });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

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
          Changes apply immediately. Zed Mode keeps Monaco and adds behavior,
          chrome, keybindings, and optional Vim editing; colors are selected below.
        </p>
      </div>

      <div className="editor-settings-section">
        <fieldset disabled={appearanceSaving}>
          <legend>Editor color theme</legend>
          <p className="editor-settings-help">
            Preview a color choice immediately, then save it for all TerminAI windows.
          </p>
          <label>
            <input
              type="radio"
              name="editor-color-theme"
              value="follow-app"
              checked={appearanceDraft.editorTheme === "follow-app"}
              onChange={() => previewEditorTheme("follow-app")}
            />
            Follow application theme
          </label>
          <label>
            <input
              type="radio"
              name="editor-color-theme"
              value="classic-dark"
              checked={appearanceDraft.editorTheme === "classic-dark"}
              onChange={() => previewEditorTheme("classic-dark")}
            />
            Classic Dark
          </label>
          <label>
            <input
              type="radio"
              name="editor-color-theme"
              value="zed-one-dark"
              checked={appearanceDraft.editorTheme === "zed-one-dark"}
              onChange={() => previewEditorTheme("zed-one-dark")}
            />
            Zed One Dark
          </label>
          <label>
            <input
              type="radio"
              name="editor-color-theme"
              value="slate-grey"
              checked={appearanceDraft.editorTheme === "slate-grey"}
              onChange={() => previewEditorTheme("slate-grey")}
            />
            Slate Grey
          </label>
          <label>
            <input
              type="radio"
              name="editor-color-theme"
              value="matrix"
              checked={appearanceDraft.editorTheme === "matrix"}
              onChange={() => previewEditorTheme("matrix")}
            />
            Matrix
          </label>
          <button type="button" onClick={() => void saveEditorAppearance()}>
            Save editor appearance
          </button>
        </fieldset>
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

      {(error || appearanceProviderError) && (
        <div className="editor-settings-error" role="alert">
          {error || appearanceProviderError}
        </div>
      )}
    </section>
  );
}
