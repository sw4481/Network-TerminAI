import { useEffect, useState } from 'react';
import './PcapBlock.css';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  cancelCapture,
  captureGet,
  exportPcap,
  subscribePcapProgress,
  type CaptureProgress,
  type PcapCapture,
} from '../lib/pcap';
import { usePcapSummary } from '../hooks/usePcapSummary';
import { PcapPacketList } from './PcapPacketList';
import { PcapHexView } from './PcapHexView';
import { PcapProtocolHierarchy } from './PcapProtocolHierarchy';
import { FollowStreamModal } from './FollowStreamModal';
import { PcapFindings } from './PcapFindings';

interface PcapBlockProps {
  captureId: string;
}

type Tab = 'packets' | 'hierarchy' | 'hex' | 'findings';

export function PcapBlock({ captureId }: PcapBlockProps) {
  const [capture, setCapture] = useState<PcapCapture | null>(null);
  const [tab, setTab] = useState<Tab>('packets');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [followStreamIndex, setFollowStreamIndex] = useState<number | null>(null);
  const [sizeWarning, setSizeWarning] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    captureGet(captureId).then((c) => {
      if (cancelled) return;
      setCapture(c);
    });

    subscribePcapProgress(captureId, (ev: CaptureProgress) => {
      if (ev.phase === 'size-warning') {
        setSizeWarning(ev.size_bytes);
      }
      // Any state change re-pulls the row; cheap and avoids drift.
      captureGet(captureId).then((c) => {
        if (!cancelled) setCapture(c);
      });
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [captureId]);

  const ready = capture?.status === 'ready' && !!capture.local_path;
  const active = capture != null && ['setup', 'capturing', 'pulling'].includes(capture.status);
  const summaryState = usePcapSummary(ready ? captureId : null, filter || null);

  return (
    <div className="pcap-block" data-testid="pcap-block">
      <header className="pcap-header">
        <span className="pcap-chip pcap-chip-device" data-testid="pcap-chip-device">
          {capture?.device_ref ?? '—'}
        </span>
        <span className="pcap-chip">{capture?.interface ?? '—'}</span>
        <span className="pcap-chip">
          {capture ? `${capture.device_kind}` : '—'}
        </span>
        <span
          className={`pcap-chip status-${capture?.status ?? 'unknown'}`}
          data-testid="pcap-status-chip"
        >
          {capture?.status ?? 'unknown'}
        </span>
        {capture?.size_bytes != null && (
          <span className="pcap-chip">
            {(capture.size_bytes / 1024).toFixed(1)} KB
          </span>
        )}
        {capture?.packet_count != null && (
          <span className="pcap-chip">{capture.packet_count} pkts</span>
        )}
        {ready && (
          <button
            type="button"
            className="pcap-export-btn"
            data-testid="pcap-export-btn"
            onClick={async () => {
              const dest = await saveDialog({
                defaultPath: `${capture?.id ?? 'capture'}.pcap`,
                filters: [{ name: 'pcap', extensions: ['pcap'] }],
              });
              if (typeof dest === 'string' && dest) {
                await exportPcap(captureId, dest);
              }
            }}
          >
            Export pcap…
          </button>
        )}
        {active && (
          <button
            type="button"
            className="pcap-export-btn"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await cancelCapture(captureId);
                setCapture(await captureGet(captureId));
              } finally {
                setCancelling(false);
              }
            }}
            data-testid="pcap-cancel-btn"
          >
            {cancelling ? 'Cancelling…' : 'Cancel capture'}
          </button>
        )}
      </header>

      {capture?.error && (
        <div className="pcap-error-banner" data-testid="pcap-error-banner">
          {capture.error}
        </div>
      )}

      {sizeWarning != null && (
        <div className="pcap-size-warning" data-testid="pcap-size-warning">
          Pcap is {(sizeWarning / 1024 / 1024).toFixed(0)} MB — summarization
          may be slow; consider a shorter duration or narrower filter.
        </div>
      )}

      <nav className="pcap-tabs">
        <button
          type="button"
          className={tab === 'packets' ? 'active' : ''}
          onClick={() => setTab('packets')}
          data-testid="pcap-tab-packets"
        >
          Packets
        </button>
        <button
          type="button"
          className={tab === 'hierarchy' ? 'active' : ''}
          onClick={() => setTab('hierarchy')}
          data-testid="pcap-tab-hierarchy"
        >
          Protocol Hierarchy
        </button>
        <button
          type="button"
          className={tab === 'hex' ? 'active' : ''}
          onClick={() => setTab('hex')}
          data-testid="pcap-tab-hex"
        >
          Hex / ASCII
        </button>
        <button
          type="button"
          className={tab === 'findings' ? 'active' : ''}
          onClick={() => setTab('findings')}
          data-testid="pcap-tab-findings"
        >
          Findings
        </button>
      </nav>

      <section className="pcap-tab-body">
        {!ready && (
          <div className="pcap-loading" data-testid="pcap-loading">
            Capture is {capture?.status ?? 'unknown'}…
          </div>
        )}
        {ready && tab === 'packets' && (
          <PcapPacketList
            packets={summaryState.summary?.packets ?? []}
            totalCount={summaryState.summary?.packet_count ?? 0}
            displayFilter={filter}
            invalidFilter={summaryState.invalidFilter}
            loading={summaryState.loading}
            onSelectPacket={setSelected}
            selectedPacketNo={selected}
            onDisplayFilterChange={setFilter}
            onFollowStream={setFollowStreamIndex}
          />
        )}
        {ready && tab === 'hierarchy' && (
          <PcapProtocolHierarchy
            packets={summaryState.summary?.packets ?? []}
            totalCount={summaryState.summary?.packet_count ?? 0}
          />
        )}
        {ready && tab === 'hex' && (
          <PcapHexView captureId={captureId} packetNo={selected} />
        )}
        {ready && tab === 'findings' && <PcapFindings captureId={captureId} />}
      </section>

      <FollowStreamModal
        captureId={captureId}
        streamIndex={followStreamIndex}
        onClose={() => setFollowStreamIndex(null)}
      />
    </div>
  );
}
