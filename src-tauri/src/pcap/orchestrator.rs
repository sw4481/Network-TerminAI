//! Capture lifecycle orchestrator.
//!
//! ## Session strategy decision (Plan 11 Task 2.1)
//!
//! `src-tauri/src/commands/ssh.rs` is **CRUD-only** for saved connections —
//! it does not expose a reusable `send_command(conn_id, cmd) -> String`
//! API. The interactive PTY in `src-tauri/src/pty/` is owned per-tab and
//! not safe to multiplex from a background task without entangling pcap
//! state with the user-facing terminal stream.
//!
//! We therefore open a **dedicated** russh session for each capture
//! (path B in the plan), mirroring the pattern at
//! `src-tauri/src/netconf_runner/transport.rs:connect_and_open_subsystem`
//! but requesting `exec` / `shell` channels rather than the `netconf`
//! subsystem. The concrete implementation lives in `pcap::ssh_exec` and
//! `pcap::sftp`; this module accepts an `Executor` trait so the
//! state-machine logic is testable without live SSH.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use super::builder;
use super::repo;
use super::sftp;
use super::types::CaptureSpec;
use super::PCAP_SIZE_WARN_BYTES;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum CaptureEvent {
    Started,
    Capturing,
    Pulling {
        bytes: u64,
        total: Option<u64>,
    },
    Ready {
        local_path: String,
        size_bytes: u64,
        packet_count: u32,
    },
    SizeWarning {
        size_bytes: u64,
    },
    Failed {
        error: String,
    },
}

#[async_trait::async_trait]
pub trait Executor: Send + Sync {
    async fn exec_lines(&self, lines: &[String]) -> Result<String>;
    async fn poll_until(
        &self,
        poll_cmd: &str,
        done: Box<dyn for<'a> Fn(&'a str) -> bool + Send>,
        timeout: Duration,
    ) -> Result<()>;
    async fn sftp_pull(&self, remote: &str, local: &Path) -> Result<u64>;
}

/// Run the capture lifecycle to completion (or to `failed`).
///
/// Updates the DB row through `setup → capturing → pulling → ready` and
/// emits a `CaptureEvent` at each phase boundary via `emit`. On any error,
/// pushes `status='failed'` with the error message AND attempts the
/// vendor cleanup commands once (best-effort) so a partially-armed device
/// doesn't keep capturing after the orchestrator gives up.
pub async fn run<E: Executor + ?Sized>(
    exec: &E,
    spec: CaptureSpec,
    capture_id: &str,
    db: &Arc<Mutex<Connection>>,
    emit: impl Fn(CaptureEvent) + Send,
) -> Result<PathBuf> {
    let script = builder::build(&spec)?;
    let result = run_inner(exec, &spec, &script, capture_id, db, &emit).await;
    match result {
        Ok(path) => Ok(path),
        Err(err) => {
            // Use the alternate formatter so context + root cause are both
            // captured in the DB error column ("send start command: simulated…").
            let msg = format!("{err:#}");
            // Best-effort cleanup so the device doesn't stay armed.
            if !script.cleanup.is_empty() {
                if let Err(cleanup_err) = exec.exec_lines(&script.cleanup).await {
                    tracing::warn!(
                        capture_id,
                        error = %cleanup_err,
                        "pcap cleanup after failure also failed"
                    );
                }
            }
            // Mark failed in DB. If the row is already in a terminal state
            // (e.g. update_status panicked mid-way), swallow.
            let conn = db.lock();
            let _ = repo::update_status(&conn, capture_id, "failed", Some(&msg));
            emit(CaptureEvent::Failed { error: msg });
            Err(err)
        }
    }
}

async fn run_inner<E: Executor + ?Sized>(
    exec: &E,
    spec: &CaptureSpec,
    script: &super::types::CaptureScript,
    capture_id: &str,
    db: &Arc<Mutex<Connection>>,
    emit: &impl Fn(CaptureEvent),
) -> Result<PathBuf> {
    {
        let conn = db.lock();
        repo::update_status(&conn, capture_id, "capturing", None)
            .context("transition setup→capturing")?;
    }
    emit(CaptureEvent::Capturing);

    if !script.setup.is_empty() {
        exec.exec_lines(&script.setup)
            .await
            .context("send setup commands")?;
    }
    exec.exec_lines(&script.start)
        .await
        .context("send start command")?;
    emit(CaptureEvent::Started);

    if let Some(poll_cmd) = &script.poll {
        let timeout = Duration::from_secs(spec.duration_s as u64 + 30);
        exec.poll_until(
            poll_cmd,
            Box::new(|out: &str| out.contains("Inactive")),
            timeout,
        )
        .await
        .context("poll capture state")?;
    } else {
        // NX-OS / Junos / EOS: start command blocks for ~duration_s; wait
        // duration + 5s slack before issuing stop / pull.
        tokio::time::sleep(Duration::from_secs(spec.duration_s as u64 + 5)).await;
    }

    if !script.stop.is_empty() {
        exec.exec_lines(&script.stop)
            .await
            .context("send stop commands")?;
    }

    {
        let conn = db.lock();
        repo::update_status(&conn, capture_id, "pulling", None)
            .context("transition capturing→pulling")?;
    }

    let remote = sftp::normalize_remote_path(spec.device_kind, &script.remote_pcap_path);
    let local_dir = sftp::pcap_cache_dir()?;
    let local_path = local_dir.join(format!("{capture_id}.pcap"));
    let bytes = exec
        .sftp_pull(&remote, &local_path)
        .await
        .context("sftp pull")?;
    emit(CaptureEvent::Pulling {
        bytes,
        total: Some(bytes),
    });

    if bytes >= PCAP_SIZE_WARN_BYTES {
        emit(CaptureEvent::SizeWarning { size_bytes: bytes });
    }

    if !script.cleanup.is_empty() {
        if let Err(e) = exec.exec_lines(&script.cleanup).await {
            tracing::warn!(capture_id, error = %e, "pcap cleanup failed (post-success)");
        }
    }

    let local_path_str = local_path
        .to_str()
        .ok_or_else(|| anyhow!("local pcap path not utf-8"))?
        .to_string();

    {
        let conn = db.lock();
        // Phase 1's `repo::finalize` records packet_count separately; the
        // sidecar provides that count once it has summarized the file.
        // Here we set 0 packet_count and let the summarize Tauri command
        // update it later. Subsequent updates should not re-trigger state
        // transitions, so write directly.
        repo::finalize(&conn, capture_id, &local_path_str, 0, bytes)?;
    }

    emit(CaptureEvent::Ready {
        local_path: local_path_str,
        size_bytes: bytes,
        packet_count: 0,
    });

    Ok(local_path)
}

/// Simple in-process registry to track active capture handles so the UI's
/// cancel command can abort an in-flight orchestration.
#[derive(Default)]
pub struct CaptureRegistry {
    inner: AsyncMutex<std::collections::HashMap<String, CancellationToken>>,
}

impl CaptureRegistry {
    pub async fn insert(&self, id: String, token: CancellationToken) {
        self.inner.lock().await.insert(id, token);
    }
    pub async fn remove(&self, id: &str) {
        self.inner.lock().await.remove(id);
    }
    pub async fn cancel(&self, id: &str) -> bool {
        let token = self.inner.lock().await.get(id).cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub async fn contains(&self, id: &str) -> bool {
        self.inner.lock().await.contains_key(id)
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::DeviceKind;
    use super::*;
    use crate::db::open_and_migrate;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;

    struct FakeExec {
        cleanup_calls: AtomicUsize,
        fail_on: Option<&'static str>, // substring of any line to fail on
        pull_bytes: u64,
    }

    #[async_trait::async_trait]
    impl Executor for FakeExec {
        async fn exec_lines(&self, lines: &[String]) -> Result<String> {
            if let Some(needle) = self.fail_on {
                if lines.iter().any(|l| l.contains(needle)) {
                    return Err(anyhow!("simulated failure on '{needle}'"));
                }
            }
            if lines.iter().any(|l| l.starts_with("no monitor capture")) {
                self.cleanup_calls.fetch_add(1, Ordering::SeqCst);
            }
            Ok(String::new())
        }
        async fn poll_until(
            &self,
            _poll_cmd: &str,
            done: Box<dyn for<'a> Fn(&'a str) -> bool + Send>,
            _timeout: Duration,
        ) -> Result<()> {
            // Pretend the device immediately reports "Inactive".
            assert!(done("State : Inactive"));
            Ok(())
        }
        async fn sftp_pull(&self, _remote: &str, local: &Path) -> Result<u64> {
            if let Some(parent) = local.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(local, vec![0u8; self.pull_bytes as usize]).unwrap();
            Ok(self.pull_bytes)
        }
    }

    fn fresh_db() -> (TempDir, Arc<Mutex<Connection>>) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = open_and_migrate(&path).unwrap();
        (dir, Arc::new(Mutex::new(conn)))
    }

    fn iosxe_spec() -> CaptureSpec {
        CaptureSpec {
            capture_name: "CAP".into(),
            device_kind: DeviceKind::IosXe,
            interface: "Gi0/0/1".into(),
            acl: None,
            duration_s: 5,
            buffer_mb: 10,
            on_device_path: "flash:CAP.pcap".into(),
        }
    }

    fn nxos_spec() -> CaptureSpec {
        CaptureSpec {
            capture_name: "CAP".into(),
            device_kind: DeviceKind::Nxos,
            interface: "mgmt0".into(),
            acl: None,
            duration_s: 1,
            buffer_mb: 10,
            on_device_path: "bootflash:CAP.pcap".into(),
        }
    }

    fn seed_capture(db: &Arc<Mutex<Connection>>, id: &str, kind: DeviceKind) {
        let conn = db.lock();
        repo::create(&conn, id, None, "router", kind, "Gi0/0/1", None).unwrap();
    }

    #[tokio::test]
    async fn iosxe_happy_path_transitions_to_ready() {
        let (_g, db) = fresh_db();
        seed_capture(&db, "c1", DeviceKind::IosXe);
        let exec = FakeExec {
            cleanup_calls: AtomicUsize::new(0),
            fail_on: None,
            pull_bytes: 1024,
        };
        let path = run(&exec, iosxe_spec(), "c1", &db, |_| {}).await.unwrap();
        assert!(path.exists());
        let conn = db.lock();
        let row = repo::get(&conn, "c1").unwrap().unwrap();
        assert_eq!(row.status, "ready");
        assert_eq!(row.size_bytes, Some(1024));
    }

    #[tokio::test]
    async fn iosxe_failure_runs_cleanup_and_marks_failed() {
        let (_g, db) = fresh_db();
        seed_capture(&db, "c1", DeviceKind::IosXe);
        let exec = FakeExec {
            cleanup_calls: AtomicUsize::new(0),
            // Fail on the start command so cleanup must still run.
            fail_on: Some("monitor capture CAP start"),
            pull_bytes: 0,
        };
        let err = run(&exec, iosxe_spec(), "c1", &db, |_| {}).await;
        assert!(err.is_err());
        assert_eq!(exec.cleanup_calls.load(Ordering::SeqCst), 1);
        let conn = db.lock();
        let row = repo::get(&conn, "c1").unwrap().unwrap();
        assert_eq!(row.status, "failed");
        assert!(row.error.unwrap().contains("simulated"));
    }

    #[tokio::test]
    async fn nxos_no_setup_or_cleanup() {
        let (_g, db) = fresh_db();
        seed_capture(&db, "c1", DeviceKind::Nxos);
        let exec = FakeExec {
            cleanup_calls: AtomicUsize::new(0),
            fail_on: None,
            pull_bytes: 512,
        };
        run(&exec, nxos_spec(), "c1", &db, |_| {}).await.unwrap();
        // NX-OS script has no `no monitor capture` lines, so cleanup count = 0.
        assert_eq!(exec.cleanup_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn size_warning_event_emitted_above_threshold() {
        let (_g, db) = fresh_db();
        seed_capture(&db, "c1", DeviceKind::IosXe);
        let exec = FakeExec {
            cleanup_calls: AtomicUsize::new(0),
            fail_on: None,
            pull_bytes: PCAP_SIZE_WARN_BYTES + 1,
        };
        let warned = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let warned_clone = warned.clone();
        run(&exec, iosxe_spec(), "c1", &db, move |ev| {
            if matches!(ev, CaptureEvent::SizeWarning { .. }) {
                warned_clone.store(true, Ordering::SeqCst);
            }
        })
        .await
        .unwrap();
        assert!(warned.load(Ordering::SeqCst));
    }
}
