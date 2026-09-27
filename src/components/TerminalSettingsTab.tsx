import React, { useEffect, useState } from "react";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  NotificationPreferences,
} from "../lib/paneActivity";
import {
  getLogLocations,
  openLogLocation,
  revealLogLocation,
  type LogLocations,
} from "../lib/tauri";
import { useAppearance } from "../theme/AppearanceProvider";
import { createDefaultAppearanceSettings } from "../theme/defaults";
import { APP_THEME_PRESETS } from "../theme/presets";
import type {
  AppearanceSettingsV1,
  TerminalAnsiPalette,
  TerminalPresetId,
} from "../theme/types";
import { APPEARANCE_LIMITS, normalizeHexColor } from "../theme/validation";
import { terminalSettingsForPreset } from "../lib/terminalAppearance";
import { useCommandSuggestionPreferences } from "../hooks/useCommandSuggestionPreferences";
import "./TerminalSettingsTab.css";

const ANSI_FIELDS: Array<[keyof TerminalAnsiPalette, string]> = [
  ["black", "ANSI black"], ["red", "ANSI red"], ["green", "ANSI green"],
  ["yellow", "ANSI yellow"], ["blue", "ANSI blue"], ["magenta", "ANSI magenta"],
  ["cyan", "ANSI cyan"], ["white", "ANSI white"], ["brightBlack", "ANSI bright black"],
  ["brightRed", "ANSI bright red"], ["brightGreen", "ANSI bright green"],
  ["brightYellow", "ANSI bright yellow"], ["brightBlue", "ANSI bright blue"],
  ["brightMagenta", "ANSI bright magenta"], ["brightCyan", "ANSI bright cyan"],
  ["brightWhite", "ANSI bright white"],
];

function clamp(value: string, limits: { min: number; max: number }): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return limits.min;
  return Math.min(limits.max, Math.max(limits.min, number));
}

function colorWithPreservedAlpha(color: string, existing: string): string {
  const normalized = normalizeHexColor(color);
  if (!normalized) return existing;
  return existing.length === 9 ? `${normalized.slice(0, 7)}${existing.slice(7)}` : normalized;
}

function selectionOpacity(color: string): number {
  if (color.length !== 9) return 1;
  return Math.round((Number.parseInt(color.slice(7), 16) / 255) * 100) / 100;
}

function selectionWithOpacity(color: string, opacity: number): string {
  const normalized = normalizeHexColor(color)?.slice(0, 7) ?? color.slice(0, 7);
  const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `${normalized}${alpha}`;
}

function resolvedPaletteForReset(settings: AppearanceSettingsV1): typeof settings.terminal {
  const preset = settings.terminal.preset === "custom"
    ? "follow-app"
    : settings.terminal.preset;
  return terminalSettingsForPreset({
    ...settings,
    terminal: { ...settings.terminal, preset },
  });
}

const TerminalSettingsTab: React.FC = () => {
  const {
    settings: appearanceSettings,
    error: appearanceProviderError,
    hydrated: appearanceHydrated,
    authoritativeState: appearanceAuthoritativeState,
    isSaving: appearanceSaving,
    previewSettings,
    retryAuthoritativeSettings,
    saveSettingsPatch,
  } = useAppearance();
  const [terminalDraft, setTerminalDraft] = useState(appearanceSettings);
  const [appearanceSaveError, setAppearanceSaveError] = useState("");
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [isSavingNotifications, setIsSavingNotifications] = useState(false);
  const [logLocations, setLogLocations] = useState<LogLocations | null>(null);
  const [logError, setLogError] = useState("");
  const [openingLogId, setOpeningLogId] = useState<string | null>(null);
  const {
    preferences: commandSuggestionPreferences,
    updatePreferences: updateCommandSuggestionPreferences,
  } = useCommandSuggestionPreferences();
  const terminalSettingsSaving = appearanceSaving || isSavingNotifications;
  const terminalAppearanceReady = appearanceHydrated && appearanceAuthoritativeState === "ready";

  useEffect(() => {
    void loadPreferences();
    void loadLogLocations();
  }, []);

  useEffect(() => setTerminalDraft(appearanceSettings), [appearanceSettings]);

  const resolvedTerminal = terminalSettingsForPreset(terminalDraft);

  const previewTerminal = (next: typeof terminalDraft) => {
    if (!terminalAppearanceReady || terminalSettingsSaving) return;
    setTerminalDraft(next);
    setAppearanceSaveError("");
    previewSettings(next);
  };

  const retryAppearanceSettings = async () => {
    try {
      await retryAuthoritativeSettings();
    } catch {
      // The provider retains the authoritative failure state and error message.
    }
  };

  const selectTerminalPreset = (preset: TerminalPresetId) => {
    if (preset === "follow-app") {
      previewTerminal({
        ...terminalDraft,
        terminal: { ...terminalDraft.terminal, preset },
      });
      return;
    }
    if (preset === "custom") {
      previewTerminal({
        ...terminalDraft,
        terminal: { ...terminalSettingsForPreset(terminalDraft), preset },
      });
      return;
    }
    const theme = APP_THEME_PRESETS.find((candidate) => candidate.id === preset)?.terminal;
    if (!theme) return;
    previewTerminal({
      ...terminalDraft,
      terminal: {
        ...theme,
        preset,
        fontFamily: terminalDraft.terminal.fontFamily,
        fontSize: terminalDraft.terminal.fontSize,
        fontWeight: terminalDraft.terminal.fontWeight,
        lineHeight: terminalDraft.terminal.lineHeight,
        cursorStyle: terminalDraft.terminal.cursorStyle,
        cursorBlink: terminalDraft.terminal.cursorBlink,
      },
    });
  };

  const updateTerminal = (updates: Partial<typeof terminalDraft.terminal>, custom = false) => {
    const base = custom && terminalDraft.terminal.preset !== "custom"
      ? terminalSettingsForPreset(terminalDraft)
      : terminalDraft.terminal;
    previewTerminal({
      ...terminalDraft,
      terminal: {
        ...base,
        ...updates,
        ...(custom ? { preset: "custom" as const } : {}),
      },
    });
  };

  const resetColors = () => {
    const defaults = resolvedPaletteForReset(terminalDraft);
    updateTerminal({
      foreground: defaults.foreground,
      background: defaults.background,
      cursor: defaults.cursor,
      cursorAccent: defaults.cursorAccent,
      selectionBackground: defaults.selectionBackground,
      ansi: { ...defaults.ansi },
    }, true);
  };

  const resetTypography = () => {
    const defaults = createDefaultAppearanceSettings().terminal;
    updateTerminal({
      fontFamily: defaults.fontFamily,
      fontSize: defaults.fontSize,
      fontWeight: defaults.fontWeight,
      lineHeight: defaults.lineHeight,
    });
  };

  const resetCursor = () => {
    const defaults = createDefaultAppearanceSettings().terminal;
    updateTerminal({ cursorStyle: defaults.cursorStyle, cursorBlink: defaults.cursorBlink });
  };

  const resetAnsiPalette = () => {
    const resolved = resolvedPaletteForReset(terminalDraft);
    updateTerminal({ ansi: { ...resolved.ansi } }, true);
  };

  const loadPreferences = async () => {
    try {
      const loaded = await getNotificationPreferences();
      setPrefs(loaded);
    } catch (error) {
      console.error("Failed to load notification preferences:", error);
    }
  };

  const loadLogLocations = async () => {
    setLogError("");
    try {
      setLogLocations(await getLogLocations());
    } catch (error) {
      console.error("Failed to load log locations:", error);
      setLogError(`Failed to load log locations: ${String(error)}`);
    }
  };

  const handleLogAction = async (id: string, action: "open" | "reveal") => {
    const actionKey = `${action}:${id}`;
    setOpeningLogId(actionKey);
    setLogError("");
    try {
      if (action === "open") {
        await openLogLocation(id);
      } else {
        await revealLogLocation(id);
      }
    } catch (error) {
      console.error(`Failed to ${action} log location:`, error);
      setLogError(`Failed to ${action} log location: ${String(error)}`);
    } finally {
      setOpeningLogId(null);
    }
  };

  const handleSave = async () => {
    if (!prefs || !terminalAppearanceReady || terminalSettingsSaving) return;

    setIsSavingNotifications(true);
    setAppearanceSaveError("");
    try {
      await saveSettingsPatch({ terminal: terminalDraft.terminal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to save terminal appearance:", error);
      setAppearanceSaveError(
        `Terminal appearance and notification settings were not saved: ${message}`,
      );
      setIsSavingNotifications(false);
      return;
    }

    try {
      await updateNotificationPreferences(prefs);
      alert("Terminal settings saved successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Terminal appearance saved, but notification settings failed:", error);
      setAppearanceSaveError(
        `Terminal appearance saved, but notification settings failed: ${message}`,
      );
    } finally {
      setIsSavingNotifications(false);
    }
  };

  return (
    <div className="terminal-settings-tab">
      <section className="terminal-appearance" aria-labelledby="terminal-appearance-heading">
        <div className="terminal-appearance__heading">
          <div>
            <h2 id="terminal-appearance-heading">Terminal appearance</h2>
            <p>Preview changes in every open terminal, then save them for new and restored sessions.</p>
          </div>
          <button
            type="button"
            className="secondary-btn"
            disabled={!prefs || !terminalAppearanceReady || terminalSettingsSaving}
            aria-busy={terminalSettingsSaving}
            onClick={() => void handleSave()}
          >
            {terminalSettingsSaving ? "Saving terminal settings..." : "Save terminal settings"}
          </button>
        </div>

        {(appearanceSaveError || appearanceProviderError) && (
          <p className="terminal-appearance__error" role="alert">
            {appearanceSaveError || appearanceProviderError}
          </p>
        )}
        {appearanceAuthoritativeState === "failed" && (
          <button
            type="button"
            className="secondary-btn"
            onClick={() => void retryAppearanceSettings()}
          >
            Retry loading appearance settings
          </button>
        )}

        <fieldset className="terminal-appearance__section" disabled={!terminalAppearanceReady || terminalSettingsSaving}>
          <legend>Terminal palette</legend>
          <div className="terminal-appearance__presets" role="radiogroup" aria-label="Terminal preset">
            <label><input type="radio" name="terminal-preset" checked={terminalDraft.terminal.preset === "follow-app"} onChange={() => selectTerminalPreset("follow-app")} /> Follow application theme</label>
            {APP_THEME_PRESETS.map((preset) => (
              <label key={preset.id}><input type="radio" name="terminal-preset" checked={terminalDraft.terminal.preset === preset.id} onChange={() => selectTerminalPreset(preset.id)} /> {preset.label}</label>
            ))}
            <label><input type="radio" name="terminal-preset" checked={terminalDraft.terminal.preset === "custom"} onChange={() => selectTerminalPreset("custom")} /> Custom</label>
          </div>
        </fieldset>

        <fieldset className="terminal-appearance__section" disabled={!terminalAppearanceReady || terminalSettingsSaving}>
          <legend>Core colors</legend>
          <div className="terminal-appearance__grid">
            {([
              ["foreground", "Foreground color"], ["background", "Background color"],
              ["cursor", "Cursor color"], ["cursorAccent", "Cursor accent color"],
            ] as const).map(([key, label]) => (
              <label key={key}>{label}<input aria-label={label} type="color" value={resolvedTerminal[key].slice(0, 7)} onChange={(event) => updateTerminal({ [key]: normalizeHexColor(event.target.value) ?? resolvedTerminal[key] }, true)} /></label>
            ))}
            <label>Selection color<input aria-label="Selection color" type="color" value={resolvedTerminal.selectionBackground.slice(0, 7)} onChange={(event) => updateTerminal({ selectionBackground: colorWithPreservedAlpha(event.target.value, resolvedTerminal.selectionBackground) }, true)} /></label>
            <label>Selection opacity<input aria-label="Selection opacity" type="number" min="0" max="1" step="0.01" value={selectionOpacity(resolvedTerminal.selectionBackground)} onChange={(event) => updateTerminal({ selectionBackground: selectionWithOpacity(resolvedTerminal.selectionBackground, Number(event.target.value)) }, true)} /></label>
          </div>
          <button type="button" className="secondary-btn" onClick={resetColors}>Reset colors</button>
        </fieldset>

        <fieldset className="terminal-appearance__section" disabled={!terminalAppearanceReady || terminalSettingsSaving}>
          <legend>ANSI palette</legend>
          <div className="terminal-appearance__grid terminal-appearance__ansi">
            {ANSI_FIELDS.map(([key, label]) => (
              <label key={key}>{label}<input aria-label={label} type="color" value={resolvedTerminal.ansi[key].slice(0, 7)} onChange={(event) => updateTerminal({ ansi: { ...resolvedTerminal.ansi, [key]: normalizeHexColor(event.target.value) ?? resolvedTerminal.ansi[key] } }, true)} /></label>
            ))}
          </div>
          <div className="terminal-appearance__preview" aria-label="ANSI preview">
            <strong>ANSI preview</strong>
            <code style={{ color: resolvedTerminal.ansi.red }}>red</code><code style={{ color: resolvedTerminal.ansi.green }}>green</code><code style={{ color: resolvedTerminal.ansi.yellow }}>yellow</code><code style={{ color: resolvedTerminal.ansi.blue }}>blue</code><code style={{ color: resolvedTerminal.ansi.brightMagenta }}>magenta</code><code style={{ color: resolvedTerminal.ansi.brightCyan }}>cyan</code>
          </div>
          <button type="button" className="secondary-btn" onClick={resetAnsiPalette}>Reset ANSI palette</button>
        </fieldset>

        <fieldset className="terminal-appearance__section" disabled={!terminalAppearanceReady || terminalSettingsSaving}>
          <legend>Typography</legend>
          <div className="terminal-appearance__grid">
            <label>Font family<input aria-label="Font family" type="text" value={terminalDraft.terminal.fontFamily} onChange={(event) => updateTerminal({ fontFamily: event.target.value.trim() || createDefaultAppearanceSettings().terminal.fontFamily })} /></label>
            <label>Font size<input aria-label="Font size" type="number" min={APPEARANCE_LIMITS.fontSize.min} max={APPEARANCE_LIMITS.fontSize.max} value={terminalDraft.terminal.fontSize} onChange={(event) => updateTerminal({ fontSize: clamp(event.target.value, APPEARANCE_LIMITS.fontSize) })} /></label>
            <label>Font weight<input aria-label="Font weight" type="number" min={APPEARANCE_LIMITS.fontWeight.min} max={APPEARANCE_LIMITS.fontWeight.max} value={terminalDraft.terminal.fontWeight} onChange={(event) => updateTerminal({ fontWeight: clamp(event.target.value, APPEARANCE_LIMITS.fontWeight) })} /></label>
            <label>Line height<input aria-label="Line height" type="number" min={APPEARANCE_LIMITS.lineHeight.min} max={APPEARANCE_LIMITS.lineHeight.max} step="0.05" value={terminalDraft.terminal.lineHeight} onChange={(event) => updateTerminal({ lineHeight: clamp(event.target.value, APPEARANCE_LIMITS.lineHeight) })} /></label>
          </div>
          <button type="button" className="secondary-btn" onClick={resetTypography}>Reset typography</button>
        </fieldset>

        <fieldset className="terminal-appearance__section" disabled={!terminalAppearanceReady || terminalSettingsSaving}>
          <legend>Cursor</legend>
          <label>Cursor style<select aria-label="Cursor style" value={terminalDraft.terminal.cursorStyle} onChange={(event) => updateTerminal({ cursorStyle: event.target.value as typeof terminalDraft.terminal.cursorStyle })}><option value="block">Block</option><option value="bar">Bar</option><option value="underline">Underline</option></select></label>
          <label><input type="checkbox" checked={terminalDraft.terminal.cursorBlink} onChange={(event) => updateTerminal({ cursorBlink: event.target.checked })} /> Blinking cursor</label>
          <button type="button" className="secondary-btn" onClick={resetCursor}>Reset cursor</button>
        </fieldset>
      </section>

      <section aria-labelledby="command-suggestions-heading">
        <h2 id="command-suggestions-heading">Command suggestions</h2>
        <p>
          Command history matches remain instant from two characters onward.
          These controls apply only to AI-generated suggestions.
        </p>
        <div className="settings-group">
          <label>
            <input
              type="checkbox"
              checked={commandSuggestionPreferences.requireFiveCharactersForAi}
              onChange={(event) => updateCommandSuggestionPreferences({
                requireFiveCharactersForAi: event.target.checked,
              })}
            />
            Require 5 characters for AI suggestions
          </label>
        </div>
        <div className="settings-group">
          <label>
            <input
              type="checkbox"
              checked={commandSuggestionPreferences.waitForTwoSecondsOfInactivity}
              onChange={(event) => updateCommandSuggestionPreferences({
                waitForTwoSecondsOfInactivity: event.target.checked,
              })}
            />
            Wait for 2 seconds of inactivity
          </label>
        </div>
      </section>

      <h2>Notification Settings</h2>

      {!prefs ? (
        <p className="log-settings-status">Loading notification settings…</p>
      ) : (
        <>
          <div className="settings-group">
            <label htmlFor="min-duration">
              Minimum duration for notification (seconds):
            </label>
            <input
              id="min-duration"
              type="number"
              value={String(prefs.minDurationSecs)}
              disabled={terminalSettingsSaving}
              onChange={(e) =>
                setPrefs({
                  ...prefs,
                  minDurationSecs: parseInt(e.target.value, 10),
                })
              }
              min="1"
            />
          </div>

          <div className="settings-group">
            <label>
              <input
                type="checkbox"
                checked={prefs.notifyOnNonzeroExit}
                disabled={terminalSettingsSaving}
                onChange={(e) =>
                  setPrefs({ ...prefs, notifyOnNonzeroExit: e.target.checked })
                }
              />
              Notify on non-zero exit code
            </label>
          </div>

          <div className="settings-group">
            <label>
              <input
                type="checkbox"
                checked={prefs.notifyOnAgentOutput}
                disabled={terminalSettingsSaving}
                onChange={(e) =>
                  setPrefs({ ...prefs, notifyOnAgentOutput: e.target.checked })
                }
              />
              Notify on agent output
            </label>
          </div>

          <div className="settings-group">
            <label htmlFor="keywords">
              Keyword triggers (comma-separated):
            </label>
            <input
              id="keywords"
              type="text"
              value={prefs.keywordTriggers.join(", ")}
              disabled={terminalSettingsSaving}
              onChange={(e) =>
                setPrefs({
                  ...prefs,
                  keywordTriggers: e.target.value
                    .split(",")
                    .map((s) => s.trim()),
                })
              }
            />
          </div>

          <div className="settings-group">
            <label htmlFor="ignore-commands">
              Ignore commands (comma-separated):
            </label>
            <input
              id="ignore-commands"
              type="text"
              value={prefs.ignoreCommands.join(", ")}
              disabled={terminalSettingsSaving}
              onChange={(e) =>
                setPrefs({
                  ...prefs,
                  ignoreCommands: e.target.value
                    .split(",")
                    .map((s) => s.trim()),
                })
              }
            />
          </div>

          <div className="settings-group">
            <label>
              <input
                type="checkbox"
                checked={prefs.enableSound}
                disabled={terminalSettingsSaving}
                onChange={(e) =>
                  setPrefs({ ...prefs, enableSound: e.target.checked })
                }
              />
              Enable notification sound
            </label>
          </div>

          <button onClick={handleSave} disabled={!terminalAppearanceReady || terminalSettingsSaving} className="save-btn">
            {terminalSettingsSaving ? "Saving terminal settings..." : "Save terminal settings"}
          </button>
        </>
      )}

      <section
        className="log-settings-section"
        aria-labelledby="diagnostic-logs-heading"
      >
        <div className="log-settings-heading">
          <div>
            <h2 id="diagnostic-logs-heading">Diagnostic logs</h2>
            <p>
              Open TerminAI logs in your system viewer or reveal them in the
              file browser.
            </p>
          </div>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => void loadLogLocations()}
          >
            Refresh
          </button>
        </div>

        {logError && (
          <p className="log-settings-error" role="alert">
            {logError}
          </p>
        )}

        {!logLocations ? (
          <p className="log-settings-status">Loading log locations…</p>
        ) : (
          <>
            <div className="log-directory-row">
              <div>
                <strong>Log folder</strong>
                <code>{logLocations.directory}</code>
              </div>
              <button
                type="button"
                className="secondary-btn"
                aria-label="Open log folder"
                disabled={openingLogId === "open:directory"}
                onClick={() => void handleLogAction("directory", "open")}
              >
                {openingLogId === "open:directory" ? "Opening…" : "Open folder"}
              </button>
            </div>

            <div className="log-file-list">
              {logLocations.files.map((file) => (
                <div className="log-file-row" key={file.id}>
                  <div className="log-file-details">
                    <div className="log-file-title">
                      <strong>{file.label}</strong>
                      <span
                        className={
                          file.exists ? "log-available" : "log-pending"
                        }
                      >
                        {file.exists
                          ? "Available"
                          : file.id === "sandbox_incidents"
                            ? "Created when the first incident occurs"
                            : "Not created yet"}
                      </span>
                    </div>
                    <p>{file.description}</p>
                    <code>{file.path}</code>
                  </div>
                  <div className="log-file-actions">
                    <button
                      type="button"
                      className="secondary-btn"
                      aria-label={`Open ${file.label}`}
                      disabled={
                        !file.exists || openingLogId === `open:${file.id}`
                      }
                      onClick={() => void handleLogAction(file.id, "open")}
                    >
                      {openingLogId === `open:${file.id}` ? "Opening…" : "Open"}
                    </button>
                    <button
                      type="button"
                      className="secondary-btn"
                      aria-label={`Show ${file.label} in folder`}
                      disabled={
                        !file.exists || openingLogId === `reveal:${file.id}`
                      }
                      onClick={() => void handleLogAction(file.id, "reveal")}
                    >
                      Show in folder
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
};

export default TerminalSettingsTab;
