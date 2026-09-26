//! Workspace-scoped Language Server Protocol (LSP) process management.
//!
//! Each canonical `(workspace root, language)` pair owns one persistent server.
//! Frontend panes/windows acquire client leases, while document ownership is
//! tracked separately so shared Monaco models do not emit duplicate didOpen or
//! premature didClose notifications.

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
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};
use url::Url;

pub mod python;
pub mod yaml;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const MONITOR_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspConfig {
    pub language: String,
    pub display_name: String,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSessionInfo {
    pub language: String,
    pub workspace_root: String,
    pub server_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct LspSessionKey {
    language: String,
    workspace_root: PathBuf,
}

impl LspSessionKey {
    fn new(language: &str, workspace_root: &str) -> Result<Self> {
        let language = normalize_language(language)?;
        let workspace_root = std::fs::canonicalize(workspace_root)
            .with_context(|| format!("LSP workspace does not exist: {workspace_root}"))?;
        if !workspace_root.is_dir() {
            bail!(
                "LSP workspace is not a directory: {}",
                workspace_root.display()
            );
        }
        Ok(Self {
            language,
            workspace_root,
        })
    }
}

#[derive(Debug, Clone)]
struct LspDocument {
    uri: String,
    language_id: String,
    text: String,
    version: i64,
    clients: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DocumentNotification {
    Open {
        uri: String,
        language_id: String,
        version: i64,
        text: String,
    },
    Change {
        uri: String,
        version: i64,
        text: String,
    },
    Close {
        uri: String,
    },
}

#[derive(Default)]
struct DocumentRegistry {
    documents: HashMap<String, LspDocument>,
}

impl DocumentRegistry {
    fn open(
        &mut self,
        client_id: &str,
        uri: &str,
        language_id: &str,
        text: &str,
    ) -> Option<DocumentNotification> {
        if let Some(document) = self.documents.get_mut(uri) {
            document.clients.insert(client_id.to_string());
            if document.text == text && document.language_id == language_id {
                return None;
            }
            document.text = text.to_string();
            document.language_id = language_id.to_string();
            document.version += 1;
            return Some(DocumentNotification::Change {
                uri: uri.to_string(),
                version: document.version,
                text: text.to_string(),
            });
        }

        let mut clients = HashSet::new();
        clients.insert(client_id.to_string());
        self.documents.insert(
            uri.to_string(),
            LspDocument {
                uri: uri.to_string(),
                language_id: language_id.to_string(),
                text: text.to_string(),
                version: 1,
                clients,
            },
        );
        Some(DocumentNotification::Open {
            uri: uri.to_string(),
            language_id: language_id.to_string(),
            version: 1,
            text: text.to_string(),
        })
    }

    fn change(
        &mut self,
        client_id: &str,
        uri: &str,
        text: &str,
    ) -> Result<Option<DocumentNotification>> {
        let document = self
            .documents
            .get_mut(uri)
            .with_context(|| format!("LSP document is not open: {uri}"))?;
        if !document.clients.contains(client_id) {
            bail!("LSP client does not own document: {uri}");
        }
        if document.text == text {
            return Ok(None);
        }
        document.text = text.to_string();
        document.version += 1;
        Ok(Some(DocumentNotification::Change {
            uri: uri.to_string(),
            version: document.version,
            text: text.to_string(),
        }))
    }

    fn close(&mut self, client_id: &str, uri: &str) -> Option<DocumentNotification> {
        let document = self.documents.get_mut(uri)?;
        document.clients.remove(client_id);
        if !document.clients.is_empty() {
            return None;
        }
        self.documents.remove(uri);
        Some(DocumentNotification::Close {
            uri: uri.to_string(),
        })
    }

    fn release_client(&mut self, client_id: &str) -> Vec<DocumentNotification> {
        let owned_uris: Vec<String> = self
            .documents
            .values()
            .filter(|document| document.clients.contains(client_id))
            .map(|document| document.uri.clone())
            .collect();
        owned_uris
            .into_iter()
            .filter_map(|uri| self.close(client_id, &uri))
            .collect()
    }

    fn snapshots(&self) -> Vec<LspDocument> {
        self.documents.values().cloned().collect()
    }
}

#[derive(Debug, thiserror::Error)]
enum LspProcessError {
    #[error("language server returned error {code}: {message}")]
    Server { code: i64, message: String },
    #[error(transparent)]
    Transport(#[from] anyhow::Error),
}

struct LspProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl LspProcess {
    async fn spawn(config: &LspConfig, workspace_root: &Path) -> Result<Self> {
        tracing::info!(
            language = %config.language,
            server = %config.display_name,
            command = %config.command,
            workspace = %workspace_root.display(),
            "starting workspace LSP server"
        );

        let mut child = Command::new(&config.command)
            .args(&config.args)
            .current_dir(workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("failed to spawn LSP process: {}", config.command))?;

        let stdin = child.stdin.take().context("failed to capture LSP stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("failed to capture LSP stdout")?;
        if let Some(stderr) = child.stderr.take() {
            let server = config.display_name.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(server = %server, message = %line, "LSP stderr");
                }
            });
        }

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn exited(&mut self) -> Result<Option<std::process::ExitStatus>> {
        self.child
            .try_wait()
            .context("failed to inspect LSP child status")
    }

    async fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        workspace_root: &Path,
        request_timeout: Duration,
    ) -> std::result::Result<Value, LspProcessError> {
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        write_message(&mut self.stdin, &request)
            .await
            .map_err(LspProcessError::Transport)?;

        let response = timeout(request_timeout, self.read_response(id, workspace_root))
            .await
            .map_err(|_| {
                LspProcessError::Transport(anyhow!(
                    "LSP request timed out after {}s: {method}",
                    request_timeout.as_secs()
                ))
            })??;

        if let Some(error) = response.get("error") {
            return Err(LspProcessError::Server {
                code: error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown language-server error")
                    .to_string(),
            });
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn read_response(
        &mut self,
        expected_id: u64,
        workspace_root: &Path,
    ) -> std::result::Result<Value, LspProcessError> {
        loop {
            let message = read_message(&mut self.stdout)
                .await
                .map_err(LspProcessError::Transport)?;

            if message.get("id").and_then(Value::as_u64) == Some(expected_id)
                && (message.get("result").is_some() || message.get("error").is_some())
            {
                return Ok(message);
            }

            if message.get("method").is_some() && message.get("id").is_some() {
                let response = server_request_response(&message, workspace_root);
                write_message(&mut self.stdin, &response)
                    .await
                    .map_err(LspProcessError::Transport)?;
                continue;
            }

            if let Some(method) = message.get("method").and_then(Value::as_str) {
                tracing::trace!(method, "received LSP notification");
            } else {
                tracing::debug!(message = %message, "ignored unrelated LSP response");
            }
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        write_message(
            &mut self.stdin,
            &json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            }),
        )
        .await
    }

    async fn force_stop(&mut self) {
        let _ = self.child.start_kill();
        let _ = timeout(SHUTDOWN_TIMEOUT, self.child.wait()).await;
    }

    async fn graceful_stop(&mut self, request_id: u64, workspace_root: &Path) {
        let _ = self
            .request(
                request_id,
                "shutdown",
                Value::Null,
                workspace_root,
                SHUTDOWN_TIMEOUT,
            )
            .await;
        let _ = self.notify("exit", Value::Null).await;
        if timeout(SHUTDOWN_TIMEOUT, self.child.wait()).await.is_err() {
            self.force_stop().await;
        }
    }
}

struct LspSession {
    key: LspSessionKey,
    config: LspConfig,
    process: Mutex<Option<LspProcess>>,
    clients: Mutex<HashSet<String>>,
    documents: Mutex<DocumentRegistry>,
    next_request_id: AtomicU64,
    monitor_started: AtomicBool,
    shutting_down: AtomicBool,
}

impl LspSession {
    fn new(key: LspSessionKey, config: LspConfig) -> Self {
        Self {
            key,
            config,
            process: Mutex::new(None),
            clients: Mutex::new(HashSet::new()),
            documents: Mutex::new(DocumentRegistry::default()),
            next_request_id: AtomicU64::new(1),
            monitor_started: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
        }
    }

    fn info(&self) -> LspSessionInfo {
        LspSessionInfo {
            language: self.key.language.clone(),
            workspace_root: self.key.workspace_root.to_string_lossy().into_owned(),
            server_name: self.config.display_name.clone(),
        }
    }

    fn request_id(&self) -> u64 {
        self.next_request_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn add_client(&self, client_id: &str) -> Result<()> {
        validate_client_id(client_id)?;
        self.clients.lock().await.insert(client_id.to_string());
        Ok(())
    }

    async fn client_count(&self) -> usize {
        self.clients.lock().await.len()
    }

    async fn remove_client(&self, client_id: &str) -> usize {
        let remaining = {
            let mut clients = self.clients.lock().await;
            clients.remove(client_id);
            clients.len()
        };

        if remaining > 0 {
            let mut process_guard = self.process.lock().await;
            let notifications = self.documents.lock().await.release_client(client_id);
            if let Some(process) = process_guard.as_mut() {
                for notification in notifications {
                    if let Err(error) = send_document_notification(process, notification).await {
                        tracing::warn!(
                            %error,
                            client_id,
                            "failed to release LSP document ownership"
                        );
                        process.force_stop().await;
                        *process_guard = None;
                        break;
                    }
                }
            }
        }

        remaining
    }

    async fn ensure_running(&self) -> Result<()> {
        if self.shutting_down.load(Ordering::Acquire) {
            bail!("LSP session is shutting down");
        }
        let mut process_guard = self.process.lock().await;
        self.ensure_process_locked(&mut process_guard).await
    }

    async fn ensure_process_locked(&self, process_slot: &mut Option<LspProcess>) -> Result<()> {
        if let Some(process) = process_slot.as_mut() {
            if let Some(status) = process.exited()? {
                tracing::warn!(
                    language = %self.key.language,
                    workspace = %self.key.workspace_root.display(),
                    %status,
                    "LSP server exited unexpectedly"
                );
                *process_slot = None;
            }
        }
        if process_slot.is_some() {
            return Ok(());
        }

        let mut process = LspProcess::spawn(&self.config, &self.key.workspace_root).await?;
        let root_uri = file_uri(&self.key.workspace_root)?;
        let initialize_params = json!({
            "processId": std::process::id(),
            "clientInfo": {
                "name": "TerminAI",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "locale": "en-US",
            "rootPath": self.key.workspace_root.to_string_lossy(),
            "rootUri": root_uri,
            "workspaceFolders": [{
                "uri": root_uri,
                "name": self.key.workspace_root.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("workspace"),
            }],
            "capabilities": {
                "workspace": {
                    "workspaceFolders": true,
                    "symbol": {
                        "dynamicRegistration": false,
                        "resolveSupport": { "properties": ["location.range"] },
                    },
                },
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": false,
                        "didSave": true,
                    },
                    "completion": {
                        "dynamicRegistration": false,
                        "completionItem": {
                            "documentationFormat": ["markdown", "plaintext"],
                            "snippetSupport": true,
                        },
                    },
                    "hover": {
                        "dynamicRegistration": false,
                        "contentFormat": ["markdown", "plaintext"],
                    },
                    "definition": {
                        "dynamicRegistration": false,
                        "linkSupport": true,
                    },
                    "references": {
                        "dynamicRegistration": false,
                    },
                },
                "window": {
                    "workDoneProgress": true,
                },
            },
            "initializationOptions": Value::Null,
            "trace": "off",
        });

        if let Err(error) = process
            .request(
                self.request_id(),
                "initialize",
                initialize_params,
                &self.key.workspace_root,
                REQUEST_TIMEOUT,
            )
            .await
        {
            process.force_stop().await;
            return Err(anyhow!(error)).context("failed to initialize language server");
        }
        process
            .notify("initialized", json!({}))
            .await
            .context("failed to send LSP initialized notification")?;

        let documents = self.documents.lock().await.snapshots();
        for document in documents {
            send_document_notification(
                &mut process,
                DocumentNotification::Open {
                    uri: document.uri,
                    language_id: document.language_id,
                    version: document.version,
                    text: document.text,
                },
            )
            .await
            .context("failed to restore LSP document after restart")?;
        }

        tracing::info!(
            language = %self.key.language,
            server = %self.config.display_name,
            workspace = %self.key.workspace_root.display(),
            "workspace LSP server ready"
        );
        *process_slot = Some(process);
        Ok(())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        for attempt in 0..2 {
            let mut process_guard = self.process.lock().await;
            self.ensure_process_locked(&mut process_guard).await?;
            let process = process_guard
                .as_mut()
                .context("LSP process missing after startup")?;
            match process
                .request(
                    self.request_id(),
                    method,
                    params.clone(),
                    &self.key.workspace_root,
                    REQUEST_TIMEOUT,
                )
                .await
            {
                Ok(result) => return Ok(result),
                Err(LspProcessError::Server { code, message }) => {
                    bail!("language server returned error {code}: {message}");
                }
                Err(LspProcessError::Transport(error)) => {
                    tracing::warn!(
                        %error,
                        method,
                        attempt,
                        language = %self.key.language,
                        workspace = %self.key.workspace_root.display(),
                        "LSP transport failed; restarting"
                    );
                    process.force_stop().await;
                    *process_guard = None;
                    if attempt == 1 {
                        return Err(error).context("LSP request failed after restart");
                    }
                }
            }
        }
        unreachable!("bounded LSP retry loop")
    }

    async fn document_open(
        &self,
        client_id: &str,
        uri: &str,
        language_id: &str,
        text: &str,
    ) -> Result<()> {
        validate_document_uri(uri, &self.key.workspace_root)?;
        let mut process_guard = self.process.lock().await;
        self.ensure_process_locked(&mut process_guard).await?;
        let notification = self
            .documents
            .lock()
            .await
            .open(client_id, uri, language_id, text);
        self.apply_document_notification(&mut process_guard, notification)
            .await
    }

    async fn document_change(&self, client_id: &str, uri: &str, text: &str) -> Result<()> {
        validate_document_uri(uri, &self.key.workspace_root)?;
        let mut process_guard = self.process.lock().await;
        self.ensure_process_locked(&mut process_guard).await?;
        let notification = self.documents.lock().await.change(client_id, uri, text)?;
        self.apply_document_notification(&mut process_guard, notification)
            .await
    }

    async fn document_close(&self, client_id: &str, uri: &str) -> Result<()> {
        let mut process_guard = self.process.lock().await;
        self.ensure_process_locked(&mut process_guard).await?;
        let notification = self.documents.lock().await.close(client_id, uri);
        self.apply_document_notification(&mut process_guard, notification)
            .await
    }

    async fn apply_document_notification(
        &self,
        process_guard: &mut Option<LspProcess>,
        notification: Option<DocumentNotification>,
    ) -> Result<()> {
        let Some(notification) = notification else {
            return Ok(());
        };
        let process = process_guard
            .as_mut()
            .context("LSP process missing while syncing document")?;
        if let Err(error) = send_document_notification(process, notification).await {
            process.force_stop().await;
            *process_guard = None;
            self.ensure_process_locked(process_guard)
                .await
                .context("failed to restore LSP document state after transport failure")?;
            tracing::info!(
                language = %self.key.language,
                workspace = %self.key.workspace_root.display(),
                %error,
                "restored LSP document state after transport failure"
            );
        }
        Ok(())
    }

    fn start_monitor(self: &Arc<Self>) {
        if self
            .monitor_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let weak: Weak<Self> = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                sleep(MONITOR_INTERVAL).await;
                let Some(session) = weak.upgrade() else {
                    break;
                };
                if session.shutting_down.load(Ordering::Acquire)
                    || session.client_count().await == 0
                {
                    break;
                }
                if let Err(error) = session.ensure_running().await {
                    tracing::warn!(
                        %error,
                        language = %session.key.language,
                        workspace = %session.key.workspace_root.display(),
                        "LSP supervisor restart failed; will retry"
                    );
                }
            }
        });
    }

    async fn is_running(&self) -> bool {
        let mut process_guard = self.process.lock().await;
        match process_guard.as_mut() {
            Some(process) => matches!(process.exited(), Ok(None)),
            None => false,
        }
    }

    async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        self.clients.lock().await.clear();
        let mut process_guard = self.process.lock().await;
        self.documents.lock().await.documents.clear();
        if let Some(mut process) = process_guard.take() {
            tracing::info!(
                language = %self.key.language,
                workspace = %self.key.workspace_root.display(),
                "stopping workspace LSP server"
            );
            process
                .graceful_stop(self.request_id(), &self.key.workspace_root)
                .await;
        }
    }
}

pub struct LspManager {
    sessions: Arc<Mutex<HashMap<LspSessionKey, Arc<LspSession>>>>,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start_lsp(
        &self,
        language: &str,
        workspace_root: &str,
        client_id: &str,
        config: LspConfig,
    ) -> Result<LspSessionInfo> {
        let key = LspSessionKey::new(language, workspace_root)?;
        let session = {
            let mut sessions = self.sessions.lock().await;
            sessions
                .entry(key.clone())
                .or_insert_with(|| Arc::new(LspSession::new(key, config)))
                .clone()
        };
        session.add_client(client_id).await?;
        if let Err(error) = session.ensure_running().await {
            let remaining = session.remove_client(client_id).await;
            if remaining == 0 {
                self.remove_if_same(&session).await;
            }
            return Err(error);
        }
        session.start_monitor();
        Ok(session.info())
    }

    pub async fn stop_lsp(
        &self,
        language: &str,
        workspace_root: &str,
        client_id: &str,
    ) -> Result<()> {
        let key = LspSessionKey::new(language, workspace_root)?;
        let session = self.sessions.lock().await.get(&key).cloned();
        let Some(session) = session else {
            return Ok(());
        };
        if session.remove_client(client_id).await == 0 {
            self.remove_if_same(&session).await;
            session.shutdown().await;
        }
        Ok(())
    }

    pub async fn send_request(
        &self,
        language: &str,
        workspace_root: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let session = self.session(language, workspace_root).await?;
        session.request(method, params).await
    }

    pub async fn document_open(
        &self,
        language: &str,
        workspace_root: &str,
        client_id: &str,
        uri: &str,
        language_id: &str,
        text: &str,
    ) -> Result<()> {
        let session = self.session(language, workspace_root).await?;
        ensure_session_client(&session, client_id).await?;
        session
            .document_open(client_id, uri, language_id, text)
            .await
    }

    pub async fn document_change(
        &self,
        language: &str,
        workspace_root: &str,
        client_id: &str,
        uri: &str,
        text: &str,
    ) -> Result<()> {
        let session = self.session(language, workspace_root).await?;
        ensure_session_client(&session, client_id).await?;
        session.document_change(client_id, uri, text).await
    }

    pub async fn document_close(
        &self,
        language: &str,
        workspace_root: &str,
        client_id: &str,
        uri: &str,
    ) -> Result<()> {
        let session = self.session(language, workspace_root).await?;
        ensure_session_client(&session, client_id).await?;
        session.document_close(client_id, uri).await
    }

    pub async fn is_running(&self, language: &str, workspace_root: &str) -> Result<bool> {
        let key = LspSessionKey::new(language, workspace_root)?;
        let session = self.sessions.lock().await.get(&key).cloned();
        Ok(match session {
            Some(session) => session.is_running().await,
            None => false,
        })
    }

    async fn session(&self, language: &str, workspace_root: &str) -> Result<Arc<LspSession>> {
        let key = LspSessionKey::new(language, workspace_root)?;
        self.sessions
            .lock()
            .await
            .get(&key)
            .cloned()
            .with_context(|| {
                format!(
                    "LSP session is not started for {language} in {}",
                    key.workspace_root.display()
                )
            })
    }

    async fn remove_if_same(&self, session: &Arc<LspSession>) {
        let mut sessions = self.sessions.lock().await;
        if sessions
            .get(&session.key)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            sessions.remove(&session.key);
        }
    }
}

impl Default for LspManager {
    fn default() -> Self {
        Self::new()
    }
}

async fn ensure_session_client(session: &LspSession, client_id: &str) -> Result<()> {
    validate_client_id(client_id)?;
    if !session.clients.lock().await.contains(client_id) {
        bail!("LSP client does not hold a session lease");
    }
    Ok(())
}

fn normalize_language(language: &str) -> Result<String> {
    match language.trim().to_ascii_lowercase().as_str() {
        "python" => Ok("python".to_string()),
        "yaml" | "yml" => Ok("yaml".to_string()),
        other => bail!("unsupported LSP language: {other}"),
    }
}

fn validate_client_id(client_id: &str) -> Result<()> {
    let trimmed = client_id.trim();
    if trimmed.is_empty() || trimmed.len() > 200 || trimmed.chars().any(char::is_control) {
        bail!("invalid LSP client ID");
    }
    Ok(())
}

fn file_uri(path: &Path) -> Result<String> {
    Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|_| anyhow!("cannot convert path to file URI: {}", path.display()))
}

fn validate_document_uri(uri: &str, workspace_root: &Path) -> Result<PathBuf> {
    let url = Url::parse(uri).with_context(|| format!("invalid LSP document URI: {uri}"))?;
    if url.scheme() != "file" {
        bail!("LSP document URI must use file://");
    }
    let path = url
        .to_file_path()
        .map_err(|_| anyhow!("invalid file URI: {uri}"))?;
    let canonical = std::fs::canonicalize(&path)
        .with_context(|| format!("LSP document does not exist: {}", path.display()))?;
    if !canonical.starts_with(workspace_root) {
        bail!("LSP document is outside workspace: {}", canonical.display());
    }
    Ok(canonical)
}

async fn send_document_notification(
    process: &mut LspProcess,
    notification: DocumentNotification,
) -> Result<()> {
    match notification {
        DocumentNotification::Open {
            uri,
            language_id,
            version,
            text,
        } => {
            process
                .notify(
                    "textDocument/didOpen",
                    json!({
                        "textDocument": {
                            "uri": uri,
                            "languageId": language_id,
                            "version": version,
                            "text": text,
                        }
                    }),
                )
                .await
        }
        DocumentNotification::Change { uri, version, text } => {
            process
                .notify(
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": version },
                        "contentChanges": [{ "text": text }],
                    }),
                )
                .await
        }
        DocumentNotification::Close { uri } => {
            process
                .notify(
                    "textDocument/didClose",
                    json!({ "textDocument": { "uri": uri } }),
                )
                .await
        }
    }
}

fn server_request_response(request: &Value, workspace_root: &Path) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "workspace/configuration" => {
            let count = params
                .get("items")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            Some(Value::Array(vec![Value::Null; count]))
        }
        "workspace/workspaceFolders" => file_uri(workspace_root).ok().map(|uri| {
            json!([{
                "uri": uri,
                "name": workspace_root.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("workspace"),
            }])
        }),
        "client/registerCapability"
        | "client/unregisterCapability"
        | "window/workDoneProgress/create" => Some(Value::Null),
        "workspace/applyEdit" => Some(json!({
            "applied": false,
            "failureReason": "TerminAI Phase 4 navigation does not apply server workspace edits",
        })),
        _ => None,
    };

    match result {
        Some(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        None => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("unsupported client method: {method}"),
            }
        }),
    }
}

async fn write_message<W>(writer: &mut W, value: &Value) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    let body = serde_json::to_vec(value)?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer
        .write_all(header.as_bytes())
        .await
        .context("failed to write LSP header")?;
    writer
        .write_all(&body)
        .await
        .context("failed to write LSP body")?;
    writer.flush().await.context("failed to flush LSP message")
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
            .context("failed reading LSP header line")?;
        if bytes == 0 {
            bail!("LSP stdout closed before message");
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("Content-Length") {
                content_length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .context("invalid LSP Content-Length")?,
                );
            }
        }
    }

    let length = content_length.context("missing LSP Content-Length")?;
    let mut body = vec![0u8; length];
    reader
        .read_exact(&mut body)
        .await
        .context("failed reading LSP message body")?;
    serde_json::from_slice(&body).context("invalid LSP JSON payload")
}

pub(crate) fn resolve_executable(
    workspace_root: &Path,
    override_env: &str,
    binary_name: &str,
) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(override_env).map(PathBuf::from) {
        if executable_file(&path) {
            return Some(path);
        }
    }

    let mut roots = vec![workspace_root.to_path_buf()];
    if let Some(repository_root) = std::env::var_os("CCIE_REPO_ROOT").map(PathBuf::from) {
        if !roots.contains(&repository_root) {
            roots.push(repository_root);
        }
    }
    #[cfg(debug_assertions)]
    if let Some(repository_root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        let repository_root = repository_root.to_path_buf();
        if !roots.contains(&repository_root) {
            roots.push(repository_root);
        }
    }
    for root in roots {
        let candidate = root.join("node_modules").join(".bin").join(binary_name);
        if executable_file(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let command_file = candidate.with_extension("cmd");
            if executable_file(&command_file) {
                return Some(command_file);
            }
        }
    }

    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(binary_name);
        if executable_file(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            for extension in ["exe", "cmd", "bat"] {
                let candidate = directory.join(format!("{binary_name}.{extension}"));
                if executable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::io::{duplex, BufReader};

    #[tokio::test]
    async fn lsp_framing_round_trips_json_and_ignores_header_case() {
        let (mut writer, reader) = duplex(4096);
        let payload = json!({"jsonrpc": "2.0", "id": 7, "result": {"ok": true}});
        let expected = payload.clone();
        let write = tokio::spawn(async move {
            write_message(&mut writer, &payload).await.expect("write");
        });
        let mut reader = BufReader::new(reader);
        assert_eq!(read_message(&mut reader).await.expect("read"), expected);
        write.await.expect("writer task");

        let raw = b"content-length: 2\r\nX-Test: ignored\r\n\r\n{}";
        let mut reader = BufReader::new(&raw[..]);
        assert_eq!(
            read_message(&mut reader).await.expect("lowercase"),
            json!({})
        );
    }

    #[test]
    fn document_registry_reference_counts_owners_and_versions_changes() {
        let mut registry = DocumentRegistry::default();
        assert_eq!(
            registry.open("pane-a", "file:///repo/a.py", "python", "one"),
            Some(DocumentNotification::Open {
                uri: "file:///repo/a.py".to_string(),
                language_id: "python".to_string(),
                version: 1,
                text: "one".to_string(),
            })
        );
        assert_eq!(
            registry.open("pane-b", "file:///repo/a.py", "python", "one"),
            None
        );
        assert_eq!(
            registry
                .change("pane-b", "file:///repo/a.py", "two")
                .expect("change"),
            Some(DocumentNotification::Change {
                uri: "file:///repo/a.py".to_string(),
                version: 2,
                text: "two".to_string(),
            })
        );
        assert_eq!(registry.close("pane-a", "file:///repo/a.py"), None);
        assert_eq!(
            registry.close("pane-b", "file:///repo/a.py"),
            Some(DocumentNotification::Close {
                uri: "file:///repo/a.py".to_string(),
            })
        );
        assert!(registry.documents.is_empty());
    }

    #[test]
    fn releasing_a_client_only_closes_documents_without_other_owners() {
        let mut registry = DocumentRegistry::default();
        registry.open("window-a", "file:///repo/a.py", "python", "a");
        registry.open("window-b", "file:///repo/a.py", "python", "a");
        registry.open("window-a", "file:///repo/b.py", "python", "b");

        assert_eq!(
            registry.release_client("window-a"),
            vec![DocumentNotification::Close {
                uri: "file:///repo/b.py".to_string(),
            }]
        );
        assert!(registry.documents.contains_key("file:///repo/a.py"));
        assert!(!registry.documents.contains_key("file:///repo/b.py"));
    }

    #[test]
    fn server_requests_receive_supported_or_honest_error_responses() {
        let root = Path::new("/tmp/workspace");
        let configuration = server_request_response(
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "workspace/configuration",
                "params": {"items": [{}, {}]},
            }),
            root,
        );
        assert_eq!(configuration["result"], json!([null, null]));

        let unknown = server_request_response(
            &json!({
                "jsonrpc": "2.0",
                "id": "server-1",
                "method": "custom/unknown",
            }),
            root,
        );
        assert_eq!(unknown["id"], "server-1");
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn session_keys_are_canonical_and_document_uris_stay_in_workspace() {
        let directory = tempdir().expect("tempdir");
        let file = directory.path().join("main.py");
        std::fs::write(&file, "value = 1\n").expect("fixture");
        let key =
            LspSessionKey::new("Python", directory.path().to_str().unwrap()).expect("session key");
        assert_eq!(key.language, "python");
        assert_eq!(key.workspace_root, directory.path().canonicalize().unwrap());

        let uri = file_uri(&file).expect("file URI");
        assert_eq!(
            validate_document_uri(&uri, &key.workspace_root).expect("inside"),
            file.canonicalize().unwrap()
        );

        let outside = tempdir().expect("outside");
        let outside_file = outside.path().join("outside.py");
        std::fs::write(&outside_file, "").expect("outside fixture");
        let outside_uri = file_uri(&outside_file).expect("outside URI");
        assert!(validate_document_uri(&outside_uri, &key.workspace_root).is_err());
    }

    #[test]
    fn executable_resolution_prefers_workspace_local_binary() {
        let directory = tempdir().expect("tempdir");
        let bin_dir = directory.path().join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin_dir).expect("bin dir");
        let binary = bin_dir.join("test-language-server");
        std::fs::write(&binary, "").expect("binary");
        assert_eq!(
            resolve_executable(
                directory.path(),
                "CCIE_TEST_LANGUAGE_SERVER_DOES_NOT_EXIST",
                "test-language-server",
            ),
            Some(binary)
        );
    }

    #[tokio::test]
    #[ignore = "requires the pinned npm Pyright language server"]
    async fn pyright_handles_real_workspace_symbols_and_definition_requests() {
        let directory = tempdir().expect("tempdir");
        let definitions = directory.path().join("definitions.py");
        let main = directory.path().join("main.py");
        std::fs::write(
            &definitions,
            "class Router:\n    def hostname(self) -> str:\n        return \"r1\"\n",
        )
        .expect("definitions fixture");
        std::fs::write(
            &main,
            "from definitions import Router\n\nrouter = Router()\nprint(router.hostname())\n",
        )
        .expect("main fixture");

        let workspace_root = directory.path().to_string_lossy().into_owned();
        let config =
            python::get_python_lsp_config(directory.path()).expect("resolve pinned Pyright");
        let manager = LspManager::new();
        manager
            .start_lsp("python", &workspace_root, "integration-test", config)
            .await
            .expect("start Pyright");
        let main_uri = file_uri(&main).expect("main URI");
        let definitions_uri = file_uri(&definitions).expect("definitions URI");
        manager
            .document_open(
                "python",
                &workspace_root,
                "integration-test",
                &definitions_uri,
                "python",
                &std::fs::read_to_string(&definitions).unwrap(),
            )
            .await
            .expect("open definitions");
        manager
            .document_open(
                "python",
                &workspace_root,
                "integration-test",
                &main_uri,
                "python",
                &std::fs::read_to_string(&main).unwrap(),
            )
            .await
            .expect("open main");

        let mut symbols = Value::Null;
        for _ in 0..10 {
            symbols = manager
                .send_request(
                    "python",
                    &workspace_root,
                    "workspace/symbol",
                    json!({ "query": "Router" }),
                )
                .await
                .expect("workspace symbols");
            if symbols
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["name"] == "Router"))
            {
                break;
            }
            sleep(Duration::from_millis(100)).await;
        }
        assert!(
            symbols
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["name"] == "Router")),
            "Pyright did not return Router: {symbols}"
        );

        let session = manager
            .session("python", &workspace_root)
            .await
            .expect("active session");
        {
            let mut process = session.process.lock().await;
            let process = process.as_mut().expect("running Pyright");
            process.child.start_kill().expect("kill Pyright");
            process.child.wait().await.expect("reap killed Pyright");
        }
        let mut restarted = false;
        for _ in 0..30 {
            if manager
                .is_running("python", &workspace_root)
                .await
                .expect("supervisor status")
            {
                restarted = true;
                break;
            }
            sleep(Duration::from_millis(100)).await;
        }
        assert!(restarted, "LSP supervisor did not restart Pyright");

        let definition = manager
            .send_request(
                "python",
                &workspace_root,
                "textDocument/definition",
                json!({
                    "textDocument": { "uri": main_uri },
                    "position": { "line": 0, "character": 24 },
                }),
            )
            .await
            .expect("definition");
        assert!(
            definition.to_string().contains("definitions.py"),
            "definition did not target definitions.py: {definition}"
        );

        manager
            .stop_lsp("python", &workspace_root, "integration-test")
            .await
            .expect("stop Pyright");
    }
}
