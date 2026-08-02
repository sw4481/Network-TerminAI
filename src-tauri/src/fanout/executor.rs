//! Tokio-based fan-out executor (Plan 07 Phase 2).

use crate::fanout::auth;
use crate::fanout::events::{FailureKind, FanoutEvent};
use crate::fanout::model::DeviceKind;
use crate::fanout::store::FanoutStore;
use crate::fanout::worker::{WorkerFactory, WorkerOutcome};
use crate::guardrails::classifier::{classify, Tier};
use crate::guardrails::rules::RuleSet;
use crate::guardrails::shell_split::split_for_classification;
use anyhow::{anyhow, Result};
use dashmap::DashMap;
use parking_lot::{Mutex, RwLock};
use rusqlite::{params, Connection};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const SEMAPHORE_CAP: usize = 50;

/// Concrete arguments to spawn a run with.
#[derive(Debug, Clone)]
pub struct ExecuteArgs {
    pub command: String,
    pub group_id: Option<String>,
    pub members: Vec<MemberRef>,
    pub timeout_ms: u64,
    pub concurrency: usize,
}

#[derive(Debug, Clone)]
pub struct MemberRef {
    pub device_id: String,
    pub device_kind: DeviceKind,
    pub display_name: String,
}

#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub run_id: String,
    pub succeeded: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub duration_ms: u64,
    pub failures: Vec<FailureRecord>,
}

#[derive(Debug, Clone)]
pub struct FailureRecord {
    pub device_id: String,
    pub device_kind: DeviceKind,
    pub kind: FailureKind,
    pub message: String,
}

/// Plug-in event sink. Production wires this to `tauri::Emitter::emit`;
/// tests use a recording sink for assertions without a real Tauri handle.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &FanoutEvent);
}

pub struct NoopSink;
impl EventSink for NoopSink {
    fn emit(&self, _event: &FanoutEvent) {}
}

/// Minimal Parser hook so the executor can integrate with the Plan 05
/// `parsed_outputs` table without dragging the full sidecar bridge into
/// every test. Returns `Ok(None)` when the command is unparseable.
#[async_trait::async_trait]
pub trait ParseHook: Send + Sync + 'static {
    async fn try_parse(
        &self,
        command: &str,
        raw: &str,
    ) -> Result<Option<(String, String, String, String)>>;
    // returns (parser, vendor, platform, data_json)
}

pub struct NoopParse;
#[async_trait::async_trait]
impl ParseHook for NoopParse {
    async fn try_parse(
        &self,
        _command: &str,
        _raw: &str,
    ) -> Result<Option<(String, String, String, String)>> {
        Ok(None)
    }
}

struct RunHandle {
    cancel: CancellationToken,
    per_device: Arc<DashMap<String, CancellationToken>>,
    join: Mutex<Option<JoinHandle<RunOutcome>>>,
}

/// Public Executor handle, cheaply cloneable.
#[derive(Clone)]
pub struct Executor {
    inner: Arc<ExecutorInner>,
}

pub struct ExecutorInner {
    pub db: Arc<Mutex<Connection>>,
    pub factory: Arc<dyn WorkerFactory>,
    pub semaphore: Arc<Semaphore>,
    pub sink: Arc<dyn EventSink>,
    pub parser: Arc<dyn ParseHook>,
    /// Plan 09 — guardrail rules applied to every fan-out command before
    /// dispatch. Optional so unit tests that don't care about classification
    /// can construct an executor without one (the executor then refuses
    /// any non-trivial command — see `classify_command`). Production
    /// always wires the AppState ruleset through `with_ruleset`.
    pub ruleset: Option<Arc<RwLock<RuleSet>>>,
    runs: DashMap<String, Arc<RunHandle>>,
    /// Result-collector queue. Populated by `run_one`; drained by `drive`.
    /// We use a dashmap of mpsc-like vectors keyed on run_id so a finished
    /// `await_run()` can read totals without scanning the DB.
    counters: DashMap<String, Arc<RunCounters>>,
}

struct RunCounters {
    succeeded: AtomicUsize,
    failed: AtomicUsize,
    cancelled: AtomicUsize,
    failures: Mutex<Vec<FailureRecord>>,
}

impl Executor {
    pub fn new(
        db: Arc<Mutex<Connection>>,
        factory: Arc<dyn WorkerFactory>,
        sink: Arc<dyn EventSink>,
        parser: Arc<dyn ParseHook>,
    ) -> Self {
        Self {
            inner: Arc::new(ExecutorInner {
                db,
                factory,
                semaphore: Arc::new(Semaphore::new(SEMAPHORE_CAP)),
                sink,
                parser,
                ruleset: None,
                runs: DashMap::new(),
                counters: DashMap::new(),
            }),
        }
    }

    /// Production constructor — same as `new` but wires the project-wide
    /// guardrail ruleset so every fan-out command is classified before
    /// reaching the wire. Non-Tier-0 commands (or any chunk thereof, after
    /// shell-split for injection defence) are refused with the
    /// `BlockedByGuardrail` failure kind.
    pub fn with_ruleset(
        db: Arc<Mutex<Connection>>,
        factory: Arc<dyn WorkerFactory>,
        sink: Arc<dyn EventSink>,
        parser: Arc<dyn ParseHook>,
        ruleset: Arc<RwLock<RuleSet>>,
    ) -> Self {
        Self {
            inner: Arc::new(ExecutorInner {
                db,
                factory,
                semaphore: Arc::new(Semaphore::new(SEMAPHORE_CAP)),
                sink,
                parser,
                ruleset: Some(ruleset),
                runs: DashMap::new(),
                counters: DashMap::new(),
            }),
        }
    }

    /// Returns `Ok(())` if the command is safe to dispatch (every shell-split
    /// chunk classifies as Tier-0 against the configured ruleset), or
    /// `Err(reason)` describing the highest-tier offending chunk. When the
    /// executor was constructed without a ruleset (test harnesses) every
    /// command is allowed — production code must use `with_ruleset`.
    fn classify_command(&self, command: &str) -> std::result::Result<(), String> {
        let rs_arc = match &self.inner.ruleset {
            Some(rs) => rs.clone(),
            None => return Ok(()),
        };
        let rs = rs_arc.read();
        // Fan-out runs the same command across many devices that may have
        // different vendors. We classify against `cisco/iosxe` because the
        // Plan 09 builtin ruleset's hard-tier rules (reload / write erase /
        // shutdown / no router / etc.) are vendor=`*` so they fire
        // regardless. A vendor-specific T0 read-only verb still passes.
        let chunks = split_for_classification(command);
        let mut highest_tier = Tier::T0;
        let mut offending: Option<String> = None;
        for chunk in &chunks {
            let d = classify(&rs, "cisco", "iosxe", chunk);
            if tier_rank(d.tier) > tier_rank(highest_tier) {
                highest_tier = d.tier;
                offending = Some(chunk.clone());
            }
        }
        if highest_tier == Tier::T0 {
            Ok(())
        } else {
            Err(format!(
                "guardrail: command above Tier-0 ({}) requires explicit user confirmation; offending chunk = {:?}",
                highest_tier.as_str(),
                offending.unwrap_or_else(|| command.to_string()),
            ))
        }
    }

    fn emit(&self, event: FanoutEvent) {
        self.inner.sink.emit(&event);
    }

    pub async fn spawn_run(&self, args: ExecuteArgs) -> Result<String> {
        let run_id = Uuid::new_v4().simple().to_string();
        let total = args.members.len();

        // SECURITY GATE — Plan 09 / Plan 15-style. Classify the command
        // BEFORE inserting any pending rows or dispatching workers. If the
        // command (or any shell-split chunk) classifies above Tier-0, mark
        // every member's row as `blocked_by_guardrail` and finalize the
        // run immediately. NO worker is ever invoked.
        let guardrail_block = self.classify_command(&args.command).err();

        // Persist run row + per-device pending rows synchronously before
        // spawning the driver task so callers can immediately
        // `fanout_run_get(run_id)` and see something. Also insert a synthetic
        // tab row keyed `fanout:<run_id>` so the per-device `command_blocks`
        // rows we'll create in `record_success` satisfy the tab FK.
        {
            let conn = self.inner.db.lock();
            let synth_tab = format!("fanout:{run_id}");
            conn.execute(
                "INSERT OR IGNORE INTO tabs(id, title, shell_cmd, cwd)
                 VALUES (?1, ?2, '', '')",
                params![&synth_tab, format!("Fan-out: {}", args.command)],
            )?;
            let params_json = serde_json::json!({
                "timeout_ms": args.timeout_ms,
                "concurrency": args.concurrency,
            })
            .to_string();
            FanoutStore::insert_run_row(
                &conn,
                &run_id,
                args.group_id.as_deref(),
                &args.command,
                &params_json,
            )?;
            for m in &args.members {
                FanoutStore::insert_pending_result(&conn, &run_id, &m.device_id, m.device_kind, 1)?;
            }
        }

        self.emit(FanoutEvent::RunStarted {
            run_id: run_id.clone(),
            total,
            command: args.command.clone(),
            group_id: args.group_id.clone(),
        });

        // If the gate fired, short-circuit: mark every device blocked and
        // finalize the run. We do this AFTER inserting pending rows + the
        // RunStarted event so the frontend's per-device UI updates from
        // pending → blocked rather than from nothing → blocked, but still
        // BEFORE any worker is created or credentials are looked up.
        if let Some(reason) = guardrail_block {
            tracing::warn!(
                run_id = %run_id,
                command = %args.command,
                reason = %reason,
                "fanout: refusing run — guardrail tier above T0",
            );
            for m in &args.members {
                {
                    let conn = self.inner.db.lock();
                    if let Err(e) = FanoutStore::finalize_result(
                        &conn,
                        &run_id,
                        &m.device_id,
                        m.device_kind,
                        1,
                        "blocked_by_guardrail",
                        None,
                        None,
                        Some(&reason),
                        None,
                        Some(chrono::Utc::now().timestamp()),
                    ) {
                        tracing::error!(
                            error = %e,
                            run_id = %run_id,
                            device = %m.device_id,
                            "fanout: failed to mark device blocked_by_guardrail",
                        );
                    }
                }
                self.emit(FanoutEvent::DeviceFailed {
                    run_id: run_id.clone(),
                    device_id: m.device_id.clone(),
                    device_kind: m.device_kind.as_str().to_string(),
                    attempt: 1,
                    error: reason.clone(),
                    duration_ms: 0,
                    failure_kind: FailureKind::BlockedByGuardrail,
                });
            }
            {
                let conn = self.inner.db.lock();
                let _ = FanoutStore::finalize_run(&conn, &run_id, 0, total, 0);
            }
            self.emit(FanoutEvent::RunCompleted {
                run_id: run_id.clone(),
                succeeded: 0,
                failed: total,
                cancelled: 0,
                duration_ms: 0,
            });
            return Ok(run_id);
        }

        let run_cancel = CancellationToken::new();
        let per_device = Arc::new(DashMap::<String, CancellationToken>::new());
        for m in &args.members {
            per_device.insert(member_key(m), run_cancel.child_token());
            self.emit(FanoutEvent::DeviceQueued {
                run_id: run_id.clone(),
                device_id: m.device_id.clone(),
                device_kind: m.device_kind.as_str().to_string(),
                display_name: m.display_name.clone(),
                attempt: 1,
            });
        }

        let counters = Arc::new(RunCounters {
            succeeded: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
            cancelled: AtomicUsize::new(0),
            failures: Mutex::new(Vec::new()),
        });
        self.inner.counters.insert(run_id.clone(), counters.clone());

        let this = self.clone();
        let run_id_for_task = run_id.clone();
        let pd_for_task = per_device.clone();
        let cancel_for_task = run_cancel.clone();
        let counters_for_task = counters.clone();
        let join = tokio::spawn(async move {
            this.drive(
                run_id_for_task,
                args,
                cancel_for_task,
                pd_for_task,
                counters_for_task,
            )
            .await
        });

        self.inner.runs.insert(
            run_id.clone(),
            Arc::new(RunHandle {
                cancel: run_cancel,
                per_device,
                join: Mutex::new(Some(join)),
            }),
        );

        Ok(run_id)
    }

    async fn drive(
        self,
        run_id: String,
        args: ExecuteArgs,
        run_cancel: CancellationToken,
        per_device: Arc<DashMap<String, CancellationToken>>,
        counters: Arc<RunCounters>,
    ) -> RunOutcome {
        let started = Instant::now();
        let mut handles: Vec<JoinHandle<()>> = Vec::with_capacity(args.members.len());
        let cap = args.concurrency.clamp(1, SEMAPHORE_CAP);
        let local_sem = Arc::new(Semaphore::new(cap));

        for member in args.members {
            if run_cancel.is_cancelled() {
                break;
            }
            let key = member_key(&member);
            let device_cancel = per_device
                .get(&key)
                .map(|tok| tok.clone())
                .unwrap_or_else(|| run_cancel.child_token());

            let permit = match local_sem.clone().acquire_owned().await {
                Ok(p) => p,
                Err(_) => break,
            };

            let this = self.clone();
            let run_id = run_id.clone();
            let cmd = args.command.clone();
            let to = Duration::from_millis(args.timeout_ms);
            let counters = counters.clone();

            handles.push(tokio::spawn(async move {
                let _permit = permit;
                this.run_one(&run_id, member, cmd, to, device_cancel, 1, counters)
                    .await;
            }));
        }

        for h in handles {
            let _ = h.await;
        }

        let succeeded = counters.succeeded.load(Ordering::SeqCst);
        let failed = counters.failed.load(Ordering::SeqCst);
        let cancelled = counters.cancelled.load(Ordering::SeqCst);

        // Roll up `fanout_runs.status`
        {
            let conn = self.inner.db.lock();
            let _ = FanoutStore::finalize_run(&conn, &run_id, succeeded, failed, cancelled);
        }

        let duration_ms = started.elapsed().as_millis() as u64;
        self.emit(FanoutEvent::RunCompleted {
            run_id: run_id.clone(),
            succeeded,
            failed,
            cancelled,
            duration_ms,
        });

        let failures = counters.failures.lock().clone();
        RunOutcome {
            run_id,
            succeeded,
            failed,
            cancelled,
            duration_ms,
            failures,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_one(
        self,
        run_id: &str,
        member: MemberRef,
        command: String,
        timeout: Duration,
        cancel: CancellationToken,
        attempt: i64,
        counters: Arc<RunCounters>,
    ) {
        let start = Instant::now();
        self.emit(FanoutEvent::DeviceStarted {
            run_id: run_id.to_string(),
            device_id: member.device_id.clone(),
            device_kind: member.device_kind.as_str().to_string(),
            attempt,
        });

        // Mark started_at on the row
        {
            let conn = self.inner.db.lock();
            let _ = conn.execute(
                "UPDATE fanout_run_results
                    SET status='running',
                        started_at=COALESCE(started_at, strftime('%s','now'))
                  WHERE run_id=?1 AND device_id=?2 AND device_kind=?3 AND attempt_number=?4",
                params![
                    run_id,
                    &member.device_id,
                    member.device_kind.as_str(),
                    attempt
                ],
            );
        }

        // Resolve credentials
        let creds = {
            let conn = self.inner.db.lock();
            auth::resolve_creds(&conn, member.device_kind, &member.device_id)
        };
        let creds = match creds {
            Ok(c) => c,
            Err(kind) => {
                let dur = start.elapsed().as_millis() as u64;
                self.record_failure(
                    run_id,
                    &member,
                    attempt,
                    kind.clone(),
                    "credential resolution failed",
                    dur,
                    &counters,
                );
                return;
            }
        };

        let worker = self.inner.factory.create(member.device_kind, creds);
        let work = worker.run(&command, timeout);
        let outcome = tokio::select! {
            _ = cancel.cancelled() => {
                let dur = start.elapsed().as_millis() as u64;
                self.record_cancel(run_id, &member, attempt, dur, &counters);
                return;
            }
            r = work => r,
        };

        let dur = start.elapsed().as_millis() as u64;
        match outcome {
            Ok(WorkerOutcome { raw_output, .. }) => {
                self.record_success(
                    run_id,
                    &member,
                    attempt,
                    &command,
                    &raw_output,
                    dur,
                    &counters,
                )
                .await;
            }
            Err(e) => {
                let kind = e.kind();
                let msg = e.message();
                self.record_failure(run_id, &member, attempt, kind, &msg, dur, &counters);
            }
        }
    }

    async fn record_success(
        &self,
        run_id: &str,
        member: &MemberRef,
        attempt: i64,
        command: &str,
        raw: &str,
        duration_ms: u64,
        counters: &RunCounters,
    ) {
        // Insert command_blocks row + tag + attempt to parse.
        let block_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp();
        let parsed_id_opt: Option<i64> = match self.inner.parser.try_parse(command, raw).await {
            Ok(Some((parser, vendor, platform, data_json))) => {
                let conn = self.inner.db.lock();
                if let Err(e) = conn.execute(
                    "INSERT INTO command_blocks(id, tab_id, cmd, output, started_at, ended_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    params![
                        &block_id,
                        format!("fanout:{run_id}"),
                        command,
                        raw.as_bytes(),
                        now
                    ],
                ) {
                    tracing::warn!(error=%e, "fanout: command_blocks insert failed");
                }
                if let Err(e) = conn.execute(
                    "INSERT OR IGNORE INTO block_tags(block_id, tag) VALUES (?1, ?2)",
                    params![&block_id, &format!("fanout:{run_id}")],
                ) {
                    tracing::warn!(error=%e, "fanout: block_tags insert failed");
                }
                crate::structured::auto_parse::upsert_parsed_output(
                    &conn, &block_id, &parser, command, &vendor, &platform, &data_json,
                )
                .ok()
            }
            _ => {
                let conn = self.inner.db.lock();
                if let Err(e) = conn.execute(
                    "INSERT INTO command_blocks(id, tab_id, cmd, output, started_at, ended_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    params![
                        &block_id,
                        format!("fanout:{run_id}"),
                        command,
                        raw.as_bytes(),
                        now
                    ],
                ) {
                    tracing::warn!(error=%e, "fanout: command_blocks insert failed");
                }
                if let Err(e) = conn.execute(
                    "INSERT OR IGNORE INTO block_tags(block_id, tag) VALUES (?1, ?2)",
                    params![&block_id, &format!("fanout:{run_id}")],
                ) {
                    tracing::warn!(error=%e, "fanout: block_tags insert failed");
                }
                None
            }
        };

        {
            let conn = self.inner.db.lock();
            let _ = FanoutStore::finalize_result(
                &conn,
                run_id,
                &member.device_id,
                member.device_kind,
                attempt,
                "success",
                Some(&block_id),
                parsed_id_opt.map(|i| i.to_string()).as_deref(),
                None,
                None,
                Some(chrono::Utc::now().timestamp()),
            );
        }

        counters.succeeded.fetch_add(1, Ordering::SeqCst);
        self.emit(FanoutEvent::DeviceSucceeded {
            run_id: run_id.to_string(),
            device_id: member.device_id.clone(),
            device_kind: member.device_kind.as_str().to_string(),
            attempt,
            block_id,
            parsed_output_id: parsed_id_opt.map(|i| i.to_string()),
            duration_ms,
        });
    }

    fn record_failure(
        &self,
        run_id: &str,
        member: &MemberRef,
        attempt: i64,
        kind: FailureKind,
        message: &str,
        duration_ms: u64,
        counters: &RunCounters,
    ) {
        {
            let conn = self.inner.db.lock();
            let status = if matches!(kind, FailureKind::Timeout) {
                "timeout"
            } else {
                "failed"
            };
            let _ = FanoutStore::finalize_result(
                &conn,
                run_id,
                &member.device_id,
                member.device_kind,
                attempt,
                status,
                None,
                None,
                Some(message),
                None,
                Some(chrono::Utc::now().timestamp()),
            );
        }
        counters.failed.fetch_add(1, Ordering::SeqCst);
        counters.failures.lock().push(FailureRecord {
            device_id: member.device_id.clone(),
            device_kind: member.device_kind,
            kind: kind.clone(),
            message: message.to_string(),
        });
        self.emit(FanoutEvent::DeviceFailed {
            run_id: run_id.to_string(),
            device_id: member.device_id.clone(),
            device_kind: member.device_kind.as_str().to_string(),
            attempt,
            error: message.to_string(),
            duration_ms,
            failure_kind: kind,
        });
    }

    fn record_cancel(
        &self,
        run_id: &str,
        member: &MemberRef,
        attempt: i64,
        _duration_ms: u64,
        counters: &RunCounters,
    ) {
        {
            let conn = self.inner.db.lock();
            let _ = FanoutStore::finalize_result(
                &conn,
                run_id,
                &member.device_id,
                member.device_kind,
                attempt,
                "cancelled",
                None,
                None,
                Some("cancelled"),
                None,
                Some(chrono::Utc::now().timestamp()),
            );
        }
        counters.cancelled.fetch_add(1, Ordering::SeqCst);
        self.emit(FanoutEvent::DeviceCancelled {
            run_id: run_id.to_string(),
            device_id: member.device_id.clone(),
            device_kind: member.device_kind.as_str().to_string(),
            attempt,
        });
    }

    pub fn cancel_device(&self, run_id: &str, device_id: &str, kind: DeviceKind) -> Result<()> {
        let handle = self
            .inner
            .runs
            .get(run_id)
            .ok_or_else(|| anyhow!("unknown run {run_id}"))?
            .clone();
        let key = format!("{}:{}", kind.as_str(), device_id);
        if let Some(tok) = handle.per_device.get(&key) {
            tok.cancel();
        }
        Ok(())
    }

    pub fn cancel_run(&self, run_id: &str) -> Result<()> {
        let handle = self
            .inner
            .runs
            .get(run_id)
            .ok_or_else(|| anyhow!("unknown run {run_id}"))?
            .clone();
        handle.cancel.cancel();
        Ok(())
    }

    pub async fn await_run(&self, run_id: &str) -> Result<RunOutcome> {
        let handle = self
            .inner
            .runs
            .get(run_id)
            .ok_or_else(|| anyhow!("unknown run {run_id}"))?
            .clone();
        let join = {
            let mut slot = handle.join.lock();
            slot.take()
        };
        match join {
            Some(j) => Ok(j.await?),
            None => Err(anyhow!("run already awaited")),
        }
    }

    /// Spawn an additional attempt for a device that previously failed/timed out.
    pub async fn retry_device(
        &self,
        run_id: &str,
        device_id: &str,
        kind: DeviceKind,
        display_name: &str,
        command: &str,
        timeout_ms: u64,
    ) -> Result<i64> {
        let attempt = {
            let conn = self.inner.db.lock();
            let n = FanoutStore::next_attempt_number(&conn, run_id, device_id, kind)?;
            FanoutStore::insert_pending_result(&conn, run_id, device_id, kind, n)?;
            n
        };

        // Re-open the run row in case it had been finalized already
        {
            let conn = self.inner.db.lock();
            let _ = conn.execute(
                "UPDATE fanout_runs SET status='running', ended_at=NULL WHERE id=?1",
                [run_id],
            );
        }

        let counters = self
            .inner
            .counters
            .get(run_id)
            .map(|c| c.clone())
            .unwrap_or_else(|| {
                let c = Arc::new(RunCounters {
                    succeeded: AtomicUsize::new(0),
                    failed: AtomicUsize::new(0),
                    cancelled: AtomicUsize::new(0),
                    failures: Mutex::new(Vec::new()),
                });
                self.inner.counters.insert(run_id.to_string(), c.clone());
                c
            });

        let cancel = CancellationToken::new();
        let key = format!("{}:{}", kind.as_str(), device_id);
        if let Some(handle) = self.inner.runs.get(run_id) {
            handle.per_device.insert(key, cancel.clone());
        }

        let permit = self.inner.semaphore.clone().acquire_owned().await?;
        let this = self.clone();
        let member = MemberRef {
            device_id: device_id.to_string(),
            device_kind: kind,
            display_name: display_name.to_string(),
        };
        let run_id_owned = run_id.to_string();
        let cmd = command.to_string();
        tokio::spawn(async move {
            let _permit = permit;
            this.run_one(
                &run_id_owned,
                member,
                cmd,
                Duration::from_millis(timeout_ms),
                cancel,
                attempt,
                counters,
            )
            .await;
        });
        Ok(attempt)
    }
}

fn member_key(m: &MemberRef) -> String {
    format!("{}:{}", m.device_kind.as_str(), m.device_id)
}

/// Order tiers for "highest of any chunk" selection. Ambiguous ranks
/// strictly above T0 so an unclassifiable chunk is treated as unsafe.
fn tier_rank(t: Tier) -> u8 {
    match t {
        Tier::T0 => 0,
        Tier::Ambiguous => 1,
        Tier::T1 => 2,
        Tier::T2 => 3,
        Tier::T3 => 4,
    }
}
