import { useState } from 'react';
import { parseCidr, calculateNetwork } from '../../../lib/subnetCalculations';
import { IpInput } from '../shared/IpInput';
import { ResultCard } from '../shared/ResultCard';
import { CopyButton } from '../shared/CopyButton';
import { BinaryDisplay } from '../shared/BinaryDisplay';

export function CidrCalculator() {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReturnType<typeof calculateNetwork> | null>(null);

  const handleCalculate = () => {
    try {
      const { ip, prefix } = parseCidr(input);
      const info = calculateNetwork(ip, prefix);
      setResult(info);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid input');
      setResult(null);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCalculate();
    }
  };

  return (
    <div className="cidr-calculator">
      <h2 className="tool-title">CIDR Calculator</h2>

      <div className="cidr-input-section">
        <IpInput
          value={input}
          onChange={setInput}
          error={error}
          placeholder="192.168.1.0/24 or 192.168.1.0 255.255.255.0"
        />
        <button
          onClick={handleCalculate}
          onKeyPress={handleKeyPress}
          className="btn-primary"
          disabled={!input.trim()}
        >
          Calculate
        </button>
      </div>

      {result && (
        <ResultCard title="Network Information">
          <div className="result-row network">
            <span className="result-label">Network Address:</span>
            <span className="result-value">{result.network}</span>
            <CopyButton text={result.network} />
          </div>

          <div className="result-row broadcast">
            <span className="result-label">Broadcast Address:</span>
            <span className="result-value">{result.broadcast}</span>
            <CopyButton text={result.broadcast} />
          </div>

          <div className="result-row usable">
            <span className="result-label">First Usable:</span>
            <span className="result-value">{result.firstUsable}</span>
            <CopyButton text={result.firstUsable} />
          </div>

          <div className="result-row usable">
            <span className="result-label">Last Usable:</span>
            <span className="result-value">{result.lastUsable}</span>
            <CopyButton text={result.lastUsable} />
          </div>

          <div className="result-row">
            <span className="result-label">Usable Hosts:</span>
            <span className="result-value">{result.usableHosts.toLocaleString()}</span>
            <CopyButton text={result.usableHosts.toString()} />
          </div>

          <div className="result-section">
            <h4>Subnet Mask</h4>
            <div className="result-row">
              <span className="result-label">CIDR:</span>
              <span className="result-value">/{result.cidr}</span>
            </div>
            <div className="result-row">
              <span className="result-label">Dotted Decimal:</span>
              <span className="result-value">{result.subnetMask}</span>
              <CopyButton text={result.subnetMask} />
            </div>
            <div className="result-row">
              <span className="result-label">Wildcard Mask:</span>
              <span className="result-value">{result.wildcardMask}</span>
              <CopyButton text={result.wildcardMask} />
            </div>
          </div>

          <div className="result-section">
            <BinaryDisplay binary={result.binary.network} label="Network (Binary)" />
            <BinaryDisplay binary={result.binary.mask} label="Subnet Mask (Binary)" />
          </div>
        </ResultCard>
      )}

      {!result && !error && (
        <div className="empty-state">
          <p>Enter an IP address and subnet mask to begin</p>
          <p className="empty-state-example">Example: 192.168.1.0/24</p>
        </div>
      )}
    </div>
  );
}
