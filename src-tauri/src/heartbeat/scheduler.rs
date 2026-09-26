use crate::agent_bridge::AgentBridge;
use crate::heartbeat::repo::HeartbeatRepo;
use crate::heartbeat::runner;
use crate::heartbeat::types::Heartbeat;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const DEFAULT_MAX_CONCURRENCY: usize = 1;
const MAX_CONFIGURED_CONCURRENCY: usize = 32;

fn interval_seconds(interval_minutes: u32) -> Result<i64> {
    if interval_minutes == 0 {
        anyhow::bail!("interval must be at least 1 minute");
    }

    i64::from(interval_minutes)
        .checked_mul(60)
        .ok_or_else(|| anyhow::anyhow!("heartbeat interval is too large"))
}

fn epoch_seconds() -> Result<i64> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?
        .as_secs();
    i64::try_from(seconds).context("current timestamp does not fit in i64")
}

/// Resolve an interval phase to the first due time strictly after `now`.
///
/// A future persisted due time is preserved exactly. A stale due time remains
/// the phase anchor, but missed intervals are skipped in closed-form rather
/// than replayed one by one. With no anchor, a fresh interval starts at
/// `now + interval_seconds`.
fn first_future_due(now: i64, persisted_due: Option<i64>, interval_seconds: i64) -> Result<i64> {
    if interval_seconds <= 0 {
        anyhow::bail!("interval must be positive");
    }

    let Some(anchor) = persisted_due else {
        return now
            .checked_add(interval_seconds)
            .ok_or_else(|| anyhow::anyhow!("next heartbeat due time overflowed"));
    };

    if anchor > now {
        return Ok(anchor);
    }

    let elapsed = now
        .checked_sub(anchor)
        .ok_or_else(|| anyhow::anyhow!("heartbeat phase calculation overflowed"))?;
    let elapsed_intervals = elapsed
        .checked_div(interval_seconds)
        .ok_or_else(|| anyhow::anyhow!("invalid heartbeat interval"))?;
    let intervals_to_advance = elapsed_intervals
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("heartbeat phase calculation overflowed"))?;
    let advance = intervals_to_advance
        .checked_mul(interval_seconds)
        .ok_or_else(|| anyhow::anyhow!("heartbeat phase calculation overflowed"))?;

    anchor
        .checked_add(advance)
        .ok_or_else(|| anyhow::anyhow!("next heartbeat due time overflowed"))
}

fn parse_max_concurrency(value: Option<&str>) -> usize {
    value
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_CONCURRENCY)
        .min(MAX_CONFIGURED_CONCURRENCY)
}

fn configured_max_concurrency() -> usize {
    let raw = std::env::var("CCIE_HEARTBEAT_MAX_CONCURRENCY").ok();
    let configured = parse_max_concurrency(raw.as_deref());

    if let Some(raw) = raw {
        match raw.trim().parse::<usize>() {
            Ok(0) | Err(_) => tracing::warn!(
                value = %raw,
                default = DEFAULT_MAX_CONCURRENCY,
                "Invalid CCIE_HEARTBEAT_MAX_CONCURRENCY; using default"
            ),
            Ok(value) if value > MAX_CONFIGURED_CONCURRENCY => tracing::warn!(
                value,
                maximum = MAX_CONFIGURED_CONCURRENCY,
                "CCIE_HEARTBEAT_MAX_CONCURRENCY exceeds safety limit; clamping"
            ),
            Ok(_) => {}
        }
    }

    configured
}

pub trait HeartbeatSink: Send + Sync + 'static {
    fn emit_execution_completed(
        &self,
        heartbeat_id: &str,
        execution_id: &str,
        status: &str,
        severity: &str,
        summary: &str,
        heartbeat_name: &str,
    );
}

pub struct NoopSink;
impl HeartbeatSink for NoopSink {
    fn emit_execution_completed(&self, _: &str, _: &str, _: &str, _: &str, _: &str, _: &str) {}
}

struct RunPermits {
    _heartbeat: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

struct HeartbeatRunGate {
    semaphore: Arc<Semaphore>,
    retiring: AtomicBool,
}

impl HeartbeatRunGate {
    fn new() -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(1)),
            retiring: AtomicBool::new(false),
        }
    }
}

#[derive(Clone)]
struct RunAdmission {
    global: Arc<Semaphore>,
    heartbeat_gates: Arc<Mutex<HashMap<String, Arc<HeartbeatRunGate>>>>,
}

impl RunAdmission {
    fn new(max_concurrency: usize) -> Self {
        Self {
            global: Arc::new(Semaphore::new(max_concurrency.max(1))),
            heartbeat_gates: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn heartbeat_gate(&self, heartbeat_id: &str) -> Arc<HeartbeatRunGate> {
        self.heartbeat_gates
            .lock()
            .entry(heartbeat_id.to_string())
            .or_insert_with(|| Arc::new(HeartbeatRunGate::new()))
            .clone()
    }

    fn select_gate(&self, heartbeat_id: &str) -> Result<Arc<HeartbeatRunGate>> {
        let gate = self.heartbeat_gate(heartbeat_id);
        if gate.retiring.load(Ordering::Acquire) {
            anyhow::bail!("heartbeat {heartbeat_id} is being deleted");
        }
        Ok(gate)
    }

    /// Manual runs intentionally wait until admitted. Their queue time is
    /// outside the heartbeat runner's own model/tool timeouts.
    #[cfg(test)]
    async fn acquire(&self, heartbeat_id: &str) -> Result<RunPermits> {
        let heartbeat_gate = self.select_gate(heartbeat_id)?;
        self.acquire_selected(heartbeat_id, heartbeat_gate).await
    }

    /// Acquire a gate selected while the scheduler lifecycle lock was held.
    /// Deletion may retire this exact gate after selection; retaining the Arc
    /// prevents a trigger from recreating a fresh map entry in that race.
    async fn acquire_selected(
        &self,
        heartbeat_id: &str,
        heartbeat_gate: Arc<HeartbeatRunGate>,
    ) -> Result<RunPermits> {
        if heartbeat_gate.retiring.load(Ordering::Acquire) {
            anyhow::bail!("heartbeat {heartbeat_id} is being deleted");
        }

        let heartbeat = heartbeat_gate
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| anyhow::anyhow!("heartbeat run gate closed"))?;
        if heartbeat_gate.retiring.load(Ordering::Acquire) {
            anyhow::bail!("heartbeat {heartbeat_id} is being deleted");
        }

        let global = self
            .global
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| anyhow::anyhow!("global heartbeat run gate closed"))?;
        if heartbeat_gate.retiring.load(Ordering::Acquire) {
            anyhow::bail!("heartbeat {heartbeat_id} is being deleted");
        }

        Ok(RunPermits {
            _heartbeat: heartbeat,
            _global: global,
        })
    }

    /// Scheduled runs can be removed while they are queued. Acquire the keyed
    /// permit first so two runs for the same heartbeat never overlap, then the
    /// global permit so all heartbeats respect the configured capacity.
    async fn acquire_scheduled(
        &self,
        heartbeat_id: &str,
        cancellation: &CancellationToken,
    ) -> Option<RunPermits> {
        let heartbeat_gate = self.heartbeat_gate(heartbeat_id);
        if heartbeat_gate.retiring.load(Ordering::Acquire) {
            return None;
        }

        let heartbeat = tokio::select! {
            _ = cancellation.cancelled() => return None,
            permit = heartbeat_gate.semaphore.clone().acquire_owned() => permit.ok()?,
        };

        if cancellation.is_cancelled() || heartbeat_gate.retiring.load(Ordering::Acquire) {
            return None;
        }

        let global = tokio::select! {
            _ = cancellation.cancelled() => return None,
            permit = self.global.clone().acquire_owned() => permit.ok()?,
        };

        if cancellation.is_cancelled() || heartbeat_gate.retiring.load(Ordering::Acquire) {
            return None;
        }

        Some(RunPermits {
            _heartbeat: heartbeat,
            _global: global,
        })
    }

    /// Stop new acquisitions and return the gate whose outstanding holders
    /// must drain before the heartbeat row can be deleted.
    fn begin_retirement(&self, heartbeat_id: &str) -> Arc<HeartbeatRunGate> {
        let gate = self.heartbeat_gate(heartbeat_id);
        gate.retiring.store(true, Ordering::Release);
        gate
    }

    fn finish_retirement(&self, heartbeat_id: &str, gate: &Arc<HeartbeatRunGate>, deleted: bool) {
        let mut gates = self.heartbeat_gates.lock();
        let is_current = gates
            .get(heartbeat_id)
            .is_some_and(|current| Arc::ptr_eq(current, gate));

        if deleted {
            if is_current {
                gates.remove(heartbeat_id);
            }
        } else {
            gate.retiring.store(false, Ordering::Release);
        }
    }

    #[cfg(test)]
    fn has_heartbeat_gate(&self, heartbeat_id: &str) -> bool {
        self.heartbeat_gates.lock().contains_key(heartbeat_id)
    }
}

struct ScheduledTask {
    cancellation: CancellationToken,
    handle: JoinHandle<()>,
}

#[derive(Clone, Copy)]
enum RegistrationPhase {
    PreservePersisted,
    Fresh,
}

#[derive(Clone)]
pub struct HeartbeatScheduler {
    inner: Arc<HeartbeatSchedulerInner>,
}

struct HeartbeatSchedulerInner {
    db: Arc<Mutex<Connection>>,
    agent_bridge: AgentBridge,
    sink: Arc<dyn HeartbeatSink>,
    admission: RunAdmission,
    started: AtomicBool,
    lifecycle: AsyncMutex<()>,
    tasks: Mutex<HashMap<String, ScheduledTask>>,
}

impl HeartbeatScheduler {
    pub fn new(
        db: Arc<Mutex<Connection>>,
        agent_bridge: AgentBridge,
        sink: Arc<dyn HeartbeatSink>,
    ) -> Self {
        Self {
            inner: Arc::new(HeartbeatSchedulerInner {
                db,
                agent_bridge,
                sink,
                admission: RunAdmission::new(configured_max_concurrency()),
                started: AtomicBool::new(false),
                lifecycle: AsyncMutex::new(()),
                tasks: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn start(&self) -> Result<()> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        if self.inner.started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        // Reap orphaned executions: any row still "running" at startup belongs
        // to a previous process that died (or a run that errored after creating
        // the record but before finalizing it). Mark them failed so the UI never
        // shows a permanently-stuck "running" execution.
        {
            let conn = self.inner.db.lock();
            if let Err(e) = conn.execute(
                "UPDATE heartbeat_executions
                 SET status = 'failed', overall_severity = 'error',
                     completed_at = COALESCE(completed_at, strftime('%s','now'))
                 WHERE status = 'running'",
                [],
            ) {
                tracing::warn!("Failed to reap orphaned heartbeat executions: {:?}", e);
            }
        }

        let enabled = {
            let conn = self.inner.db.lock();
            match HeartbeatRepo::list_heartbeats(&conn) {
                Ok(heartbeats) => heartbeats
                    .into_iter()
                    .filter(|heartbeat| heartbeat.enabled)
                    .collect::<Vec<_>>(),
                Err(error) => {
                    self.inner.started.store(false, Ordering::Release);
                    return Err(error);
                }
            }
        };

        // One malformed row must not prevent other enabled heartbeats from
        // registering at startup.
        for heartbeat in enabled {
            if let Err(error) = self
                .register_locked(&heartbeat, RegistrationPhase::PreservePersisted)
                .await
            {
                tracing::warn!("Failed to register heartbeat {}: {:?}", heartbeat.id, error);
            }
        }

        Ok(())
    }

    pub async fn shutdown(&self) -> Result<()> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        self.inner.started.store(false, Ordering::Release);

        let tasks = {
            let mut tasks = self.inner.tasks.lock();
            tasks.drain().collect::<Vec<_>>()
        };

        for (_, task) in &tasks {
            task.cancellation.cancel();
        }
        for (heartbeat_id, task) in tasks {
            if let Err(error) = task.handle.await {
                tracing::warn!(
                    heartbeat_id = %heartbeat_id,
                    "Heartbeat scheduling task ended unexpectedly during shutdown: {}",
                    error
                );
            }

            // A task cancelled while queued may still have its just-expired due
            // persisted. Keep enabled heartbeat phases, but advance any stale
            // timestamp so restart never catches up missed runs.
            let now = epoch_seconds()?;
            let conn = self.inner.db.lock();
            if let Some(heartbeat) = HeartbeatRepo::get_heartbeat(&conn, &heartbeat_id)? {
                if heartbeat.enabled {
                    let interval = interval_seconds(heartbeat.interval_minutes)?;
                    let due = first_future_due(now, heartbeat.next_run_at, interval)?;
                    HeartbeatRepo::set_next_run(&conn, &heartbeat_id, Some(due))?;
                }
            }
        }

        Ok(())
    }

    pub async fn add_heartbeat(&self, heartbeat: &Heartbeat) -> Result<()> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        self.register_locked(heartbeat, RegistrationPhase::Fresh)
            .await
    }

    pub async fn pause(&self, id: &str) -> Result<()> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        {
            let conn = self.inner.db.lock();
            HeartbeatRepo::set_enabled(&conn, id, false)?;
        }
        self.cancel_task_locked(id).await;
        let conn = self.inner.db.lock();
        HeartbeatRepo::set_next_run(&conn, id, None)?;
        Ok(())
    }

    pub async fn resume(&self, id: &str) -> Result<()> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let heartbeat = {
            let conn = self.inner.db.lock();
            HeartbeatRepo::set_enabled(&conn, id, true)?;
            HeartbeatRepo::get_heartbeat(&conn, id)?
                .ok_or_else(|| anyhow::anyhow!("heartbeat {id} not found"))?
        };
        self.register_locked(&heartbeat, RegistrationPhase::Fresh)
            .await
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        {
            let conn = self.inner.db.lock();
            if HeartbeatRepo::get_heartbeat(&conn, id)?.is_none() {
                anyhow::bail!("heartbeat {id} not found");
            }
        }

        let retiring_gate = self.inner.admission.begin_retirement(id);
        self.cancel_task_locked(id).await;

        // Drain any manual run that acquired this gate before retirement. New
        // acquisitions see `retiring` and fail without entering the runner.
        let _exclusive = match retiring_gate.semaphore.clone().acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => {
                self.inner
                    .admission
                    .finish_retirement(id, &retiring_gate, false);
                anyhow::bail!("heartbeat run gate closed during deletion");
            }
        };

        let result = {
            let conn = self.inner.db.lock();
            HeartbeatRepo::delete_heartbeat(&conn, id)
        };
        match result {
            Ok(()) => {
                self.inner
                    .admission
                    .finish_retirement(id, &retiring_gate, true);
                Ok(())
            }
            Err(delete_error) => {
                // The row survived, so restore the gate and its periodic task
                // before surfacing the original repository error. Preserve the
                // prior phase rather than delaying the heartbeat by a fresh
                // interval. register_locked also handles an unexpectedly
                // disabled surviving row by keeping it unscheduled.
                self.inner
                    .admission
                    .finish_retirement(id, &retiring_gate, false);
                let surviving = {
                    let conn = self.inner.db.lock();
                    HeartbeatRepo::get_heartbeat(&conn, id)
                };
                let recovery = match surviving {
                    Ok(Some(heartbeat)) => {
                        self.register_locked(&heartbeat, RegistrationPhase::PreservePersisted)
                            .await
                    }
                    Ok(None) => Ok(()),
                    Err(error) => Err(error),
                };

                if let Err(recovery_error) = recovery {
                    return Err(anyhow::anyhow!(
                        "failed to delete heartbeat {id}: {delete_error}; \
                         failed to restore heartbeat scheduling: {recovery_error}"
                    ));
                }

                Err(delete_error)
            }
        }
    }

    pub async fn trigger_now(&self, id: &str) -> Result<String> {
        // Deliberately do not touch next_run_at: an on-demand run must not move
        // the periodic phase.
        let heartbeat_gate = {
            // Select the gate under the same lifecycle lock used by delete so
            // the DB existence check and keyed-gate identity are atomic with
            // retirement/removal.
            let _lifecycle = self.inner.lifecycle.lock().await;
            let conn = self.inner.db.lock();
            if HeartbeatRepo::get_heartbeat(&conn, id)?.is_none() {
                anyhow::bail!("heartbeat {id} not found");
            }
            self.inner.admission.select_gate(id)?
        };
        let _permits = self
            .inner
            .admission
            .acquire_selected(id, heartbeat_gate)
            .await?;
        let run =
            runner::run_heartbeat(self.inner.db.clone(), self.inner.agent_bridge.clone(), id).await;

        match run {
            Ok(result) => {
                self.inner.sink.emit_execution_completed(
                    id,
                    &result.execution_id,
                    &result.status,
                    &result.severity,
                    &result.summary,
                    &result.heartbeat_name,
                );
                Ok(result.execution_id)
            }
            Err(error) => {
                // Still emit a completion event so the UI clears its running
                // state when setup failed before an execution was finalized.
                self.inner.sink.emit_execution_completed(
                    id,
                    "",
                    "failed",
                    "error",
                    &format!("Heartbeat run failed: {}", error),
                    "",
                );
                Err(error)
            }
        }
    }

    async fn register_locked(
        &self,
        heartbeat_snapshot: &Heartbeat,
        phase: RegistrationPhase,
    ) -> Result<()> {
        // Callers may hold a row fetched before they acquired the scheduler
        // lifecycle lock (notably heartbeat_update). Re-read under that lock so
        // a stale enabled snapshot can never resurrect a heartbeat paused or
        // deleted in the meantime.
        let heartbeat = {
            let conn = self.inner.db.lock();
            HeartbeatRepo::get_heartbeat(&conn, &heartbeat_snapshot.id)?
        };

        let heartbeat = match heartbeat {
            Some(heartbeat) if heartbeat.enabled => heartbeat,
            Some(heartbeat) => {
                self.cancel_task_locked(&heartbeat.id).await;
                let conn = self.inner.db.lock();
                HeartbeatRepo::set_next_run(&conn, &heartbeat.id, None)?;
                return Ok(());
            }
            None => {
                self.cancel_task_locked(&heartbeat_snapshot.id).await;
                anyhow::bail!("heartbeat {} not found", heartbeat_snapshot.id);
            }
        };

        let interval = interval_seconds(heartbeat.interval_minutes).with_context(|| {
            format!(
                "Invalid interval {} for heartbeat {}",
                heartbeat.interval_minutes, heartbeat.id
            )
        })?;

        if !self.inner.started.load(Ordering::Acquire) {
            return Ok(());
        }

        self.cancel_task_locked(&heartbeat.id).await;

        let now = epoch_seconds()?;
        let anchor = match phase {
            RegistrationPhase::PreservePersisted => heartbeat.next_run_at,
            RegistrationPhase::Fresh => None,
        };
        let due = first_future_due(now, anchor, interval)?;
        {
            let conn = self.inner.db.lock();
            HeartbeatRepo::set_next_run(&conn, &heartbeat.id, Some(due))?;
        }

        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let inner = self.inner.clone();
        let heartbeat_id = heartbeat.id.clone();
        let task_heartbeat_id = heartbeat_id.clone();
        let handle = tokio::spawn(async move {
            run_scheduled_loop(inner, task_heartbeat_id, interval, due, task_cancellation).await;
        });

        self.inner.tasks.lock().insert(
            heartbeat_id,
            ScheduledTask {
                cancellation,
                handle,
            },
        );
        Ok(())
    }

    async fn cancel_task_locked(&self, heartbeat_id: &str) {
        let task = self.inner.tasks.lock().remove(heartbeat_id);
        if let Some(task) = task {
            task.cancellation.cancel();
            if let Err(error) = task.handle.await {
                tracing::warn!(
                    heartbeat_id,
                    "Heartbeat scheduling task ended unexpectedly: {}",
                    error
                );
            }
        }
    }
}

async fn wait_until_due(due: i64, cancellation: &CancellationToken) -> Result<bool> {
    let now = epoch_seconds()?;
    if due <= now {
        return Ok(!cancellation.is_cancelled());
    }

    let delay = u64::try_from(due - now).context("heartbeat delay does not fit in u64")?;
    tokio::select! {
        _ = cancellation.cancelled() => Ok(false),
        _ = tokio::time::sleep(Duration::from_secs(delay)) => {
            Ok(!cancellation.is_cancelled())
        }
    }
}

async fn run_scheduled_loop(
    inner: Arc<HeartbeatSchedulerInner>,
    heartbeat_id: String,
    interval: i64,
    mut due: i64,
    cancellation: CancellationToken,
) {
    loop {
        match wait_until_due(due, &cancellation).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                tracing::error!(
                    heartbeat_id = %heartbeat_id,
                    "Failed while waiting for heartbeat due time: {}",
                    error
                );
                return;
            }
        }

        // The tick at `due` has now been consumed. Persist the next future
        // phase before admission so next_run_at always describes the next
        // scheduled run even while this execution is queued or running.
        let next_due = match epoch_seconds()
            .and_then(|now| first_future_due(now, Some(due), interval))
            .and_then(|next| {
                let conn = inner.db.lock();
                HeartbeatRepo::set_next_run(&conn, &heartbeat_id, Some(next))?;
                Ok(next)
            }) {
            Ok(next) => next,
            Err(error) => {
                tracing::error!(
                    heartbeat_id = %heartbeat_id,
                    "Failed to advance heartbeat phase at scheduled tick: {}",
                    error
                );
                return;
            }
        };

        let Some(_permits) = inner
            .admission
            .acquire_scheduled(&heartbeat_id, &cancellation)
            .await
        else {
            return;
        };

        let result =
            runner::run_heartbeat(inner.db.clone(), inner.agent_bridge.clone(), &heartbeat_id)
                .await;

        // Queueing or execution may cross one or more additional phase
        // boundaries. Re-advance only when needed, still before the completion
        // event that causes the frontend to reload next_run_at.
        let post_run_due = match epoch_seconds()
            .and_then(|now| first_future_due(now, Some(next_due), interval))
            .and_then(|candidate| {
                if candidate != next_due {
                    let conn = inner.db.lock();
                    HeartbeatRepo::set_next_run(&conn, &heartbeat_id, Some(candidate))?;
                }
                Ok(candidate)
            }) {
            Ok(candidate) => candidate,
            Err(error) => {
                tracing::error!(
                    heartbeat_id = %heartbeat_id,
                    "Failed to advance scheduled heartbeat phase: {}",
                    error
                );
                emit_scheduled_result(&inner, &heartbeat_id, result);
                return;
            }
        };

        emit_scheduled_result(&inner, &heartbeat_id, result);
        due = post_run_due;

        if cancellation.is_cancelled() {
            return;
        }
    }
}

fn emit_scheduled_result(
    inner: &HeartbeatSchedulerInner,
    heartbeat_id: &str,
    result: Result<runner::ExecutionResult>,
) {
    let (execution_id, status, severity, summary, heartbeat_name) = match result {
        Ok(result) => (
            result.execution_id,
            result.status,
            result.severity,
            result.summary,
            result.heartbeat_name,
        ),
        Err(error) => {
            let message = format!("Runner failed: {}", error);
            tracing::error!("Heartbeat {} execution failed: {}", heartbeat_id, message);
            (
                "unknown".to_string(),
                "failed".to_string(),
                "error".to_string(),
                message,
                "Unknown".to_string(),
            )
        }
    };

    inner.sink.emit_execution_completed(
        heartbeat_id,
        &execution_id,
        &status,
        &severity,
        &summary,
        &heartbeat_name,
    );
}

#[cfg(test)]
#[path = "scheduler_tests.rs"]
mod tests;
