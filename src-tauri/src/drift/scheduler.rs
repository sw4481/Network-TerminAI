//! `tokio-cron-scheduler`-backed runner for `drift_schedules`.
//!
//! On startup, every enabled row in `drift_schedules` registers a cron job
//! that calls `drift::runner::run_on_demand(template_id)`. Add/remove/
//! enable/disable mutations are reflected by re-registering the job.

use crate::drift::runner::run_on_demand;
use crate::drift::schedule::{DriftSchedule, DriftScheduleRepo};
use crate::fanout::executor::Executor;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Arc;
use tokio_cron_scheduler::{Job, JobScheduler};
use uuid::Uuid;

/// Plug-in callback invoked after each scheduled run completes (or fails).
/// Production wires this to a Tauri event emit; tests use a recording sink.
pub trait ScheduleSink: Send + Sync + 'static {
    fn emit_run_completed(&self, schedule_id: &str, template_id: &str, ok: bool, summary: &str);
}

pub struct NoopScheduleSink;
impl ScheduleSink for NoopScheduleSink {
    fn emit_run_completed(&self, _id: &str, _t: &str, _ok: bool, _s: &str) {}
}

#[derive(Clone)]
pub struct DriftScheduler {
    inner: Arc<DriftSchedulerInner>,
}

struct DriftSchedulerInner {
    db: Arc<Mutex<Connection>>,
    executor: Executor,
    sink: Arc<dyn ScheduleSink>,
    sched: Mutex<Option<JobScheduler>>,
    jobs: Mutex<HashMap<String, Uuid>>,
}

impl DriftScheduler {
    pub fn new(
        db: Arc<Mutex<Connection>>,
        executor: Executor,
        sink: Arc<dyn ScheduleSink>,
    ) -> Self {
        Self {
            inner: Arc::new(DriftSchedulerInner {
                db,
                executor,
                sink,
                sched: Mutex::new(None),
                jobs: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Start the underlying scheduler and register every enabled schedule
    /// from the DB. Idempotent: a second call is a no-op.
    pub async fn start(&self) -> Result<()> {
        if self.inner.sched.lock().is_some() {
            return Ok(());
        }
        let scheduler = JobScheduler::new().await.context("create JobScheduler")?;
        scheduler.start().await.context("start JobScheduler")?;
        *self.inner.sched.lock() = Some(scheduler);

        let enabled = {
            let conn = self.inner.db.lock();
            DriftScheduleRepo::list_enabled(&conn)?
        };
        for s in enabled {
            self.register(&s).await?;
        }
        Ok(())
    }

    /// Stop the scheduler. Currently shutdown is best-effort: outstanding
    /// jobs that have already started complete their async future.
    pub async fn shutdown(&self) -> Result<()> {
        let scheduler = {
            let mut slot = self.inner.sched.lock();
            slot.take()
        };
        if let Some(mut scheduler) = scheduler {
            scheduler.shutdown().await.ok();
        }
        self.inner.jobs.lock().clear();
        Ok(())
    }

    /// Add a new schedule row (DB) and register the cron job.
    pub async fn add_schedule(&self, template_id: &str, cron_expr: &str) -> Result<DriftSchedule> {
        let row = {
            let conn = self.inner.db.lock();
            DriftScheduleRepo::create(&conn, template_id, cron_expr)?
        };
        self.register(&row).await?;
        Ok(row)
    }

    pub async fn pause(&self, id: &str) -> Result<()> {
        {
            let conn = self.inner.db.lock();
            DriftScheduleRepo::set_enabled(&conn, id, false)?;
        }
        self.unregister(id).await
    }

    pub async fn resume(&self, id: &str) -> Result<()> {
        let row = {
            let conn = self.inner.db.lock();
            DriftScheduleRepo::set_enabled(&conn, id, true)?;
            DriftScheduleRepo::get(&conn, id)?
                .ok_or_else(|| anyhow::anyhow!("schedule {id} not found"))?
        };
        self.register(&row).await
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        self.unregister(id).await?;
        let conn = self.inner.db.lock();
        DriftScheduleRepo::delete(&conn, id)?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<DriftSchedule>> {
        let conn = self.inner.db.lock();
        DriftScheduleRepo::list(&conn)
    }

    async fn register(&self, row: &DriftSchedule) -> Result<()> {
        // Skip when scheduler isn't started yet.
        let scheduler = match self.inner.sched.lock().as_ref() {
            Some(s) => s.clone(),
            None => return Ok(()),
        };
        // Drop any existing job for this schedule before re-adding.
        self.unregister_locked(&row.id, &scheduler).await;

        let inner = self.inner.clone();
        let schedule_id = row.id.clone();
        let template_id = row.template_id.clone();
        let job = Job::new_async(row.cron_expr.as_str(), move |_uuid, _l| {
            let inner = inner.clone();
            let schedule_id = schedule_id.clone();
            let template_id = template_id.clone();
            Box::pin(async move {
                let result =
                    run_on_demand(inner.db.clone(), inner.executor.clone(), &template_id).await;
                let (ok, summary) = match &result {
                    Ok(reports) => {
                        let drift = reports.iter().filter(|r| r.status == "drift").count();
                        let err = reports.iter().filter(|r| r.status == "error").count();
                        (
                            true,
                            format!(
                                "ran {} reports ({} drift, {} error)",
                                reports.len(),
                                drift,
                                err
                            ),
                        )
                    }
                    Err(e) => (false, format!("error: {e}")),
                };
                {
                    let conn = inner.db.lock();
                    let _ = DriftScheduleRepo::touch_last_run(&conn, &schedule_id);
                }
                inner
                    .sink
                    .emit_run_completed(&schedule_id, &template_id, ok, &summary);
            })
        })
        .with_context(|| format!("Job::new_async for cron '{}'", row.cron_expr))?;

        let job_uuid = scheduler.add(job).await.context("scheduler.add")?;
        self.inner.jobs.lock().insert(row.id.clone(), job_uuid);
        Ok(())
    }

    async fn unregister(&self, schedule_id: &str) -> Result<()> {
        let scheduler = match self.inner.sched.lock().as_ref() {
            Some(s) => s.clone(),
            None => return Ok(()),
        };
        self.unregister_locked(schedule_id, &scheduler).await;
        Ok(())
    }

    async fn unregister_locked(&self, schedule_id: &str, scheduler: &JobScheduler) {
        let job_uuid = self.inner.jobs.lock().remove(schedule_id);
        if let Some(uuid) = job_uuid {
            let _ = scheduler.remove(&uuid).await;
        }
    }
}
