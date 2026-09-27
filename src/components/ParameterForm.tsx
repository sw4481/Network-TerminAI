import { useState, useEffect, useRef, FormEvent, KeyboardEvent } from 'react';
import { sshSaveConnection } from '../lib/sshConnections';
import { CommandDefinition } from '../hooks/useParameterDetection';
import './ParameterForm.css';

interface ParameterFormProps {
  commandDef: CommandDefinition;
  onSubmit: (command: string, metadata?: { host?: string; user?: string; password?: string }) => void;
  onCancel: () => void;
}

export function ParameterForm({ commandDef, onSubmit, onCancel }: ParameterFormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saveName, setSaveName] = useState<string>('');
  const [showSaveDialog, setShowSaveDialog] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus first input on mount
  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  // Handle Escape key to cancel
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();

    // Validate required fields
    const missingRequired = commandDef.parameters
      .filter(p => p.required && !values[p.name])
      .map(p => p.name);

    if (missingRequired.length > 0) {
      return; // Form validation will show error
    }

    // Build command from values
    const command = commandDef.buildCommand(values);

    // Pass metadata for SSH commands
    const metadata = commandDef.command === 'ssh' ? {
      host: values.host,
      user: values.user,
      password: values.password,
    } : undefined;

    onSubmit(command, metadata);
  };

  const handleInputChange = (name: string, value: string) => {
    setValues(prev => ({ ...prev, [name]: value }));
  };

  const handleKeyPress = (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      // Let form submission handle it
      return;
    }
  };

  const handleSaveConnection = async () => {
    if (!saveName.trim()) {
      setSaveError('Please enter a connection name');
      return;
    }

    try {
      await sshSaveConnection({
        name: saveName.trim(),
        host: values.host || '',
        user: values.user || null,
        port: values.port ? parseInt(values.port) : null,
        identity_file: values.identity || null,
      });
      setShowSaveDialog(false);
      setSaveName('');
      setSaveError(null);
      // Show success by briefly showing message
      const temp = saveError;
      setSaveError('✓ Connection saved successfully!');
      setTimeout(() => setSaveError(temp), 2000);
    } catch (err) {
      setSaveError(String(err));
    }
  };

  return (
    <div
      className="parameter-form-overlay"
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
      onKeyPress={(e) => e.stopPropagation()}
    >
      <div
        className="parameter-form"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="parameter-form-header">
          <h3>{commandDef.command}</h3>
          <p>{commandDef.description}</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="parameter-fields">
            {commandDef.parameters.map((param, index) => (
              <div key={param.name} className="parameter-field">
                <label htmlFor={param.name}>
                  {param.name}
                  {param.required && <span className="required">*</span>}
                </label>
                {param.description && (
                  <span className="parameter-description">{param.description}</span>
                )}

                {param.type === 'select' ? (
                  <select
                    id={param.name}
                    name={param.name}
                    value={values[param.name] || ''}
                    onChange={(e) => handleInputChange(param.name, e.target.value)}
                    onKeyDown={handleKeyPress}
                    required={param.required}
                    aria-label={param.name}
                  >
                    <option value="">Select...</option>
                    {param.options?.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    ref={index === 0 ? firstInputRef : null}
                    id={param.name}
                    type={param.type}
                    name={param.name}
                    placeholder={param.placeholder}
                    value={values[param.name] || ''}
                    onChange={(e) => handleInputChange(param.name, e.target.value)}
                    onKeyDown={handleKeyPress}
                    required={param.required}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="parameter-form-actions">
            <button type="button" onClick={onCancel} className="btn-cancel">
              Cancel
            </button>
            {commandDef.command === 'ssh' && (
              <button
                type="button"
                onClick={() => setShowSaveDialog(true)}
                className="btn-save"
              >
                Save Connection
              </button>
            )}
            <button type="submit" className="btn-submit">
              Execute
            </button>
          </div>
        </form>

        {/* Save connection dialog */}
        {showSaveDialog && commandDef.command === 'ssh' && (
          <div className="save-dialog">
            <h4>Save SSH Connection</h4>
            <input
              type="text"
              placeholder="Connection name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSaveConnection();
                } else if (e.key === 'Escape') {
                  setShowSaveDialog(false);
                  setSaveError(null);
                }
              }}
              autoFocus
            />
            {saveError && <div className="save-error">{saveError}</div>}
            <div className="save-dialog-actions">
              <button
                type="button"
                onClick={() => {
                  setShowSaveDialog(false);
                  setSaveError(null);
                }}
              >
                Cancel
              </button>
              <button type="button" onClick={handleSaveConnection}>
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
