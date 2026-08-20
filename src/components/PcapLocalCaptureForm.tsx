import { useCallback, useEffect, useState } from 'react';
import {
  listLocalCaptureInterfaces,
  startLocalCapture,
  type LocalCaptureInterface,
} from '../lib/pcap';

interface PcapLocalCaptureFormProps {
  onStarted?: (captureId: string) => void;
}

export function PcapLocalCaptureForm({ onStarted }: PcapLocalCaptureFormProps) {
  const [interfaces, setInterfaces] = useState<LocalCaptureInterface[]>([]);
  const [selector, setSelector] = useState('');
  const [filter, setFilter] = useState('');
  const [duration, setDuration] = useState(30);
  const [maxSize, setMaxSize] = useState(100);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listLocalCaptureInterfaces();
      setInterfaces(rows);
      setSelector((current) =>
        rows.some((item) => item.selector === current)
          ? current
          : (rows[0]?.selector ?? ''),
      );
    } catch (caught) {
      setInterfaces([]);
      setSelector('');
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = interfaces.find((item) => item.selector === selector);
  const valid =
    !!selected &&
    duration >= 1 &&
    duration <= 600 &&
    maxSize >= 1 &&
    maxSize <= 1024 &&
    !submitting;

  return (
    <form
      className="pcap-quick-wizard"
      data-testid="pcap-local-capture-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!selected || !valid) return;
        setSubmitting(true);
        setError(null);
        try {
          const reply = await startLocalCapture({
            interfaceSelector: selected.selector,
            interfaceLabel: selected.label,
            captureFilter: filter.trim() || null,
            durationSeconds: duration,
            maxSizeMiB: maxSize,
          });
          onStarted?.(reply.capture_id);
        } catch (caught) {
          setError(String(caught));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <label>
        Local interface
        <select
          value={selector}
          onChange={(event) => setSelector(event.target.value)}
          disabled={loading || interfaces.length === 0}
          data-testid="pcap-local-interface"
        >
          {interfaces.length === 0 && (
            <option value="">{loading ? 'Finding interfaces…' : 'No interfaces found'}</option>
          )}
          {interfaces.map((item) => (
            <option key={`${item.selector}-${item.label}`} value={item.selector}>
              {item.selector}. {item.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="pcap-local-refresh" onClick={() => void refresh()}>
        Refresh interfaces
      </button>
      <label>
        BPF capture filter (optional)
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="tcp port 443"
          data-testid="pcap-local-filter"
        />
      </label>
      <label>
        Duration (1–600 seconds)
        <input
          type="number"
          min={1}
          max={600}
          value={duration}
          onChange={(event) => setDuration(Number(event.target.value))}
          data-testid="pcap-local-duration"
        />
      </label>
      <label>
        Maximum size (1–1024 MiB)
        <input
          type="number"
          min={1}
          max={1024}
          value={maxSize}
          onChange={(event) => setMaxSize(Number(event.target.value))}
          data-testid="pcap-local-size"
        />
      </label>
      <div className="pcap-wizard-warn">
        Requires dumpcap from Wireshark and capture permission for this account.
        TerminAI never elevates itself.
      </div>
      {error && <div className="pcap-wizard-error">{error}</div>}
      <button
        type="submit"
        className="pcap-wizard-run"
        disabled={!valid}
        data-testid="pcap-local-run"
      >
        {submitting ? 'Starting…' : 'Run local capture'}
      </button>
    </form>
  );
}
