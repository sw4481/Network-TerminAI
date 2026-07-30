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
  const { settings, error, previewSettings, setSettings } = useAppearance();
  const [draft, setDraft] = useState(settings);

  useEffect(() => setDraft(settings), [settings]);

  const preview = (next: AppearanceSettingsV1) => {
    setDraft(next);
    previewSettings(next);
  };

  const save = async () => {
    try {
      await setSettings(draft);
    } catch {
      // The provider keeps the non-fatal error visible in this tab.
    }
  };

  const reset = () => preview(createDefaultAppearanceSettings());

  return (
    <section className="appearance-settings tab-content" aria-labelledby="appearance-heading">
      <header className="appearance-settings__header">
        <div>
          <h2 id="appearance-heading">Appearance</h2>
          <p className="muted">Preview a preset immediately, then save it for every TerminAI window.</p>
        </div>
      </header>

      {error && <p className="appearance-settings__error" role="alert">{error}</p>}

      <fieldset className="appearance-settings__presets">
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
        <p className="muted">These static overlays only apply to Matrix and automatically turn off when reduced motion is requested.</p>
        <label>
          <input
            type="checkbox"
            checked={draft.effects.matrixScanlines}
            onChange={(event) => preview({ ...draft, effects: { ...draft.effects, matrixScanlines: event.target.checked } })}
          />
          Enable Matrix scanlines
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.effects.matrixGlow}
            onChange={(event) => preview({ ...draft, effects: { ...draft.effects, matrixGlow: event.target.checked } })}
          />
          Enable Matrix glow
        </label>
        <label>
          Motion preference
          <select
            aria-label="Matrix motion preference"
            value={draft.effects.motion}
            onChange={(event) => preview({ ...draft, effects: { ...draft.effects, motion: event.target.value as AppearanceSettingsV1["effects"]["motion"] } })}
          >
            <option value="system">Follow system</option>
            <option value="reduced">Reduce motion</option>
          </select>
        </label>
      </fieldset>

      <div className="appearance-settings__actions">
        <button type="button" className="primary" onClick={() => void save()}>Save appearance</button>
        <button type="button" onClick={reset}>Reset appearance</button>
      </div>
    </section>
  );
}
