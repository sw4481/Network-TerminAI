use crate::mcp::Transport;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures::stream::StreamExt;
use reqwest;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

/// SSE Transport for MCP over HTTP with Server-Sent Events
pub struct SseTransport {
    base_url: String,
    client: reqwest::Client,
    response_queue: Arc<Mutex<tokio::sync::mpsc::UnboundedReceiver<Value>>>,
    sse_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    sender: Arc<tokio::sync::mpsc::UnboundedSender<Value>>,
}

impl SseTransport {
    /// Create a new SSE transport with the given base URL
    pub async fn new(base_url: &str) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let sender = Arc::new(tx);

        let transport = Self {
            base_url: base_url.to_string(),
            client: client.clone(),
            response_queue: Arc::new(Mutex::new(rx)),
            sse_task: Arc::new(Mutex::new(None)),
            sender: sender.clone(),
        };

        // Start SSE connection
        transport.connect_sse().await?;

        Ok(transport)
    }

    /// Connect to the SSE endpoint and start listening for events
    async fn connect_sse(&self) -> Result<()> {
        let url = format!("{}/sse", self.base_url);
        let sender = self.sender.clone();

        let client = self.client.clone();
        let task = tokio::spawn(async move {
            loop {
                match Self::sse_loop(&client, &url, sender.clone()).await {
                    Ok(_) => break,
                    Err(e) => {
                        eprintln!("SSE connection error: {}, reconnecting...", e);
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        });

        let mut sse_task = self.sse_task.lock().await;
        *sse_task = Some(task);

        Ok(())
    }

    /// Internal SSE loop to read events
    async fn sse_loop(
        client: &reqwest::Client,
        url: &str,
        sender: Arc<tokio::sync::mpsc::UnboundedSender<Value>>,
    ) -> Result<()> {
        let response = timeout(Duration::from_secs(10), client.get(url).send())
            .await
            .map_err(|_| anyhow!("SSE connection timeout"))?
            .map_err(|e| anyhow!("SSE request failed: {}", e))?;

        if !response.status().is_success() {
            return Err(anyhow!("SSE connection failed: {}", response.status()));
        }

        let mut stream = response.bytes_stream();

        let mut buffer = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| anyhow!("Stream error: {}", e))?;
            let text = String::from_utf8_lossy(&chunk);

            for line in text.lines() {
                if line.starts_with("data:") {
                    let data = line.strip_prefix("data:").unwrap().trim();
                    if !data.is_empty() {
                        if let Ok(value) = serde_json::from_str::<Value>(data) {
                            let _ = sender.send(value);
                        }
                    }
                } else if line.is_empty() && !buffer.is_empty() {
                    buffer.clear();
                }
            }
        }

        Ok(())
    }

    /// Send a JSON-RPC request via HTTP POST
    async fn post_request(&self, endpoint: &str, request: Value) -> Result<Value> {
        let url = format!("{}{}", self.base_url, endpoint);
        let response = self
            .client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| anyhow!("HTTP POST failed: {}", e))?;

        if !response.status().is_success() {
            return Err(anyhow!(
                "HTTP POST to {} failed: {}",
                endpoint,
                response.status()
            ));
        }

        let value = response
            .json::<Value>()
            .await
            .map_err(|e| anyhow!("Failed to parse JSON response: {}", e))?;

        Ok(value)
    }

    /// Determine the endpoint based on the method
    fn endpoint_for_method(method: &str) -> &str {
        match method {
            "initialize" => "/initialize",
            "tools/list" => "/tools/list",
            "tools/call" => "/tools/call",
            _ => "/rpc",
        }
    }
}

#[async_trait]
impl Transport for SseTransport {
    async fn send(&self, request: Value) -> Result<()> {
        let method = request["method"]
            .as_str()
            .ok_or_else(|| anyhow!("Missing method in request"))?;

        let endpoint = Self::endpoint_for_method(method);

        // Send HTTP POST and get response
        let response = self.post_request(endpoint, request.clone()).await?;

        // Push response to queue for receive() to consume
        self.sender
            .send(response)
            .map_err(|_| anyhow!("Failed to queue response"))?;

        Ok(())
    }

    async fn receive(&self) -> Result<Value> {
        let mut queue = self.response_queue.lock().await;
        queue
            .recv()
            .await
            .ok_or_else(|| anyhow!("Response channel closed"))
    }

    async fn close(&self) -> Result<()> {
        let mut task = self.sse_task.lock().await;
        if let Some(handle) = task.take() {
            handle.abort();
        }
        Ok(())
    }
}

impl Drop for SseTransport {
    fn drop(&mut self) {
        // Abort SSE task on drop
        if let Ok(mut task) = self.sse_task.try_lock() {
            if let Some(handle) = task.take() {
                handle.abort();
            }
        }
    }
}
