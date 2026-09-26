//! MCP transport layer for stdio communication with child processes.

use crate::mcp::types::{JsonRpcNotification, JsonRpcRequest, JsonRpcResponse};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

/// Transport trait for MCP communication
/// Abstracts the underlying transport mechanism (stdio, HTTP/SSE, WebSocket, etc.)
#[async_trait]
pub trait Transport: Send + Sync {
    /// Send a JSON-RPC request to the server
    async fn send(&self, request: Value) -> Result<()>;

    /// Receive a JSON-RPC response from the server
    async fn receive(&self) -> Result<Value>;

    /// Close the transport connection
    async fn close(&self) -> Result<()>;
}

/// Stdio transport for communicating with MCP servers via stdin/stdout.
pub struct StdioTransport {
    /// Command to spawn the MCP server.
    command: String,
    /// Arguments for the command.
    args: Vec<String>,
    /// Environment variables.
    env: HashMap<String, String>,
    /// Child process handle.
    child: Arc<Mutex<Option<Child>>>,
    /// Stdin handle for writing requests.
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// Pending requests awaiting responses.
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    /// Notification callback.
    notification_tx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<JsonRpcNotification>>>>,
}

impl StdioTransport {
    /// Create a new stdio transport.
    pub fn new(command: String, args: Vec<String>, env: HashMap<String, String>) -> Self {
        Self {
            command,
            args,
            env,
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            notification_tx: Arc::new(Mutex::new(None)),
        }
    }

    /// Set the notification callback channel.
    pub fn set_notification_tx(&self, tx: tokio::sync::mpsc::UnboundedSender<JsonRpcNotification>) {
        *self.notification_tx.lock() = Some(tx);
    }

    /// Start the child process and begin reading from stdout.
    pub async fn start(&self) -> Result<()> {
        let mut cmd = Command::new(&self.command);
        cmd.args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        for (key, value) in &self.env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().context("Failed to spawn MCP server process")?;

        let stdin = child.stdin.take().context("Failed to get stdin")?;
        let stdout = child.stdout.take().context("Failed to get stdout")?;

        *self.stdin.lock() = Some(stdin);
        *self.child.lock() = Some(child);

        // Start reader thread for stdout
        self.spawn_reader(stdout);

        Ok(())
    }

    /// Spawn a thread to read JSON-RPC responses from stdout.
    fn spawn_reader(&self, stdout: ChildStdout) {
        let pending = Arc::clone(&self.pending);
        let notification_tx = Arc::clone(&self.notification_tx);

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if line.trim().is_empty() {
                            continue;
                        }

                        // Try to parse as response first
                        if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(&line) {
                            if let Some(sender) = pending.lock().remove(&response.id) {
                                let _ = sender.send(response);
                            }
                            continue;
                        }

                        // Try to parse as notification
                        if let Ok(notification) = serde_json::from_str::<JsonRpcNotification>(&line)
                        {
                            if let Some(tx) = notification_tx.lock().as_ref() {
                                let _ = tx.send(notification);
                            }
                            continue;
                        }

                        eprintln!("Failed to parse JSON-RPC message: {}", line);
                    }
                    Err(e) => {
                        eprintln!("Error reading from stdout: {}", e);
                        break;
                    }
                }
            }
        });
    }

    /// Send a JSON-RPC request and wait for the response.
    pub async fn send_request(
        &self,
        request: JsonRpcRequest,
        timeout: Duration,
    ) -> Result<JsonRpcResponse> {
        let (tx, rx) = oneshot::channel();

        // Register the pending request
        self.pending.lock().insert(request.id, tx);

        // Serialize and send the request
        let json = serde_json::to_string(&request).context("Failed to serialize request")?;

        {
            let mut stdin = self.stdin.lock();
            let stdin = stdin
                .as_mut()
                .ok_or_else(|| anyhow!("Stdin not available"))?;
            writeln!(stdin, "{}", json).context("Failed to write request")?;
            stdin.flush().context("Failed to flush stdin")?;
        }

        // Wait for response with timeout
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => {
                if let Some(error) = response.error {
                    return Err(anyhow!("JSON-RPC error {}: {}", error.code, error.message));
                }
                Ok(response)
            }
            Ok(Err(_)) => Err(anyhow!("Response channel closed")),
            Err(_) => {
                // Remove from pending on timeout
                self.pending.lock().remove(&request.id);
                Err(anyhow!("Request timeout after {:?}", timeout))
            }
        }
    }

    /// Check if the child process is running.
    pub fn is_running(&self) -> bool {
        if let Some(child) = self.child.lock().as_mut() {
            child.try_wait().ok().flatten().is_none()
        } else {
            false
        }
    }

    /// Kill the child process.
    pub async fn kill(&self) -> Result<()> {
        if let Some(mut child) = self.child.lock().take() {
            child.kill().context("Failed to kill child process")?;
            child.wait().context("Failed to wait for child")?;
        }
        *self.stdin.lock() = None;
        self.pending.lock().clear();
        Ok(())
    }
}

// Implement Transport trait for StdioTransport for compatibility with SSE transport
#[async_trait]
impl Transport for StdioTransport {
    async fn send(&self, request: Value) -> Result<()> {
        // Convert Value to JsonRpcRequest
        let json_request: JsonRpcRequest = serde_json::from_value(request)?;

        // Send request without waiting for response (caller will use receive())
        let json = serde_json::to_string(&json_request)?;
        let mut stdin = self.stdin.lock();
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| anyhow!("Stdin not available"))?;
        writeln!(stdin, "{}", json)?;
        stdin.flush()?;

        Ok(())
    }

    async fn receive(&self) -> Result<Value> {
        // This is a simplified implementation
        // In a full implementation, we'd need to properly handle the response queue
        // For now, return an error as the existing code uses send_request directly
        Err(anyhow!(
            "StdioTransport::receive not implemented - use send_request instead"
        ))
    }

    async fn close(&self) -> Result<()> {
        self.kill().await
    }
}
