import { useEffect } from "react";
import { useUpdateStore } from "../state/updateStore";

/**
 * Floating bottom-right toast that appears when an app update is available.
 * On mount it kicks off a single automatic update check (skipped in dev). All
 * state lives in the shared `useUpdateStore` so the status-bar pill and the
 * Settings → Updates tab stay in sync with this toast.
 */
export function UpdateNotification() {
  const available = useUpdateStore((s) => s.available);
  const downloading = useUpdateStore((s) => s.downloading);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const error = useUpdateStore((s) => s.error);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);
  const dismiss = useUpdateStore((s) => s.dismiss);

  useEffect(() => {
    // Skip the automatic check in development — no updater endpoint locally.
    if (import.meta.env.DEV) {
      console.log("Update checks disabled in development mode");
      return;
    }
    checkForUpdate(false);
  }, [checkForUpdate]);

  if (!available || dismissed) {
    return null;
  }

  return (
    <div
      style={{
        position: "fixed",
        bottom: "20px",
        right: "20px",
        background: "var(--surface-terminal)",
        border: "1px solid var(--border-default)",
        borderRadius: "8px",
        padding: "16px",
        maxWidth: "400px",
        boxShadow: "0 4px 12px rgb(var(--backdrop-rgb) / 0.3)",
        zIndex: 9999,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>
            Update Available
          </h3>
          <p style={{ margin: "0 0 8px 0", fontSize: "13px", color: "var(--text-primary)" }}>
            Version {available.version} is now available
            {available.currentVersion && ` (current: ${available.currentVersion})`}
          </p>
          {available.body && (
            <p style={{ margin: "0 0 12px 0", fontSize: "12px", color: "var(--text-primary)", maxHeight: "60px", overflow: "auto" }}>
              {available.body}
            </p>
          )}
          {error && (
            <p style={{ margin: "0 0 12px 0", fontSize: "12px", color: "var(--text-primary)" }}>
              {error}
            </p>
          )}
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => downloadAndInstall()}
              disabled={downloading}
              style={{
                background: "var(--surface-2)",
                border: "none",
                borderRadius: "4px",
                color: "var(--text-inverse)",
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: 500,
                cursor: downloading ? "not-allowed" : "pointer",
                opacity: downloading ? 0.6 : 1,
              }}
            >
              {downloading ? "Downloading..." : "Update & Restart"}
            </button>
            <button
              onClick={dismiss}
              disabled={downloading}
              style={{
                background: "transparent",
                border: "1px solid var(--border-default)",
                borderRadius: "4px",
                color: "var(--text-primary)",
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: 500,
                cursor: downloading ? "not-allowed" : "pointer",
                opacity: downloading ? 0.6 : 1,
              }}
            >
              Later
            </button>
          </div>
        </div>
        {!downloading && (
          <button
            onClick={dismiss}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-primary)",
              cursor: "pointer",
              fontSize: "16px",
              padding: "0",
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
