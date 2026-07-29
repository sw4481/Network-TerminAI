//! Language Server Protocol (LSP) management.
//!
//! Spawns and communicates with language server subprocesses over stdin/stdout
//! using the JSON-RPC framing specified by the LSP (Content-Length headers).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

pub mod python;
pub mod yaml;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspConfig {
    pub language: String,
    pub command: String,
    pub args: Vec<String>,
}

pub struct LspManager {
    processes: Arc<Mutex<HashMap<String, LspProcess>>>,
}

struct LspProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start_lsp(&self, language: &str, config: LspConfig) -> Result<()> {
        let mut processes = self.processes.lock().await;

        if processes.contains_key(language) {
            return Ok(());
        }

        tracing::info!(language = %language, command = %config.command, "Starting LSP server");

        let mut child = Command::new(&config.command)
            .args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("Failed to spawn LSP process: {}", config.command))?;

        let stdin = child.stdin.take().context("Failed to capture LSP stdin")?;
        let stdout = child.stdout.take().context("Failed to capture LSP stdout")?;

        processes.insert(
            language.to_string(),
            LspProcess {
                child,
                stdin,
                stdout: BufReader::new(stdout),
            },
        );

        Ok(())
    }

    pub async fn stop_lsp(&self, language: &str) -> Result<()> {
        let mut processes = self.processes.lock().await;

        if let Some(mut process) = processes.remove(language) {
            tracing::info!(language = %language, "Stopping LSP server");
            let _ = process.child.start_kill();
            let _ = process.child.wait().await;
        }

        Ok(())
    }

    pub async fn send_request(
        &self,
        language: &str,
        request: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let mut processes = self.processes.lock().await;

        let process = processes
            .get_mut(language)
            .with_context(|| format!("LSP not running for language: {}", language))?;

        let body = serde_json::to_vec(&request)?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());

        process
            .stdin
            .write_all(header.as_bytes())
            .await
            .context("Failed to write LSP header")?;
        process
            .stdin
            .write_all(&body)
            .await
            .context("Failed to write LSP body")?;
        process.stdin.flush().await.context("Failed to flush LSP stdin")?;

        read_message(&mut process.stdout).await
    }

    pub async fn is_running(&self, language: &str) -> bool {
        let processes = self.processes.lock().await;
        processes.contains_key(language)
    }
}

impl Default for LspManager {
    fn default() -> Self {
        Self::new()
    }
}

async fn read_message(
    stdout: &mut BufReader<ChildStdout>,
) -> Result<serde_json::Value> {
    use tokio::io::AsyncBufReadExt;

    let mut content_length: Option<usize> = None;

    loop {
        let mut line = String::new();
        let bytes = stdout
            .read_line(&mut line)
            .await
            .context("Failed reading LSP header line")?;
        if bytes == 0 {
            anyhow::bail!("LSP stdout closed before response");
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }

        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            content_length = Some(
                rest.trim()
                    .parse::<usize>()
                    .context("Invalid Content-Length")?,
            );
        }
    }

    let length = content_length.context("Missing Content-Length in LSP response")?;
    let mut body = vec![0u8; length];
    stdout
        .read_exact(&mut body)
        .await
        .context("Failed reading LSP response body")?;

    Ok(serde_json::from_slice(&body)?)
}
