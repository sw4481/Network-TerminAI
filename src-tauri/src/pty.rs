//! PTY session manager. One `PtyHandle` per tab.
//!
//! This module manages pseudo-terminal (PTY) sessions for terminal tabs using
//! the `portable-pty` crate for cross-platform support (including Windows ConPTY).
//!
//! # Architecture
//!
//! Each terminal tab has a dedicated `PtyHandle` that manages:
//! - A PTY master/slave pair
//! - A shell subprocess
//! - A reader thread for PTY output
//! - A waiter thread for process exit
//!
//! # Data Flow
//!
//! ```text
//! User Input → Frontend → pty_write → PtyHandle → Shell
//!                                                     ↓
//! Frontend ← PtyEvent ← Channel ← Parser ← Reader ← PTY
//! ```
//!
//! # Responsibilities
//!
//! - Spawn shells via `portable-pty` (cross-platform, ConPTY on Windows)
//! - Run a reader task that funnels PTY bytes through `command_parser::Parser`
//! - Forward parsed events via `mpsc::Sender<PtyEvent>`
//! - Accept write / resize / kill operations from the caller

use crate::command_parser::{ParseEvent, Parser};
use anyhow::{Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Configuration options for spawning a new PTY session.
#[derive(Debug, Clone, Deserialize)]
pub struct PtyOptions {
    /// Shell executable path (e.g., "/bin/zsh", "/bin/bash")
    pub shell: String,
    /// Shell arguments (e.g., ["-l"] for login shell)
    #[serde(default)]
    pub args: Vec<String>,
    /// Initial working directory
    pub cwd: String,
    /// Terminal width in columns
    pub cols: u16,
    /// Terminal height in rows
    pub rows: u16,
    /// Pane/tab id exported as `CCIE_PANE_ID` so in-pane agents (claude/codex)
    /// can report their lifecycle status back to the right pane via hooks.
    #[serde(default)]
    pub pane_id: Option<String>,
    /// App-managed Claude Code config dir exported as `CLAUDE_CONFIG_DIR`, so
    /// `claude` launched in this pane picks up our status-reporting hooks
    /// without touching the user's global ~/.claude config.
    #[serde(default)]
    pub claude_config_dir: Option<String>,
}

/// Events emitted by PTY sessions.
///
/// These events are sent via a tokio channel to the caller and
/// eventually forwarded to the frontend via Tauri IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PtyEvent {
    /// Raw output bytes from the PTY
    Output { bytes: Vec<u8> },
    /// Command started (detected via OSC 133 A sequence)
    CommandStart {
        cmd: String,
        block_id: Option<String>,
    },
    /// Command ended (detected via OSC 133 D sequence)
    CommandEnd { exit_code: Option<i32> },
    /// Working directory reported by the shell (OSC 7). Lets the frontend track
    /// the tab's live cwd as the user `cd`s.
    Cwd { path: String },
    /// A full-screen TUI took over the alternate screen (`\e[?1049h`). Used to
    /// suppress the "command running" indicator for long-lived interactive
    /// apps (claude, codex, vim, …) that never emit OSC 133 D until they exit.
    EnterAltScreen,
    /// The alternate screen was restored (`\e[?1049l`); the TUI has exited.
    ExitAltScreen,
    /// Shell process exited
    Exit { code: Option<i32> },
}

/// Raw byte chunk from the PTY before parsing. Used by the recording tap
/// hook so playback preserves OSC 133 sequences and timing.
#[derive(Debug, Clone)]
pub struct RawOutput {
    pub bytes: Vec<u8>,
    pub recv_at: std::time::Instant,
}

/// Slot for an optional secondary "tap" sender. Held alongside the reader
/// thread so `attach_tap` / `detach_tap` can take effect at runtime
/// without re-spawning the PTY.
pub type TapSlot = Arc<Mutex<Option<mpsc::Sender<RawOutput>>>>;

/// Handle to a spawned PTY session.
///
/// Provides operations for interacting with the PTY:
/// - Writing user input to the shell
/// - Resizing the terminal
/// - Killing the shell process
///
/// The underlying PTY reader and waiter threads run independently
/// and send events via the channel provided during spawn.
pub struct PtyHandle {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    /// Plan 14 — optional recording tap. The reader thread `try_send`s
    /// each chunk through this slot before parsing; recording is purely
    /// additive — absence has zero effect on terminal performance.
    tap_slot: TapSlot,
    /// OS process id of the spawned shell (Phase 3E — used for port/ssh
    /// metadata gathering). `None` if the platform did not report one.
    pid: Option<u32>,
}

impl PtyHandle {
    /// The OS process id of the spawned shell, if known.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Full command line of the current foreground process-group leader in this
    /// PTY: the executable path plus its arguments, space-joined — e.g.
    /// `.../claude/versions/2.1.207` for native Claude Code, or
    /// `node $HOME/.npm-global/bin/codex resume` for the node-wrapped Codex
    /// CLI, or `/bin/zsh -il` at the prompt. Used by the agent-toolbelt poll to
    /// detect an in-pane agent BEFORE it fires any lifecycle hook; the
    /// classifier (`foreground::foreground_agent_for`) inspects the components.
    /// We include argv (not just the exe path) because JS/Python-wrapped agents
    /// run as `node .../codex` — the exe is `node`, but argv carries `codex`.
    /// Returns `None` if the platform can't report the leader or its command.
    #[cfg(target_os = "macos")]
    pub fn foreground_process_name(&self) -> Option<String> {
        let pgid = self.foreground_process_group_id()?;
        // Prefer the full argv (catches node/python-wrapped agents); fall back to
        // the executable path if argv can't be read.
        proc_command_macos(pgid).or_else(|| proc_name_macos(pgid))
    }

    /// Kernel-owned identity for the process currently controlling this PTY.
    /// A saved-SSH binding records this generation so a later, unrelated `ssh`
    /// process in the same shell cannot inherit the earlier connection record.
    #[cfg(target_os = "macos")]
    pub fn foreground_process_group_id(&self) -> Option<libc::pid_t> {
        self.master.lock().process_group_leader()
    }

    /// Kernel-observed foreground process identity with true argv boundaries.
    /// Used when a security decision must not depend on a space-joined command.
    #[cfg(target_os = "macos")]
    pub fn foreground_process_identity(
        &self,
    ) -> Option<(libc::pid_t, String, Vec<String>)> {
        let pgid = self.foreground_process_group_id()?;
        let (executable, argv) = proc_args_macos(pgid)?;
        Some((pgid, executable, argv))
    }

    #[cfg(not(target_os = "macos"))]
    pub fn foreground_process_name(&self) -> Option<String> {
        None
    }

    #[cfg(not(target_os = "macos"))]
    pub fn foreground_process_group_id(&self) -> Option<i32> {
        None
    }

    #[cfg(not(target_os = "macos"))]
    pub fn foreground_process_identity(&self) -> Option<(i32, String, Vec<String>)> {
        None
    }

    /// Attach a recording tap. Subsequent reads from the PTY will be
    /// `try_send` to `tx` BEFORE parsing. Replaces any existing tap.
    pub fn attach_tap(&self, tx: mpsc::Sender<RawOutput>) {
        *self.tap_slot.lock() = Some(tx);
    }

    /// Detach the recording tap (if any).
    pub fn detach_tap(&self) {
        *self.tap_slot.lock() = None;
    }

    pub fn has_tap(&self) -> bool {
        self.tap_slot.lock().is_some()
    }
}

impl PtyHandle {
    /// Write bytes to the PTY input (sent to shell).
    ///
    /// # Arguments
    /// * `bytes` - Raw bytes to write (typically UTF-8 encoded text)
    ///
    /// # Errors
    /// Returns error if write or flush fails.
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let mut w = self.writer.lock();
        w.write_all(bytes).context("pty write")?;
        w.flush().context("pty flush")?;
        Ok(())
    }

    /// Resize the PTY dimensions.
    ///
    /// # Arguments
    /// * `cols` - New width in columns
    /// * `rows` - New height in rows
    ///
    /// # Errors
    /// Returns error if resize operation fails.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("pty resize")?;
        Ok(())
    }

    /// Kill the shell process.
    ///
    /// Sends a kill signal to the shell subprocess. The waiter thread
    /// will emit a `PtyEvent::Exit` when the process terminates.
    ///
    /// # Errors
    /// Returns error if kill signal fails.
    pub fn kill(&self) -> Result<()> {
        self.killer.lock().kill().context("pty kill")?;
        Ok(())
    }
}

/// Spawn a new PTY session with the given options.
///
/// Creates a PTY master/slave pair, spawns the specified shell, and starts
/// background threads for reading output and waiting for process exit.
///
/// # Arguments
/// * `opts` - Configuration for the PTY session
/// * `tx` - Channel for sending `PtyEvent`s to the caller
///
/// # Returns
/// A `PtyHandle` for controlling the PTY session.
///
/// # Errors
/// Returns error if:
/// - PTY creation fails
/// - Shell spawn fails
/// - Reader/writer setup fails
///
/// # Example
/// ```no_run
/// use ccie_terminal_lib::pty::{spawn_pty, PtyOptions, PtyEvent};
/// use tokio::sync::mpsc;
///
/// #[tokio::main]
/// async fn main() {
///     let (tx, mut rx) = mpsc::channel::<PtyEvent>(256);
///
///     let handle = spawn_pty(
///         PtyOptions {
///             shell: "/bin/bash".to_string(),
///             args: vec![],
///             cwd: "/tmp".to_string(),
///             cols: 80,
///             rows: 24,
///             pane_id: None,
///             claude_config_dir: None,
///         },
///         tx,
///     ).await.unwrap();
///
///     handle.write(b"echo test\n").unwrap();
///
///     while let Some(event) = rx.recv().await {
///         println!("PTY event: {:?}", event);
///     }
/// }
/// ```
pub async fn spawn_pty(opts: PtyOptions, tx: mpsc::Sender<PtyEvent>) -> Result<PtyHandle> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            cols: opts.cols,
            rows: opts.rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty")?;

    let mut cmd = CommandBuilder::new(&opts.shell);

    // If no args provided and it's a common shell, add interactive AND login flags
    if opts.args.is_empty() && (opts.shell.ends_with("/zsh") || opts.shell.ends_with("/bash")) {
        // -i = interactive mode (enables line editing, history, and echo)
        // -l = login shell (loads profile, sets up environment properly)
        tracing::info!(
            "Adding -il flags for interactive login shell: {}",
            opts.shell
        );
        cmd.arg("-il");
    } else {
        tracing::info!("Using provided args for shell: {:?}", opts.args);
        for a in &opts.args {
            cmd.arg(a);
        }
    }

    cmd.cwd(&opts.cwd);
    // Set TERM to ensure proper terminal behavior
    cmd.env("TERM", "xterm-256color");
    // Enable shell integration for command block detection
    cmd.env("CCIE_TERMINAL", "1");
    // Expose the pane id so in-pane agents' lifecycle hooks can report status
    // back to the correct pane (see control_server /agent_status).
    if let Some(ref pane_id) = opts.pane_id {
        cmd.env("CCIE_PANE_ID", pane_id);
    }
    // Point `claude` at our app-managed config dir so it loads the
    // status-reporting hooks without polluting the user's global config.
    if let Some(ref dir) = opts.claude_config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }

    let child = pair.slave.spawn_command(cmd).context("spawn shell")?;
    let pid = child.process_id();

    // Drop the slave end in the parent so the PTY closes when the child exits.
    drop(pair.slave);

    // Clone the killer handle before moving the child into the waiter thread.
    let killer = child.clone_killer();

    let writer = pair.master.take_writer().context("take_writer")?;
    let mut reader = pair.master.try_clone_reader().context("clone_reader")?;

    let master = Arc::new(Mutex::new(pair.master));
    let writer = Arc::new(Mutex::new(writer));
    let killer = Arc::new(Mutex::new(killer));
    let tap_slot: TapSlot = Arc::new(Mutex::new(None));

    // Reader thread: blocking reads, forward to tokio channel via blocking_send.
    let tx_read = tx.clone();
    let tap_slot_clone = tap_slot.clone();
    std::thread::spawn(move || {
        let mut parser = Parser::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Plan 14 — recording tap: forward raw pre-parser bytes
                    // to the recording supervisor (if attached). Use
                    // try_send so a slow recording can never back-pressure
                    // the user's terminal.
                    {
                        let slot = tap_slot_clone.lock();
                        if let Some(tx) = slot.as_ref() {
                            let _ = tx.try_send(RawOutput {
                                bytes: buf[..n].to_vec(),
                                recv_at: std::time::Instant::now(),
                            });
                        }
                    }
                    for ev in parser.feed(&buf[..n]) {
                        let pty_ev = match ev {
                            ParseEvent::Output(bytes) => PtyEvent::Output { bytes },
                            ParseEvent::CommandStart { cmd } => PtyEvent::CommandStart {
                                cmd,
                                block_id: None,
                            },
                            ParseEvent::CommandEnd { exit_code } => {
                                PtyEvent::CommandEnd { exit_code }
                            }
                            ParseEvent::Cwd(path) => PtyEvent::Cwd { path },
                            ParseEvent::EnterAltScreen => PtyEvent::EnterAltScreen,
                            ParseEvent::ExitAltScreen => PtyEvent::ExitAltScreen,
                        };
                        if tx_read.blocking_send(pty_ev).is_err() {
                            return;
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Waiter thread: when the child exits, emit a final Exit event.
    // The waiter thread owns the child directly - no Arc/Mutex needed.
    let tx_wait = tx.clone();
    std::thread::spawn(move || {
        let mut child = child; // take ownership
        let exit = child.wait().ok().map(|s| if s.success() { 0 } else { 1 });
        let _ = tx_wait.blocking_send(PtyEvent::Exit { code: exit });
    });

    Ok(PtyHandle {
        master,
        writer,
        killer,
        tap_slot,
        pid,
    })
}

/// Resolve a pid to its full executable path via macOS `proc_pidpath`.
/// Returns the whole path (not just the basename) because agent CLIs are often
/// symlinks that resolve to a versioned file — e.g. `claude` →
/// `.../claude/versions/2.1.207` — so the basename alone (`2.1.207`) doesn't
/// identify the agent. The classifier inspects the path's components.
#[cfg(target_os = "macos")]
fn proc_name_macos(pid: libc::pid_t) -> Option<String> {
    const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;
    let mut buf = [0u8; PROC_PIDPATHINFO_MAXSIZE];
    // SAFETY: buf is valid for `buf.len()` bytes; proc_pidpath writes at most
    // that many and returns the number written (<=0 on failure).
    let n =
        unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

/// Read a pid's full command line (executable path + argv), space-joined, via
/// `sysctl(KERN_PROCARGS2)`. This is how we detect script-wrapped agents like
/// Codex, which run as `node .../bin/codex` — the exe path is `node`, but argv
/// carries the `codex` token. Returns `None` on any failure (permissions, race).
///
/// KERN_PROCARGS2 buffer layout (macOS): `i32 argc`, then the exec path
/// (NUL-terminated), then `argc` NUL-terminated argv strings. We stitch the
/// exec path and argv together with spaces.
#[cfg(target_os = "macos")]
fn proc_command_macos(pid: libc::pid_t) -> Option<String> {
    let (exec, argv) = proc_args_macos(pid)?;
    let mut cmd = exec;
    for a in argv {
        cmd.push(' ');
        cmd.push_str(&a);
    }
    Some(cmd)
}

#[cfg(target_os = "macos")]
fn proc_args_macos(pid: libc::pid_t) -> Option<(String, Vec<String>)> {
    // The KERN_PROCARGS2 buffer must be sized to KERN_ARGMAX. Passing a larger
    // buffer makes the syscall fail with EINVAL, so query the real max first.
    let arg_max = kern_argmax_macos()?;
    let mut mib: [libc::c_int; 3] = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut buf = vec![0u8; arg_max];
    let mut size = buf.len();
    // SAFETY: mib points to 3 valid c_ints; buf is valid for `size` bytes and
    // `size` is updated in place with the number of bytes written.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size < std::mem::size_of::<libc::c_int>() {
        return None;
    }
    buf.truncate(size);

    // First 4 bytes = argc (native-endian).
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if argc <= 0 {
        return None;
    }
    // NUL-separated C strings follow argc: [exec_path, argv0, argv1, ...].
    // The exec path is followed by one-or-more NULs (padding) before argv0.
    let rest = &buf[std::mem::size_of::<libc::c_int>()..];
    let mut parts = rest
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned());

    // The first non-empty token is the exec path; the next `argc` are argv.
    // Joining exec path + argv gives the classifier every token to match on.
    let exec = parts.next()?;
    let argv: Vec<String> = parts.take(argc as usize).collect();
    (argv.len() == argc as usize).then_some((exec, argv))
}

/// Query `KERN_ARGMAX` — the exact buffer size KERN_PROCARGS2 requires. Passing
/// any other size makes the args query fail with EINVAL.
#[cfg(target_os = "macos")]
fn kern_argmax_macos() -> Option<usize> {
    let mut mib: [libc::c_int; 2] = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut argmax: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    // SAFETY: mib has 2 valid c_ints; argmax is a valid c_int out-param and size
    // matches its byte length.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            &mut argmax as *mut libc::c_int as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || argmax <= 0 {
        return None;
    }
    Some(argmax as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pty_events_can_route_to_pane_manager() {
        // This is an integration placeholder - actual integration
        // happens via spawn() modifications in a future task when
        // we understand the PTY architecture better.
        let _manager = crate::pane_context::PaneContextManager::new();
    }

    #[tokio::test]
    async fn test_spawn_pty_captures_pid() {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let shell = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };
        let handle = spawn_pty(
            PtyOptions {
                shell: shell.to_string(),
                args: vec![],
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                cols: 80,
                rows: 24,
                pane_id: None,
                claude_config_dir: None,
            },
            tx,
        )
        .await
        .expect("spawn");
        assert!(handle.pid().is_some(), "expected a captured pid");
        assert!(handle.pid().unwrap() > 0);
        let _ = handle.kill();
    }
}
