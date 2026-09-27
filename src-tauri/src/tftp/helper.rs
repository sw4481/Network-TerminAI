//! Elevated TFTP helper for privileged ports (< 1024, i.e. the standard port 69).
//!
//! The unprivileged app cannot bind port 69, so it relaunches its own binary in
//! `--tftp-helper` mode via `osascript ... with administrator privileges` (native
//! macOS auth prompt). That privileged context has no controlling terminal and
//! reaps backgrounded children when `do shell script` returns, so the helper
//! **self-daemonizes** (double-fork + setsid) to detach into its own session
//! before serving; the shell command runs it in the foreground with no `nohup`
//! or `&`. Because a non-root parent cannot signal a root child, the helper is
//! controlled by a *runfile* it polls: the parent removes the runfile to request
//! shutdown, and the helper self-exits on its next poll (it also self-exits if
//! the app process it was launched from dies).
use crate::tftp::server::LoggingHandler;
use crate::tftp::types::{TftpConfig, TftpStatus};
use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// Where the daemonized helper redirects stdout/stderr. Fixed path so a crash
/// is discoverable without knowing the elevated process's cwd.
#[cfg(unix)]
const HELPER_LOG: &str = "/tmp/ccie-tftp-helper.log";

fn ctrl_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".ccie-terminal")
}
fn pidfile() -> PathBuf {
    ctrl_dir().join("tftp.pid")
}
fn runfile() -> PathBuf {
    ctrl_dir().join("tftp.run")
}

/// Build the shell command run (as root) by osascript. Exports config via env
/// and execs the app binary in --tftp-helper mode.
///
/// The binary self-daemonizes (fork + setsid + fork; see `daemonize`), so it
/// runs in the FOREGROUND here — NO `nohup` and NO `&`. That is deliberate:
/// `osascript ... with administrator privileges` runs the command in a
/// privileged context with no controlling terminal, where `nohup` fails
/// ("Inappropriate ioctl for device") and a `&`-backgrounded child is reaped
/// when the script returns. Because the binary forks into its own session and
/// its original process exits immediately, `do shell script` still returns
/// promptly while the detached daemon keeps serving.
#[allow(clippy::too_many_arguments)]
pub fn build_helper_shell_command(
    binary: &str,
    host: &str,
    port: u16,
    root: &str,
    read_only: bool,
    db_path: &str,
    pid_path: &str,
    run_path: &str,
    parent_pid: u32,
) -> String {
    // Single-quote each value for the shell; values are app-controlled paths.
    // The host is single-quoted too: bind_host is operator-editable, so an
    // unquoted value would allow shell injection on this root-executed command.
    format!(
        "CCIE_TFTP_HOST='{host}' CCIE_TFTP_PORT={port} CCIE_TFTP_ROOT='{root}' \
         CCIE_TFTP_RO={ro} CCIE_TFTP_DB='{db}' CCIE_TFTP_PID='{pid}' CCIE_TFTP_RUN='{run}' \
         CCIE_TFTP_PARENT={parent} \
         '{bin}' --tftp-helper",
        host = host,
        port = port,
        root = root,
        ro = if read_only { 1 } else { 0 },
        db = db_path,
        pid = pid_path,
        run = run_path,
        parent = parent_pid,
        bin = binary,
    )
}

#[cfg(unix)]
fn pid_is_alive(pid: i32) -> bool {
    // kill(pid, 0): Ok or EPERM => exists; ESRCH => gone.
    unsafe {
        let r = libc::kill(pid, 0);
        if r == 0 {
            return true;
        }
        // errno EPERM (1) means it exists but we can't signal it (root-owned).
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

// Windows never spawns the elevated helper (no osascript/privileged-port path),
// so there is never a helper pid to probe.
#[cfg(not(unix))]
fn pid_is_alive(_pid: i32) -> bool {
    false
}

pub fn helper_is_running() -> bool {
    let pf = pidfile();
    let Ok(txt) = std::fs::read_to_string(&pf) else {
        return false;
    };
    match txt.trim().parse::<i32>() {
        Ok(pid) => pid_is_alive(pid),
        Err(_) => false,
    }
}

pub fn helper_status(last_error: Option<String>) -> TftpStatus {
    if helper_is_running() {
        let bind = std::fs::read_to_string(runfile())
            .ok()
            .map(|s| s.trim().to_string());
        TftpStatus {
            running: true,
            bind_address: bind,
            started_at: None,
            last_error,
            elevated: true,
        }
    } else {
        TftpStatus {
            running: false,
            bind_address: None,
            started_at: None,
            last_error,
            elevated: false,
        }
    }
}

/// Spawn the elevated helper. Blocks until the osascript auth dialog resolves.
pub fn spawn_elevated(config: &TftpConfig, root: &Path) -> Result<()> {
    // Defense-in-depth: the elevated path returns before the in-process
    // SocketAddr::parse that validates the host, and bind_host is embedded in a
    // root-executed shell command. Require a bare IP address (no shell
    // metacharacters can survive an IpAddr parse).
    if config.bind_host.parse::<std::net::IpAddr>().is_err() {
        anyhow::bail!(
            "invalid bind host {:?}: must be an IP address",
            config.bind_host
        );
    }

    let dir = ctrl_dir();
    std::fs::create_dir_all(&dir).ok();

    let bind = format!("{}:{}", config.bind_host, config.bind_port);
    // Runfile presence == "keep running". Written by us (non-root) so we can remove it.
    std::fs::write(runfile(), &bind)?;
    let _ = std::fs::remove_file(pidfile()); // clear stale

    let binary = std::env::current_exe()?.to_string_lossy().to_string();
    let db_path = crate::db::default_db_path()?.to_string_lossy().to_string();
    let shell = build_helper_shell_command(
        &binary,
        &config.bind_host,
        config.bind_port,
        &root.to_string_lossy(),
        config.read_only,
        &db_path,
        &pidfile().to_string_lossy(),
        &runfile().to_string_lossy(),
        std::process::id(),
    );

    // osascript: prompt once for admin, then run the shell command as root.
    let apple = format!(
        "do shell script {} with administrator privileges",
        applescript_quote(&shell)
    );
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&apple)
        .status()?;
    if !status.success() {
        let _ = std::fs::remove_file(runfile());
        anyhow::bail!("authorization cancelled or failed");
    }
    Ok(())
}

/// Quote a string as an AppleScript string literal.
fn applescript_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// Request shutdown by removing the runfile the helper polls.
pub fn stop_elevated() -> Result<()> {
    let _ = std::fs::remove_file(runfile());
    Ok(())
}

/// If invoked with `--tftp-helper`, run the listener and never return.
/// Returns true if we handled helper mode (caller should exit).
pub fn run_helper_if_requested() -> bool {
    if !std::env::args().any(|a| a == "--tftp-helper") {
        return false;
    }
    // Detach into our own session BEFORE starting tokio. `osascript ... with
    // administrator privileges` runs us with no controlling terminal and reaps
    // backgrounded children when `do shell script` returns; daemonizing (fork +
    // setsid + fork) escapes that session so the listener survives. The original
    // process exits inside `daemonize`, so `do shell script` returns promptly.
    // The elevation path is macOS-specific; on Windows there is nothing to
    // detach from, so skip it.
    #[cfg(unix)]
    daemonize();

    // Build a tokio runtime and run the listener (separate elevated process, no Tauri).
    let rt = tokio::runtime::Runtime::new().expect("helper runtime");
    rt.block_on(async {
        if let Err(e) = helper_main().await {
            eprintln!("tftp helper error: {e}");
        }
    });
    true
}

/// Classic double-fork daemonization. Detaches from the controlling terminal and
/// process group so the helper is not tied to the (tty-less) osascript session
/// that launched it. The intermediate and original processes exit here; only the
/// final grandchild returns to run the listener. stdio is redirected to the
/// helper log so a crash leaves a trace.
///
/// Safety: only raw libc process calls are used; nothing here touches shared
/// Rust state, and the parent/intermediate processes exit before any tokio
/// runtime or file handles are created.
#[cfg(unix)]
fn daemonize() {
    unsafe {
        // First fork: parent exits so `do shell script` (which waits on the
        // command) returns immediately, and the child is not a process-group
        // leader (a precondition for setsid()).
        match libc::fork() {
            -1 => return, // fork failed; fall through and run attached (best effort)
            0 => {}       // child continues
            _ => libc::_exit(0), // parent exits now
        }

        // New session: detaches from the controlling terminal and osascript's
        // process group so we are never reaped with it.
        if libc::setsid() == -1 {
            // Can't detach cleanly; keep going rather than abort — better a
            // possibly-attached server than none.
        }

        // Second fork: the session leader can reacquire a controlling terminal;
        // forking again yields a process that never can.
        match libc::fork() {
            -1 => {}
            0 => {}              // grandchild continues to run the listener
            _ => libc::_exit(0), // intermediate leader exits
        }

        // Redirect stdio to the helper log (fd 0 from /dev/null, 1/2 to the log)
        // so nothing writes to the now-closed osascript pipes and a crash is
        // still captured.
        redirect_daemon_stdio();
    }
}

/// Point stdin at /dev/null and stdout/stderr at the helper log. Best-effort:
/// failures are ignored (the daemon still runs, just without a log).
#[cfg(unix)]
unsafe fn redirect_daemon_stdio() {
    let devnull = std::ffi::CString::new("/dev/null").unwrap();
    let log_path = std::ffi::CString::new(HELPER_LOG).unwrap();

    let in_fd = libc::open(devnull.as_ptr(), libc::O_RDONLY);
    if in_fd >= 0 {
        libc::dup2(in_fd, libc::STDIN_FILENO);
        if in_fd > 2 {
            libc::close(in_fd);
        }
    }
    let out_fd = libc::open(
        log_path.as_ptr(),
        libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND,
        0o644,
    );
    if out_fd >= 0 {
        libc::dup2(out_fd, libc::STDOUT_FILENO);
        libc::dup2(out_fd, libc::STDERR_FILENO);
        if out_fd > 2 {
            libc::close(out_fd);
        }
    }
}

async fn helper_main() -> Result<()> {
    let host = std::env::var("CCIE_TFTP_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port: u16 = std::env::var("CCIE_TFTP_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(69);
    let root = PathBuf::from(std::env::var("CCIE_TFTP_ROOT").unwrap_or_default());
    let read_only = std::env::var("CCIE_TFTP_RO").ok().as_deref() == Some("1");
    let db_path = std::env::var("CCIE_TFTP_DB")?;
    let pid_path = PathBuf::from(std::env::var("CCIE_TFTP_PID")?);
    let run_path = PathBuf::from(std::env::var("CCIE_TFTP_RUN")?);
    // Real app pid to watch. We daemonize (double-fork + setsid), so getppid()
    // reparents to launchd (1) at birth — watch the app's actual pid instead.
    // If missing/unparseable, treat the parent as alive and rely on the runfile.
    let parent_pid: Option<i32> = std::env::var("CCIE_TFTP_PARENT")
        .ok()
        .and_then(|s| s.trim().parse().ok());

    std::fs::write(&pid_path, std::process::id().to_string())?;

    let conn = Connection::open(&db_path)?;
    let db = Arc::new(Mutex::new(conn));
    let addr: std::net::SocketAddr = format!("{host}:{port}").parse()?;

    use async_tftp::server::TftpServerBuilder;
    let handler = LoggingHandler {
        db: db.clone(),
        root,
        read_only,
    };
    let server = TftpServerBuilder::with_handler(handler)
        .bind(addr)
        .build()
        .await?;

    let parent_gone = async {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let runfile_gone = !run_path.exists();
            // Parent gone => app process no longer exists (ESRCH). Missing pid
            // means "assume alive" so we don't self-terminate on the runfile's
            // behalf. Reuses the same liveness logic as pid_is_alive.
            let parent_gone = parent_pid.map(|p| !pid_is_alive(p)).unwrap_or(false);
            if runfile_gone || parent_gone {
                break;
            }
        }
    };

    tokio::select! {
        res = server.serve() => { res?; }
        _ = parent_gone => {}
    }
    let _ = std::fs::remove_file(&pid_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osascript_command_exports_env_and_execs_binary() {
        let cmd = build_helper_shell_command(
            "/Applications/CCIE.app/Contents/MacOS/ccie-terminal",
            "0.0.0.0",
            69,
            "$HOME/.ccie-terminal/tftp",
            true,
            "$HOME/.ccie-terminal/db.sqlite",
            "$HOME/.ccie-terminal/tftp.pid",
            "$HOME/.ccie-terminal/tftp.run",
            4321,
        );
        assert!(cmd.contains("CCIE_TFTP_PORT=69"));
        // Host must be single-quoted (matching other values) to prevent shell
        // injection on this root-executed command.
        assert!(cmd.contains("CCIE_TFTP_HOST='0.0.0.0'"));
        assert!(cmd.contains("CCIE_TFTP_RO=1"));
        assert!(cmd.contains("CCIE_TFTP_PARENT=4321"));
        assert!(cmd.contains("--tftp-helper"));
        assert!(cmd.contains("ccie-terminal"));
    }

    #[test]
    fn read_only_flag_serializes_to_zero_when_false() {
        let cmd = build_helper_shell_command(
            "/bin/x", "0.0.0.0", 69, "/r", false, "/db", "/p", "/run", 4321,
        );
        assert!(cmd.contains("CCIE_TFTP_RO=0"));
    }

    #[test]
    fn applescript_quote_escapes_quotes() {
        assert_eq!(applescript_quote(r#"a"b"#), r#""a\"b""#);
    }

    #[test]
    fn spawn_elevated_rejects_malicious_host() {
        // bind_host is embedded into a root-executed shell command; a value
        // with shell metacharacters must be rejected before spawn.
        let cfg = TftpConfig {
            bind_host: "0.0.0.0; rm -rf /".into(),
            bind_port: 69,
            root_dir: std::env::temp_dir().to_string_lossy().into(),
            read_only: true,
            auto_start: false,
        };
        let err = spawn_elevated(&cfg, &std::env::temp_dir()).unwrap_err();
        assert!(err.to_string().contains("invalid bind host"));
    }
}
