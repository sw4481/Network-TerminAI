import { useState } from 'react';
import { splitSubnet } from '../../../lib/subnetCalculations';
import type { NetworkInfo } from '../../../lib/subnetCalculations';
import { IpInput } from '../shared/IpInput';
import { CopyButton } from '../shared/CopyButton';

export function SubnetSplitter() {
  const [parentNetwork, setParentNetwork] = useState('');
  const [parts, setParts] = useState('4');
  const [error, setError] = useState('');
  const [results, setResults] = useState<NetworkInfo[]>([]);

  const handleSplit = () => {
    try {
      const partsNum = parseInt(parts, 10);
      if (isNaN(partsNum) || partsNum < 2) {
        setError('Number of subnets must be at least 2');
        return;
      }

      const subnets = splitSubnet(parentNetwork, partsNum);
      setResults(subnets);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid input');
      setResults([]);
    }
  };

  const handleCopyAll = () => {
    const csv = results.map((r, i) =>
      `${i + 1},${r.network}/${r.cidr},${r.broadcast},${r.firstUsable} - ${r.lastUsable},${r.usableHosts}`
    ).join('\n');
    const header = 'Subnet #,Network,Broadcast,Usable Range,Host Count\n';
    navigator.clipboard.writeText(header + csv);
  };

  return (
    <div className="subnet-splitter">
      <h2 className="tool-title">Subnet Splitter</h2>

      <div className="splitter-inputs">
        <div className="input-group">
          <label htmlFor="parent-network">Parent Network</label>
          <IpInput
            value={parentNetwork}
            onChange={setParentNetwork}
            error={error}
            placeholder="10.0.0.0/8"
          />
        </div>

        <div className="input-group">
          <label htmlFor="parts">Number of Subnets</label>
          <input
            id="parts"
            type="number"
            value={parts}
            onChange={(e) => setParts(e.target.value)}
            min="2"
            className="number-input"
          />
        </div>

        <button onClick={handleSplit} className="btn-primary" disabled={!parentNetwork.trim()}>
          Split Network
        </button>
      </div>

      {results.length > 0 && (
        <div className="splitter-results">
          <div className="results-header">
            <h3>{results.length} Subnets</h3>
            <button onClick={handleCopyAll} className="btn-secondary">
              Copy All as CSV
            </button>
          </div>

          <table className="results-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Network</th>
                <th>Broadcast</th>
                <th>Usable Range</th>
                <th>Hosts</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {results.map((result, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td className="monospace">{result.network}/{result.cidr}</td>
                  <td className="monospace">{result.broadcast}</td>
                  <td className="monospace">{result.firstUsable} - {result.lastUsable}</td>
                  <td>{result.usableHosts}</td>
                  <td>
                    <CopyButton text={`${result.network}/${result.cidr}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
