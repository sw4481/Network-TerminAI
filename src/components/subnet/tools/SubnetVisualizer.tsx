import { useState } from 'react';
import { parseCidr, calculateNetwork } from '../../../lib/subnetCalculations';

export function SubnetVisualizer() {
  const [network, setNetwork] = useState('');
  const [error, setError] = useState('');
  const [binary, setBinary] = useState<{ network: string; mask: string } | null>(null);

  const handleVisualize = () => {
    try {
      const { ip, prefix } = parseCidr(network);
      const info = calculateNetwork(ip, prefix);
      setBinary(info.binary);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid input');
      setBinary(null);
    }
  };

  const formatBinary = (bin: string, prefix: number) => {
    const networkBits = bin.slice(0, prefix);
    const hostBits = bin.slice(prefix);
    return { networkBits, hostBits };
  };

  return (
    <div className="subnet-visualizer">
      <h2 className="tool-title">Subnet Visualizer</h2>

      <div className="visualizer-inputs">
        <input
          type="text"
          value={network}
          onChange={(e) => setNetwork(e.target.value)}
          placeholder="192.168.1.0/24"
          className="ip-input"
        />
        <button onClick={handleVisualize} className="btn-primary" disabled={!network.trim()}>
          Visualize
        </button>
      </div>

      {error && <p className="error-message">{error}</p>}

      {binary && (() => {
        const prefix = parseCidr(network).prefix;
        const { networkBits, hostBits } = formatBinary(binary.network, prefix);
        const { networkBits: maskNetworkBits, hostBits: maskHostBits } = formatBinary(binary.mask, prefix);

        return (
          <div className="bit-diagram">
            <h3>Bit Diagram</h3>

            <div className="binary-row">
              <span className="binary-label">Network Address:</span>
              <span className="binary-value">
                <span className="network-bits">{networkBits}</span>
                <span className="host-bits">{hostBits}</span>
              </span>
            </div>

            <div className="binary-row">
              <span className="binary-label">Subnet Mask:</span>
              <span className="binary-value">
                <span className="network-bits">{maskNetworkBits}</span>
                <span className="host-bits">{maskHostBits}</span>
              </span>
            </div>

            <div className="bit-legend">
              <div className="legend-item">
                <span className="network-bits sample">■</span> Network Bits (/{prefix})
              </div>
              <div className="legend-item">
                <span className="host-bits sample">■</span> Host Bits ({32 - prefix})
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
