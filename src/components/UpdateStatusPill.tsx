import { useUpdateStore } from "../state/updateStore";

/**
 * Bottom-status-bar pill that appears only when an app update is available,
 * mirroring the FTP/TFTP pills in StatusFooter. Reads the shared update store
 * (populated by the automatic check in UpdateNotification), and on click kicks
 * off the download + relaunch directly. This gives users a persistent entry
 * point even after they dismiss the floating toast.
 */
export function UpdateStatusPill() {
  const available = useUpdateStore((s) => s.available);
  const downloading = useUpdateStore((s) => s.downloading);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);

  if (!available) return null;

  return (
    <button
      type="button"
      className="status-pill running"
      onClick={() => downloadAndInstall()}
      disabled={downloading}
      title={
        downloading
          ? "Downloading update…"
          : `Update to v${available.version} available — click to install & restart`
      }
    >
      <span className="status-dot" />
      <span className="status-label">
        {downloading ? "Updating…" : `Update v${available.version}`}
      </span>
    </button>
  );
}
