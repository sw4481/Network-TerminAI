import { useEffect, useMemo, useState } from "react";
import { useIntentStore } from "../state/intentStore";
import { useDriftStore } from "../state/driftStore";
import type { DriftReport, DriftSchedule } from "../lib/drift";
import { driftSnapshotDevice, driftExceptionAdd } from "../lib/drift";
import { ScheduleEditor } from "./ScheduleEditor";
import { RemediationDialog } from "./RemediationDialog";
import { ConfigArchiveModal } from "./ConfigArchiveModal";
import { DriftExceptionsModal } from "./DriftExceptionsModal";
import "./DriftSidebar.css";

export function DriftSidebar() {
  const { templates, refresh: refreshTemplates } = useIntentStore();
  const {
    reportsByTemplate,
    selectedReportId,
    schedules,
    loading,
    refreshReports,
    selectReport,
    runOnDemand,
    refreshSchedules,
    createSchedule,
    pauseSchedule,
    resumeSchedule,
    deleteSchedule,
  } = useDriftStore();
  const [templateId, setTemplateId] = useState<string>("");
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [remediateOpen, setRemediateOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [exceptionsOpen, setExceptionsOpen] = useState(false);

  useEffect(() => {
    refreshTemplates();
    refreshSchedules();
  }, [refreshTemplates, refreshSchedules]);

  useEffect(() => {
    if (templateId) refreshReports(templateId);
  }, [templateId, refreshReports]);

  const reports = templateId ? (reportsByTemplate[templateId] ?? []) : [];
  const selected = reports.find((r) => r.id === selectedReportId);
  const templateSchedules = useMemo(
    () => schedules.filter((s) => s.template_id === templateId),
    [schedules, templateId],
  );

  const handleRun = async () => {
    if (!templateId) return;
    try {
      await runOnDemand(templateId);
    } catch (e) {
      console.error("drift run failed", e);
    }
  };

  const handleSchedule = async (cronExpr: string) => {
    if (!templateId) return;
    await createSchedule(templateId, cronExpr);
    setScheduleDialogOpen(false);
  };

  return (
    <div className="drift-sidebar" data-testid="drift-sidebar">
      <div className="drift-tree">
        <div className="drift-tree-header">
          <h3>Drift Reports</h3>
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            data-testid="drift-template-select"
          >
            <option value="">— Select intent —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.vendor}/{t.platform})
              </option>
            ))}
          </select>
          <div className="actions">
            <button
              onClick={handleRun}
              disabled={!templateId || loading}
              data-testid="drift-run"
            >
              {loading ? "Running…" : "Run Now"}
            </button>
            <button
              className="secondary"
              onClick={() => setScheduleDialogOpen(true)}
              disabled={!templateId}
              data-testid="drift-schedule"
            >
              Schedule
            </button>
            <button
              className="drift-snapshot"
              disabled={!templateId}
              onClick={async () => {
                const tpl = templates.find((t) => t.id === templateId);
                const connId = tpl?.selector?.ssh_connection_id;
                if (!tpl || !connId) {
                  alert(
                    "Select an intent whose selector is a single SSH connection to snapshot.",
                  );
                  return;
                }
                try {
                  await driftSnapshotDevice(connId, tpl.vendor, tpl.platform);
                  alert("Snapshot captured.");
                } catch (e) {
                  alert(`Snapshot failed: ${e}`);
                }
              }}
            >
              Snapshot now
            </button>
            <button
              className="drift-archive"
              disabled={!templateId}
              onClick={() => setArchiveOpen(true)}
            >
              Archive
            </button>
            <button
              className="secondary"
              disabled={!templateId}
              onClick={() => setExceptionsOpen(true)}
            >
              Manage exceptions
            </button>
          </div>
        </div>

        {!templateId ? (
          <div className="drift-empty">
            Pick an intent template to see drift reports.
          </div>
        ) : reports.length === 0 ? (
          <div className="drift-empty">
            No reports yet. Click "Run Now" to dispatch the intent across the
            selected devices.
          </div>
        ) : (
          reports.map((r) => <ReportRow key={r.id} report={r} onSelect={selectReport} selected={r.id === selectedReportId} />)
        )}

        {templateId && templateSchedules.length > 0 && (
          <div className="drift-schedule-section">
            <h4>Schedules</h4>
            {templateSchedules.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                onPause={() => pauseSchedule(s.id)}
                onResume={() => resumeSchedule(s.id)}
                onDelete={() => deleteSchedule(s.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="drift-detail">
        {!selected ? (
          <div className="drift-empty">
            Select a report on the left to view its diff.
          </div>
        ) : (
          <>
            <div className="drift-detail-header">
              <span className="name">
                {selected.device_id} ({selected.device_kind})
              </span>
              <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                {new Date(selected.captured_at * 1000).toLocaleString()}
              </span>
              {selected.status === "drift" && (
                <button
                  className="primary"
                  onClick={() => setRemediateOpen(true)}
                  data-testid="drift-remediate"
                >
                  Remediate
                </button>
              )}
            </div>
            {selected.diff_patch && (
              <div className="drift-stats">
                <span className="add">+{selected.diff_patch.stats.additions}</span>
                <span className="del">−{selected.diff_patch.stats.deletions}</span>
                <span>{selected.diff_patch.stats.blocks_changed} blocks</span>
                <span style={{ marginLeft: "auto" }}>
                  severity: {selected.diff_patch.severity}
                </span>
              </div>
            )}
            <DiffView report={selected} templateId={templateId} runOnDemand={runOnDemand} />
          </>
        )}
      </div>

      {scheduleDialogOpen && (
        <ScheduleEditor
          onCancel={() => setScheduleDialogOpen(false)}
          onSubmit={handleSchedule}
        />
      )}
      {remediateOpen && selected && (
        <RemediationDialog
          report={selected}
          onClose={() => setRemediateOpen(false)}
        />
      )}
      {archiveOpen && templateId && (() => {
        const tpl = templates.find((t) => t.id === templateId);
        const connId = tpl?.selector?.ssh_connection_id;
        return connId ? (
          <ConfigArchiveModal
            deviceId={connId}
            deviceKind="ssh"
            onClose={() => setArchiveOpen(false)}
          />
        ) : null;
      })()}
      {exceptionsOpen && templateId && (
        <DriftExceptionsModal templateId={templateId} onClose={() => setExceptionsOpen(false)} />
      )}
    </div>
  );
}

function ReportRow({
  report,
  onSelect,
  selected,
}: {
  report: DriftReport;
  onSelect: (id: string) => void;
  selected: boolean;
}) {
  const dotClass = report.diff_patch
    ? `severity-${report.diff_patch.severity}`
    : report.status === "error"
      ? "error"
      : report.status;
  const dotLabel = report.diff_patch
    ? `${report.diff_patch.severity[0].toUpperCase()}${report.diff_patch.severity.slice(1)} drift`
    : report.status === "in_sync"
      ? "In sync"
      : report.status === "error"
        ? "Drift check error"
        : "Drift detected";
  return (
    <div
      className={`drift-report-row ${selected ? "selected" : ""}`}
      onClick={() => onSelect(report.id)}
      data-testid={`drift-report-${report.id}`}
    >
      <div className="drift-row-top">
        <span
          className={`drift-status-dot ${dotClass}`}
          role="img"
          aria-label={dotLabel}
          title={dotLabel}
        />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
          {report.device_id}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>{report.status}</span>
      </div>
      <div className="drift-row-meta">
        <span>{new Date(report.captured_at * 1000).toLocaleTimeString()}</span>
        {report.diff_patch && (
          <>
            <span style={{ color: "var(--text-primary)" }}>
              +{report.diff_patch.stats.additions}
            </span>
            <span style={{ color: "var(--text-primary)" }}>
              −{report.diff_patch.stats.deletions}
            </span>
          </>
        )}
        {report.error_msg && (
          <span style={{ color: "var(--status-danger)" }} title={report.error_msg}>
            error
          </span>
        )}
      </div>
    </div>
  );
}

function ScheduleRow({
  schedule,
  onPause,
  onResume,
  onDelete,
}: {
  schedule: DriftSchedule;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="drift-schedule-row">
      <span
        className={`drift-status-dot ${schedule.enabled ? "in_sync" : "paused"}`}
        role="img"
        aria-label={schedule.enabled ? "Schedule active" : "Schedule paused"}
        title={schedule.enabled ? "Schedule active" : "Schedule paused"}
      />
      <span className="drift-schedule-cron">{schedule.cron_expr}</span>
      <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
        {schedule.last_run_at
          ? `last ${new Date(schedule.last_run_at * 1000).toLocaleTimeString()}`
          : "never run"}
      </span>
      <div className="actions">
        {schedule.enabled ? (
          <button onClick={onPause}>Pause</button>
        ) : (
          <button onClick={onResume}>Resume</button>
        )}
        <button onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

function DiffView({
  report,
  templateId,
  runOnDemand,
}: {
  report: DriftReport;
  templateId: string;
  runOnDemand: (tid: string) => Promise<DriftReport[]>;
}) {
  const { templates } = useIntentStore();
  const selectedIntent = templates.find((t) => t.id === templateId);
  const isPartialMode = selectedIntent?.match_mode === "partial";

  if (report.error_msg) {
    return (
      <div className="drift-empty" style={{ color: "var(--text-primary)" }}>
        Error: {report.error_msg}
      </div>
    );
  }
  if (!report.diff_patch || report.diff_patch.blocks.length === 0) {
    return <div className="drift-empty">In sync — no differences.</div>;
  }

  const insertLabel = isPartialMode ? "Missing" : "Intent-only";
  const deleteLabel = isPartialMode ? "Changed" : "Device-only";
  const legendText = isPartialMode
    ? "Missing = intended line absent on device · Changed = value differs"
    : "Intent-only = line in intent, not device · Device-only = line on device, not intent";

  return (
    <div className="drift-blocks" data-testid="drift-diff-view">
      <div className="drift-legend">
        <span className="drift-badge drift-insert">{insertLabel}</span> ·
        <span className="drift-badge drift-delete">{deleteLabel}</span> · {legendText}
      </div>
      {report.diff_patch.blocks.map((b, i) => (
        <div key={i} className="drift-block">
          <div className="drift-block-header">
            <span>{b.block_path}</span>
            <span className={`severity ${b.severity}`}>{b.severity}</span>
          </div>
          <div className="drift-changes">
            {b.changes.map((c, j) => {
              const label =
                c.tag === "insert" ? insertLabel :
                c.tag === "delete" ? deleteLabel : "";
              return (
                <div key={j} className={`drift-line drift-${c.tag}`}>
                  {label && <span className={`drift-badge drift-${c.tag}`}>{label}</span>}
                  <span className="marker">
                    {c.tag === "insert" ? "+" : c.tag === "delete" ? "−" : " "}
                  </span>
                  {c.line}
                  {(c.tag === "insert" || c.tag === "delete") && (
                    <button
                      className="drift-ack"
                      title="Acknowledge — stop reporting this line"
                      onClick={async () => {
                        if (!templateId) return;
                        try {
                          await driftExceptionAdd(templateId, c.line);
                          await runOnDemand(templateId);
                        } catch (e) {
                          alert(`Failed to acknowledge: ${e}`);
                        }
                      }}
                    >
                      Acknowledge
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
