use anyhow::{Context, Result};
use crate::agent_bridge::AgentBridge;
use crate::heartbeat::repo::HeartbeatRepo;
use crate::heartbeat::runner;
use crate::heartbeat::types::Heartbeat;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Arc;
use tokio_cron_scheduler::{Job, JobScheduler};
use uuid::Uuid;

pub fn interval_to_cron(interval_minutes: u32) -> Result<String> {
    if interval_minutes == 0 {
        anyhow::bail!("interval must be at least 1 minute");
    }

    if interval_minutes >= 1440 {
        // Days
        let days = interval_minutes / 1440;
        Ok(format!("0 0 0 */{} * *", days))
    } else if interval_minutes >= 60 {
        // Hours
        let hours = interval_minutes / 60;
        Ok(format!("0 0 */{} * * *", hours))
    } else {
        // Minutes
        Ok(format!("0 */{} * * * *", interval_minutes))
    }
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

#[derive(Clone)]
pub struct HeartbeatScheduler {
    inner: Arc<HeartbeatSchedulerInner>,
}

struct HeartbeatSchedulerInner {
    db: Arc<Mutex<Connection>>,
    agent_bridge: AgentBridge,
    sink: Arc<dyn HeartbeatSink>,
    sched: Mutex<Option<JobScheduler>>,
    jobs: Mutex<HashMap<String, Uuid>>,
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
                sched: Mutex::new(None),
                jobs: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn start(&self) -> Result<()> {
        if self.inner.sched.lock().is_some() {
            return Ok(());
        }
        let scheduler = JobScheduler::new().await.context("create JobScheduler")?;
        scheduler.start().await.context("start JobScheduler")?;
        *self.inner.sched.lock() = Some(scheduler);

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
            HeartbeatRepo::list_heartbeats(&conn)?
                .into_iter()
                .filter(|h| h.enabled)
                .collect::<Vec<_>>()
        };

        // Collect failures but continue with other heartbeats (resilient approach)
        let mut errors = Vec::new();
        for h in enabled {
            if let Err(e) = self.register(&h).await {
                errors.push((h.id.clone(), e));
            }
        }

        // Log warnings for failed registrations but don't fail overall
        for (id, err) in &errors {
            tracing::warn!("Failed to register heartbeat {}: {:?}", id, err);
        }

        Ok(())
    }

    pub async fn shutdown(&self) -> Result<()> {
        let mut slot = self.inner.sched.lock();
        if let Some(mut s) = slot.take() {
            drop(slot);
            s.shutdown().await.ok();
        }
        self.inner.jobs.lock().clear();
        Ok(())
    }

    pub async fn add_heartbeat(&self, heartbeat: &Heartbeat) -> Result<()> {
        self.register(heartbeat).await
    }

    pub async fn pause(&self, id: &str) -> Result<()> {
        {
            let conn = self.inner.db.lock();
            HeartbeatRepo::set_enabled(&conn, id, false)?;
        }
        self.unregister(id).await
    }

    pub async fn resume(&self, id: &str) -> Result<()> {
        let heartbeat = {
            let conn = self.inner.db.lock();
            HeartbeatRepo::set_enabled(&conn, id, true)?;
            HeartbeatRepo::get_heartbeat(&conn, id)?
                .ok_or_else(|| anyhow::anyhow!("heartbeat {id} not found"))?
        };
        self.register(&heartbeat).await
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        self.unregister(id).await?;
        let conn = self.inner.db.lock();
        HeartbeatRepo::delete_heartbeat(&conn, id)?;
        Ok(())
    }

    pub async fn trigger_now(&self, id: &str) -> Result<String> {
        let run = runner::run_heartbeat(
            self.inner.db.clone(),
            self.inner.agent_bridge.clone(),
            id,
        )
        .await;

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
            Err(e) => {
                // The run itself failed (e.g. setup error, timeout before any
                // execution record was finalized). Still emit a completion
                // event so the UI clears the "running" state instead of
                // hanging forever, then surface the error to the caller.
                self.inner.sink.emit_execution_completed(
                    id,
                    "",
                    "failed",
                    "error",
                    &format!("Heartbeat run failed: {}", e),
                    "",
                );
                Err(e)
            }
        }
    }

    async fn register(&self, heartbeat: &Heartbeat) -> Result<()> {
        let (scheduler, cron_expr, heartbeat_id, old_uuid) = {
            // Hold both locks during critical section to prevent race conditions
            let sched_guard = self.inner.sched.lock();
            let scheduler = match sched_guard.as_ref() {
                Some(s) => s.clone(),
                None => return Ok(()),
            };

            let mut jobs = self.inner.jobs.lock();

            // Remove existing job UUID if present (will unregister after releasing lock)
            let old_uuid = jobs.remove(&heartbeat.id);

            let cron_expr = interval_to_cron(heartbeat.interval_minutes)
                .with_context(|| format!("Invalid interval {} for heartbeat {}", heartbeat.interval_minutes, heartbeat.id))?;

            (scheduler, cron_expr, heartbeat.id.clone(), old_uuid)
            // Locks dropped here
        };

        // Calculate next run time (now + interval)
        let next_run_at = {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs() as i64;
            now + (heartbeat.interval_minutes as i64 * 60)
        };

        // Update next_run_at in database
        {
            let conn = self.inner.db.lock();
            HeartbeatRepo::set_next_run(&conn, &heartbeat_id, Some(next_run_at))?;
        }

        // Unregister existing job if present (outside lock scope)
        if let Some(uuid) = old_uuid {
            let _ = scheduler.remove(&uuid).await;
        }

        let inner = self.inner.clone();
        let heartbeat_id_clone = heartbeat_id.clone();

        let job = Job::new_async(cron_expr.as_str(), move |_uuid, _l| {
            let inner = inner.clone();
            let heartbeat_id = heartbeat_id_clone.clone();
            Box::pin(async move {
                let result = runner::run_heartbeat(
                    inner.db.clone(),
                    inner.agent_bridge.clone(),
                    &heartbeat_id,
                )
                .await;

                let (execution_id, status, severity, summary, heartbeat_name) = match result {
                    Ok(r) => (r.execution_id, r.status, r.severity, r.summary, r.heartbeat_name),
                    Err(e) => {
                        let err_msg = format!("Runner failed: {}", e);
                        tracing::error!("Heartbeat {} execution failed: {}", heartbeat_id, err_msg);
                        ("unknown".to_string(), "failed".to_string(), "error".to_string(), err_msg, "Unknown".to_string())
                    }
                };

                inner.sink.emit_execution_completed(
                    &heartbeat_id,
                    &execution_id,
                    &status,
                    &severity,
                    &summary,
                    &heartbeat_name,
                );
            })
        })
        .with_context(|| format!("Job::new_async for cron '{}'", cron_expr))?;

        let job_uuid = scheduler.add(job).await.context("scheduler.add")?;

        // Insert the job atomically
        self.inner.jobs.lock().insert(heartbeat_id, job_uuid);
        Ok(())
    }

    async fn unregister(&self, heartbeat_id: &str) -> Result<()> {
        let scheduler = match self.inner.sched.lock().as_ref() {
            Some(s) => s.clone(),
            None => return Ok(()),
        };
        self.unregister_locked(heartbeat_id, &scheduler).await;
        Ok(())
    }

    async fn unregister_locked(&self, heartbeat_id: &str, scheduler: &JobScheduler) {
        let job_uuid = self.inner.jobs.lock().remove(heartbeat_id);
        if let Some(uuid) = job_uuid {
            let _ = scheduler.remove(&uuid).await;
        }
    }
}

#[cfg(test)]
#[path = "scheduler_tests.rs"]
mod tests;
