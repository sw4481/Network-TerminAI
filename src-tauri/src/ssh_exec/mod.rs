//! Shared, device-friendly SSH command executor.
//!
//! Network devices (Cisco IOS/IOS-XE, etc.) frequently reject the limited
//! algorithm set that the pure-Rust `russh` client offers (observed as an
//! immediate "Disconnected" during topology discovery). They also never emit
//! the OSC-133 shell-integration markers that `pty_runner` waits for, so any
//! feature built on the interactive PTY hangs for the full timeout per
//! command inside a real SSH session.
//!
//! This module runs commands by shelling out to the system `ssh` client via
//! `sshpass`, exactly mirroring the verified-working topology discovery path
//! (`commands::topology::topology_discover_device`). It is the single shared
//! primitive that the structured-parse (Plan 05), change-verify (Plan 06),
//! notebook (Plan 03), and troubleshooting-tree (Plan 15) features all use to
//! reach a device directly instead of relying on command blocks.
//!
//! The argument-construction logic is split into the pure [`build_ssh_args`]
//! function so it can be unit-tested without spawning a process; the spawn
//! lives in [`run_command`] / [`run_commands`].
//!
//! # Security model
//!
//! * **Password handling.** The password is passed to `sshpass` via the
//!   `SSHPASS` environment variable (`sshpass -e`), never as a `-p <pw>` CLI
//!   argument. CLI args are world-readable through `ps`/`/proc/<pid>/cmdline`;
//!   the env var is only visible to the process owner on the platforms we
//!   target. It is still preferable to migrate to key-based auth where the
//!   device supports it.
//!
//! * **Command trust.** `command` is handed to the remote shell verbatim
//!   (this is how `ssh host "cmd"` works), so whoever supplies the command
//!   string can run arbitrary commands on the device. This is intentional and
//!   not a privilege escalation: the user is already authenticating to *their*
//!   device with *their* credentials, and network operators legitimately rely
//!   on shell features the device exposes — e.g. `show run | include bgp`,
//!   `show ip route | begin 10.0`. We therefore do NOT strip shell
//!   metacharacters (`|`, `<`, `>`, `$`…); doing so would break everyday CLI
//!   usage. Command strings originate from trusted sources: the user's own UI
//!   input, or YAML bundles/playbooks the user authored. Callers must not feed
//!   untrusted third-party input into `command` without their own vetting.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rusqlite::Connection;
use tokio::process::Command;

/// A resolved SSH target: everything needed to open a one-shot session.
#[derive(Debug, Clone)]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

/// Resolve a saved `ssh_connections` row into a ready-to-use [`SshTarget`].
///
/// `override_password` (typically prompted from the user when the connection
/// has no saved password) takes precedence; otherwise the stored
/// `password_encrypted` is decrypted. Returns the target plus the saved
/// connection's display `name` (handy as a device_ref). Shared by every
/// feature that runs commands directly against a device (topology, structured
/// parse, change-verify, notebooks, troubleshooting).
pub fn resolve_target(
    db: &Arc<Mutex<Connection>>,
    connection_id: &str,
    override_password: Option<String>,
) -> Result<(SshTarget, String), String> {
    let (host, port, username, password_encrypted, name) = {
        let conn = db.lock();
        let mut stmt = conn
            .prepare(
                "SELECT host, port, user, password_encrypted, name
                 FROM ssh_connections WHERE id = ?1",
            )
            .map_err(|e| format!("Failed to query connection: {e}"))?;
        stmt.query_row([connection_id], |row| {
            let host: String = row.get(0)?;
            let port: i64 = row.get(1)?;
            let user: Option<String> = row.get(2)?;
            let pass_enc: Option<String> = row.get(3)?;
            let name: String = row.get(4)?;
            Ok((host, port, user, pass_enc, name))
        })
        .map_err(|e| format!("Connection not found: {e}"))?
    };

    let password = if let Some(pw) = override_password {
        pw
    } else if let Some(enc) = password_encrypted {
        crate::commands::ssh::decrypt_password(&enc)
            .map_err(|e| format!("Failed to decrypt password: {e}"))?
    } else {
        return Err("No password provided or saved for this connection".to_string());
    };

    let username = username.ok_or("No username saved for this connection")?;

    Ok((
        SshTarget {
            host,
            port: port as u16,
            username,
            password,
        },
        name,
    ))
}

/// How long to allow a single command to run before giving up.
pub const DEFAULT_CMD_TIMEOUT: Duration = Duration::from_secs(30);

/// Connect timeout passed to the ssh client (seconds).
const SSH_CONNECT_TIMEOUT_SECS: u32 = 10;

/// Build the `sshpass` argument vector for running `command` against `target`.
/// Pure (no IO) so it can be unit-tested.
///
/// Uses `sshpass -e`, which reads the password from the `SSHPASS` environment
/// variable rather than `-p <password>`. Passing the password as a CLI arg
/// makes it world-readable via `ps`/`/proc/<pid>/cmdline`; the env var is only
/// visible to the process owner on the platforms we target. The caller
/// ([`run_command`]) is responsible for setting `SSHPASS`. The password is
/// therefore intentionally absent from this arg vector.
pub fn build_ssh_args(target: &SshTarget, command: &str) -> Vec<String> {
    vec![
        "-e".to_string(),
        "ssh".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=no".to_string(),
        "-o".to_string(),
        "UserKnownHostsFile=/dev/null".to_string(),
        "-o".to_string(),
        format!("ConnectTimeout={}", SSH_CONNECT_TIMEOUT_SECS),
        "-p".to_string(),
        target.port.to_string(),
        format!("{}@{}", target.username, target.host),
        command.to_string(),
    ]
}

/// Error returned by the executor. Kept small and `Display`-friendly so each
/// caller can map it into its own error type with `.to_string()`.
#[derive(Debug)]
pub enum SshExecError {
    /// `sshpass` (or `ssh`) could not be spawned at all.
    Spawn(String),
    /// The command exceeded its timeout.
    Timeout,
    /// The ssh process exited non-zero; carries stderr.
    NonZeroExit(String),
    /// Some other IO failure while waiting for the child.
    Io(String),
}

impl std::fmt::Display for SshExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshExecError::Spawn(e) => {
                write!(f, "failed to spawn sshpass: {e}. Is sshpass installed?")
            }
            SshExecError::Timeout => write!(f, "ssh command timed out"),
            SshExecError::NonZeroExit(stderr) => write!(f, "ssh command failed: {stderr}"),
            SshExecError::Io(e) => write!(f, "ssh io error: {e}"),
        }
    }
}

impl std::error::Error for SshExecError {}

/// Run a single command against `target`, returning its stdout.
pub async fn run_command(
    target: &SshTarget,
    command: &str,
    timeout: Duration,
) -> Result<String, SshExecError> {
    let args = build_ssh_args(target, command);
    let child = Command::new("sshpass")
        .args(&args)
        // Pass the password via SSHPASS (consumed by `sshpass -e`) instead of
        // argv so it never appears in `ps`/`/proc/<pid>/cmdline`.
        .env("SSHPASS", &target.password)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| SshExecError::Spawn(e.to_string()))?;

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Err(_) => return Err(SshExecError::Timeout),
        Ok(Err(e)) => return Err(SshExecError::Io(e.to_string())),
        Ok(Ok(o)) => o,
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(SshExecError::NonZeroExit(stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Run several commands against `target`, returning each command's stdout
/// paired with the command string. Commands run sequentially over independent
/// one-shot ssh sessions (the device-friendly equivalent of `exec_lines`).
///
/// A per-command failure is surfaced as `Err(command, error)` for that entry
/// so the caller can decide whether to continue; the overall call only returns
/// `Err` if nothing could run.
///
/// `timeout` bounds each command individually; there is no cumulative cap, so
/// worst-case wall time is `timeout * commands.len()`. Callers are expected to
/// pass a small, fixed command list (e.g. topology discovery runs two), so a
/// per-command bound is the right granularity. If a caller ever passes an
/// unbounded/large list, wrap this call in `tokio::time::timeout`.
pub async fn run_commands(
    target: &SshTarget,
    commands: &[&str],
    timeout: Duration,
) -> Vec<(String, Result<String, SshExecError>)> {
    let mut results = Vec::with_capacity(commands.len());
    for cmd in commands {
        let r = run_command(target, cmd, timeout).await;
        results.push((cmd.to_string(), r));
    }
    results
}

/// Notebook [`crate::notebooks::runner::PtyExecutor`] backed by direct SSH.
///
/// The OSC-133 PTY executor waits for a shell-integration end-marker that
/// network devices never send. This implementation runs each command over a
/// one-shot SSH session instead, so command/assertion cells work against real
/// devices. A failed exec is reported as a non-zero `exit_code` (with the
/// error text in `output`) rather than an `Err`, so a single failing cell
/// marks that cell failed without aborting the entire notebook run — matching
/// the OSC-133 executor's exit-code semantics.
///
/// The SSH dispatch is injected so the executor is unit-testable; production
/// wiring uses [`run_command`] against a resolved [`SshTarget`].
pub struct SshPtyExecutor {
    exec: AdhocExecFn,
}

/// Async command-runner used by [`SshPtyExecutor`]: command -> raw output.
pub type AdhocExecFn = Arc<
    dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send>>
        + Send
        + Sync,
>;

impl SshPtyExecutor {
    pub fn new(exec: AdhocExecFn) -> Self {
        Self { exec }
    }

    /// Production constructor: run commands against `target` via [`run_command`].
    pub fn from_target(target: SshTarget) -> Self {
        let target = Arc::new(target);
        let exec: AdhocExecFn = Arc::new(move |cmd: String| {
            let target = target.clone();
            Box::pin(async move {
                run_command(&target, &cmd, DEFAULT_CMD_TIMEOUT)
                    .await
                    .map_err(|e| anyhow::anyhow!(e.to_string()))
            })
        });
        Self::new(exec)
    }
}

#[async_trait::async_trait]
impl crate::notebooks::runner::PtyExecutor for SshPtyExecutor {
    async fn run_command(
        &self,
        _tab_id: &str,
        command: &str,
        _block_id: &str,
    ) -> anyhow::Result<crate::notebooks::runner::PtyRunResult> {
        let started = std::time::Instant::now();
        match (self.exec)(command.to_string()).await {
            Ok(output) => Ok(crate::notebooks::runner::PtyRunResult {
                output,
                exit_code: Some(0),
                duration_ms: started.elapsed().as_millis() as u64,
            }),
            Err(e) => Ok(crate::notebooks::runner::PtyRunResult {
                output: e.to_string(),
                exit_code: Some(1),
                duration_ms: started.elapsed().as_millis() as u64,
            }),
        }
    }
}

/// Troubleshoot-engine [`crate::troubleshoot::live_executor::SshExec`] backed
/// by direct SSH. Replaces the `UnimplementedSsh` stub so diagnostic playbooks
/// run their show-commands against a real device. Unlike the notebook
/// executor, a failed exec propagates as `Err` so the engine marks the step
/// failed (matching the trait's contract).
///
/// SSH dispatch is injected for testability; production wiring uses
/// [`run_command`] against a resolved [`SshTarget`].
pub struct TroubleshootSshExec {
    exec: AdhocExecFn,
}

impl TroubleshootSshExec {
    pub fn new(exec: AdhocExecFn) -> Self {
        Self { exec }
    }

    /// Production constructor: run commands against `target` via [`run_command`].
    pub fn from_target(target: SshTarget) -> Self {
        let target = Arc::new(target);
        let exec: AdhocExecFn = Arc::new(move |cmd: String| {
            let target = target.clone();
            Box::pin(async move {
                run_command(&target, &cmd, DEFAULT_CMD_TIMEOUT)
                    .await
                    .map_err(|e| anyhow::anyhow!(e.to_string()))
            })
        });
        Self::new(exec)
    }
}

#[async_trait::async_trait]
impl crate::troubleshoot::live_executor::SshExec for TroubleshootSshExec {
    async fn exec(&self, _tab_id: &str, command: &str) -> anyhow::Result<String> {
        (self.exec)(command.to_string()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> SshTarget {
        SshTarget {
            host: "device.example.test".to_string(),
            port: 22,
            username: "cisco".to_string(),
            password: "password1".to_string(),
        }
    }

    #[test]
    fn build_ssh_args_uses_env_password_flag_not_argv() {
        let args = build_ssh_args(&target(), "show cdp neighbors detail");
        // sshpass reads the password from the SSHPASS env var (-e), so the
        // password must NEVER appear in argv (which is world-readable via ps).
        assert_eq!(args[0], "-e");
        assert_eq!(args[1], "ssh");
        assert!(
            !args.contains(&"password1".to_string()),
            "password must not be in argv: {args:?}"
        );
    }

    #[test]
    fn build_ssh_args_disables_host_key_prompts() {
        let args = build_ssh_args(&target(), "show version");
        let joined = args.join(" ");
        assert!(joined.contains("StrictHostKeyChecking=no"));
        assert!(joined.contains("UserKnownHostsFile=/dev/null"));
    }

    #[test]
    fn build_ssh_args_sets_port_and_user_host() {
        let mut t = target();
        t.port = 2222;
        let args = build_ssh_args(&t, "show version");
        // The user@host target is the second-to-last arg (command is last).
        assert_eq!(args[args.len() - 2], "cisco@device.example.test");
        assert_eq!(args[args.len() - 1], "show version");
        assert!(args.contains(&"2222".to_string()));
    }

    #[test]
    fn build_ssh_args_command_is_last_arg() {
        let args = build_ssh_args(&target(), "show ip ospf neighbor");
        assert_eq!(args.last().unwrap(), "show ip ospf neighbor");
    }

    fn open_test_db() -> (tempfile::TempDir, Arc<Mutex<Connection>>) {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = crate::db::open_and_migrate(&path).unwrap();
        (dir, Arc::new(Mutex::new(conn)))
    }

    fn seed_conn(
        db: &Arc<Mutex<Connection>>,
        id: &str,
        user: Option<&str>,
        pass_enc: Option<&str>,
    ) {
        let conn = db.lock();
        conn.execute(
            "INSERT INTO ssh_connections (id, name, host, port, user, password_encrypted)
             VALUES (?1, ?2, 'device.example.test', 22, ?3, ?4)",
            rusqlite::params![id, format!("dev-{id}"), user, pass_enc],
        )
        .unwrap();
    }

    #[test]
    fn resolve_target_uses_override_password_when_provided() {
        let (_d, db) = open_test_db();
        seed_conn(&db, "c1", Some("cisco"), None);
        let (target, name) =
            resolve_target(&db, "c1", Some("password1".to_string())).unwrap();
        assert_eq!(target.username, "cisco");
        assert_eq!(target.password, "password1");
        assert_eq!(target.host, "device.example.test");
        assert_eq!(name, "dev-c1");
    }

    #[test]
    fn resolve_target_errors_when_no_password_anywhere() {
        let (_d, db) = open_test_db();
        seed_conn(&db, "c2", Some("cisco"), None);
        let err = resolve_target(&db, "c2", None).unwrap_err();
        assert!(err.contains("No password"), "got: {err}");
    }

    #[test]
    fn resolve_target_errors_on_unknown_connection() {
        let (_d, db) = open_test_db();
        let err = resolve_target(&db, "missing", Some("x".to_string())).unwrap_err();
        assert!(err.contains("Connection not found"), "got: {err}");
    }

    #[test]
    fn resolve_target_errors_when_no_username() {
        let (_d, db) = open_test_db();
        seed_conn(&db, "c3", None, None);
        let err = resolve_target(&db, "c3", Some("pw".to_string())).unwrap_err();
        assert!(err.contains("No username"), "got: {err}");
    }
}
