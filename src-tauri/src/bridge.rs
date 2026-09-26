use anyhow::{bail, Context, Result};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
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

/// Inner state protected by a single mutex. Keeping stdin + the pending map
/// under one lock keeps send + pending-slot insertion atomic, which avoids a
/// race where the reader thread sees a response before the sender is registered.
struct Inner {
    child: Child,
    stdin: ChildStdin,
    pending: HashMap<String, mpsc::Sender<SupervisorEvent>>,
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
    inner: Mutex<Option<Arc<Mutex<Inner>>>>,
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
    fn get_or_spawn(&self) -> Result<Arc<Mutex<Inner>>> {
        let mut slot = self.inner.lock();
        if let Some(existing) = slot.as_ref() {
            // Still alive? try_wait returns Ok(Some(_)) when process has exited.
            let alive = {
                let mut g = existing.lock();
                matches!(g.child.try_wait(), Ok(None))
            };
            if alive {
                return Ok(existing.clone());
            }
            // Dead — fall through to respawn.
        }

        let mut child = Command::new(&self.program)
            .args(&self.args)
            // Unbuffered: stderr is redirected to a FILE (sidecar_stderr_stdio),
            // and Python block-buffers stderr to a non-tty — without this a
            // crash traceback can sit unflushed and never reach the log.
            .env("PYTHONUNBUFFERED", "1")
            .env("CCIE_LOG_DIR", crate::logging::default_log_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(sidecar_stderr_stdio())
            .spawn()
            .with_context(|| format!("spawn sidecar {}", self.program))?;
        let stdin = child.stdin.take().context("capture stdin")?;
        let stdout = child.stdout.take().context("capture stdout")?;

        let inner = Arc::new(Mutex::new(Inner {
            child,
            stdin,
            pending: HashMap::new(),
        }));

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
                        let mut g = reader_inner.lock();
                        if terminal {
                            g.pending.remove(&id)
                        } else {
                            g.pending.get(&id).cloned()
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
                    let mut g = reader_inner.lock();
                    g.pending.drain().collect()
                };
                for (_id, tx) in drained {
                    let _ = tx.send(SupervisorEvent::Disconnected(
                        "sidecar stdout closed".into(),
                    ));
                }
            })
            .context("spawn supervisor reader thread")?;

        *slot = Some(inner.clone());
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
        self.call_stream_ex_typed_with_idle_timeout(method, params, std::time::Duration::from_secs(720), on_event)
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
        let id = REQ_SEQ.fetch_add(1, Ordering::Relaxed).to_string();
        let req = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&req).map_err(|e| SupervisorError::Infra(e.into()))?;
        line.push('\n');
        let (tx, rx) = mpsc::channel::<SupervisorEvent>();

        {
            let mut g = inner.lock();
            g.pending.insert(id.clone(), tx);
            if let Err(e) = g.stdin.write_all(line.as_bytes()) {
                g.pending.remove(&id);
                return Err(SupervisorError::Infra(anyhow::anyhow!("write stdin: {e}")));
            }
            if let Err(e) = g.stdin.flush() {
                g.pending.remove(&id);
                return Err(SupervisorError::Infra(anyhow::anyhow!("flush stdin: {e}")));
            }
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
                    inner.lock().pending.remove(&id);
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

        // Register sender + write request atomically under the inner lock so a
        // super-fast reader can't observe a response before we've inserted.
        {
            let mut g = inner.lock();
            g.pending.insert(id.clone(), tx);
            if let Err(e) = g.stdin.write_all(line.as_bytes()) {
                g.pending.remove(&id);
                bail!("write to sidecar stdin: {e}");
            }
            if let Err(e) = g.stdin.flush() {
                g.pending.remove(&id);
                bail!("flush sidecar stdin: {e}");
            }
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

    /// Request a graceful shutdown. Closes stdin, waits for the child briefly.
    pub fn shutdown(&self) {
        let mut slot = self.inner.lock();
        if let Some(inner) = slot.take() {
            let mut g = inner.lock();
            // Drop stdin by replacing with a null sink is not trivial; instead
            // we kill the child, which will end the reader thread cleanly.
            let _ = g.child.kill();
            let _ = g.child.wait();
        }
    }
}

impl Drop for SidecarSupervisor {
    fn drop(&mut self) {
        self.shutdown();
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
