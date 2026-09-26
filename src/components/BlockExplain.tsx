import { memo } from 'react';
import './BlockExplain.css';

interface BlockExplainProps {
  explanation: string | null;
  loading?: boolean;
  onClose: () => void;
}

export const BlockExplain = memo(function BlockExplain({
  explanation,
  loading = false,
  onClose,
}: BlockExplainProps) {
  return (
    <div className="block-explain">
      <div className="explain-header">
        <span className="explain-icon">💡</span>
        <span className="explain-title">Command Explanation</span>
        <button
          className="explain-close"
          onClick={onClose}
          title="Close explanation"
        >
          ✕
        </button>
      </div>

      <div className="explain-content">
        {loading ? (
          <div className="explain-loading">
            <span className="loading-spinner">⏳</span>
            Explaining command...
          </div>
        ) : explanation ? (
          <p>
            {/*
              SECURITY NOTE: explanation contains AI-generated text.
              React escapes by default which prevents XSS.
              DO NOT use dangerouslySetInnerHTML without proper sanitization.
            */}
            {explanation}
          </p>
        ) : (
          <p className="explain-error">Failed to generate explanation.</p>
        )}
      </div>
    </div>
  );
});
