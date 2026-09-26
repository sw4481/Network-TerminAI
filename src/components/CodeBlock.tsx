import React, { useState } from 'react';
import './CodeBlock.css';

export interface CodeBlockProps {
  code: string;
  collapsed?: boolean;
  status: 'executing' | 'success' | 'error' | 'retrying';
  output?: string;
  error?: string;
  attempt?: number;
}

export function CodeBlock({
  code,
  collapsed = true,
  status,
  output,
  error,
  attempt,
}: CodeBlockProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(!collapsed);

  const getStatusIcon = (): string => {
    switch (status) {
      case 'executing':
        return '⟳';
      case 'success':
        return '✓';
      case 'error':
        return '✗';
      case 'retrying':
        return '⟳';
      default:
        return '';
    }
  };

  const getStatusClass = (): string => {
    return `code-block-status-${status}`;
  };

  const handleToggle = (): void => {
    setIsExpanded(!isExpanded);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggle();
    }
  };

  return (
    <div className={`code-block ${getStatusClass()}`}>
      <div
        className="code-block-header"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
      >
        <span className="code-block-status-icon">{getStatusIcon()}</span>
        <span className="code-block-status-text">
          {status}
          {attempt !== undefined && attempt > 1 && ` (attempt ${attempt})`}
        </span>
        <span className="code-block-expand-icon">
          {isExpanded ? '▼' : '▶'}
        </span>
      </div>

      {isExpanded && (
        <div className="code-block-body">
          <div className="code-block-code-section">
            <div className="code-block-section-header">Code:</div>
            <pre className="code-block-code">
              <code>{code}</code>
            </pre>
          </div>

          {output && (
            <div className="code-block-output-section">
              <div className="code-block-section-header">Output:</div>
              <pre className="code-block-output">
                <code>{output}</code>
              </pre>
            </div>
          )}

          {error && (
            <div className="code-block-error-section">
              <div className="code-block-section-header">Error:</div>
              <pre className="code-block-error">
                <code>{error}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
