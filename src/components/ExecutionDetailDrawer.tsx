import { useState } from 'react';
import { useHeartbeatStore } from '../state/heartbeatStore';
import type { CheckGroup, FindingDetail } from '../state/heartbeatStore';
import './ExecutionDetailDrawer.css';

export function ExecutionDetailDrawer() {
  const { selectedExecution, clearExecutionDetail } = useHeartbeatStore();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  if (!selectedExecution) {
    return null;
  }

  const { execution, checkGroups } = selectedExecution;

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const handleExport = async () => {
    try {
      const json = JSON.stringify(selectedExecution, null, 2);
      await navigator.clipboard.writeText(json);
    } catch (err) {
      console.error('Failed to export:', err);
    }
  };

  const formatTimestamp = (ts: number | null) => {
    if (!ts) return 'N/A';
    return new Date(ts * 1000).toLocaleString();
  };

  const formatDuration = (ms: number | null) => {
    if (!ms) return 'N/A';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'ok':
        return '✓';
      case 'info':
        return 'ℹ';
      case 'warning':
        return '⚠';
      case 'critical':
      case 'error':
        return '✕';
      default:
        return '•';
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'ok':
        return 'severity-ok';
      case 'info':
        return 'severity-info';
      case 'warning':
        return 'severity-warning';
      case 'critical':
      case 'error':
        return 'severity-error';
      default:
        return '';
    }
  };

  return (
    <>
      <div className="execution-detail-overlay" onClick={clearExecutionDetail} />
      <div className="execution-detail-drawer">
        <div className="execution-detail-header">
          <h2>Execution Details</h2>
          <div className="execution-detail-actions">
            <button
              className="execution-detail-btn"
              onClick={handleExport}
              title="Export JSON"
            >
              📋
            </button>
            <button
              className="execution-detail-btn close-btn"
              onClick={clearExecutionDetail}
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="execution-detail-content">
          <div className="execution-summary">
            <div className="execution-summary-row">
              <span className="execution-label">Status:</span>
              <span className={`execution-status status-${execution.status}`}>
                {execution.status}
              </span>
            </div>
            <div className="execution-summary-row">
              <span className="execution-label">Severity:</span>
              <span className={`execution-severity ${getSeverityColor(execution.overallSeverity)}`}>
                {getSeverityIcon(execution.overallSeverity)} {execution.overallSeverity}
              </span>
            </div>
            <div className="execution-summary-row">
              <span className="execution-label">Started:</span>
              <span>{formatTimestamp(execution.startedAt)}</span>
            </div>
            <div className="execution-summary-row">
              <span className="execution-label">Completed:</span>
              <span>{formatTimestamp(execution.completedAt)}</span>
            </div>
            <div className="execution-summary-row">
              <span className="execution-label">Duration:</span>
              <span>{formatDuration(execution.durationMs)}</span>
            </div>
          </div>

          <div className="check-groups-section">
            <h3>Check Groups</h3>
            {checkGroups.length === 0 ? (
              <div className="check-groups-empty">No check groups</div>
            ) : (
              <div className="check-groups-list">
                {checkGroups.map((group) => (
                  <CheckGroupItem
                    key={group.id}
                    group={group}
                    expanded={expandedGroups.has(group.id)}
                    onToggle={() => toggleGroup(group.id)}
                    getSeverityIcon={getSeverityIcon}
                    getSeverityColor={getSeverityColor}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

interface CheckGroupItemProps {
  group: CheckGroup;
  expanded: boolean;
  onToggle: () => void;
  getSeverityIcon: (severity: string) => string;
  getSeverityColor: (severity: string) => string;
}

function CheckGroupItem({
  group,
  expanded,
  onToggle,
  getSeverityIcon,
  getSeverityColor,
}: CheckGroupItemProps) {
  return (
    <div className="check-group">
      <div className="check-group-header" onClick={onToggle}>
        <span className="check-group-toggle">{expanded ? '▼' : '▶'}</span>
        <span className="check-group-name">{group.name}</span>
        <span className={`check-group-severity ${getSeverityColor(group.severity)}`}>
          {getSeverityIcon(group.severity)} {group.severity}
        </span>
        <span className="check-group-count">
          {group.findings.length} {group.findings.length === 1 ? 'finding' : 'findings'}
        </span>
      </div>
      {expanded && (
        <div className="check-group-findings">
          {group.findings.length === 0 ? (
            <div className="findings-empty">No findings</div>
          ) : (
            group.findings.map((finding) => (
              <FindingItem
                key={finding.id}
                finding={finding}
                getSeverityIcon={getSeverityIcon}
                getSeverityColor={getSeverityColor}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface FindingItemProps {
  finding: FindingDetail;
  getSeverityIcon: (severity: string) => string;
  getSeverityColor: (severity: string) => string;
}

function FindingItem({ finding, getSeverityIcon, getSeverityColor }: FindingItemProps) {
  const [showMetadata, setShowMetadata] = useState(false);

  // Format message to make timestamps and JSON more readable
  const formatMessage = (msg: string): string => {
    // Try to detect if message contains JSON
    if (msg.includes('{') && msg.includes('}')) {
      try {
        // Try to parse and pretty-print JSON blocks
        const jsonMatch = msg.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const formatted = JSON.stringify(parsed, null, 2);
          return msg.replace(jsonMatch[0], formatted);
        }
      } catch {
        // Not valid JSON or mixed content, fall through to timestamp formatting
      }
    }

    // Format ISO timestamps to human-readable
    // Match ISO 8601: 2026-06-27T00:36:57.006000Z
    const isoPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
    return msg.replace(isoPattern, (isoStr) => {
      try {
        const date = new Date(isoStr);
        return date.toLocaleString();
      } catch {
        return isoStr; // Return original if parsing fails
      }
    });
  };

  // Format metadata JSON with human-readable timestamps
  const formatMetadata = (meta: Record<string, any>): string => {
    const formatted = JSON.stringify(meta, null, 2);
    // Replace ISO timestamps in the JSON string
    const isoPattern = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g;
    return formatted.replace(isoPattern, (match, isoStr) => {
      try {
        const date = new Date(isoStr);
        return `"${date.toLocaleString()}"`;
      } catch {
        return match;
      }
    });
  };

  const formattedMessage = finding.message ? formatMessage(finding.message) : '';

  return (
    <div className="finding-item">
      <div className="finding-header">
        <span className={`finding-severity ${getSeverityColor(finding.severity)}`}>
          {getSeverityIcon(finding.severity)}
        </span>
        <span className="finding-title">{finding.title}</span>
      </div>
      {formattedMessage && (
        <div className="finding-message">{formattedMessage}</div>
      )}
      {finding.metadata && (
        <>
          <button
            className="finding-metadata-toggle"
            onClick={() => setShowMetadata(!showMetadata)}
          >
            {showMetadata ? '▼' : '▶'} Metadata
          </button>
          {showMetadata && (
            <pre className="finding-metadata">
              {formatMetadata(finding.metadata)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
