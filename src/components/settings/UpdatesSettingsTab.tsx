import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdateStore } from "../../state/updateStore";
import "./UpdatesSettingsTab.css";

/**
 * Settings → Updates. Shows the installed version, a manual "Check now" button,
 * and — when an update is available — release notes plus an install button. All
 * state comes from the shared `useUpdateStore`, so the floating toast and the
 * status-bar pill reflect any check kicked off here.
 */
export default function UpdatesSettingsTab() {
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const available = useUpdateStore((s) => s.available);
  const checking = useUpdateStore((s) => s.checking);
  const downloading = useUpdateStore((s) => s.downloading);
  const error = useUpdateStore((s) => s.error);
  const lastCheckedAt = useUpdateStore((s) => s.lastCheckedAt);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);

  useEffect(() => {
    getVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion("unknown"));
  }, []);

  const upToDate = !available && lastCheckedAt !== null && !error;

  return (
    <div className="updates-tab">
      <div className="updates-header">
        <h2>Updates</h2>
        <p className="updates-subtitle">
          TerminAI checks for updates automatically on launch. You can also check
          manually here. Updates are signed and verified before they install; your
          sessions, vault, and RAG data are preserved across upgrades.
        </p>
      </div>

      <div className="updates-section">
        <div className="updates-version-row">
          <div>
            <span className="updates-label">Installed version</span>
            <span className="updates-version">v{currentVersion || "…"}</span>
          </div>
          <button
            type="button"
            className="updates-check-btn"
            onClick={() => checkForUpdate(true)}
            disabled={checking || downloading}
          >
            {checking ? "Checking…" : "Check now"}
          </button>
        </div>

        {lastCheckedAt !== null && (
          <div className="updates-last-checked">
            Last checked {new Date(lastCheckedAt).toLocaleString()}
          </div>
        )}
      </div>

      {error && <div className="updates-error">Update check failed: {error}</div>}

      {upToDate && (
        <div className="updates-status-ok">You're on the latest version.</div>
      )}

      {available && (
        <div className="updates-section updates-available">
          <h3>Version {available.version} available</h3>
          {available.body && <pre className="updates-notes">{available.body}</pre>}
          <button
            type="button"
            className="updates-install-btn"
            onClick={() => downloadAndInstall()}
            disabled={downloading}
          >
            {downloading ? "Downloading & installing…" : "Update & Restart"}
          </button>
        </div>
      )}
    </div>
  );
}
