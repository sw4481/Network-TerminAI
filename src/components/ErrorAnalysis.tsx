import { memo } from 'react';
import './ErrorAnalysis.css';

export interface ErrorAnalysisData {
  errorType: string;
  explanation: string;
  suggestions: string[];
}

interface ErrorAnalysisProps {
  analysis: ErrorAnalysisData | null;
  loading?: boolean;
  onExecuteSuggestion: (suggestion: string) => void;
}

export const ErrorAnalysis = memo(function ErrorAnalysis({
  analysis,
  loading = false,
  onExecuteSuggestion,
}: ErrorAnalysisProps) {
  return (
    <div className="error-analysis">
      <div className="error-analysis-header">
        <span className="error-icon">🔴</span>
        <span className="error-title">Error Analysis</span>
      </div>

      <div className="error-analysis-content">
        {loading ? (
          <div className="error-loading">
            <span className="loading-spinner">⏳</span>
            Analyzing error...
          </div>
        ) : analysis ? (
          <>
            <div className="error-explanation">
              <strong>What went wrong:</strong>
              <p>{analysis.explanation}</p>
            </div>

            {analysis.suggestions.length > 0 && (
              <div className="error-suggestions">
                <strong>Suggested fixes:</strong>
                <ul>
                  {analysis.suggestions.slice(0, 3).map((suggestion, index) => (
                    <li
                      key={index}
                      className="error-suggestion"
                      onClick={() => onExecuteSuggestion(suggestion)}
                      title="Click to execute this command"
                    >
                      <span className="suggestion-icon">→</span>
                      <code>{suggestion}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="error-failed">Failed to analyze error.</p>
        )}
      </div>
    </div>
  );
});
