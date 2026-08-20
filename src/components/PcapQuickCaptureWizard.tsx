import { useEffect, useState } from 'react';
import {
  startCapture,
  type CaptureSpec,
  type DeviceConn,
  type RemoteDeviceKind,
  type PcapTemplate,
} from '../lib/pcap';

interface PcapQuickCaptureWizardProps {
  template: PcapTemplate | null;
  conn: DeviceConn | null;
  onStarted?: (captureId: string) => void;
}

const VENDOR_DEFAULT_PATH: Record<RemoteDeviceKind, string> = {
  iosxe: 'flash:CAP.pcap',
  nxos: 'bootflash:CAP.pcap',
  junos: '/var/tmp/CAP.pcap',
  eos: '/mnt/flash/CAP.pcap',
};

function deviceKindFromPlatform(platform: string): RemoteDeviceKind {
  if (platform === 'iosxe' || platform === 'nxos' || platform === 'junos') {
    return platform;
  }
  if (platform.includes('eos')) return 'eos';
  return 'iosxe';
}

export function PcapQuickCaptureWizard({
  template,
  conn,
  onStarted,
}: PcapQuickCaptureWizardProps) {
  const [iface, setIface] = useState('');
  const [acl, setAcl] = useState('');
  const [duration, setDuration] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (template) {
      setIface(template.interface ?? '');
      setAcl(template.acl ?? '');
      setDuration(template.duration_s);
    }
  }, [template]);

  const canSubmit =
    !!conn &&
    !!template &&
    iface.trim().length > 0 &&
    duration >= 5 &&
    duration <= 3600 &&
    !submitting;

  const submit = async () => {
    if (!template || !conn) return;
    setError(null);
    setSubmitting(true);
    try {
      const kind = deviceKindFromPlatform(template.platform);
      const spec: CaptureSpec = {
        capture_name: 'CAP',
        device_kind: kind,
        interface: iface.trim(),
        acl: acl.trim() || null,
        duration_s: duration,
        buffer_mb: 10,
        on_device_path: VENDOR_DEFAULT_PATH[kind],
      };
      const { capture_id } = await startCapture(spec, conn);
      onStarted?.(capture_id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="pcap-quick-wizard"
      data-testid="pcap-quick-wizard"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label>
        Interface
        <input
          value={iface}
          onChange={(e) => setIface(e.target.value)}
          placeholder="GigabitEthernet0/0/1"
          data-testid="pcap-wizard-interface"
        />
      </label>
      <label>
        ACL / capture filter (optional)
        <input
          value={acl}
          onChange={(e) => setAcl(e.target.value)}
          placeholder="MGMT_ACL  or  host 10.1.1.1"
        />
      </label>
      <label>
        Duration: {duration}s
        <input
          type="range"
          min={5}
          max={300}
          step={5}
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
          data-testid="pcap-wizard-duration"
        />
      </label>
      {!conn && (
        <div className="pcap-wizard-warn">
          Pick or paste an SSH connection before running the capture.
        </div>
      )}
      {error && <div className="pcap-wizard-error">{error}</div>}
      <button
        type="submit"
        className="pcap-wizard-run"
        disabled={!canSubmit}
        data-testid="pcap-wizard-run"
      >
        {submitting ? 'Starting…' : 'Run capture'}
      </button>
    </form>
  );
}
