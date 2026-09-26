import { useState } from 'react';
import { supernet } from '../../../lib/subnetCalculations';
import { ResultCard } from '../shared/ResultCard';
import { CopyButton } from '../shared/CopyButton';

export function SupernettingTool() {
  const [subnetsText, setSubnetsText] = useState('');
  const [result, setResult] = useState<ReturnType<typeof supernet> | null>(null);

  const handleAggregate = () => {
    try {
      const subnets = subnetsText
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      if (subnets.length === 0) {
        return;
      }

      const aggregateResult = supernet(subnets);
      setResult(aggregateResult);
    } catch (err) {
      setResult({
        supernet: '',
        valid: false,
        error: err instanceof Error ? err.message : 'Invalid input',
      });
    }
  };

  return (
    <div className="supernetting-tool">
      <h2 className="tool-title">Supernetting</h2>

      <div className="supernet-inputs">
        <label htmlFor="subnets-textarea">Subnets (one per line)</label>
        <textarea
          id="subnets-textarea"
          value={subnetsText}
          onChange={(e) => setSubnetsText(e.target.value)}
          placeholder="192.168.0.0/24&#10;192.168.1.0/24&#10;192.168.2.0/24&#10;192.168.3.0/24"
          rows={10}
          className="subnets-textarea"
        />

        <button
          onClick={handleAggregate}
          className="btn-primary"
          disabled={!subnetsText.trim()}
        >
          Aggregate
        </button>
      </div>

      {result && (
        <ResultCard>
          {result.valid ? (
            <>
              <div className="supernet-success">
                <h3>Supernet</h3>
                <div className="supernet-value">
                  <span className="monospace large">{result.supernet}</span>
                  <CopyButton text={result.supernet} />
                </div>
                <p className="success-message">✓ All subnets are covered</p>
              </div>
            </>
          ) : (
            <div className="supernet-error">
              <h3>Cannot Aggregate</h3>
              <p className="error-message">✗ {result.error}</p>
              {result.supernet && (
                <p className="suggested-supernet">
                  Suggested supernet (may have gaps): <span className="monospace">{result.supernet}</span>
                </p>
              )}
            </div>
          )}
        </ResultCard>
      )}
    </div>
  );
}
