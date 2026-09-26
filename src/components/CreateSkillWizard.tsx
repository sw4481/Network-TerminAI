import { useState } from "react";
import { agentGenerateSkill, skillsCreate, type SkillScript } from "../lib/tauri";

interface CreateSkillWizardProps {
  onClose: () => void;
  onCreated: () => void;
}

type Step = 1 | 2 | 3;

export function CreateSkillWizard({ onClose, onCreated }: CreateSkillWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [description, setDescription] = useState("");
  const [examples, setExamples] = useState("");
  const [generating, setGenerating] = useState(false);
  const [editedMd, setEditedMd] = useState("");
  const [suggestedScripts, setSuggestedScripts] = useState<SkillScript[]>([]);
  const [selectedScripts, setSelectedScripts] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleGenerate = async () => {
    if (!description.trim()) {
      setError("Please provide a skill description");
      return;
    }

    setGenerating(true);
    setError(null);

    try {
      const result = await agentGenerateSkill({
        description,
        examples,
      });
      setEditedMd(result.skill_md);
      setSuggestedScripts(result.scripts || []);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate skill");
    } finally {
      setGenerating(false);
    }
  };

  const handleRegenerate = async () => {
    setGenerating(true);
    setError(null);

    try {
      const result = await agentGenerateSkill({
        description,
        examples,
      });
      setEditedMd(result.skill_md);
      setSuggestedScripts(result.scripts || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to regenerate skill");
    } finally {
      setGenerating(false);
    }
  };

  const handleNext = () => {
    if (step === 2) {
      setStep(3);
    }
  };

  const handleBack = () => {
    if (step === 2) {
      setStep(1);
    } else if (step === 3) {
      setStep(2);
    }
  };

  const toggleScript = (index: number) => {
    const newSelected = new Set(selectedScripts);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedScripts(newSelected);
  };

  const handleCreate = async () => {
    setCreating(true);
    setError(null);

    try {
      // Extract skill name from SKILL.md frontmatter
      const nameMatch = editedMd.match(/^name:\s*(.+)$/m);
      const skillName = nameMatch
        ? nameMatch[1].trim()
        : "unnamed-skill";

      // Collect selected scripts
      const scriptsToCreate: SkillScript[] = [];
      selectedScripts.forEach((index) => {
        if (suggestedScripts[index]) {
          scriptsToCreate.push(suggestedScripts[index]);
        }
      });

      await skillsCreate({
        name: skillName,
        skillMdContent: editedMd,
        scripts: scriptsToCreate,
      });

      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create skill");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content wizard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Create New Skill - Step {step} of 3</h2>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {/* Step 1: Describe skill */}
          {step === 1 && (
            <div className="wizard-step">
              <h3>Describe Your Skill</h3>
              <p className="help-text">
                Tell the AI what this skill should do. Be specific about the functionality,
                inputs, and expected outputs.
              </p>

              <div className="field">
                <label>Skill Description *</label>
                <textarea
                  className="wizard-textarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Example: Create a skill that analyzes Python code for security vulnerabilities. It should scan for common issues like SQL injection, hardcoded credentials, and unsafe deserialization. Output a formatted report with severity levels."
                  rows={8}
                />
              </div>

              <div className="field">
                <label>Example Commands (Optional)</label>
                <textarea
                  className="wizard-textarea"
                  value={examples}
                  onChange={(e) => setExamples(e.target.value)}
                  placeholder="Example commands or usage scenarios:
/security-scan app.py
/security-scan --strict src/"
                  rows={4}
                />
              </div>

              {error && (
                <div className="error-message">
                  <strong>Error:</strong> {error}
                </div>
              )}

              <div className="button-row">
                <button
                  onClick={handleGenerate}
                  disabled={generating || !description.trim()}
                  className="primary"
                >
                  {generating ? "Generating..." : "Generate with AI"}
                </button>
                <button onClick={onClose} className="secondary">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Preview and edit SKILL.md */}
          {step === 2 && (
            <div className="wizard-step">
              <h3>Review Generated Skill</h3>
              <p className="help-text">
                Edit the generated SKILL.md content below. This file defines the skill's
                behavior, triggers, and documentation.
              </p>

              <div className="field">
                <label>SKILL.md Content</label>
                <textarea
                  className="wizard-textarea code-editor"
                  value={editedMd}
                  onChange={(e) => setEditedMd(e.target.value)}
                  rows={16}
                  spellCheck={false}
                />
              </div>

              {suggestedScripts.length > 0 && (
                <div className="suggested-scripts">
                  <h4>Suggested Scripts ({suggestedScripts.length})</h4>
                  <p className="muted">These scripts will be available in the next step.</p>
                  <ul className="script-list">
                    {suggestedScripts.map((script, i) => (
                      <li key={i}>
                        <code>{script.name}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {error && (
                <div className="error-message">
                  <strong>Error:</strong> {error}
                </div>
              )}

              <div className="button-row">
                <button
                  onClick={handleRegenerate}
                  disabled={generating}
                  className="secondary"
                >
                  {generating ? "Regenerating..." : "Regenerate"}
                </button>
                <button onClick={handleNext} disabled={!editedMd.trim()} className="primary">
                  Next: Add Scripts
                </button>
                <button onClick={handleBack} className="secondary">
                  Back
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Add scripts */}
          {step === 3 && (
            <div className="wizard-step">
              <h3>Add Scripts (Optional)</h3>
              <p className="help-text">
                Select which suggested scripts to include with your skill. You can skip this
                step if the skill doesn't need any scripts.
              </p>

              {suggestedScripts.length > 0 ? (
                <div className="scripts-section">
                  {suggestedScripts.map((script, i) => (
                    <div key={i} className="script-item">
                      <div className="script-header">
                        <label className="script-checkbox">
                          <input
                            type="checkbox"
                            checked={selectedScripts.has(i)}
                            onChange={() => toggleScript(i)}
                          />
                          <span className="script-name">{script.name}</span>
                        </label>
                      </div>
                      {selectedScripts.has(i) && (
                        <pre className="script-preview">
                          <code>{script.content}</code>
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No scripts suggested for this skill.</p>
              )}

              {error && (
                <div className="error-message">
                  <strong>Error:</strong> {error}
                </div>
              )}

              <div className="button-row">
                <button
                  onClick={handleCreate}
                  disabled={creating}
                  className="primary"
                >
                  {creating ? "Creating..." : "Create Skill"}
                </button>
                <button onClick={handleBack} className="secondary" disabled={creating}>
                  Back
                </button>
                <button onClick={onClose} className="secondary" disabled={creating}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
