import { useEffect, useState } from 'react';
import { packetBytes, type PcapPacketBytes } from '../lib/pcap';

interface PcapHexViewProps {
  captureId: string | null;
  packetNo: number | null;
}

export function PcapHexView({ captureId, packetNo }: PcapHexViewProps) {
  const [bytes, setBytes] = useState<PcapPacketBytes | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBytes(null);
    setError(null);
    if (!captureId || !packetNo) return;
    let cancelled = false;
    packetBytes(captureId, packetNo)
      .then((b) => {
        if (!cancelled) setBytes(b);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [captureId, packetNo]);

  if (!packetNo) {
    return (
      <div className="pcap-hex empty" data-testid="pcap-hex">
        Select a packet to view raw bytes.
      </div>
    );
  }
  if (error) {
    return (
      <div className="pcap-hex error" data-testid="pcap-hex">
        {error}
      </div>
    );
  }
  if (!bytes) {
    return (
      <div className="pcap-hex" data-testid="pcap-hex">
        Loading raw bytes…
      </div>
    );
  }
  return (
    <div className="pcap-hex" data-testid="pcap-hex">
      <div className="pcap-hex-meta">{bytes.length} bytes</div>
      <div className="pcap-hex-grid">
        <pre className="pcap-hex-col">{bytes.hex}</pre>
        <pre className="pcap-hex-col ascii">{bytes.ascii}</pre>
      </div>
    </div>
  );
}
