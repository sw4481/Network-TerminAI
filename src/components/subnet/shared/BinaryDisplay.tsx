import { useState } from 'react';

export interface BinaryDisplayProps {
  binary: string;
  label: string;
}

export function BinaryDisplay({ binary, label }: BinaryDisplayProps) {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="binary-toggle"
        aria-label={`Show binary representation for ${label}`}
      >
        Show Binary
      </button>
    );
  }

  // Format binary with dots every 8 bits for readability
  const formatted = binary.match(/.{1,8}/g)?.join('.') || binary;

  return (
    <div className="binary-display">
      <div className="binary-header">
        <span className="binary-label">{label}</span>
        <button
          onClick={() => setExpanded(false)}
          className="binary-toggle"
          aria-label="Hide binary representation"
        >
          Hide
        </button>
      </div>
      <pre className="binary-value">{formatted}</pre>
    </div>
  );
}
