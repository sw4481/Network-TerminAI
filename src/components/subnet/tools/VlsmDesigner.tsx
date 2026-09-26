import { useState } from 'react';
import { designVlsm } from '../../../lib/subnetCalculations';
import type { VlsmRequirement } from '../../../lib/subnetCalculations';
import { IpInput } from '../shared/IpInput';
import { CopyButton } from '../shared/CopyButton';

export function VlsmDesigner() {
  const [parentNetwork, setParentNetwork] = useState('');
  const [requirements, setRequirements] = useState<VlsmRequirement[]>([
    { name: '', hostsNeeded: 0 },
  ]);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReturnType<typeof designVlsm> | null>(null);

  const addRequirement = () => {
    setRequirements([...requirements, { name: '', hostsNeeded: 0 }]);
  };

  const removeRequirement = (index: number) => {
    setRequirements(requirements.filter((_, i) => i !== index));
  };

  const updateRequirement = (index: number, field: keyof VlsmRequirement, value: string | number) => {
    const updated = [...requirements];
    updated[index] = { ...updated[index], [field]: value };
    setRequirements(updated);
  };

  const handleDesign = () => {
    try {
      const validReqs = requirements.filter(r => r.name && r.hostsNeeded > 0);
      if (validReqs.length === 0) {
        setError('Add at least one requirement');
        return;
      }

      const vlsmResult = designVlsm(parentNetwork, validReqs);
      setResult(vlsmResult);
      setError(vlsmResult.error || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid input');
      setResult(null);
    }
  };

  const handleExportCsv = () => {
    if (!result) return;

    const csv = result.allocations.map(a =>
      `${a.name},${a.hostsNeeded},${a.subnet},${a.actualHosts},${a.utilization.toFixed(1)}%`
    ).join('\n');
    const header = 'Name,Hosts Needed,Subnet Allocated,Actual Hosts,Utilization\n';
    navigator.clipboard.writeText(header + csv);
  };

  return (
    <div className="vlsm-designer">
      <h2 className="tool-title">VLSM Designer</h2>

      <div className="vlsm-inputs">
        <div className="input-group">
          <label htmlFor="parent-network-vlsm">Parent Network</label>
          <IpInput
            value={parentNetwork}
            onChange={setParentNetwork}
            error={error}
            placeholder="10.1.0.0/16"
          />
        </div>

        <div className="requirements-section">
          <h3>Requirements</h3>
          {requirements.map((req, i) => (
            <div key={i} className="requirement-row">
              <input
                type="text"
                value={req.name}
                onChange={(e) => updateRequirement(i, 'name', e.target.value)}
                placeholder="Name (e.g., Servers)"
                className="req-name-input"
              />
              <input
                type="number"
                value={req.hostsNeeded || ''}
                onChange={(e) => updateRequirement(i, 'hostsNeeded', parseInt(e.target.value, 10) || 0)}
                placeholder="Hosts needed"
                min="1"
                className="req-hosts-input"
              />
              {requirements.length > 1 && (
                <button
                  onClick={() => removeRequirement(i)}
                  className="btn-remove"
                  aria-label="Remove requirement"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button onClick={addRequirement} className="btn-secondary">
            Add Requirement
          </button>
        </div>

        <button
          onClick={handleDesign}
          className="btn-primary"
          disabled={!parentNetwork.trim()}
        >
          Design VLSM
        </button>
      </div>

      {result && !result.error && (
        <div className="vlsm-results">
          <div className="results-header">
            <h3>Allocations</h3>
            <button onClick={handleExportCsv} className="btn-secondary">
              Export as CSV
            </button>
          </div>

          <table className="results-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Hosts Needed</th>
                <th>Subnet Allocated</th>
                <th>Actual Hosts</th>
                <th>Utilization</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {result.allocations.map((alloc, i) => (
                <tr key={i}>
                  <td>{alloc.name}</td>
                  <td>{alloc.hostsNeeded}</td>
                  <td className="monospace">{alloc.subnet}</td>
                  <td>{alloc.actualHosts}</td>
                  <td className={alloc.utilization < 50 ? 'low-util' : ''}>
                    {alloc.utilization.toFixed(1)}%
                  </td>
                  <td>
                    <CopyButton text={alloc.subnet} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.remainingSpace.length > 0 && (
            <div className="remaining-space">
              <h4>Remaining Unallocated Space</h4>
              {result.remainingSpace.map((space, i) => (
                <p key={i} className="monospace">{space}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
