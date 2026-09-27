import { useEffect, useState } from "react";
import { useAppearance } from "../../theme/AppearanceProvider";
import { createDefaultAppearanceSettings } from "../../theme/defaults";
import { APP_THEME_PRESETS } from "../../theme/presets";
import type { AppearanceSettingsV1, AppThemeId } from "../../theme/types";
import "./AppearanceSettingsTab.css";

function withTheme(settings: AppearanceSettingsV1, appTheme: AppThemeId): AppearanceSettingsV1 {
  return { ...settings, appTheme };
}

export function AppearanceSettingsTab() {
  const {
    settings,
    error,
    isSaving: providerSaving,
    previewSettings,
    saveSettingsPatch,
  } = useAppearance();
  const [draft, setDraft] = useState(settings);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const isSaving = providerSaving || saveStatus === "saving";

  useEffect(() => setDraft(settings), [settings]);

  const preview = (next: AppearanceSettingsV1) => {
    if (isSaving) return;
    setDraft(next);
    setSaveStatus("idle");
    previewSettings(next);
  };

  const save = async () => {
    if (isSaving) return;
    setSaveStatus("saving");
    try {
      await saveSettingsPatch({
        appTheme: draft.appTheme,
        effects: draft.effects,
      });
      setSaveStatus("saved");
    } catch {
      // The provider keeps the non-fatal error visible in this tab.
      setSaveStatus("failed");
    }
  };

  const reset = () => preview(createDefaultAppearanceSettings());
  const matrixEffectsAvailable = draft.appTheme === "matrix";
  const saveMessage = {
    idle: "",
    saving: "Saving appearance…",
    saved: "Appearance saved.",
    failed: "Appearance was not saved.",
  }[saveStatus];

  return (
    <section
      className="appearance-settings tab-content"
      aria-labelledby="appearance-heading"
      aria-busy={saveStatus === "saving"}
    >
      <header className="appearance-settings__header">
        <div>
          <h2 id="appearance-heading">Appearance</h2>
          <p className="muted">Preview a preset immediately, then save it for every TerminAI window.</p>
        </div>
      </header>

      {error && <p className="appearance-settings__error" role="alert">{error}</p>}

      <fieldset className="appearance-settings__presets" disabled={isSaving}>
        <legend>Application theme</legend>
        <div className="appearance-settings__cards">
          {APP_THEME_PRESETS.map((preset) => (
            <label className="appearance-card" key={preset.id} data-theme-preview={preset.id}>
              <input
                type="radio"
                name="application-theme"
                value={preset.id}
                checked={draft.appTheme === preset.id}
                onChange={() => preview(withTheme(draft, preset.id))}
              />
              <span className="appearance-card__swatch" aria-hidden="true" />
              <span className="appearance-card__title">{preset.label}</span>
              <span className="appearance-card__description">{preset.description}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="appearance-settings__effects">
        <legend>Matrix effects</legend>
        <p className="muted" id="matrix-effects-description">
          {matrixEffectsAvailable
            ? "These static overlays automatically turn off when reduced motion is requested."
            : "Select Matrix to enable these effects. They automatically turn off when reduced motion is requested."}
        </p>
        <label>
          <input
            type="checkbox"
            disabled={!matrixEffectsAvailable || isSaving}
            aria-describedby="matrix-effects-description"
            checked={draft.effects.matrixScanlines}
            onChange={(event) => preview({ ...draft, effects: { ...draft.effects, matrixScanlines: event.target.checked } })}
          />
          Enable Matrix scanlines
        </label>
        <label>
          <input
            type="checkbox"
            disabled={!matrixEffectsAvailable || isSaving}
            aria-describedby="matrix-effects-description"
            checked={draft.effects.matrixGlow}
            onChange={(event) => preview({ ...draft, effects: { ...draft.effects, matrixGlow: event.target.checked } })}
          />
          Enable Matrix glow
        </label>
        <label>
          Motion preference
          <select
            aria-label="Matrix motion preference"
            disabled={!matrixEffectsAvailable || isSaving}
            value={draft.effects.motion}
            onChange={(event) => preview({ ...draft, effects: { ...draft.effects, motion: event.target.value as AppearanceSettingsV1["effects"]["motion"] } })}
          >
            <option value="system">Follow system</option>
            <option value="reduced">Reduce motion</option>
          </select>
        </label>
      </fieldset>

      <div className="appearance-settings__actions">
        <button
          type="button"
          className="primary"
          disabled={isSaving}
          onClick={() => void save()}
        >
          Save appearance
        </button>
        <button type="button" disabled={isSaving} onClick={reset}>Reset appearance</button>
      </div>
      {saveMessage && (
        <p
          className={`appearance-settings__save-status appearance-settings__save-status--${saveStatus}`}
          role={saveStatus === "failed" ? "alert" : "status"}
          aria-live={saveStatus === "failed" ? "assertive" : "polite"}
        >
          {saveMessage}
        </p>
      )}
    </section>
  );
}
