import { useEffect, useState } from 'react';
import { useHeartbeatStore, type Heartbeat, type Execution } from '../state/heartbeatStore';
import { pauseHeartbeat, resumeHeartbeat, deleteHeartbeat, triggerHeartbeatNow } from '../lib/tauri';
import { CreateHeartbeatModal } from './CreateHeartbeatModal';
import { EditHeartbeatModal } from './EditHeartbeatModal';
import './HeartbeatTab.css';

const formatInterval = (minutes: number): string => {
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440);
    return `${days} day${days !== 1 ? 's' : ''}`;
  } else if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours} hour${hours !== 1 ? 's' : ''}`;
  } else {
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }
};

const formatTimestamp = (ts: number | null): string => {
  if (!ts) return 'N/A';
  return new Date(ts * 1000).toLocaleString();
};

const formatDuration = (ms: number | null): string => {
  if (!ms) return 'N/A';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
};

const formatNextRun = (ts: number | null): string => {
  if (!ts) return 'Not scheduled';
  const now = Date.now() / 1000;
  const diff = ts - now;

  if (diff < 0) return 'Overdue';
  if (diff < 60) return 'Less than 1 minute';
  if (diff < 3600) {
    const mins = Math.floor(diff / 60);
    return `${mins} minute${mins > 1 ? 's' : ''}`;
  }
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    return `${hours} hour${hours > 1 ? 's' : ''}`;
  }
  const days = Math.floor(diff / 86400);
  return `${days} day${days > 1 ? 's' : ''}`;
};

const severityBadge = (severity: string) => {
  return <span className={`severity-badge severity-${severity}`}>{severity}</span>;
};

const statusBadge = (status: string) => {
  return <span className={`status-badge status-${status}`}>{status}</span>;
};

export function HeartbeatTab() {
  const {
    heartbeats,
    executions,
    loadHeartbeats,
    loadExecutions,
    subscribeToEvents,
    loadExecutionDetail
  } = useHeartbeatStore();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'next_run' | 'last_run'>('name');
  const [filterStatus, setFilterStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  useEffect(() => {
    loadHeartbeats();
    const unsubscribe = subscribeToEvents();
    return () => {
      unsubscribe.then((fn) => fn());
    };
  }, [loadHeartbeats, subscribeToEvents]);

  useEffect(() => {
    if (expandedId) {
      loadExecutions(expandedId);
    }
  }, [expandedId, loadExecutions]);

  const handleToggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  const handlePause = async (id: string) => {
    setActionLoading(id);
    try {
      await pauseHeartbeat(id);
      await loadHeartbeats();
    } finally {
      setActionLoading(null);
    }
  };

  const handleResume = async (id: string) => {
    setActionLoading(id);
    try {
      await resumeHeartbeat(id);
      await loadHeartbeats();
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete heartbeat "${name}"? This will remove all execution history.`)) {
      return;
    }
    setActionLoading(id);
    try {
      await deleteHeartbeat(id);
      await loadHeartbeats();
      if (expandedId === id) {
        setExpandedId(null);
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleRunNow = async (id: string) => {
    setActionLoading(id);
    try {
      await triggerHeartbeatNow(id);
      await loadHeartbeats();
      await loadExecutions(id);
    } finally {
      setActionLoading(null);
    }
  };

  const handleExecutionClick = (executionId: string) => {
    loadExecutionDetail(executionId);
  };

  const handleCreateSuccess = () => {
    loadHeartbeats();
  };

  // Sort and filter heartbeats
  const filteredHeartbeats = (heartbeats || [])
    .filter((h) => {
      if (filterStatus === 'enabled') return h.enabled;
      if (filterStatus === 'disabled') return !h.enabled;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'name') {
        return a.name.localeCompare(b.name);
      }
      if (sortBy === 'next_run') {
        if (!a.nextRunAt && !b.nextRunAt) return 0;
        if (!a.nextRunAt) return 1;
        if (!b.nextRunAt) return -1;
        return a.nextRunAt - b.nextRunAt;
      }
      if (sortBy === 'last_run') {
        const aExec = executions[a.id]?.[0];
        const bExec = executions[b.id]?.[0];
        if (!aExec && !bExec) return 0;
        if (!aExec) return 1;
        if (!bExec) return -1;
        return bExec.startedAt - aExec.startedAt;
      }
      return 0;
    });

  return (
    <div className="heartbeat-tab" data-testid="heartbeat-tab">
      <div className="heartbeat-header">
        <div className="heartbeat-title">
          <h2>Heartbeat Monitoring</h2>
          <span className="heartbeat-count">{(heartbeats || []).length} configured</span>
        </div>
        <div className="heartbeat-controls">
          <div className="heartbeat-filter">
            <label>Filter:</label>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as any)}>
              <option value="all">All</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          <div className="heartbeat-sort">
            <label>Sort:</label>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
              <option value="name">Name</option>
              <option value="next_run">Next Run</option>
              <option value="last_run">Last Run</option>
            </select>
          </div>
          <button className="heartbeat-new-btn" onClick={() => setShowCreateModal(true)}>+ New Heartbeat</button>
        </div>
      </div>

      {filteredHeartbeats.length === 0 ? (
        <div className="heartbeat-empty">
          <p>No heartbeats configured</p>
          <button className="heartbeat-empty-btn" onClick={() => setShowCreateModal(true)}>Create your first heartbeat</button>
        </div>
      ) : (
        <div className="heartbeat-grid">
          {filteredHeartbeats.map((heartbeat) => (
            <HeartbeatCard
              key={heartbeat.id}
              heartbeat={heartbeat}
              executions={executions[heartbeat.id] || []}
              expanded={expandedId === heartbeat.id}
              loading={actionLoading === heartbeat.id}
              onToggleExpand={handleToggleExpand}
              onPause={handlePause}
              onResume={handleResume}
              onDelete={handleDelete}
              onRunNow={handleRunNow}
              onEdit={setEditId}
              onExecutionClick={handleExecutionClick}
            />
          ))}
        </div>
      )}

      <CreateHeartbeatModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={handleCreateSuccess}
      />

      <EditHeartbeatModal
        heartbeatId={editId}
        onClose={() => setEditId(null)}
        onSuccess={() => {
          setEditId(null);
          loadHeartbeats();
        }}
      />
    </div>
  );
}

interface HeartbeatCardProps {
  heartbeat: Heartbeat;
  executions: Execution[];
  expanded: boolean;
  loading: boolean;
  onToggleExpand: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string, name: string) => void;
  onRunNow: (id: string) => void;
  onEdit: (id: string) => void;
  onExecutionClick: (executionId: string) => void;
}

function HeartbeatCard({
  heartbeat,
  executions,
  expanded,
  loading,
  onToggleExpand,
  onPause,
  onResume,
  onDelete,
  onRunNow,
  onEdit,
  onExecutionClick,
}: HeartbeatCardProps) {
  const lastExecution = executions[0];

  return (
    <div className={`heartbeat-card ${expanded ? 'expanded' : ''}`}>
      <div className="heartbeat-card-header">
        <div className="heartbeat-card-title">
          <h3>{heartbeat.name}</h3>
          {!heartbeat.enabled && <span className="heartbeat-disabled-badge">Paused</span>}
        </div>
        <div className="heartbeat-card-actions">
          <button
            className="heartbeat-action-btn"
            onClick={() => onRunNow(heartbeat.id)}
            disabled={loading}
            title="Run now"
          >
            ▶
          </button>
          <button
            className="heartbeat-action-btn"
            onClick={() => onEdit(heartbeat.id)}
            disabled={loading}
            title="Edit"
          >
            ✎
          </button>
          <button
            className="heartbeat-action-btn"
            onClick={() => heartbeat.enabled ? onPause(heartbeat.id) : onResume(heartbeat.id)}
            disabled={loading}
            title={heartbeat.enabled ? 'Pause' : 'Resume'}
          >
            {heartbeat.enabled ? '⏸' : '▶'}
          </button>
          <button
            className="heartbeat-action-btn danger"
            onClick={() => onDelete(heartbeat.id, heartbeat.name)}
            disabled={loading}
            title="Delete"
          >
            🗑
          </button>
        </div>
      </div>

      {heartbeat.description && (
        <div className="heartbeat-card-description">{heartbeat.description}</div>
      )}

      <div className="heartbeat-card-meta">
        <div className="heartbeat-meta-item">
          <span className="heartbeat-meta-label">Interval:</span>
          <span className="heartbeat-meta-value">{formatInterval(heartbeat.intervalMinutes)}</span>
        </div>
        <div className="heartbeat-meta-item">
          <span className="heartbeat-meta-label">Next Run:</span>
          <span className="heartbeat-meta-value">{formatNextRun(heartbeat.nextRunAt)}</span>
        </div>
        {lastExecution && (
          <>
            <div className="heartbeat-meta-item">
              <span className="heartbeat-meta-label">Last Run:</span>
              <span className="heartbeat-meta-value">{formatTimestamp(lastExecution.startedAt)}</span>
            </div>
            <div className="heartbeat-meta-item">
              <span className="heartbeat-meta-label">Status:</span>
              {statusBadge(lastExecution.status)}
            </div>
            <div className="heartbeat-meta-item">
              <span className="heartbeat-meta-label">Severity:</span>
              {severityBadge(lastExecution.overallSeverity)}
            </div>
            <div className="heartbeat-meta-item">
              <span className="heartbeat-meta-label">Duration:</span>
              <span className="heartbeat-meta-value">{formatDuration(lastExecution.durationMs)}</span>
            </div>
          </>
        )}
      </div>

      <div className="heartbeat-card-footer">
        <button
          className="heartbeat-expand-btn"
          onClick={() => onToggleExpand(heartbeat.id)}
        >
          {expanded ? '▼ Hide History' : `▶ Show History (${executions.length})`}
        </button>
      </div>

      {expanded && (
        <div className="heartbeat-timeline">
          {executions.length === 0 ? (
            <div className="heartbeat-timeline-empty">No executions yet</div>
          ) : (
            <div className="heartbeat-timeline-list">
              {executions.map((exec) => (
                <div
                  key={exec.id}
                  className="heartbeat-timeline-item"
                  onClick={() => onExecutionClick(exec.id)}
                  style={{ cursor: 'pointer' }}
                  title="Click to view details"
                >
                  <div className="heartbeat-timeline-time">
                    {formatTimestamp(exec.startedAt)}
                  </div>
                  <div className="heartbeat-timeline-status">
                    {statusBadge(exec.status)}
                  </div>
                  <div className="heartbeat-timeline-severity">
                    {severityBadge(exec.overallSeverity)}
                  </div>
                  <div className="heartbeat-timeline-duration">
                    {formatDuration(exec.durationMs)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
