import { useEffect, useState } from 'react';
import {
  getHeartbeat,
  updateHeartbeat,
  updateHeartbeatChecks,
  type CheckInput,
} from '../lib/tauri';
import './CreateHeartbeatModal.css';

type EditHeartbeatModalProps = {
  /** Heartbeat id to edit, or null when closed. */
  heartbeatId: string | null;
  onClose: () => void;
  onSuccess: () => void;
};

const AVAILABLE_AGENTS = [
  { id: 'meraki', label: 'Meraki Dashboard' },
  { id: 'pyats', label: 'pyATS Devices' },
  { id: 'stealthwatch', label: 'Stealthwatch' },
  { id: 'ise', label: 'Cisco ISE' },
  { id: 'cml', label: 'Cisco CML' },
  { id: 'catalyst_center', label: 'Catalyst Center' },
];

export function EditHeartbeatModal({ heartbeatId, onClose, onSuccess }: EditHeartbeatModalProps) {
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [intervalUnit, setIntervalUnit] = useState<'minutes' | 'hours' | 'days'>('minutes');
  const [retentionDays, setRetentionDays] = useState(30);
  const [checks, setChecks] = useState<CheckInput[]>([]);

  // Load the heartbeat + checks when opened.
  useEffect(() => {
    if (!heartbeatId) return;
    setLoadingData(true);
    setError(null);
    getHeartbeat(heartbeatId)
      .then((detail) => {
        const hb = detail.heartbeat;
        setName(hb.name);
        setDescription(hb.description);

        const mins = hb.intervalMinutes;
        if (mins >= 1440 && mins % 1440 === 0) {
          setIntervalMinutes(mins / 1440);
          setIntervalUnit('days');
        } else if (mins >= 60 && mins % 60 === 0) {
          setIntervalMinutes(mins / 60);
          setIntervalUnit('hours');
        } else {
          setIntervalMinutes(mins);
          setIntervalUnit('minutes');
        }
        setRetentionDays(hb.retentionDays);

        setChecks(
          detail.checks
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((c) => ({
              checkGroupName: c.checkGroupName,
              agentId: c.agentId,
              agentPrompt: c.agentPrompt,
              sortOrder: c.sortOrder,
            })),
        );
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to load heartbeat');
      })
      .finally(() => setLoadingData(false));
  }, [heartbeatId]);

  const handleClose = () => {
    setError(null);
    setSuccess(false);
    onClose();
  };

  const handleAddCheck = () => {
    setChecks([
      ...checks,
      { checkGroupName: 'New Check', agentId: 'meraki', agentPrompt: '', sortOrder: checks.length },
    ]);
  };

  const handleRemoveCheck = (index: number) => {
    const updated = checks.filter((_, i) => i !== index);
    updated.forEach((c, i) => (c.sortOrder = i));
    setChecks(updated);
  };

  const handleUpdateCheck = (index: number, field: keyof CheckInput, value: string | number) => {
    const updated = [...checks];
    updated[index] = { ...updated[index], [field]: value };
    setChecks(updated);
  };

  const handleSave = async () => {
    if (!heartbeatId) return;
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (checks.length === 0) {
      setError('At least one check is required');
      return;
    }
    if (intervalMinutes <= 0) {
      setError('Interval must be greater than 0');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let finalIntervalMinutes = intervalMinutes;
      if (intervalUnit === 'hours') finalIntervalMinutes *= 60;
      else if (intervalUnit === 'days') finalIntervalMinutes *= 1440;

      // Update metadata first (this also re-registers the scheduler with the
      // new interval), then replace the checks.
      await updateHeartbeat(
        heartbeatId,
        name.trim(),
        description.trim(),
        finalIntervalMinutes,
        retentionDays,
      );
      await updateHeartbeatChecks(heartbeatId, checks);

      setSuccess(true);
      setTimeout(() => {
        handleClose();
        onSuccess();
      }, 1200);
    } catch (e) {
      console.error('Update heartbeat error:', e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Failed to save changes: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  if (!heartbeatId) return null;

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content create-heartbeat-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Edit Heartbeat</h2>
          <button className="close-btn" onClick={handleClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {success ? (
            <div className="success-message">Heartbeat updated successfully!</div>
          ) : loadingData ? (
            <div className="checks-empty">Loading…</div>
          ) : (
            <div className="heartbeat-review-stage">
              <div className="field">
                <label htmlFor="edit-name">Name *</label>
                <input
                  id="edit-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Heartbeat name"
                  disabled={loading}
                />
              </div>

              <div className="field">
                <label htmlFor="edit-description">Description</label>
                <textarea
                  id="edit-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description..."
                  rows={2}
                  disabled={loading}
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="edit-interval">Interval</label>
                  <div className="interval-input">
                    <input
                      id="edit-interval"
                      type="number"
                      min="1"
                      value={intervalMinutes}
                      onChange={(e) => setIntervalMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                      disabled={loading}
                    />
                    <select
                      value={intervalUnit}
                      onChange={(e) => setIntervalUnit(e.target.value as any)}
                      disabled={loading}
                    >
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="edit-retention">Retention (days)</label>
                  <input
                    id="edit-retention"
                    type="number"
                    min="1"
                    value={retentionDays}
                    onChange={(e) => setRetentionDays(Math.max(1, parseInt(e.target.value) || 1))}
                    disabled={loading}
                  />
                </div>
              </div>

              <div className="checks-section">
                <div className="checks-header">
                  <h3>Checks ({checks.length})</h3>
                  <button className="add-check-btn" onClick={handleAddCheck} disabled={loading}>
                    + Add Check
                  </button>
                </div>

                {checks.length === 0 ? (
                  <div className="checks-empty">No checks configured. Add at least one check.</div>
                ) : (
                  <div className="checks-list">
                    {checks.map((check, index) => (
                      <div key={index} className="check-item">
                        <div className="check-item-header">
                          <span className="check-item-number">#{index + 1}</span>
                          <button
                            className="remove-check-btn"
                            onClick={() => handleRemoveCheck(index)}
                            disabled={loading}
                            title="Remove check"
                          >
                            ✕
                          </button>
                        </div>

                        <div className="check-field">
                          <label>Group Name</label>
                          <input
                            type="text"
                            value={check.checkGroupName}
                            onChange={(e) => handleUpdateCheck(index, 'checkGroupName', e.target.value)}
                            disabled={loading}
                          />
                        </div>

                        <div className="check-field">
                          <label>Agent</label>
                          <select
                            value={check.agentId}
                            onChange={(e) => handleUpdateCheck(index, 'agentId', e.target.value)}
                            disabled={loading}
                          >
                            {AVAILABLE_AGENTS.map((agent) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.label}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="check-field">
                          <label>Prompt</label>
                          <textarea
                            value={check.agentPrompt}
                            onChange={(e) => handleUpdateCheck(index, 'agentPrompt', e.target.value)}
                            placeholder="What should this agent check?"
                            rows={3}
                            disabled={loading}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {error && (
                <div className="error-message">
                  <strong>Error:</strong> {error}
                </div>
              )}

              <div className="button-row">
                <button className="secondary" onClick={handleClose} disabled={loading}>
                  Cancel
                </button>
                <button className="primary" onClick={handleSave} disabled={loading}>
                  {loading ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
