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
import "./TerminalSettingsTab.css";

const TerminalSettingsTab: React.FC = () => {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [logLocations, setLogLocations] = useState<LogLocations | null>(null);
  const [logError, setLogError] = useState("");
  const [openingLogId, setOpeningLogId] = useState<string | null>(null);

  useEffect(() => {
    void loadPreferences();
    void loadLogLocations();
  }, []);

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
    if (!prefs) return;

    setIsSaving(true);
    try {
      await updateNotificationPreferences(prefs);
      alert("Preferences saved successfully");
    } catch (error) {
      console.error("Failed to save preferences:", error);
      alert("Failed to save preferences");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="terminal-settings-tab">
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
                onChange={(e) =>
                  setPrefs({ ...prefs, enableSound: e.target.checked })
                }
              />
              Enable notification sound
            </label>
          </div>

          <button onClick={handleSave} disabled={isSaving} className="save-btn">
            {isSaving ? "Saving..." : "Save"}
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
