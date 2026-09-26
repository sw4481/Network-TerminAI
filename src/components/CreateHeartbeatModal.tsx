import { useState } from 'react';
import { planHeartbeat, createHeartbeat, type CheckInput } from '../lib/tauri';
import './CreateHeartbeatModal.css';

type CreateHeartbeatModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

type Stage = 'input' | 'review';

const EXAMPLE_PROMPTS = [
  'Check for critical issues on my Meraki network Example-Branch every hour',
  'Verify all pyATS devices are reachable every 30 minutes',
  'Monitor Stealthwatch for security events every 15 minutes',
];

const AVAILABLE_AGENTS = [
  { id: 'meraki', label: 'Meraki Dashboard' },
  { id: 'pyats', label: 'pyATS Devices' },
  { id: 'stealthwatch', label: 'Stealthwatch' },
  { id: 'ise', label: 'Cisco ISE' },
  { id: 'cml', label: 'Cisco CML' },
  { id: 'catalyst_center', label: 'Catalyst Center' },
];

export function CreateHeartbeatModal({ isOpen, onClose, onSuccess }: CreateHeartbeatModalProps) {
  const [stage, setStage] = useState<Stage>('input');
  const [nlInput, setNlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Plan state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [intervalUnit, setIntervalUnit] = useState<'minutes' | 'hours' | 'days'>('minutes');
  const [retentionDays, setRetentionDays] = useState(30);
  const [checks, setChecks] = useState<CheckInput[]>([]);

  const handleAnalyze = async () => {
    if (!nlInput.trim()) {
      setError('Please enter a description of what you want to monitor');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await planHeartbeat(nlInput.trim());

      if (result.status === 'error' || !result.plan) {
        setError(result.error || 'Failed to generate plan');
        return;
      }

      // Populate plan fields
      const plan = result.plan;
      setName(plan.name);
      setDescription(plan.description);

      // Convert interval to appropriate unit
      if (plan.interval_minutes >= 1440 && plan.interval_minutes % 1440 === 0) {
        setIntervalMinutes(plan.interval_minutes / 1440);
        setIntervalUnit('days');
      } else if (plan.interval_minutes >= 60 && plan.interval_minutes % 60 === 0) {
        setIntervalMinutes(plan.interval_minutes / 60);
        setIntervalUnit('hours');
      } else {
        setIntervalMinutes(plan.interval_minutes);
        setIntervalUnit('minutes');
      }

      // Map plan checks from snake_case (Python) to camelCase (Tauri)
      const mappedChecks = plan.checks.map((check, index) => ({
        checkGroupName: check.check_group_name,
        agentId: check.agent_id,
        agentPrompt: check.agent_prompt,
        sortOrder: check.sort_order ?? index,
      }));
      setChecks(mappedChecks);
      setStage('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to analyze input');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    // Validate
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
      // Convert interval to minutes
      let finalIntervalMinutes = intervalMinutes;
      if (intervalUnit === 'hours') {
        finalIntervalMinutes *= 60;
      } else if (intervalUnit === 'days') {
        finalIntervalMinutes *= 1440;
      }

      await createHeartbeat(
        name.trim(),
        description.trim(),
        finalIntervalMinutes,
        retentionDays,
        checks
      );

      setSuccess(true);
      setTimeout(() => {
        handleClose();
        onSuccess();
      }, 1500);
    } catch (e) {
      console.error('Create heartbeat error:', e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      setError(`Failed to create heartbeat: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    setStage('input');
    setError(null);
  };

  const handleClose = () => {
    setStage('input');
    setNlInput('');
    setName('');
    setDescription('');
    setIntervalMinutes(30);
    setIntervalUnit('minutes');
    setRetentionDays(30);
    setChecks([]);
    setError(null);
    setSuccess(false);
    onClose();
  };

  const handleAddCheck = () => {
    const newCheck: CheckInput = {
      checkGroupName: 'New Check',
      agentId: 'meraki',
      agentPrompt: '',
      sortOrder: checks.length,
    };
    setChecks([...checks, newCheck]);
  };

  const handleRemoveCheck = (index: number) => {
    const updated = checks.filter((_, i) => i !== index);
    // Re-index sortOrder
    updated.forEach((check, i) => {
      check.sortOrder = i;
    });
    setChecks(updated);
  };

  const handleUpdateCheck = (index: number, field: keyof CheckInput, value: string | number) => {
    const updated = [...checks];
    updated[index] = { ...updated[index], [field]: value };
    setChecks(updated);
  };

  const handleExampleClick = (example: string) => {
    setNlInput(example);
    setError(null);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content create-heartbeat-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{stage === 'input' ? 'Create Heartbeat' : 'Review & Edit Plan'}</h2>
          <button className="close-btn" onClick={handleClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {success ? (
            <div className="success-message">
              Heartbeat created successfully!
            </div>
          ) : stage === 'input' ? (
            <div className="heartbeat-input-stage">
              <div className="field">
                <label htmlFor="nl-input">Describe what you want to monitor</label>
                <textarea
                  id="nl-input"
                  className="heartbeat-nl-input"
                  value={nlInput}
                  onChange={(e) => setNlInput(e.target.value)}
                  placeholder="e.g., Check my Meraki network for issues every hour"
                  rows={4}
                  disabled={loading}
                  autoFocus
                />
              </div>

              <div className="heartbeat-examples">
                <p className="examples-label">Examples:</p>
                {EXAMPLE_PROMPTS.map((example, idx) => (
                  <button
                    key={idx}
                    className="example-prompt"
                    onClick={() => handleExampleClick(example)}
                    disabled={loading}
                  >
                    {example}
                  </button>
                ))}
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
                <button className="primary" onClick={handleAnalyze} disabled={loading}>
                  {loading ? 'Analyzing...' : 'Analyze'}
                </button>
              </div>
            </div>
          ) : (
            <div className="heartbeat-review-stage">
              <div className="field">
                <label htmlFor="plan-name">Name *</label>
                <input
                  id="plan-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Heartbeat name"
                  disabled={loading}
                />
              </div>

              <div className="field">
                <label htmlFor="plan-description">Description</label>
                <textarea
                  id="plan-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description..."
                  rows={2}
                  disabled={loading}
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="plan-interval">Interval</label>
                  <div className="interval-input">
                    <input
                      id="plan-interval"
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
                  <label htmlFor="plan-retention">Retention (days)</label>
                  <input
                    id="plan-retention"
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
                  <div className="checks-empty">
                    No checks configured. Add at least one check.
                  </div>
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
                <button className="secondary" onClick={handleBack} disabled={loading}>
                  Back
                </button>
                <button className="primary" onClick={handleCreate} disabled={loading}>
                  {loading ? 'Creating...' : 'Create Heartbeat'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
