import { useMemo } from 'react';
import type { PcapPacket } from '../lib/pcap';

interface PcapProtocolHierarchyProps {
  packets: PcapPacket[];
  totalCount: number;
}

interface Bucket {
  protocol: string;
  count: number;
  bytes: number;
  percent: number;
}

export function PcapProtocolHierarchy({
  packets,
  totalCount,
}: PcapProtocolHierarchyProps) {
  const buckets = useMemo<Bucket[]>(() => {
    const counts = new Map<string, { c: number; b: number }>();
    for (const p of packets) {
      const cur = counts.get(p.protocol) ?? { c: 0, b: 0 };
      cur.c += 1;
      cur.b += p.length;
      counts.set(p.protocol, cur);
    }
    const total = packets.length || 1;
    return [...counts.entries()]
      .map(([protocol, { c, b }]) => ({
        protocol,
        count: c,
        bytes: b,
        percent: (c / total) * 100,
      }))
      .sort((a, b) => b.count - a.count);
  }, [packets]);

  if (totalCount === 0) {
    return (
      <div className="pcap-hierarchy empty" data-testid="pcap-hierarchy">
        No packets to summarize.
      </div>
    );
  }

  return (
    <div className="pcap-hierarchy" data-testid="pcap-hierarchy">
      <table>
        <thead>
          <tr>
            <th>Protocol</th>
            <th>Packets</th>
            <th>Bytes</th>
            <th>Percent</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.protocol}>
              <td>{b.protocol}</td>
              <td>{b.count}</td>
              <td>{b.bytes}</td>
              <td>{b.percent.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pcap-hierarchy-note">
        Aggregated over the {packets.length} sampled packet(s); total capture
        contains {totalCount}.
      </div>
    </div>
  );
}
