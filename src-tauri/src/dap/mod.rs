//! Debug Adapter Protocol (DAP) client and supervised Python debug sessions.
//!
//! Phase 5 keeps one debugpy adapter per editor tab. The adapter is an
//! asynchronous protocol peer: a dedicated reader task routes responses to
//! pending requests while forwarding events to every TerminAI webview.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex, Notify, RwLock};
use tokio::time::timeout;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

pub const DAP_EVENT: &str = "dap://event";
pub const DAP_BREAKPOINTS_CHANGED_EVENT: &str = "dap://breakpoints-changed";

pub type DapEventSink = Arc<dyn Fn(DapEventEnvelope) + Send + Sync + 'static>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapEventEnvelope {
    pub session_id: String,
    pub tab_id: String,
    pub event: String,
    pub body: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapSessionInfo {
    pub session_id: String,
    pub tab_id: String,
    pub workspace_root: String,
    pub program: String,
    pub interpreter: String,
    pub adapter_name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DapBreakpoint {
    pub id: Option<i64>,
    pub line: i64,
    pub verified: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapBreakpointSet {
    pub tab_id: String,
    pub file_path: String,
    pub breakpoints: Vec<DapBreakpoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapAvailability {
    pub available: bool,
    pub adapter_python: String,
    pub interpreter: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DapLaunchConfig {
    pub tab_id: String,
    pub workspace_root: String,
    pub program: String,
    pub interpreter: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub stop_on_entry: bool,
    pub just_my_code: bool,
}

#[derive(Debug, Clone)]
pub struct DapAdapterConfig {
    pub command: String,
    pub args: Vec<String>,
    pub display_name: String,
}

impl DapAdapterConfig {
    pub fn debugpy() -> Self {
        let (command, _) = crate::commands::sidecar_spawn_target();
        Self {
            command,
            args: vec!["-m".to_string(), "debugpy.adapter".to_string()],
            display_name: "debugpy".to_string(),
        }
    }
}

type PendingResponse = oneshot::Receiver<std::result::Result<Value, String>>;

struct DapSession {
    session_id: String,
    tab_id: String,
    workspace_root: PathBuf,
    program: PathBuf,
    interpreter: PathBuf,
    adapter: DapAdapterConfig,
    launch_config: DapLaunchConfig,
    child: Mutex<Option<Child>>,
    writer: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>,
    next_seq: AtomicU64,
    initialized: AtomicBool,
    initialized_notify: Notify,
    closing: AtomicBool,
    terminal_event_received: AtomicBool,
    transport_closed: AtomicBool,
    status: RwLock<String>,
    capabilities: RwLock<Value>,
    event_sink: DapEventSink,
}

impl DapSession {
    async fn spawn(
        session_id: String,
        launch_config: DapLaunchConfig,
        workspace_root: PathBuf,
        program: PathBuf,
        interpreter: PathBuf,
        adapter: DapAdapterConfig,
        event_sink: DapEventSink,
    ) -> Result<Arc<Self>> {
        tracing::info!(
            session_id,
            tab_id = %launch_config.tab_id,
            adapter = %adapter.display_name,
            command = %adapter.command,
            workspace = %workspace_root.display(),
            program = %program.display(),
            "starting Python debug adapter"
        );

        let mut child = Command::new(&adapter.command)
            .args(&adapter.args)
            .current_dir(&workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("failed to spawn DAP adapter: {}", adapter.command))?;

        let writer = child
            .stdin
            .take()
            .context("failed to capture DAP adapter stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("failed to capture DAP adapter stdout")?;
        if let Some(stderr) = child.stderr.take() {
            let session_for_log = session_id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(
                        session_id = %session_for_log,
                        message = %line,
                        "DAP adapter stderr"
                    );
                }
            });
        }

        let session = Arc::new(Self {
            session_id,
            tab_id: launch_config.tab_id.clone(),
            workspace_root,
            program,
            interpreter,
            adapter,
            launch_config,
            child: Mutex::new(Some(child)),
            writer: Mutex::new(Some(writer)),
            pending: Mutex::new(HashMap::new()),
            next_seq: AtomicU64::new(1),
            initialized: AtomicBool::new(false),
            initialized_notify: Notify::new(),
            closing: AtomicBool::new(false),
            terminal_event_received: AtomicBool::new(false),
            transport_closed: AtomicBool::new(false),
            status: RwLock::new("starting".to_string()),
            capabilities: RwLock::new(Value::Null),
            event_sink,
        });
        Self::start_reader(&session, stdout);
        Ok(session)
    }

    fn start_reader(session: &Arc<Self>, stdout: ChildStdout) {
        let weak: Weak<Self> = Arc::downgrade(session);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let message = match read_message(&mut reader).await {
                    Ok(message) => message,
                    Err(error) => {
                        if let Some(session) = weak.upgrade() {
                            session.handle_transport_closed(error).await;
                        }
                        break;
                    }
                };
                let Some(session) = weak.upgrade() else {
                    break;
                };
                session.handle_message(message).await;
            }
        });
    }

    async fn handle_message(&self, message: Value) {
        match message.get("type").and_then(Value::as_str) {
            Some("response") => self.handle_response(message).await,
            Some("event") => self.handle_event(message).await,
            Some("request") => {
                if let Err(error) = self.reject_reverse_request(&message).await {
                    tracing::warn!(
                        session_id = %self.session_id,
                        %error,
                        "failed to reject unsupported DAP reverse request"
                    );
                }
            }
            message_type => {
                tracing::debug!(
                    session_id = %self.session_id,
                    ?message_type,
                    payload = %message,
                    "ignored unknown DAP message"
                );
            }
        }
    }

    async fn handle_response(&self, message: Value) {
        let Some(request_seq) = message.get("request_seq").and_then(Value::as_u64) else {
            tracing::debug!(
                session_id = %self.session_id,
                payload = %message,
                "ignored DAP response without request_seq"
            );
            return;
        };
        let Some(sender) = self.pending.lock().await.remove(&request_seq) else {
            tracing::debug!(
                session_id = %self.session_id,
                request_seq,
                "ignored stale DAP response"
            );
            return;
        };
        let result = if message
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            Ok(message.get("body").cloned().unwrap_or(Value::Null))
        } else {
            Err(message
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("debug adapter request failed")
                .to_string())
        };
        let _ = sender.send(result);
    }

    async fn handle_event(&self, message: Value) {
        let Some(event) = message.get("event").and_then(Value::as_str) else {
            return;
        };
        let body = message.get("body").cloned().unwrap_or(Value::Null);
        match event {
            "initialized" => {
                self.initialized.store(true, Ordering::Release);
                self.initialized_notify.notify_waiters();
            }
            "stopped" => *self.status.write().await = "paused".to_string(),
            "continued" | "process" => *self.status.write().await = "running".to_string(),
            "exited" | "terminated" => {
                self.terminal_event_received.store(true, Ordering::Release);
                *self.status.write().await = "stopped".to_string();
            }
            _ => {}
        }
        (self.event_sink)(DapEventEnvelope {
            session_id: self.session_id.clone(),
            tab_id: self.tab_id.clone(),
            event: event.to_string(),
            body,
        });
    }

    async fn reject_reverse_request(&self, request: &Value) -> Result<()> {
        let request_seq = request
            .get("seq")
            .and_then(Value::as_u64)
            .context("DAP reverse request missing seq")?;
        let command = request
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        self.write_raw(&json!({
            "seq": self.next_sequence(),
            "type": "response",
            "request_seq": request_seq,
            "success": false,
            "command": command,
            "message": format!("TerminAI does not support DAP reverse request: {command}"),
        }))
        .await
    }

    async fn handle_transport_closed(&self, error: anyhow::Error) {
        if self.transport_closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.initialized_notify.notify_waiters();
        let message = error.to_string();
        let pending = {
            let mut pending = self.pending.lock().await;
            std::mem::take(&mut *pending)
        };
        for (_, sender) in pending {
            let _ = sender.send(Err(format!("DAP transport closed: {message}")));
        }
        if !self.closing.load(Ordering::Acquire)
            && !self.terminal_event_received.load(Ordering::Acquire)
        {
            *self.status.write().await = "error".to_string();
            (self.event_sink)(DapEventEnvelope {
                session_id: self.session_id.clone(),
                tab_id: self.tab_id.clone(),
                event: "adapterError".to_string(),
                body: json!({ "message": message }),
            });
        }
    }

    fn next_sequence(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::Relaxed)
    }

    async fn begin_request(
        &self,
        command: &str,
        arguments: Value,
    ) -> Result<(u64, PendingResponse)> {
        if self.transport_closed.load(Ordering::Acquire) {
            bail!("DAP adapter transport is closed");
        }
        let seq = self.next_sequence();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(seq, sender);
        let message = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        if let Err(error) = self.write_raw(&message).await {
            self.pending.lock().await.remove(&seq);
            return Err(error);
        }
        Ok((seq, receiver))
    }

    async fn finish_request(
        &self,
        seq: u64,
        command: &str,
        receiver: PendingResponse,
        request_timeout: Duration,
    ) -> Result<Value> {
        match timeout(request_timeout, receiver).await {
            Ok(Ok(Ok(body))) => Ok(body),
            Ok(Ok(Err(message))) => bail!("debug adapter {command} failed: {message}"),
            Ok(Err(_)) => bail!("debug adapter {command} response channel closed"),
            Err(_) => {
                self.pending.lock().await.remove(&seq);
                bail!(
                    "DAP request timed out after {}s: {command}",
                    request_timeout.as_secs()
                )
            }
        }
    }

    async fn request_with_timeout(
        &self,
        command: &str,
        arguments: Value,
        request_timeout: Duration,
    ) -> Result<Value> {
        let (seq, receiver) = self.begin_request(command, arguments).await?;
        self.finish_request(seq, command, receiver, request_timeout)
            .await
    }

    async fn request(&self, command: &str, arguments: Value) -> Result<Value> {
        self.request_with_timeout(command, arguments, REQUEST_TIMEOUT)
            .await
    }

    async fn write_raw(&self, message: &Value) -> Result<()> {
        let mut writer = self.writer.lock().await;
        let writer = writer
            .as_mut()
            .context("DAP adapter stdin is unavailable")?;
        write_message(writer, message).await
    }

    async fn wait_for_initialized(&self) -> Result<()> {
        if self.initialized.load(Ordering::Acquire) {
            return Ok(());
        }
        timeout(LAUNCH_TIMEOUT, async {
            loop {
                if self.closing.load(Ordering::Acquire)
                    || self.transport_closed.load(Ordering::Acquire)
                {
                    bail!("debug adapter stopped before initialization");
                }
                let notified = self.initialized_notify.notified();
                if self.initialized.load(Ordering::Acquire) {
                    return Ok(());
                }
                notified.await;
                if self.initialized.load(Ordering::Acquire) {
                    return Ok(());
                }
            }
        })
        .await
        .map_err(|_| anyhow!("debug adapter did not emit initialized"))?
    }

    async fn launch(
        &self,
        initial_breakpoints: &[(String, Vec<i64>)],
    ) -> Result<HashMap<String, Vec<DapBreakpoint>>> {
        let capabilities = self
            .request(
                "initialize",
                json!({
                    "clientID": "terminai",
                    "clientName": "TerminAI",
                    "adapterID": "python",
                    "locale": "en-US",
                    "linesStartAt1": true,
                    "columnsStartAt1": true,
                    "pathFormat": "path",
                    "supportsVariableType": true,
                    "supportsVariablePaging": true,
                    "supportsRunInTerminalRequest": false,
                    "supportsProgressReporting": false,
                    "supportsInvalidatedEvent": true,
                    "supportsMemoryReferences": false,
                }),
            )
            .await
            .context("failed to initialize debug adapter")?;
        *self.capabilities.write().await = capabilities;

        let (launch_seq, launch_response) = self
            .begin_request(
                "launch",
                json!({
                    "name": "TerminAI: Current Python File",
                    "type": "python",
                    "request": "launch",
                    "program": self.program.to_string_lossy(),
                    "python": [self.interpreter.to_string_lossy()],
                    "cwd": self.workspace_root.to_string_lossy(),
                    "args": self.launch_config.args,
                    "env": self.launch_config.env,
                    "console": "internalConsole",
                    "redirectOutput": true,
                    "justMyCode": self.launch_config.just_my_code,
                    "stopOnEntry": self.launch_config.stop_on_entry,
                    "subProcess": false,
                }),
            )
            .await
            .context("failed to send debugpy launch request")?;

        self.wait_for_initialized().await?;
        let mut verified = HashMap::new();
        for (path, lines) in initial_breakpoints {
            let breakpoints = self.set_breakpoints(path, lines).await?;
            verified.insert(path.clone(), breakpoints);
        }
        self.request("setExceptionBreakpoints", json!({ "filters": [] }))
            .await
            .context("failed to configure exception breakpoints")?;
        self.request("configurationDone", json!({}))
            .await
            .context("failed to complete DAP configuration")?;
        self.finish_request(launch_seq, "launch", launch_response, LAUNCH_TIMEOUT)
            .await
            .context("debugpy launch failed")?;

        let mut status = self.status.write().await;
        if status.as_str() == "starting" {
            *status = "running".to_string();
        }
        tracing::info!(
            session_id = %self.session_id,
            tab_id = %self.tab_id,
            program = %self.program.display(),
            "Python debug session ready"
        );
        Ok(verified)
    }

    async fn set_breakpoints(&self, file_path: &str, lines: &[i64]) -> Result<Vec<DapBreakpoint>> {
        let body = self
            .request(
                "setBreakpoints",
                json!({
                    "source": {
                        "name": Path::new(file_path)
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("source.py"),
                        "path": file_path,
                    },
                    "breakpoints": lines.iter().map(|line| json!({ "line": line })).collect::<Vec<_>>(),
                    "sourceModified": false,
                }),
            )
            .await?;
        Ok(parse_breakpoint_response(&body, lines))
    }

    async fn info(&self) -> DapSessionInfo {
        DapSessionInfo {
            session_id: self.session_id.clone(),
            tab_id: self.tab_id.clone(),
            workspace_root: self.workspace_root.to_string_lossy().into_owned(),
            program: self.program.to_string_lossy().into_owned(),
            interpreter: self.interpreter.to_string_lossy().into_owned(),
            adapter_name: self.adapter.display_name.clone(),
            status: self.status.read().await.clone(),
        }
    }

    async fn is_running(&self) -> bool {
        let mut child = self.child.lock().await;
        match child.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }

    async fn shutdown(&self) {
        if self.closing.swap(true, Ordering::AcqRel) {
            return;
        }
        self.initialized_notify.notify_waiters();
        if !self.transport_closed.load(Ordering::Acquire) && self.is_running().await {
            let _ = self
                .request_with_timeout(
                    "disconnect",
                    json!({
                        "restart": false,
                        "terminateDebuggee": true,
                        "suspendDebuggee": false,
                    }),
                    SHUTDOWN_TIMEOUT,
                )
                .await;
        }

        self.writer.lock().await.take();
        let mut child_guard = self.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.start_kill();
            }
            let _ = timeout(SHUTDOWN_TIMEOUT, child.wait()).await;
        }
        self.transport_closed.store(true, Ordering::Release);
        *self.status.write().await = "stopped".to_string();
        let pending = {
            let mut pending = self.pending.lock().await;
            std::mem::take(&mut *pending)
        };
        for (_, sender) in pending {
            let _ = sender.send(Err("debug session stopped".to_string()));
        }
        tracing::info!(
            session_id = %self.session_id,
            tab_id = %self.tab_id,
            "Python debug session stopped"
        );
    }
}

#[derive(Default)]
struct DapRegistry {
    sessions: HashMap<String, Arc<DapSession>>,
    tab_sessions: HashMap<String, String>,
    starting_tabs: HashSet<String>,
    starting_sessions: HashMap<String, Arc<DapSession>>,
    breakpoints: HashMap<(String, PathBuf), Vec<DapBreakpoint>>,
}

pub struct DapManager {
    registry: Mutex<DapRegistry>,
}

impl DapManager {
    pub fn new() -> Self {
        Self {
            registry: Mutex::new(DapRegistry::default()),
        }
    }

    pub async fn check_available(&self, workspace_root: &str) -> DapAvailability {
        let adapter = DapAdapterConfig::debugpy();
        let adapter_python = adapter.command.clone();
        let interpreter = resolve_target_python(Path::new(workspace_root), None)
            .ok()
            .map(|path| path.to_string_lossy().into_owned());
        let result = timeout(
            Duration::from_secs(5),
            Command::new(&adapter.command)
                .args(["-c", "import debugpy; print(debugpy.__version__)"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status(),
        )
        .await;
        match result {
            Ok(Ok(status)) if status.success() => DapAvailability {
                available: interpreter.is_some(),
                adapter_python,
                interpreter,
                message: None,
            },
            Ok(Ok(status)) => DapAvailability {
                available: false,
                adapter_python,
                interpreter,
                message: Some(format!("debugpy import exited with {status}")),
            },
            Ok(Err(error)) => DapAvailability {
                available: false,
                adapter_python,
                interpreter,
                message: Some(error.to_string()),
            },
            Err(_) => DapAvailability {
                available: false,
                adapter_python,
                interpreter,
                message: Some("debugpy availability check timed out".to_string()),
            },
        }
    }

    pub fn resolve_interpreter(
        &self,
        workspace_root: &str,
        explicit: Option<&str>,
    ) -> Result<String> {
        let root = canonical_workspace(workspace_root)?;
        resolve_target_python(&root, explicit).map(|path| path.to_string_lossy().into_owned())
    }

    pub async fn start(
        &self,
        launch_config: DapLaunchConfig,
        event_sink: DapEventSink,
    ) -> Result<DapSessionInfo> {
        self.start_with_adapter(launch_config, DapAdapterConfig::debugpy(), event_sink)
            .await
    }

    async fn start_with_adapter(
        &self,
        mut launch_config: DapLaunchConfig,
        adapter: DapAdapterConfig,
        event_sink: DapEventSink,
    ) -> Result<DapSessionInfo> {
        validate_tab_id(&launch_config.tab_id)?;
        validate_launch_environment(&launch_config.env)?;
        if launch_config.args.len() > 256
            || launch_config.args.iter().any(|value| value.contains('\0'))
        {
            bail!("invalid Python launch arguments");
        }

        let workspace_root = canonical_workspace(&launch_config.workspace_root)?;
        let program = canonical_source(&workspace_root, &launch_config.program, true)?;
        let interpreter =
            resolve_target_python(&workspace_root, launch_config.interpreter.as_deref())?;
        launch_config.workspace_root = workspace_root.to_string_lossy().into_owned();
        launch_config.program = program.to_string_lossy().into_owned();
        launch_config.interpreter = Some(interpreter.to_string_lossy().into_owned());

        {
            let mut registry = self.registry.lock().await;
            if registry.tab_sessions.contains_key(&launch_config.tab_id)
                || !registry.starting_tabs.insert(launch_config.tab_id.clone())
            {
                bail!("an active debug session already exists for this editor tab");
            }
        }

        let initial_breakpoints = {
            let registry = self.registry.lock().await;
            registry
                .breakpoints
                .iter()
                .filter(|((tab_id, path), _)| {
                    tab_id == &launch_config.tab_id && path.starts_with(&workspace_root)
                })
                .map(|((_, path), points)| {
                    (
                        path.to_string_lossy().into_owned(),
                        points.iter().map(|point| point.line).collect::<Vec<_>>(),
                    )
                })
                .collect::<Vec<_>>()
        };

        let session_id = uuid::Uuid::new_v4().to_string();
        let session = match DapSession::spawn(
            session_id.clone(),
            launch_config.clone(),
            workspace_root,
            program,
            interpreter,
            adapter,
            event_sink,
        )
        .await
        {
            Ok(session) => session,
            Err(error) => {
                self.registry
                    .lock()
                    .await
                    .starting_tabs
                    .remove(&launch_config.tab_id);
                return Err(error);
            }
        };
        let accepted = {
            let mut registry = self.registry.lock().await;
            if registry.starting_tabs.contains(&launch_config.tab_id) {
                registry
                    .starting_sessions
                    .insert(launch_config.tab_id.clone(), Arc::clone(&session));
                true
            } else {
                false
            }
        };
        if !accepted {
            session.shutdown().await;
            bail!("debug session start was cancelled");
        }

        let verified = match session.launch(&initial_breakpoints).await {
            Ok(verified) => verified,
            Err(error) => {
                session.shutdown().await;
                let mut registry = self.registry.lock().await;
                registry.starting_tabs.remove(&launch_config.tab_id);
                registry.starting_sessions.remove(&launch_config.tab_id);
                return Err(error);
            }
        };

        let info = session.info().await;
        let mut registry = self.registry.lock().await;
        let still_starting = registry.starting_tabs.remove(&launch_config.tab_id)
            && registry
                .starting_sessions
                .remove(&launch_config.tab_id)
                .is_some();
        if !still_starting {
            drop(registry);
            session.shutdown().await;
            bail!("debug session start was cancelled");
        }
        for (path, points) in verified {
            registry
                .breakpoints
                .insert((launch_config.tab_id.clone(), PathBuf::from(path)), points);
        }
        registry
            .tab_sessions
            .insert(launch_config.tab_id.clone(), session_id.clone());
        registry.sessions.insert(session_id, session);
        Ok(info)
    }

    pub async fn restart(
        &self,
        session_id: &str,
        event_sink: DapEventSink,
    ) -> Result<DapSessionInfo> {
        let session = self.session(session_id).await?;
        let launch_config = session.launch_config.clone();
        self.stop(session_id).await?;
        self.start(launch_config, event_sink).await
    }

    pub async fn stop(&self, session_id: &str) -> Result<()> {
        let session = {
            let mut registry = self.registry.lock().await;
            let Some(session) = registry.sessions.remove(session_id) else {
                return Ok(());
            };
            if registry
                .tab_sessions
                .get(&session.tab_id)
                .is_some_and(|current| current == session_id)
            {
                registry.tab_sessions.remove(&session.tab_id);
            }
            session
        };
        session.shutdown().await;
        Ok(())
    }

    pub async fn remove_tab(&self, tab_id: &str) {
        let (starting_session, session) = {
            let mut registry = self.registry.lock().await;
            registry.starting_tabs.remove(tab_id);
            let starting_session = registry.starting_sessions.remove(tab_id);
            let session = registry
                .tab_sessions
                .remove(tab_id)
                .and_then(|session_id| registry.sessions.remove(&session_id));
            registry
                .breakpoints
                .retain(|(owner_tab, _), _| owner_tab != tab_id);
            (starting_session, session)
        };
        if let Some(starting_session) = starting_session {
            starting_session.shutdown().await;
        }
        if let Some(session) = session {
            session.shutdown().await;
        }
    }

    pub async fn session_for_tab(&self, tab_id: &str) -> Option<DapSessionInfo> {
        let session = {
            let registry = self.registry.lock().await;
            registry
                .tab_sessions
                .get(tab_id)
                .and_then(|session_id| registry.sessions.get(session_id))
                .cloned()
        };
        match session {
            Some(session) => Some(session.info().await),
            None => None,
        }
    }

    pub async fn get_breakpoints(
        &self,
        tab_id: &str,
        workspace_root: &str,
        file_path: &str,
    ) -> Result<DapBreakpointSet> {
        validate_tab_id(tab_id)?;
        let root = canonical_workspace(workspace_root)?;
        let source = canonical_source(&root, file_path, false)?;
        let breakpoints = self
            .registry
            .lock()
            .await
            .breakpoints
            .get(&(tab_id.to_string(), source.clone()))
            .cloned()
            .unwrap_or_default();
        Ok(DapBreakpointSet {
            tab_id: tab_id.to_string(),
            file_path: source.to_string_lossy().into_owned(),
            breakpoints,
        })
    }

    pub async fn set_breakpoints(
        &self,
        tab_id: &str,
        workspace_root: &str,
        file_path: &str,
        lines: Vec<i64>,
    ) -> Result<DapBreakpointSet> {
        validate_tab_id(tab_id)?;
        let root = canonical_workspace(workspace_root)?;
        let source = canonical_source(&root, file_path, false)?;
        let lines = normalize_lines(lines)?;
        let requested = lines
            .iter()
            .map(|line| DapBreakpoint {
                id: None,
                line: *line,
                verified: false,
                message: None,
            })
            .collect::<Vec<_>>();

        let session = {
            let mut registry = self.registry.lock().await;
            registry
                .breakpoints
                .insert((tab_id.to_string(), source.clone()), requested.clone());
            registry
                .tab_sessions
                .get(tab_id)
                .and_then(|session_id| registry.sessions.get(session_id))
                .cloned()
        };

        let breakpoints = if let Some(session) = session {
            if session.workspace_root != root {
                bail!("debug session workspace does not match breakpoint workspace");
            }
            match session
                .set_breakpoints(&source.to_string_lossy(), &lines)
                .await
            {
                Ok(verified) => verified,
                Err(error) => requested
                    .into_iter()
                    .map(|mut point| {
                        point.message = Some(error.to_string());
                        point
                    })
                    .collect(),
            }
        } else {
            requested
        };

        self.registry
            .lock()
            .await
            .breakpoints
            .insert((tab_id.to_string(), source.clone()), breakpoints.clone());
        Ok(DapBreakpointSet {
            tab_id: tab_id.to_string(),
            file_path: source.to_string_lossy().into_owned(),
            breakpoints,
        })
    }

    pub async fn request(
        &self,
        session_id: &str,
        command: &str,
        arguments: Value,
    ) -> Result<Value> {
        let session = self.session(session_id).await?;
        session.request(command, arguments).await
    }

    async fn session(&self, session_id: &str) -> Result<Arc<DapSession>> {
        if session_id.trim().is_empty() || session_id.len() > 200 {
            bail!("invalid DAP session ID");
        }
        self.registry
            .lock()
            .await
            .sessions
            .get(session_id)
            .cloned()
            .with_context(|| format!("debug session is not active: {session_id}"))
    }
}

impl Default for DapManager {
    fn default() -> Self {
        Self::new()
    }
}

fn validate_tab_id(tab_id: &str) -> Result<()> {
    let trimmed = tab_id.trim();
    if trimmed.is_empty() || trimmed.len() > 200 || trimmed.chars().any(char::is_control) {
        bail!("invalid editor tab ID");
    }
    Ok(())
}

fn canonical_workspace(workspace_root: &str) -> Result<PathBuf> {
    let root = std::fs::canonicalize(workspace_root)
        .with_context(|| format!("debug workspace does not exist: {workspace_root}"))?;
    if !root.is_dir() {
        bail!("debug workspace is not a directory: {}", root.display());
    }
    Ok(root)
}

fn canonical_source(workspace_root: &Path, source: &str, require_python: bool) -> Result<PathBuf> {
    let source = std::fs::canonicalize(source)
        .with_context(|| format!("debug source does not exist: {source}"))?;
    if !source.is_file() || !source.starts_with(workspace_root) {
        bail!(
            "debug source is outside the workspace or not a file: {}",
            source.display()
        );
    }
    if require_python
        && source
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("py"))
    {
        bail!("debug launch target must be a Python file");
    }
    Ok(source)
}

fn resolve_target_python(workspace_root: &Path, explicit: Option<&str>) -> Result<PathBuf> {
    if let Some(explicit) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return canonical_interpreter(Path::new(explicit))
            .with_context(|| format!("invalid Python interpreter: {explicit}"));
    }

    let relative = if cfg!(windows) {
        ["Scripts/python.exe", "Scripts/python3.exe"]
    } else {
        ["bin/python", "bin/python3"]
    };
    for environment in [".venv", "venv"] {
        for suffix in relative {
            let candidate = workspace_root.join(environment).join(suffix);
            if candidate.is_file() {
                return canonical_interpreter(&candidate);
            }
        }
    }

    if let Some(virtual_env) = std::env::var_os("VIRTUAL_ENV").map(PathBuf::from) {
        for suffix in relative {
            let candidate = virtual_env.join(suffix);
            if candidate.is_file() {
                return canonical_interpreter(&candidate);
            }
        }
    }

    let path = std::env::var_os("PATH").context("PATH is unavailable")?;
    let names: &[&str] = if cfg!(windows) {
        &["python.exe", "python3.exe"]
    } else {
        &["python3", "python"]
    };
    for directory in std::env::split_paths(&path) {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return canonical_interpreter(&candidate);
            }
        }
    }
    bail!("no Python interpreter found for workspace")
}

fn canonical_interpreter(path: &Path) -> Result<PathBuf> {
    let interpreter = std::fs::canonicalize(path)
        .with_context(|| format!("Python interpreter does not exist: {}", path.display()))?;
    if !interpreter.is_file() {
        bail!(
            "Python interpreter is not a file: {}",
            interpreter.display()
        );
    }
    Ok(interpreter)
}

fn validate_launch_environment(env: &HashMap<String, String>) -> Result<()> {
    if env.len() > 256 {
        bail!("too many debug launch environment variables");
    }
    for (key, value) in env {
        if key.is_empty()
            || key.len() > 512
            || key.contains('=')
            || key.chars().any(char::is_control)
            || value.contains('\0')
        {
            bail!("invalid debug launch environment variable");
        }
    }
    Ok(())
}

fn normalize_lines(lines: Vec<i64>) -> Result<Vec<i64>> {
    if lines.len() > 10_000 || lines.iter().any(|line| *line <= 0) {
        bail!("invalid source breakpoint lines");
    }
    let mut lines = lines;
    lines.sort_unstable();
    lines.dedup();
    Ok(lines)
}

fn parse_breakpoint_response(body: &Value, requested: &[i64]) -> Vec<DapBreakpoint> {
    let response = body
        .get("breakpoints")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    requested
        .iter()
        .enumerate()
        .map(|(index, requested_line)| {
            let value = response.get(index);
            DapBreakpoint {
                id: value
                    .and_then(|value| value.get("id"))
                    .and_then(Value::as_i64),
                line: value
                    .and_then(|value| value.get("line"))
                    .and_then(Value::as_i64)
                    .unwrap_or(*requested_line),
                verified: value
                    .and_then(|value| value.get("verified"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                message: value
                    .and_then(|value| value.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            }
        })
        .collect()
}

async fn write_message<W>(writer: &mut W, value: &Value) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_MESSAGE_BYTES {
        bail!("DAP message exceeds size limit");
    }
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer
        .write_all(header.as_bytes())
        .await
        .context("failed to write DAP header")?;
    writer
        .write_all(&body)
        .await
        .context("failed to write DAP body")?;
    writer.flush().await.context("failed to flush DAP message")
}

async fn read_message<R>(reader: &mut R) -> Result<Value>
where
    R: AsyncBufRead + Unpin,
{
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .await
            .context("failed reading DAP header line")?;
        if bytes == 0 {
            bail!("DAP stdout closed before message");
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("Content-Length") {
                let length = value
                    .trim()
                    .parse::<usize>()
                    .context("invalid DAP Content-Length")?;
                if length > MAX_MESSAGE_BYTES {
                    bail!("DAP message exceeds size limit");
                }
                content_length = Some(length);
            }
        }
    }

    let length = content_length.context("missing DAP Content-Length")?;
    let mut body = vec![0u8; length];
    reader
        .read_exact(&mut body)
        .await
        .context("failed reading DAP message body")?;
    serde_json::from_slice(&body).context("invalid DAP JSON payload")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tempfile::tempdir;
    use tokio::io::{duplex, BufReader};

    #[tokio::test]
    async fn dap_framing_round_trips_utf8_and_ignores_header_case() {
        let (mut writer, reader) = duplex(4096);
        let payload = json!({
            "seq": 7,
            "type": "event",
            "event": "output",
            "body": { "output": "héllo" }
        });
        let expected = payload.clone();
        let task = tokio::spawn(async move {
            write_message(&mut writer, &payload).await.expect("write");
        });
        let mut reader = BufReader::new(reader);
        assert_eq!(read_message(&mut reader).await.expect("read"), expected);
        task.await.expect("writer task");

        let raw = b"content-length: 2\r\nX-Ignored: yes\r\n\r\n{}";
        let mut reader = BufReader::new(&raw[..]);
        assert_eq!(
            read_message(&mut reader).await.expect("lowercase"),
            json!({})
        );
    }

    #[test]
    fn breakpoint_lines_are_sorted_deduplicated_and_positive() {
        assert_eq!(normalize_lines(vec![8, 3, 8, 4]).unwrap(), vec![3, 4, 8]);
        assert!(normalize_lines(vec![0]).is_err());
        assert!(normalize_lines(vec![-1]).is_err());
    }

    #[test]
    fn breakpoint_response_preserves_requested_lines_when_adapter_omits_them() {
        let parsed = parse_breakpoint_response(
            &json!({
                "breakpoints": [
                    { "id": 4, "verified": true },
                    { "verified": false, "line": 12, "message": "moved" }
                ]
            }),
            &[5, 10],
        );
        assert_eq!(
            parsed,
            vec![
                DapBreakpoint {
                    id: Some(4),
                    line: 5,
                    verified: true,
                    message: None,
                },
                DapBreakpoint {
                    id: None,
                    line: 12,
                    verified: false,
                    message: Some("moved".to_string()),
                },
            ]
        );
    }

    #[test]
    fn source_validation_enforces_workspace_and_python_target() {
        let root = tempdir().unwrap();
        let inside = root.path().join("main.py");
        std::fs::write(&inside, "print('ok')").unwrap();
        let text = root.path().join("readme.txt");
        std::fs::write(&text, "not python").unwrap();
        let outside = tempdir().unwrap();
        let outside_file = outside.path().join("other.py");
        std::fs::write(&outside_file, "print('no')").unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();

        assert_eq!(
            canonical_source(&canonical_root, inside.to_str().unwrap(), true).unwrap(),
            std::fs::canonicalize(inside).unwrap()
        );
        assert!(canonical_source(&canonical_root, text.to_str().unwrap(), true).is_err());
        assert!(canonical_source(&canonical_root, outside_file.to_str().unwrap(), false).is_err());
    }

    #[test]
    fn launch_environment_rejects_unsafe_keys_and_nul_values() {
        assert!(validate_launch_environment(&HashMap::from([(
            "SAFE".to_string(),
            "value".to_string()
        )]))
        .is_ok());
        assert!(validate_launch_environment(&HashMap::from([(
            "BAD=KEY".to_string(),
            "value".to_string()
        )]))
        .is_err());
        assert!(validate_launch_environment(&HashMap::from([(
            "SAFE".to_string(),
            "bad\0value".to_string()
        )]))
        .is_err());
    }

    #[test]
    fn workspace_virtualenv_wins_interpreter_resolution() {
        let root = tempdir().unwrap();
        let interpreter = if cfg!(windows) {
            root.path().join(".venv/Scripts/python.exe")
        } else {
            root.path().join(".venv/bin/python")
        };
        std::fs::create_dir_all(interpreter.parent().unwrap()).unwrap();
        std::fs::write(&interpreter, b"python").unwrap();
        assert_eq!(
            resolve_target_python(root.path(), None).unwrap(),
            std::fs::canonicalize(interpreter).unwrap()
        );
    }

    async fn wait_for_event(
        events: &Arc<StdMutex<Vec<DapEventEnvelope>>>,
        event_name: &str,
        wait: Duration,
    ) -> Option<DapEventEnvelope> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            if let Some(event) = events
                .lock()
                .unwrap()
                .iter()
                .find(|event| event.event == event_name)
                .cloned()
            {
                return Some(event);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn event_recorder() -> (Arc<StdMutex<Vec<DapEventEnvelope>>>, DapEventSink) {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let sink: DapEventSink = Arc::new(move |event| {
            captured.lock().unwrap().push(event);
        });
        (events, sink)
    }

    #[tokio::test]
    async fn fake_adapter_validates_handshake_requests_events_and_cleanup() {
        let root = tempdir().unwrap();
        let program = root.path().join("main.py");
        std::fs::write(&program, "router = {'hostname': 'r1'}\nprint(router)\n").unwrap();
        let interpreter = resolve_target_python(root.path(), None).unwrap();
        let adapter_script = root.path().join("fake_adapter.py");
        let order_path = root.path().join("order.log");
        std::fs::write(
            &adapter_script,
            r#"
import json
import sys

order_path = sys.argv[1]
stall_launch = len(sys.argv) > 2 and sys.argv[2] == "stall"
next_seq = 1000
pending_launch = None

def record(value):
    with open(order_path, "a", encoding="utf-8") as handle:
        handle.write(value + "\n")

def send(payload):
    global next_seq
    if "seq" not in payload:
        payload["seq"] = next_seq
        next_seq += 1
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()

def receive():
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, value = line.decode("ascii").split(":", 1)
        if name.lower() == "content-length":
            length = int(value.strip())
    return json.loads(sys.stdin.buffer.read(length))

def reply(request, body=None):
    send({
        "type": "response",
        "request_seq": request["seq"],
        "success": True,
        "command": request["command"],
        "body": body or {},
    })

while True:
    message = receive()
    if message is None:
        break
    if message.get("type") == "response":
        record(f"reverse-response:{str(message.get('success')).lower()}")
        continue
    command = message["command"]
    record(command)
    arguments = message.get("arguments") or {}
    if command == "initialize":
        reply(message, {"supportsConfigurationDoneRequest": True})
        send({
            "type": "request",
            "command": "runInTerminal",
            "arguments": {"kind": "integrated"},
        })
    elif command == "launch":
        pending_launch = message
        if not stall_launch:
            send({"type": "event", "event": "initialized", "body": {}})
    elif command == "setBreakpoints":
        points = [
            {"id": index + 1, "verified": True, "line": point["line"]}
            for index, point in enumerate(arguments.get("breakpoints", []))
        ]
        reply(message, {"breakpoints": points})
    elif command == "setExceptionBreakpoints":
        reply(message)
    elif command == "configurationDone":
        reply(message)
        reply(pending_launch)
        send({
            "type": "event",
            "event": "output",
            "body": {"category": "stdout", "output": "fake output\n"},
        })
        send({
            "type": "event",
            "event": "stopped",
            "body": {"reason": "breakpoint", "threadId": 7},
        })
    elif command == "threads":
        reply(message, {"threads": [{"id": 7, "name": "MainThread"}]})
    elif command == "stackTrace":
        reply(message, {"stackFrames": [{
            "id": 11,
            "name": "main",
            "source": {"name": "main.py", "path": arguments.get("sourcePath", "")},
            "line": 2,
            "column": 1,
        }]})
    elif command == "scopes":
        reply(message, {"scopes": [{
            "name": "Locals",
            "variablesReference": 21,
            "expensive": False,
        }]})
    elif command == "variables":
        reply(message, {"variables": [{
            "name": "router",
            "value": "{'hostname': 'r1'}",
            "type": "dict",
            "variablesReference": 0,
        }]})
    elif command == "evaluate":
        reply(message, {"result": "'r1'", "type": "str", "variablesReference": 0})
    elif command in ("continue", "next", "stepIn", "stepOut", "pause"):
        reply(message, {"allThreadsContinued": True})
        send({"type": "event", "event": "continued", "body": {"threadId": 7}})
    elif command == "disconnect":
        reply(message)
        send({"type": "event", "event": "terminated", "body": {}})
        break
    else:
        send({
            "type": "response",
            "request_seq": message["seq"],
            "success": False,
            "command": command,
            "message": f"unsupported fake request: {command}",
        })
"#,
        )
        .unwrap();

        let manager = DapManager::new();
        manager
            .set_breakpoints(
                "tab-fake",
                root.path().to_str().unwrap(),
                program.to_str().unwrap(),
                vec![2],
            )
            .await
            .unwrap();
        let (events, sink) = event_recorder();
        let launch = DapLaunchConfig {
            tab_id: "tab-fake".to_string(),
            workspace_root: root.path().to_string_lossy().into_owned(),
            program: program.to_string_lossy().into_owned(),
            interpreter: Some(interpreter.to_string_lossy().into_owned()),
            args: vec!["--lab".to_string()],
            env: HashMap::from([("SITE".to_string(), "edge".to_string())]),
            stop_on_entry: false,
            just_my_code: true,
        };
        let adapter = DapAdapterConfig {
            command: interpreter.to_string_lossy().into_owned(),
            args: vec![
                adapter_script.to_string_lossy().into_owned(),
                order_path.to_string_lossy().into_owned(),
            ],
            display_name: "fake-debugpy".to_string(),
        };

        let info = manager
            .start_with_adapter(launch.clone(), adapter.clone(), sink)
            .await
            .expect("fake adapter launch");
        assert_eq!(info.tab_id, "tab-fake");
        assert_eq!(info.adapter_name, "fake-debugpy");
        assert!(manager
            .start_with_adapter(launch, adapter, Arc::new(|_| {}))
            .await
            .unwrap_err()
            .to_string()
            .contains("already exists"));

        assert!(wait_for_event(&events, "output", Duration::from_secs(2))
            .await
            .is_some());
        assert!(wait_for_event(&events, "stopped", Duration::from_secs(2))
            .await
            .is_some());
        assert_eq!(
            manager
                .request(&info.session_id, "threads", json!({}))
                .await
                .unwrap()["threads"][0]["id"],
            7
        );
        assert_eq!(
            manager
                .request(
                    &info.session_id,
                    "variables",
                    json!({"variablesReference": 21})
                )
                .await
                .unwrap()["variables"][0]["name"],
            "router"
        );
        assert_eq!(
            manager
                .request(
                    &info.session_id,
                    "evaluate",
                    json!({"expression": "router['hostname']", "frameId": 11}),
                )
                .await
                .unwrap()["result"],
            "'r1'"
        );
        let changed = manager
            .set_breakpoints(
                "tab-fake",
                root.path().to_str().unwrap(),
                program.to_str().unwrap(),
                vec![4, 2, 4],
            )
            .await
            .unwrap();
        assert_eq!(
            changed
                .breakpoints
                .iter()
                .map(|point| point.line)
                .collect::<Vec<_>>(),
            vec![2, 4]
        );

        manager.stop(&info.session_id).await.unwrap();
        manager.stop(&info.session_id).await.unwrap();
        assert!(manager.session_for_tab("tab-fake").await.is_none());

        let order = std::fs::read_to_string(&order_path).unwrap();
        let commands = order.lines().collect::<Vec<_>>();
        let initialize = commands
            .iter()
            .position(|value| *value == "initialize")
            .unwrap();
        let launch = commands
            .iter()
            .position(|value| *value == "launch")
            .unwrap();
        let breakpoints = commands
            .iter()
            .position(|value| *value == "setBreakpoints")
            .unwrap();
        let exceptions = commands
            .iter()
            .position(|value| *value == "setExceptionBreakpoints")
            .unwrap();
        let configured = commands
            .iter()
            .position(|value| *value == "configurationDone")
            .unwrap();
        assert!(initialize < launch);
        assert!(launch < breakpoints);
        assert!(breakpoints < exceptions);
        assert!(exceptions < configured);
        assert!(commands.contains(&"reverse-response:false"));
        assert!(commands.contains(&"disconnect"));

        let cancel_manager = Arc::new(DapManager::new());
        let cancel_task_manager = Arc::clone(&cancel_manager);
        let cancel_adapter = DapAdapterConfig {
            command: interpreter.to_string_lossy().into_owned(),
            args: vec![
                adapter_script.to_string_lossy().into_owned(),
                order_path.to_string_lossy().into_owned(),
                "stall".to_string(),
            ],
            display_name: "stalling-fake".to_string(),
        };
        let cancel_launch = DapLaunchConfig {
            tab_id: "tab-cancel".to_string(),
            workspace_root: root.path().to_string_lossy().into_owned(),
            program: program.to_string_lossy().into_owned(),
            interpreter: Some(interpreter.to_string_lossy().into_owned()),
            args: Vec::new(),
            env: HashMap::new(),
            stop_on_entry: false,
            just_my_code: true,
        };
        let start_task = tokio::spawn(async move {
            cancel_task_manager
                .start_with_adapter(cancel_launch, cancel_adapter, Arc::new(|_| {}))
                .await
        });
        timeout(Duration::from_secs(2), async {
            loop {
                if cancel_manager
                    .registry
                    .lock()
                    .await
                    .starting_sessions
                    .contains_key("tab-cancel")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("starting adapter registered");
        cancel_manager.remove_tab("tab-cancel").await;
        let cancelled = timeout(Duration::from_secs(2), start_task)
            .await
            .expect("cancelled start returned")
            .expect("cancel start task");
        assert!(cancelled.unwrap_err().to_string().contains("stopped"));
        assert!(cancel_manager
            .registry
            .lock()
            .await
            .starting_sessions
            .is_empty());
    }

    #[tokio::test]
    async fn real_debugpy_hits_breakpoint_reads_locals_and_exits_cleanly() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let adapter_python = if cfg!(windows) {
            repo_root.join("sidecar/.venv/Scripts/python.exe")
        } else {
            repo_root.join("sidecar/.venv/bin/python")
        };
        if !adapter_python.is_file()
            || !Command::new(&adapter_python)
                .args(["-c", "import debugpy"])
                .status()
                .await
                .is_ok_and(|status| status.success())
        {
            eprintln!("skipping real debugpy test: sidecar interpreter/debugpy unavailable");
            return;
        }

        let root = tempdir().unwrap();
        let program = root.path().join("main.py");
        std::fs::write(
            &program,
            "router = {'hostname': 'r1'}\nhostname = router['hostname']\nprint(hostname, flush=True)\n",
        )
        .unwrap();
        let manager = DapManager::new();
        manager
            .set_breakpoints(
                "tab-real",
                root.path().to_str().unwrap(),
                program.to_str().unwrap(),
                vec![2],
            )
            .await
            .unwrap();
        let (events, sink) = event_recorder();
        let info = manager
            .start_with_adapter(
                DapLaunchConfig {
                    tab_id: "tab-real".to_string(),
                    workspace_root: root.path().to_string_lossy().into_owned(),
                    program: program.to_string_lossy().into_owned(),
                    interpreter: Some(adapter_python.to_string_lossy().into_owned()),
                    args: Vec::new(),
                    env: HashMap::new(),
                    stop_on_entry: false,
                    just_my_code: true,
                },
                DapAdapterConfig {
                    command: adapter_python.to_string_lossy().into_owned(),
                    args: vec!["-m".to_string(), "debugpy.adapter".to_string()],
                    display_name: "debugpy".to_string(),
                },
                sink,
            )
            .await
            .expect("real debugpy launch");

        let stopped = wait_for_event(&events, "stopped", Duration::from_secs(10))
            .await
            .expect("real debugpy breakpoint");
        let preferred_thread = stopped.body.get("threadId").and_then(Value::as_i64);
        let threads = manager
            .request(&info.session_id, "threads", json!({}))
            .await
            .unwrap();
        let thread_id = preferred_thread
            .or_else(|| threads["threads"][0]["id"].as_i64())
            .expect("debugpy thread");
        let stack = manager
            .request(
                &info.session_id,
                "stackTrace",
                json!({"threadId": thread_id, "startFrame": 0, "levels": 20}),
            )
            .await
            .unwrap();
        let frame_id = stack["stackFrames"][0]["id"]
            .as_i64()
            .expect("debugpy frame");
        assert_eq!(stack["stackFrames"][0]["line"], 2);
        let scopes = manager
            .request(&info.session_id, "scopes", json!({"frameId": frame_id}))
            .await
            .unwrap();
        let locals = scopes["scopes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|scope| scope["name"].as_str() == Some("Locals"))
            .expect("locals scope");
        let variables_reference = locals["variablesReference"].as_i64().unwrap();
        let variables = manager
            .request(
                &info.session_id,
                "variables",
                json!({"variablesReference": variables_reference}),
            )
            .await
            .unwrap();
        assert!(variables["variables"]
            .as_array()
            .unwrap()
            .iter()
            .any(|variable| variable["name"].as_str() == Some("router")));

        manager
            .request(&info.session_id, "continue", json!({"threadId": thread_id}))
            .await
            .unwrap();
        assert!(
            wait_for_event(&events, "terminated", Duration::from_secs(10))
                .await
                .is_some()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.event == "adapterError"));
        manager.stop(&info.session_id).await.unwrap();
        assert!(manager.session_for_tab("tab-real").await.is_none());
    }
}
