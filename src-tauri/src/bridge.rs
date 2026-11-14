use anyhow::{bail, Context, Result};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

static REQ_SEQ: AtomicU64 = AtomicU64::new(1);

/// Build the `Stdio` for the sidecar's stderr. Previously inherited, which sent
/// Python tracebacks to the app's own stderr where they were lost (not written
/// to any log file). Agent/provider failures surface to the UI as a one-line
/// `DeepAgents runtime error: <Type>: <msg>` with no stack, making them
/// undiagnosable after the fact. Redirect to an append-mode `sidecar-stderr.log`
/// beside the other logs so the full traceback is retained. Falls back to
/// `inherit` if the file can't be opened (never blocks a spawn).
fn sidecar_stderr_stdio() -> Stdio {
    let path = crate::logging::default_log_dir().join("sidecar-stderr.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(f) => Stdio::from(f),
        Err(e) => {
            tracing::warn!(error = %e, path = %path.display(), "sidecar stderr log unavailable; inheriting");
            Stdio::inherit()
        }
    }
}

pub struct SidecarHandle {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl SidecarHandle {
    pub fn spawn(program: &str, args: &[String]) -> Result<Self> {
        let mut child = Command::new(program)
            .args(args)
            // Unbuffered: stderr is now redirected to a FILE (see
            // sidecar_stderr_stdio), and Python block-buffers stderr to a
            // non-tty. Without this a crash traceback can sit unflushed and
            // never reach the log. Harmless for stdout NDJSON (already flushed).
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("CCIE_LOG_DIR", crate::logging::default_log_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(sidecar_stderr_stdio())
            .spawn()
            .with_context(|| format!("spawn sidecar {program}"))?;
        let stdin = child.stdin.take().context("capture stdin")?;
        let stdout = BufReader::new(child.stdout.take().context("capture stdout")?);
        Ok(Self {
            child,
            stdin,
            stdout,
        })
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = REQ_SEQ.fetch_add(1, Ordering::Relaxed).to_string();
        let req = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.flush()?;

        // Loop reading lines until we get a response (not a heartbeat)
        loop {
            let mut resp_line = String::new();
            let n = self.stdout.read_line(&mut resp_line)?;
            if n == 0 {
                bail!("sidecar closed stdout");
            }
            let resp: Value = serde_json::from_str(resp_line.trim())?;

            // Skip heartbeat messages
            if resp.get("type").and_then(|v| v.as_str()) == Some("sidecar.heartbeat") {
                continue;
            }

            // Return actual response (done or error)
            return Ok(resp);
        }
    }

    /// Call a streaming method - reads multiple lines until "done" or "error".
    /// Token-only callback (backwards-compatible). Non-token events (tool_call, etc.) are dropped.
    pub fn call_streaming<F>(
        &mut self,
        method: &str,
        params: Value,
        mut on_token: F,
    ) -> Result<Value>
    where
        F: FnMut(String) -> Result<()>,
    {
        self.call_streaming_ex(method, params, |ev| {
            if ev.get("type").and_then(|v| v.as_str()) == Some("token") {
                if let Some(data) = ev.get("data").and_then(|v| v.as_str()) {
                    on_token(data.to_string())?;
                }
            }
            Ok(())
        })
    }

    /// Call a streaming method, surfacing every event (token, tool_call, custom types) to the callback.
    /// "done" / "error" still terminate the loop (done = Ok(result), error = bail).
    pub fn call_streaming_ex<F>(
        &mut self,
        method: &str,
        params: Value,
        mut on_event: F,
    ) -> Result<Value>
    where
        F: FnMut(&Value) -> Result<()>,
    {
        let id = REQ_SEQ.fetch_add(1, Ordering::Relaxed).to_string();
        let req = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.flush()?;

        loop {
            let mut resp_line = String::new();
            let n = self.stdout.read_line(&mut resp_line)?;
            if n == 0 {
                bail!("sidecar closed stdout");
            }
            let resp: Value = serde_json::from_str(resp_line.trim())?;
            let resp_type = resp.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match resp_type {
                "done" => {
                    return Ok(resp.get("result").cloned().unwrap_or(Value::Null));
                }
                "error" => {
                    let msg = resp
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown error");
                    bail!("sidecar error: {msg}");
                }
                _ => {
                    on_event(&resp)?;
                }
            }
        }
    }

    pub fn shutdown(mut self) {
        drop(self.stdin);
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------
// Persistent supervisor — one long-lived child process, requests multiplexed
// by `id`. Replaces the fresh-spawn-per-call model used by `AgentBridge` prior
// to Plan 00 / Phase 3 / Task 3.0.
// ---------------------------------------------------------------------------

/// Error kind returned by `SidecarSupervisor::call_typed`. Keeps sidecar-
/// reported errors (NDJSON `{"type":"error","message":...}`) distinct from
/// infrastructure problems (spawn failures, writes, channel close) so
/// callers don't need to string-match on `anyhow::Error` messages.
#[derive(Debug)]
pub enum SupervisorError {
    /// The sidecar returned a structured error response.
    Sidecar(String),
    /// Spawning, I/O, or channel-level failure.
    Infra(anyhow::Error),
}

impl std::fmt::Display for SupervisorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SupervisorError::Sidecar(msg) => write!(f, "sidecar error: {msg}"),
            SupervisorError::Infra(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for SupervisorError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SupervisorError::Sidecar(_) => None,
            SupervisorError::Infra(e) => e.source(),
        }
    }
}

/// Event dispatched to a waiting caller. `Terminal` ends the subscription.
#[derive(Debug, Clone)]
pub enum SupervisorEvent {
    /// Non-terminal event (token, progress, etc.).
    Intermediate(Value),
    /// Terminal `done` event; carries the `result` field (null if absent).
    Done(Value),
    /// Terminal `error` event; carries the `message` string.
    Error(String),
    /// Reader thread or child process died; all pending callers drain with this.
    Disconnected(String),
}

enum WaitAuthority {
    Owned,
    Reaped(std::process::ExitStatus),
    Lost,
}

struct OwnedChild {
    child: Child,
    authority: WaitAuthority,
    #[cfg(test)]
    wait_script: std::collections::VecDeque<Option<i32>>,
    #[cfg(test)]
    wait_calls: usize,
    #[cfg(test)]
    signal_calls: usize,
    #[cfg(test)]
    kill_error: Option<i32>,
}

impl OwnedChild {
    fn new(child: Child) -> Self {
        Self {
            child,
            authority: WaitAuthority::Owned,
            #[cfg(test)]
            wait_script: std::collections::VecDeque::new(),
            #[cfg(test)]
            wait_calls: 0,
            #[cfg(test)]
            signal_calls: 0,
            #[cfg(test)]
            kill_error: None,
        }
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        match self.authority {
            WaitAuthority::Lost => {
                return Err(std::io::Error::other(
                    "Sidecar wait authority lost; cleanup unresolved",
                ))
            }
            WaitAuthority::Reaped(status) => return Ok(Some(status)),
            WaitAuthority::Owned => {}
        }
        #[cfg(test)]
        let result = {
            self.wait_calls += 1;
            match self.wait_script.pop_front() {
                Some(Some(code)) => Err(std::io::Error::from_raw_os_error(code)),
                Some(None) => Ok(None),
                None => self.child.try_wait(),
            }
        };
        #[cfg(not(test))]
        let result = self.child.try_wait();
        // All access is under Inner.child's lock, including signal dispatch.
        // Conservatively retire authority on ANY wait error, not just ECHILD:
        // retaining Child does not justify trying a possibly reused PID later.
        // This transition is permanent, even if the process subsequently exits.
        match &result {
            Ok(Some(status)) => self.authority = WaitAuthority::Reaped(*status),
            Err(_) => self.authority = WaitAuthority::Lost,
            Ok(None) => {}
        }
        result
    }

    fn kill(&mut self) -> std::io::Result<()> {
        match self.authority {
            WaitAuthority::Lost => {
                return Err(std::io::Error::other(
                    "Sidecar wait authority lost; signal forbidden",
                ))
            }
            WaitAuthority::Reaped(_) => return Ok(()),
            WaitAuthority::Owned => {}
        }
        #[cfg(test)]
        {
            self.signal_calls += 1;
            match self.kill_error {
                Some(0) => return Ok(()), // Inert fixture: no signal delivery.
                Some(code) => return Err(std::io::Error::from_raw_os_error(code)),
                None => {}
            }
        }
        self.child.kill()
    }

    #[cfg(all(test, unix))]
    fn id(&self) -> u32 {
        self.child.id()
    }
}

/// Process termination and response routing never wait behind a pipe writer.
struct Inner {
    child: Mutex<OwnedChild>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, mpsc::Sender<SupervisorEvent>>>,
    stopped: AtomicBool,
}

impl Inner {
    fn stop(&self) -> Result<()> {
        // Revocation is not exit confirmation. Wake callers even when termination
        // fails; the supervisor (or retained registry) still owns the actual Child.
        self.stopped.store(true, Ordering::Release);
        for (_, sender) in self.pending.lock().drain() {
            let _ = sender.send(SupervisorEvent::Disconnected("sidecar stopping".into()));
        }
        let mut child = self
            .child
            .try_lock_for(std::time::Duration::from_millis(100))
            .context("Sidecar stop busy; cleanup remains owned, retry shutdown")?;
        // OwnedChild caches confirmed reap and permanently retires wait/signal
        // authority after a wait error, across every stop and liveness attempt.
        if child
            .try_wait()
            .context("Sidecar reap failed; cleanup remains owned")?
            .is_some()
        {
            return Ok(());
        }
        let signal = child.kill();
        if let Err(error) = signal {
            if child.try_wait()?.is_some() {
                return Ok(());
            }
            return Err(error)
                .context("Sidecar signal failed; cleanup remains owned, retry shutdown");
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
        loop {
            if child
                .try_wait()
                .context("Sidecar reap failed; cleanup remains owned")?
                .is_some()
            {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                bail!("Sidecar reap deadline exceeded; cleanup remains owned, retry shutdown");
            }
            thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    fn write(self: &Arc<Self>, line: String) -> Result<()> {
        if self.stopped.load(Ordering::Acquire) {
            bail!("Sidecar stopped; cleanup remains owned until reaped");
        }
        let mut pipe = self.stdin.lock();
        if self.stopped.load(Ordering::Acquire) {
            bail!("Sidecar stopped");
        }
        let stdin = pipe.as_mut().context("Missing sidecar stdin")?;
        stdin.write_all(line.as_bytes())?;
        stdin.flush()?;
        Ok(())
    }
}

/// Heartbeat payload mirrored from the sidecar's `sidecar.heartbeat` NDJSON
/// message. Consumed by the status-footer pipeline (Plan 00 / Task 3.3).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct HeartbeatPayload {
    pub version: String,
    pub pid: i64,
    pub uptime_s: i64,
}

type HeartbeatSink = Arc<dyn Fn(HeartbeatPayload) + Send + Sync>;

/// Long-lived sidecar process manager. One reader thread demuxes stdout lines
/// back to waiting callers by request `id`. Call `call` / `call_stream_ex`
/// concurrently from any number of tasks.
pub struct SidecarSupervisor {
    program: String,
    args: Vec<String>,
    /// `None` until the first call spawns the child. Wrapped in Mutex so that
    /// if the child dies we can re-establish a fresh Inner on the next call.
    inner: Mutex<Option<Arc<Inner>>>,
    closed: AtomicBool,
    /// Optional heartbeat receiver; invoked from the reader thread whenever a
    /// `sidecar.heartbeat` NDJSON line is seen. Set via `set_heartbeat_sink`.
    /// Shared via Arc so late installs after the reader thread is already
    /// running still take effect.
    heartbeat_sink: Arc<Mutex<Option<HeartbeatSink>>>,
}

impl SidecarSupervisor {
    pub fn new(program: String, args: Vec<String>) -> Self {
        Self {
            program,
            args,
            inner: Mutex::new(None),
            closed: AtomicBool::new(false),
            heartbeat_sink: Arc::new(Mutex::new(None)),
        }
    }

    /// Install a callback that receives every sidecar heartbeat. Replaces any
    /// previously installed sink. The callback runs on the reader thread — it
    /// should be cheap and non-blocking (e.g. push into a queue or do a
    /// single DB UPDATE).
    pub fn set_heartbeat_sink<F>(&self, sink: F)
    where
        F: Fn(HeartbeatPayload) + Send + Sync + 'static,
    {
        *self.heartbeat_sink.lock() = Some(Arc::new(sink));
    }

    /// Lazily spawn the child and start its reader thread. Returns the shared
    /// Inner handle. If a previous child died, a fresh one is started.
    fn get_or_spawn(&self) -> Result<Arc<Inner>> {
        let mut slot = self.inner.lock();
        if self.closed.load(Ordering::Acquire) {
            bail!("Private sidecar ownership revoked");
        }
        if let Some(existing) = slot.as_ref() {
            if !existing.stopped.load(Ordering::Acquire)
                && existing.child.lock().try_wait()?.is_none()
            {
                return Ok(existing.clone());
            }
            // A revoked or uncertain owner cannot be reused or replaced until
            // its actual child is confirmed reaped. Wait errors retain the slot.
            existing.stop()?;
            *slot = None;
        }

        let mut child = Command::new(&self.program)
            .args(&self.args)
            // Normal-agent diagnostics keep their existing file destination.
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("CCIE_LOG_DIR", crate::logging::default_log_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(sidecar_stderr_stdio())
            .spawn()
            .with_context(|| format!("spawn sidecar {}", self.program))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();

        let inner = Arc::new(Inner {
            child: Mutex::new(OwnedChild::new(child)),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            stopped: AtomicBool::new(false),
        });

        // Register ownership before fallible pipe/thread setup. Failure cannot
        // discard the only retry authority for an already spawned child.
        *slot = Some(inner.clone());
        let stdout = stdout.with_context(|| {
            inner.stopped.store(true, Ordering::Release);
            "capture stdout"
        })?;
        if inner.stdin.lock().is_none() {
            inner.stopped.store(true, Ordering::Release);
            bail!("capture stdin");
        }
        // Reader thread: parse lines, route by id. Exits when stdout closes.
        let reader_inner = inner.clone();
        let heartbeat_sink_handle = self.heartbeat_sink.clone();
        thread::Builder::new()
            .name("ccie-sidecar-reader".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut buf = String::new();
                loop {
                    buf.clear();
                    match reader.read_line(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let line = buf.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let resp: Value = match serde_json::from_str(line) {
                        Ok(v) => v,
                        Err(e) => {
                            tracing::warn!(error = %e, line = %line, "supervisor: bad json from sidecar");
                            continue;
                        }
                    };
                    let id = resp
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let resp_type = resp
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    // Heartbeats have id="" and go to the dedicated sink,
                    // not the pending-request map. Re-read the sink every time
                    // so late installs take effect.
                    if resp_type == "sidecar.heartbeat" {
                        let sink = heartbeat_sink_handle.lock().clone();
                        if let Some(sink) = sink {
                            if let Some(payload) = resp.get("payload") {
                                match serde_json::from_value::<HeartbeatPayload>(payload.clone()) {
                                    Ok(hb) => (sink)(hb),
                                    Err(e) => tracing::warn!(error = %e, "supervisor: malformed heartbeat"),
                                }
                            }
                        }
                        continue;
                    }

                    if id.is_empty() {
                        tracing::warn!(line = %line, "supervisor: response missing id");
                        continue;
                    }

                    let event = match resp_type.as_str() {
                        "done" => SupervisorEvent::Done(resp.get("result").cloned().unwrap_or(Value::Null)),
                        "error" => SupervisorEvent::Error(
                            resp.get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown error")
                                .to_string(),
                        ),
                        _ => SupervisorEvent::Intermediate(resp),
                    };
                    let terminal =
                        matches!(event, SupervisorEvent::Done(_) | SupervisorEvent::Error(_));

                    let sender_opt = {
                        let mut pending = reader_inner.pending.lock();
                        if terminal {
                            pending.remove(&id)
                        } else {
                            pending.get(&id).cloned()
                        }
                    };
                    if let Some(tx) = sender_opt {
                        let _ = tx.send(event);
                    } else {
                        tracing::warn!(id = %id, "supervisor: response for unknown id");
                    }
                }
                // Reader exiting: drain pending senders with Disconnected.
                let drained: Vec<_> = {
                    reader_inner.pending.lock().drain().collect()
                };
                for (_id, tx) in drained {
                    let _ = tx.send(SupervisorEvent::Disconnected(
                        "sidecar stdout closed".into(),
                    ));
                }
            })
            .inspect_err(|_| inner.stopped.store(true, Ordering::Release))
            .context("spawn supervisor reader thread")?;
        Ok(inner)
    }

    /// Blocking call. Sends one request and waits for the terminal event.
    pub fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.call_stream_ex(method, params, |_| Ok(()))
    }

    /// Variant of `call` that distinguishes sidecar-reported errors (the
    /// sidecar's NDJSON `{"type":"error","message":...}` response) from
    /// infrastructure failures (spawn/write/disconnect). Callers that need
    /// to surface sidecar-reported errors as user-visible messages without
    /// tearing down the whole operation should use this instead of matching
    /// on error-string prefixes.
    pub fn call_typed(
        &self,
        method: &str,
        params: Value,
    ) -> std::result::Result<Value, SupervisorError> {
        self.call_stream_ex_typed(method, params, |_| Ok(()))
    }

    pub fn call_typed_with_idle_timeout(
        &self,
        method: &str,
        params: Value,
        idle_timeout: std::time::Duration,
    ) -> std::result::Result<Value, SupervisorError> {
        self.call_stream_ex_typed_with_idle_timeout(method, params, idle_timeout, |_| Ok(()))
    }

    fn call_stream_ex_typed<F>(
        &self,
        method: &str,
        params: Value,
        on_event: F,
    ) -> std::result::Result<Value, SupervisorError>
    where
        F: FnMut(&Value) -> Result<()>,
    {
        self.call_stream_ex_typed_with_idle_timeout(
            method,
            params,
            std::time::Duration::from_secs(720),
            on_event,
        )
    }

    fn call_stream_ex_typed_with_idle_timeout<F>(
        &self,
        method: &str,
        params: Value,
        idle_timeout: std::time::Duration,
        mut on_event: F,
    ) -> std::result::Result<Value, SupervisorError>
    where
        F: FnMut(&Value) -> Result<()>,
    {
        let inner = self.get_or_spawn().map_err(SupervisorError::Infra)?;
        self.call_on_inner(inner, method, params, &mut on_event, idle_timeout)
    }

    fn call_on_inner<F>(
        &self,
        inner: Arc<Inner>,
        method: &str,
        params: Value,
        mut on_event: F,
        idle_timeout: std::time::Duration,
    ) -> std::result::Result<Value, SupervisorError>
    where
        F: FnMut(&Value) -> Result<()>,
    {
        let id = REQ_SEQ.fetch_add(1, Ordering::Relaxed).to_string();
        let req = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&req).map_err(|e| SupervisorError::Infra(e.into()))?;
        line.push('\n');
        let (tx, rx) = mpsc::channel::<SupervisorEvent>();

        inner.pending.lock().insert(id.clone(), tx);
        if let Err(error) = inner.write(line) {
            inner.pending.lock().remove(&id);
            return Err(SupervisorError::Infra(error));
        }

        // Idle timeout between events. We reset the clock on every event
        // (including intermediate stream tokens), so a long-but-progressing
        // call is fine — this only fires when the sidecar goes completely
        // silent (e.g. a request was orphaned by a mid-flight restart, or a
        // provider HTTP call wedged below its own timeout). Without this,
        // `recv()` blocks forever and the UI spins indefinitely.
        //
        // MUST sit ABOVE the longest legitimate blocking call. The worst case
        // is `heartbeat.execute_check`, a SINGLE blocking RPC that emits NO
        // intermediate events for its entire run (it collects events internally
        // and returns one result), so the idle clock counts down uninterrupted.
        // Its budget is 540s in Python (AGENT_TIMEOUT_SECONDS) under a 600s Rust
        // outer cap (heartbeat/runner.rs). A 240s idle guard fired BELOW those
        // and killed slow-but-healthy checks as "Agent call failed"; measured, a
        // full org-wide Meraki check needs ~8 LLM steps at 40-70s each on hosted
        // gpt-oss-120b (~312s to the grader). Set the guard above the 600s cap so
        // those inner layers return their own clean timeout first, while a
        // genuinely wedged sidecar is still caught (just later). Shorter-lived
        // callers can pass a smaller timeout through the helper above.
        loop {
            match rx.recv_timeout(idle_timeout) {
                Ok(SupervisorEvent::Intermediate(v)) => {
                    on_event(&v).map_err(SupervisorError::Infra)?
                }
                Ok(SupervisorEvent::Done(result)) => return Ok(result),
                Ok(SupervisorEvent::Error(msg)) => return Err(SupervisorError::Sidecar(msg)),
                Ok(SupervisorEvent::Disconnected(msg)) => {
                    return Err(SupervisorError::Infra(anyhow::anyhow!(
                        "sidecar disconnected: {msg}"
                    )));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // Drop the orphaned pending entry so a late response
                    // doesn't get misrouted, then surface a clear error.
                    inner.pending.lock().remove(&id);
                    return Err(SupervisorError::Infra(anyhow::anyhow!(
                        "sidecar call '{method}' timed out after {}s with no response",
                        idle_timeout.as_secs()
                    )));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(SupervisorError::Infra(anyhow::anyhow!(
                        "sidecar channel closed"
                    )));
                }
            }
        }
    }

    /// Streaming call. Every intermediate event is forwarded to `on_event`.
    /// Returns the `result` payload from the terminal `done`, or `Err` on `error`.
    pub fn call_stream_ex<F>(&self, method: &str, params: Value, mut on_event: F) -> Result<Value>
    where
        F: FnMut(&Value) -> Result<()>,
    {
        let inner = self.get_or_spawn()?;
        let id = REQ_SEQ.fetch_add(1, Ordering::Relaxed).to_string();
        let req = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        // Serialize BEFORE acquiring the lock / inserting the pending sender,
        // so a serialization failure can't leak an entry into `pending`.
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        let (tx, rx) = mpsc::channel::<SupervisorEvent>();

        // Register before writing; the response cannot precede its pending slot.
        inner.pending.lock().insert(id.clone(), tx);
        if let Err(error) = inner.write(line) {
            inner.pending.lock().remove(&id);
            return Err(error);
        }

        loop {
            match rx.recv() {
                Ok(SupervisorEvent::Intermediate(v)) => on_event(&v)?,
                Ok(SupervisorEvent::Done(result)) => return Ok(result),
                Ok(SupervisorEvent::Error(msg)) => bail!("sidecar error: {msg}"),
                Ok(SupervisorEvent::Disconnected(msg)) => bail!("sidecar disconnected: {msg}"),
                Err(_) => bail!("sidecar channel closed"),
            }
        }
    }

    /// Permanently seal a private owner before stopping. Ordinary agent shutdown
    /// remains restartable; late private run/control races cannot spawn again.
    pub fn shutdown_permanently(&self) {
        if let Err(error) = self.try_shutdown_permanently() {
            tracing::error!(%error, "Private sidecar stop unconfirmed");
        }
    }

    pub fn try_shutdown_permanently(&self) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        self.try_shutdown()
    }

    /// Compatibility API for void callers; failures remain owned and logged.
    /// Callers that decide success/restart must use try_shutdown instead.
    pub fn shutdown(&self) {
        if let Err(error) = self.try_shutdown() {
            tracing::error!(%error, "Sidecar stop unconfirmed");
        }
    }

    pub fn try_shutdown(&self) -> Result<()> {
        let mut slot = self.inner.lock();
        if let Some(inner) = slot.as_ref() {
            inner.stop()?;
            *slot = None;
        }
        Ok(())
    }
}

// Last-owner failure retains actual Children, never PID-only signal authority.
// Synchronous retries only; process-local retention is not an app-exit guarantee.
static RETAINED_SIDECARS: Mutex<Vec<Arc<Inner>>> = Mutex::new(Vec::new());
#[cfg(all(test, unix))]
pub(crate) fn retry_retained_sidecars() -> Result<()> {
    let owners = RETAINED_SIDECARS.lock().clone();
    let mut failure = None;
    for inner in owners {
        if let Err(error) = inner.stop() {
            failure.get_or_insert(error);
        } else {
            RETAINED_SIDECARS
                .lock()
                .retain(|owner| !Arc::ptr_eq(owner, &inner));
        }
    }
    failure.map_or(Ok(()), Err)
}

impl Drop for SidecarSupervisor {
    fn drop(&mut self) {
        if let Err(error) = self.try_shutdown_permanently() {
            tracing::error!(%error, "Sidecar stop unconfirmed; retaining cleanup ownership");
            if let Some(inner) = self.inner.get_mut().take() {
                RETAINED_SIDECARS.lock().push(inner);
            }
        }
    }
}

#[cfg(all(test, unix))]
pub(crate) mod stop_tests {
    use super::*;
    use std::time::{Duration, Instant};

    pub(crate) static FIXTURES: Mutex<()> = Mutex::new(());

    fn fixture(seconds: &str, signal: i32) -> (SidecarSupervisor, Arc<Inner>) {
        // Finite child is an independent hard guard even against the old blocking wait.
        let mut child = Command::new("/bin/sleep")
            .arg(seconds)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let inner = Arc::new(Inner {
            child: Mutex::new(OwnedChild::new(child)),
            stdin: Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            stopped: AtomicBool::new(false),
        });
        inner.child.lock().kill_error = Some(signal);
        let supervisor = SidecarSupervisor::new("/not/a/program".into(), vec![]);
        *supervisor.inner.lock() = Some(inner.clone());
        (supervisor, inner)
    }

    fn cleanup(inner: &Inner) {
        // The inert seam never removed this fixture's real wait authority.
        // Cleanup owns the actual Child independently of production test state;
        // never clear a lost-authority latch to make a test pass.
        let mut owned = inner.child.lock();
        owned.kill_error = None;
        let child = &mut owned.child;
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        child.wait().unwrap();
    }

    #[test]
    fn bridge_wait_authority_loss_is_sticky_at_every_wait_site() {
        let _exclusive = FIXTURES.lock();
        let mut observations = Vec::new();
        for code in [libc::ECHILD, libc::EIO] {
            for site in [
                "initial stop",
                "signal reconciliation",
                "reap polling",
                "spawn liveness",
            ] {
                let signal = if site == "signal reconciliation" {
                    libc::EPERM
                } else {
                    0
                };
                let (supervisor, inner) = fixture("0.65", signal);
                let pid = inner.child.lock().id();
                {
                    let mut child = inner.child.lock();
                    if matches!(site, "signal reconciliation" | "reap polling") {
                        child.wait_script.push_back(None);
                    }
                    child.wait_script.extend([Some(code), None]);
                }
                let first_failed = match site {
                    "spawn liveness" => supervisor.get_or_spawn().is_err(),
                    _ => inner.stop().is_err(),
                };
                let counts = {
                    let child = inner.child.lock();
                    (child.wait_calls, child.signal_calls)
                };
                // A later inert benign outcome must never reach the underlying
                // wait or restore authority. Gate further calls on this check so
                // the unfixed RED cannot fall through into a real replacement.
                let retry_failed = inner.child.lock().try_wait().is_err();
                let signal_forbidden = inner.child.lock().kill().is_err();
                let unchanged = {
                    let child = inner.child.lock();
                    (child.wait_calls, child.signal_calls) == counts
                };
                let (blocked, retained) = if retry_failed && unchanged {
                    let blocked = supervisor.get_or_spawn().is_err()
                        && supervisor.try_shutdown().is_err()
                        && supervisor.try_shutdown_permanently().is_err();
                    drop(supervisor);
                    let retained = RETAINED_SIDECARS
                        .lock()
                        .iter()
                        .any(|owner| Arc::ptr_eq(owner, &inner));
                    (blocked && retry_retained_sidecars().is_err(), retained)
                } else {
                    drop(supervisor);
                    (false, false)
                };
                // This synthetic error did not revoke the fixture's genuine
                // Child authority. Independently reap without clearing lost state.
                cleanup(&inner);
                let still_failed_after_fixture_reap = inner.stop().is_err();
                let final_counts = {
                    let child = inner.child.lock();
                    (child.wait_calls, child.signal_calls)
                };
                // Remove only our now physically reaped fixture from the test
                // registry. Production never retires an authority-lost owner.
                RETAINED_SIDECARS
                    .lock()
                    .retain(|owner| !Arc::ptr_eq(owner, &inner));
                println!("bridge-authority-loss site={site} error={code} pid={pid} first_failed={first_failed} retry_failed={retry_failed} counts={counts:?}->{final_counts:?} retained={retained}; independent exact child reaped");
                observations.push((
                    site,
                    code,
                    first_failed
                        && retry_failed
                        && signal_forbidden
                        && unchanged
                        && blocked
                        && retained
                        && still_failed_after_fixture_reap
                        && counts == final_counts,
                ));
            }
        }
        for (site, code, passed) in observations {
            assert!(
                passed,
                "{site}/{code}: lost wait authority must remain sticky across all later attempts"
            );
        }
    }

    #[test]
    fn bridge_confirmed_reap_is_cached_before_later_wait_or_signal() {
        let _exclusive = FIXTURES.lock();
        let (_supervisor, inner) = fixture("0.65", 0);
        let pid = inner.child.lock().id();
        cleanup(&inner);
        let mut child = inner.child.lock();
        let confirmed = child.try_wait().unwrap();
        let counts = (child.wait_calls, child.signal_calls);
        child.wait_script.push_back(Some(libc::ECHILD));
        let cached = child.try_wait();
        let signal = child.kill();
        let final_counts = (child.wait_calls, child.signal_calls);
        drop(child);
        println!("bridge-cached-reap pid={pid} counts={counts:?}->{final_counts:?}; exact child already reaped");
        assert!(confirmed.is_some() && cached.is_ok() && signal.is_ok() && counts == final_counts);
    }

    #[test]
    fn bridge_stop_refusal_is_bounded_and_retains_owner() {
        let _exclusive = FIXTURES.lock();
        for permanent in [false, true] {
            let (supervisor, inner) = fixture("0.35", libc::EPERM);
            let pid = inner.child.lock().id();
            let start = Instant::now();
            if permanent {
                supervisor.shutdown_permanently();
            } else {
                supervisor.shutdown();
            }
            let elapsed = start.elapsed();
            let retained = supervisor
                .inner
                .lock()
                .as_ref()
                .is_some_and(|p| Arc::ptr_eq(p, &inner));
            let alive = inner.child.lock().try_wait().unwrap().is_none();
            let failed = supervisor.try_shutdown().is_err();
            let cannot_replace = supervisor.get_or_spawn().is_err();
            cleanup(&inner);
            let retry = supervisor.try_shutdown();
            let removed = supervisor.inner.lock().is_none();
            let sealed = !permanent || supervisor.get_or_spawn().is_err();
            println!("bridge-stop-refusal permanent={permanent} pid={pid} elapsed_ms={} retained={retained} alive={alive}; exact child reaped", elapsed.as_millis());
            assert!(
                elapsed < Duration::from_millis(200)
                    && retained
                    && alive
                    && failed
                    && cannot_replace
            );
            assert!(retry.is_ok() && removed && sealed);
        }
    }

    #[test]
    fn bridge_reap_deadline_retains_owner_and_drains_waiters() {
        let _exclusive = FIXTURES.lock();
        let (supervisor, inner) = fixture("0.65", 0);
        let pid = inner.child.lock().id();
        let (tx, rx) = mpsc::channel();
        inner.pending.lock().insert("waiting".into(), tx);
        let start = Instant::now();
        let result = supervisor.try_shutdown();
        let elapsed = start.elapsed();
        let retained = supervisor.inner.lock().is_some();
        let waiter = matches!(rx.try_recv(), Ok(SupervisorEvent::Disconnected(_)));
        let alive = inner.child.lock().try_wait().unwrap().is_none();
        cleanup(&inner);
        let retry = supervisor.try_shutdown();
        println!("bridge-reap-deadline pid={pid} elapsed_ms={} retained={retained} waiter={waiter} alive={alive}; exact child reaped", elapsed.as_millis());
        assert!(result.is_err() && retained && waiter && alive && retry.is_ok());
        assert!(elapsed < Duration::from_millis(250));
    }

    #[test]
    fn bridge_drop_transfers_actual_owner_for_synchronous_retry() {
        let _exclusive = FIXTURES.lock();
        let (supervisor, inner) = fixture("0.65", libc::EPERM);
        let pid = inner.child.lock().id();
        let start = Instant::now();
        drop(supervisor);
        let elapsed = start.elapsed();
        let retained = RETAINED_SIDECARS
            .lock()
            .iter()
            .any(|p| Arc::ptr_eq(p, &inner));
        let failed_retry = retry_retained_sidecars().is_err();
        let still_retained = RETAINED_SIDECARS
            .lock()
            .iter()
            .any(|p| Arc::ptr_eq(p, &inner));
        cleanup(&inner);
        let retry = retry_retained_sidecars();
        let removed = !RETAINED_SIDECARS
            .lock()
            .iter()
            .any(|p| Arc::ptr_eq(p, &inner));
        println!("bridge-drop-refusal pid={pid} elapsed_ms={} retained={retained} retry_failed={failed_retry} removed_after_reap={removed}; exact child reaped", elapsed.as_millis());
        assert!(elapsed < Duration::from_millis(200) && retained && failed_retry && still_retained);
        assert!(retry.is_ok() && removed);
    }

    #[test]
    fn bridge_stop_busy_is_bounded_and_reaped_child_never_signalled() {
        let _exclusive = FIXTURES.lock();
        let (supervisor, inner) = fixture("0.65", libc::EPERM);
        let held = inner.child.lock();
        let pid = held.id();
        let start = Instant::now();
        let result = supervisor.try_shutdown();
        let elapsed = start.elapsed();
        drop(held);
        cleanup(&inner);
        // A failed signal seam must not run once the retained Child caches exit.
        inner.child.lock().kill_error = Some(libc::EPERM);
        let reaped_stop = supervisor.try_shutdown();
        println!(
            "bridge-stop-busy pid={pid} elapsed_ms={}; exact child reaped",
            elapsed.as_millis()
        );
        assert!(result.is_err() && elapsed < Duration::from_millis(250));
        assert!(reaped_stop.is_ok() && supervisor.inner.lock().is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn supervisor_call_typed_honors_custom_idle_timeout() {
        let supervisor = SidecarSupervisor::new(
            "python3".into(),
            vec![
                "-c".into(),
                "import sys, time\nsys.stdin.readline()\ntime.sleep(10)".into(),
            ],
        );

        let started = Instant::now();
        let err = supervisor
            .call_typed_with_idle_timeout("noop", serde_json::json!({}), Duration::from_millis(50))
            .unwrap_err();

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(err.to_string().contains("timed out"));
    }
}
