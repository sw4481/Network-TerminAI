import { useState, useCallback } from 'react';
import { Workflow, WorkflowParam, WorkflowStep, Vendor, ParamType } from '../lib/workflows';
import { DEVICE_VENDORS } from '../lib/deviceProfiles';
import './WorkflowEditor.css';

interface WorkflowEditorProps {
  workflow?: Workflow | null;
  onSave: (workflow: Workflow) => void;
  onCancel: () => void;
}

const PARAM_TYPES: ParamType[] = ['string', 'enum', 'ip', 'int', 'interface'];

export function WorkflowEditor({ workflow, onSave, onCancel }: WorkflowEditorProps) {
  const [name, setName] = useState(workflow?.name ?? '');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [vendor, setVendor] = useState<Vendor>(workflow?.vendor ?? 'generic');
  const [platform, setPlatform] = useState(workflow?.platform ?? '');
  const [tags, setTags] = useState(workflow?.tags?.join(', ') ?? '');
  const [steps, setSteps] = useState<WorkflowStep[]>(
    workflow?.steps ?? [{ idx: 0, command_template: '' }]
  );
  const [params, setParams] = useState<WorkflowParam[]>(workflow?.params ?? []);

  const handleAddStep = useCallback(() => {
    setSteps((prev) => [...prev, { idx: prev.length, command_template: '' }]);
  }, []);

  const handleRemoveStep = useCallback((idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, idx: i })));
  }, []);

  const handleStepChange = useCallback((idx: number, value: string) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, command_template: value } : s))
    );
  }, []);

  const handleAddParam = useCallback(() => {
    setParams((prev) => [
      ...prev,
      {
        name: '',
        type: 'string',
        default_value: null,
        required: false,
        description: '',
        enum_values: null,
      },
    ]);
  }, []);

  const handleRemoveParam = useCallback((idx: number) => {
    setParams((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleParamChange = useCallback(
    (idx: number, field: keyof WorkflowParam, value: any) => {
      setParams((prev) =>
        prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p))
      );
    },
    []
  );

  const handleSave = useCallback(() => {
    const wf: Workflow = {
      id: workflow?.id ?? '',
      name,
      description,
      vendor,
      platform,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      steps,
      params,
      created_at: workflow?.created_at ?? Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    };
    onSave(wf);
  }, [workflow, name, description, vendor, platform, tags, steps, params, onSave]);

  const isValid = name.trim() && steps.every((s) => s.command_template.trim());

  return (
    <div className="workflow-editor-backdrop" onClick={onCancel}>
      <div className="workflow-editor-modal" onClick={(e) => e.stopPropagation()}>
        <header className="workflow-editor-header">
          <h2>{workflow ? 'Edit Workflow' : 'New Workflow'}</h2>
          <button className="workflow-editor-close" onClick={onCancel}>
            ×
          </button>
        </header>

        <div className="workflow-editor-content">
          <section className="workflow-editor-section">
            <h3>Basic Info</h3>
            <label>
              Name *
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Show IP Route"
              />
            </label>
            <label>
              Description
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g., Display routing table"
              />
            </label>
            <label>
              Vendor
              <select value={vendor} onChange={(e) => setVendor(e.target.value as Vendor)}>
              {DEVICE_VENDORS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Platform
              <input
                type="text"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                placeholder="e.g., ios-xe, nxos, eos (leave blank for all)"
              />
            </label>
            <label>
              Tags (comma-separated)
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="e.g., routing, diagnostics"
              />
            </label>
          </section>

          <section className="workflow-editor-section">
            <div className="workflow-editor-section-header">
              <h3>Parameters</h3>
              <button className="workflow-editor-add-btn" onClick={handleAddParam}>
                + Add Parameter
              </button>
            </div>
            {params.length === 0 && (
              <p className="workflow-editor-empty">No parameters. Add one to make this workflow reusable.</p>
            )}
            {params.map((param, idx) => (
              <div key={idx} className="workflow-editor-param">
                <input
                  type="text"
                  value={param.name}
                  onChange={(e) => handleParamChange(idx, 'name', e.target.value)}
                  placeholder="Parameter name (e.g., host)"
                />
                <select
                  value={param.type}
                  onChange={(e) => handleParamChange(idx, 'type', e.target.value)}
                >
                  {PARAM_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={param.default_value ?? ''}
                  onChange={(e) => handleParamChange(idx, 'default_value', e.target.value || null)}
                  placeholder="Default value (optional)"
                />
                <label className="workflow-editor-checkbox">
                  <input
                    type="checkbox"
                    checked={param.required}
                    onChange={(e) => handleParamChange(idx, 'required', e.target.checked)}
                  />
                  Required
                </label>
                <button
                  className="workflow-editor-remove-btn"
                  onClick={() => handleRemoveParam(idx)}
                >
                  Remove
                </button>
              </div>
            ))}
            <p className="workflow-editor-hint">
              Use parameters in commands with double braces: <code>{'{'}{'{ host }}'}</code>
            </p>
          </section>

          <section className="workflow-editor-section">
            <div className="workflow-editor-section-header">
              <h3>Commands *</h3>
              <button className="workflow-editor-add-btn" onClick={handleAddStep}>
                + Add Command
              </button>
            </div>
            {steps.map((step, idx) => (
              <div key={idx} className="workflow-editor-step">
                <span className="workflow-editor-step-number">{idx + 1}.</span>
                <input
                  type="text"
                  value={step.command_template}
                  onChange={(e) => handleStepChange(idx, e.target.value)}
                  placeholder="e.g., show ip route {{ vrf }}"
                />
                {steps.length > 1 && (
                  <button
                    className="workflow-editor-remove-btn"
                    onClick={() => handleRemoveStep(idx)}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </section>
        </div>

        <footer className="workflow-editor-footer">
          <button className="workflow-editor-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="workflow-editor-save"
            onClick={handleSave}
            disabled={!isValid}
          >
            {workflow ? 'Save Changes' : 'Create Workflow'}
          </button>
        </footer>
      </div>
    </div>
  );
}
