import { memo, useState } from 'react';
import { aiNaturalToCommand } from '../lib/ai';
import './NaturalLanguageInput.css';

interface NaturalLanguageInputProps {
  onCommandGenerated: (command: string) => void;
  onClose: () => void;
  cwd: string;
  tabId: string;
  paneId?: string;
}

export const NaturalLanguageInput = memo(function NaturalLanguageInput({
  onCommandGenerated,
  onClose,
  cwd,
  tabId,
  paneId,
}: NaturalLanguageInputProps) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedCommand, setGeneratedCommand] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!input.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const result = await aiNaturalToCommand(
        input.trim(),
        cwd,
        tabId,
        paneId
      );

      setGeneratedCommand(result.command);
      setExplanation(result.explanation);
    } catch (err) {
      console.error('Failed to generate command:', err);
      setError('Failed to generate command. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleUse = () => {
    if (generatedCommand) {
      onCommandGenerated(generatedCommand);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (generatedCommand) {
        handleUse();
      } else {
        handleGenerate();
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="nl-input-overlay" onClick={onClose}>
      <div className="nl-input-modal" onClick={(e) => e.stopPropagation()}>
        <div className="nl-header">
          <h3>Natural Language Command</h3>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="nl-content">
          <div className="nl-input-section">
            <label htmlFor="nl-input">Describe what you want to do:</label>
            <textarea
              id="nl-input"
              placeholder="e.g., find all text files in this directory, list processes using port 8080, compress this folder..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={3}
              autoFocus
            />
          </div>

          {generatedCommand && (
            <div className="nl-result">
              <div className="result-command">
                <span className="result-label">Generated command:</span>
                <code>{generatedCommand}</code>
              </div>
              {explanation && (
                <div className="result-explanation">
                  <span className="result-label">Explanation:</span>
                  <p>{explanation}</p>
                </div>
              )}
            </div>
          )}

          {error && <div className="nl-error">{error}</div>}
        </div>

        <div className="nl-actions">
          <button className="cancel-btn" onClick={onClose}>
            Cancel
          </button>
          {generatedCommand ? (
            <button className="use-btn" onClick={handleUse}>
              Use Command
            </button>
          ) : (
            <button
              className="generate-btn"
              onClick={handleGenerate}
              disabled={!input.trim() || loading}
            >
              {loading ? 'Generating...' : 'Generate'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
