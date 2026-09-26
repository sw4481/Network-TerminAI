import { useEffect, useState } from 'react';
import { followStream, type FollowStreamResult } from '../lib/pcap';

interface FollowStreamModalProps {
  captureId: string | null;
  streamIndex: number | null;
  onClose: () => void;
}

export function FollowStreamModal({
  captureId,
  streamIndex,
  onClose,
}: FollowStreamModalProps) {
  const [data, setData] = useState<FollowStreamResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (captureId == null || streamIndex == null) return;
    setData(null);
    setError(null);
    let cancelled = false;
    followStream(captureId, streamIndex)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [captureId, streamIndex]);

  if (captureId == null || streamIndex == null) return null;

  return (
    <div
      className="pcap-follow-modal-overlay"
      role="dialog"
      aria-modal="true"
      data-testid="pcap-follow-modal"
      onClick={onClose}
    >
      <div className="pcap-follow-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pcap-follow-header">
          <span>Follow TCP stream {streamIndex}</span>
          <button
            type="button"
            className="pcap-follow-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {error && <div className="pcap-follow-error">{error}</div>}
        {!data && !error && <div className="pcap-follow-loading">Loading…</div>}
        {data && (
          <div className="pcap-follow-body">
            <div className="pcap-follow-pane">
              <div className="pcap-follow-label">
                Client → Server ({data.client_bytes} bytes)
              </div>
              <pre>{data.client_ascii}</pre>
            </div>
            <div className="pcap-follow-pane">
              <div className="pcap-follow-label">
                Server → Client ({data.server_bytes} bytes)
              </div>
              <pre>{data.server_ascii}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
