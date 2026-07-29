import { useState } from 'react';
import { checkIpInSubnet } from '../../../lib/subnetCalculations';
import { IpInput } from '../shared/IpInput';
import { ResultCard } from '../shared/ResultCard';

export function IpChecker() {
  const [ipAddress, setIpAddress] = useState('');
  const [subnet, setSubnet] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReturnType<typeof checkIpInSubnet> | null>(null);

  const handleCheck = () => {
    try {
      const checkResult = checkIpInSubnet(ipAddress, subnet);
      setResult(checkResult);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid input');
      setResult(null);
    }
  };

  return (
    <div className="ip-checker">
      <h2 className="tool-title">IP Checker</h2>

      <div className="checker-inputs">
        <div className="input-group">
          <label htmlFor="ip-address">IP Address</label>
          <IpInput
            value={ipAddress}
            onChange={setIpAddress}
            placeholder="192.168.1.50"
          />
        </div>

        <div className="input-group">
          <label htmlFor="subnet-input">Subnet</label>
          <IpInput
            value={subnet}
            onChange={setSubnet}
            error={error}
            placeholder="192.168.1.0/24"
          />
        </div>

        <button
          onClick={handleCheck}
          className="btn-primary"
          disabled={!ipAddress.trim() || !subnet.trim()}
        >
          Check
        </button>
      </div>

      {result && (
        <ResultCard>
          <div className={`check-result ${result.inSubnet ? 'in-subnet' : 'not-in-subnet'}`}>
            <div className="check-icon">
              {result.inSubnet ? '✓' : '✗'}
            </div>
            <div className="check-text">
              {result.inSubnet ? (
                <>
                  <h3>IP is in subnet</h3>
                  {result.position !== undefined && result.total !== undefined && (
                    <p>
                      Host #{result.position} of {result.total} usable hosts
                      <br />
                      ({((result.position / result.total) * 100).toFixed(1)}% through range)
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h3>IP is NOT in subnet</h3>
                  <p>{ipAddress} is not in {subnet}</p>
                </>
              )}
            </div>
          </div>
        </ResultCard>
      )}
    </div>
  );
}
