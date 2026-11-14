//! Per-PTY plain-text logging. Only displayed output enters this manager, never stdin.
use crate::recording::redactor::Redactor;
use crate::transcript_export::AnsiStripper;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLogStatus {
    pub id: String,
    pub tab_id: String,
    pub path: String,
    pub active: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalLogMode {
    Create,
    Append,
    Overwrite,
}

type StatusSink = Arc<dyn Fn(TerminalLogStatus) + Send + Sync>;

struct LogEntry {
    generation: String,
    path: PathBuf,
    sender: Option<mpsc::SyncSender<Vec<u8>>>,
    worker: Arc<Mutex<Option<JoinHandle<()>>>>,
    status: Arc<Mutex<TerminalLogStatus>>,
}

#[derive(Default)]
pub struct TerminalLogManager {
    sessions: Mutex<HashMap<String, LogEntry>>,
    starts: Mutex<()>,
    shutting_down: AtomicBool,
}

impl TerminalLogManager {
    pub fn start(
        &self,
        tab_id: &str,
        generation: &str,
        path: &Path,
        mode: TerminalLogMode,
        sink: StatusSink,
    ) -> Result<TerminalLogStatus, String> {
        // Disk opens serialize only other starts, never PTY output delivery.
        let _start = self.starts.lock();
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("Terminal logging is shutting down".into());
        }
        if !path.is_absolute() || path.file_name().is_none() {
            return Err("Choose an absolute log file path".into());
        }
        let canonical = match path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => path
                .parent()
                .ok_or("Log directory is missing")?
                .canonicalize()
                .map_err(|error| format!("Log directory: {error}"))?
                .join(path.file_name().ok_or("Log file name is missing")?),
            Err(error) => return Err(format!("Log path: {error}")),
        };
        let sessions = self.sessions.lock();
        if sessions
            .get(tab_id)
            .is_some_and(|entry| entry.status.lock().active)
        {
            return Err("This pane is already logging".into());
        }
        if sessions
            .values()
            .any(|entry| entry.path == canonical && entry.status.lock().active)
        {
            return Err("This file is already being logged to by another pane".into());
        }
        drop(sessions);
        if let Ok(metadata) = canonical.metadata() {
            if !metadata.is_file() {
                return Err("Log destination must be a regular file".into());
            }
        }
        let mut options = OpenOptions::new();
        options.write(true);
        // Windows locking requires read or write access, not append-only access.
        #[cfg(windows)]
        options.read(true);
        match mode {
            TerminalLogMode::Create => {
                options.create_new(true);
            }
            TerminalLogMode::Append => {
                options.create(true).append(true);
            }
            TerminalLogMode::Overwrite => {
                options.create(true);
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
        }
        // Do not truncate on open: a hard-link alias must be checked first.
        let file = options
            .open(&canonical)
            .map_err(|error| format!("Open log: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("Log metadata: {error}"))?;
        if !metadata.is_file() {
            return Err("Log destination must be a regular file".into());
        }
        // The OS lock protects hard-link aliases too, on every supported platform.
        file.try_lock()
            .map_err(|error| format!("Log file is already in use or cannot be locked: {error}"))?;
        let redactor = Redactor::new(&[]).map_err(|error| error.to_string())?;
        if matches!(mode, TerminalLogMode::Overwrite) {
            file.set_len(0)
                .map_err(|error| format!("Overwrite log: {error}"))?;
        }
        let status = TerminalLogStatus {
            id: uuid::Uuid::new_v4().to_string(),
            tab_id: tab_id.into(),
            path: canonical.to_string_lossy().into_owned(),
            active: true,
            error: None,
        };
        let shared_status = Arc::new(Mutex::new(status.clone()));
        let worker_status = shared_status.clone();
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(256);
        let worker = std::thread::Builder::new()
            .name("terminal-log".into())
            .spawn(move || write_log(file, receiver, redactor, worker_status, sink))
            .map_err(|error| format!("Start log writer: {error}"))?;
        self.sessions.lock().insert(
            tab_id.into(),
            LogEntry {
                generation: generation.into(),
                path: canonical,
                sender: Some(sender),
                worker: Arc::new(Mutex::new(Some(worker))),
                status: shared_status,
            },
        );
        Ok(status)
    }

    /// This hot path never waits for disk, a worker, or queue capacity.
    pub fn output(&self, tab_id: &str, generation: &str, bytes: &[u8]) {
        let mut sessions = self.sessions.lock();
        let Some(entry) = sessions
            .get_mut(tab_id)
            .filter(|entry| entry.generation == generation)
        else {
            return;
        };
        let Some(sender) = entry.sender.as_ref() else {
            return;
        };
        match sender.try_send(bytes.to_vec()) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => {
                entry.status.lock().error = Some(
                    "Logging stopped: disk writer could not keep up (output queue full)".into(),
                );
                // Drain accepted output before the worker publishes the final failure.
                entry.sender.take();
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                entry.sender.take();
            }
        }
    }

    pub fn status(&self, tab_id: &str) -> Option<TerminalLogStatus> {
        self.sessions
            .lock()
            .get(tab_id)
            .map(|entry| entry.status.lock().clone())
    }

    /// Close the producer first; join without the map lock so accepted output is
    /// drained and flushed before Stop, pane close, or process exit completes.
    pub fn stop(&self, tab_id: &str, generation: Option<&str>) -> Option<TerminalLogStatus> {
        self.stop_matching(tab_id, generation, None)
    }

    pub fn stop_instance(&self, tab_id: &str, instance: &str) -> Option<TerminalLogStatus> {
        self.stop_matching(tab_id, None, Some(instance))
    }

    fn stop_matching(
        &self,
        tab_id: &str,
        generation: Option<&str>,
        instance: Option<&str>,
    ) -> Option<TerminalLogStatus> {
        let (worker, status) = {
            let mut sessions = self.sessions.lock();
            let entry = sessions.get_mut(tab_id)?;
            if generation.is_some_and(|generation| entry.generation != generation)
                || instance.is_some_and(|instance| entry.status.lock().id != instance)
            {
                return None;
            }
            entry.sender.take();
            (entry.worker.clone(), entry.status.clone())
        };
        // Concurrent process-exit cleanup must wait for an in-flight Stop too.
        let mut worker = worker.lock();
        if let Some(worker) = worker.take() {
            if worker.join().is_err() {
                let mut status = status.lock();
                status.active = false;
                status.error = Some("Terminal log writer stopped unexpectedly".into());
            }
        }
        let result = status.lock().clone();
        Some(result)
    }

    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        let _start = self.starts.lock();
        let tabs: Vec<_> = self.sessions.lock().keys().cloned().collect();
        for tab in tabs {
            self.stop(&tab, None);
        }
    }
}

struct PlainText {
    stripper: AnsiStripper,
    utf8: Vec<u8>,
    line: String,
    after_cr: bool,
    redactor: Redactor,
}

impl PlainText {
    fn feed(&mut self, bytes: &[u8], finishing: bool, file: &mut impl Write) -> io::Result<()> {
        self.utf8.extend_from_slice(bytes);
        let mut valid = 0;
        while valid < self.utf8.len() {
            match std::str::from_utf8(&self.utf8[valid..]) {
                Ok(_) => {
                    valid = self.utf8.len();
                    break;
                }
                Err(error) => {
                    valid += error.valid_up_to();
                    if let Some(length) = error.error_len() {
                        valid += length;
                    } else {
                        break;
                    }
                }
            }
        }
        if finishing {
            valid = self.utf8.len();
        }
        let text = String::from_utf8_lossy(&self.utf8[..valid]);
        let mut plain = String::new();
        self.stripper.feed(&text, |ch| plain.push(ch));
        self.utf8.drain(..valid);
        for ch in plain.chars() {
            if self.after_cr && ch == '\n' {
                self.after_cr = false;
                continue;
            }
            self.after_cr = ch == '\r';
            self.line.push(if ch == '\r' { '\n' } else { ch });
            if ch == '\r' || ch == '\n' {
                file.write_all(&self.redactor.feed(self.line.as_bytes()))?;
                self.line.clear();
            }
            // ponytail: redact complete lines so split secrets cannot leak a prefix.
            // Partial lines wait for newline/Stop; stop visibly rather than grow unbounded.
            if self.line.len() > 1024 * 1024 {
                return Err(io::Error::other(
                    "Terminal log line exceeds 1 MiB safety limit",
                ));
            }
        }
        if finishing && !self.line.is_empty() {
            file.write_all(&self.redactor.feed(self.line.as_bytes()))?;
            self.line.clear();
        }
        file.flush()
    }
}

fn write_log(
    mut file: File,
    receiver: mpsc::Receiver<Vec<u8>>,
    redactor: Redactor,
    status: Arc<Mutex<TerminalLogStatus>>,
    sink: StatusSink,
) {
    let mut text = PlainText {
        stripper: AnsiStripper::default(),
        utf8: Vec::new(),
        line: String::new(),
        after_cr: false,
        redactor,
    };
    let result = (|| {
        for bytes in receiver {
            text.feed(&bytes, false, &mut file)?;
        }
        text.feed(&[], true, &mut file)
    })();
    // A writer failure still attempts to flush already accepted file writes.
    let flush = file.flush();
    drop(file);
    let finished = {
        let mut status = status.lock();
        status.active = false;
        if let Err(error) = result.and(flush) {
            status.error = Some(format!("Terminal logging failed: {error}"));
        }
        status.clone()
    };
    sink(finished);
}

#[cfg(test)]
#[path = "terminal_logging_tests.rs"]
mod tests;
