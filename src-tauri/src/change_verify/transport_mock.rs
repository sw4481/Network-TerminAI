use super::transport::ShowTransport;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use parking_lot::Mutex;
use std::collections::HashMap;

pub struct MockTransport {
    platform: (String, String),
    responses: Mutex<HashMap<String, String>>,
}

impl MockTransport {
    pub fn new(vendor: &str, platform: &str) -> Self {
        Self {
            platform: (vendor.into(), platform.into()),
            responses: Mutex::new(HashMap::new()),
        }
    }
    pub fn set(&self, cmd: &str, raw: &str) {
        self.responses.lock().insert(cmd.into(), raw.into());
    }
}

#[async_trait]
impl ShowTransport for MockTransport {
    async fn run_show(&self, _tab: &str, cmd: &str) -> Result<String> {
        self.responses
            .lock()
            .get(cmd)
            .cloned()
            .ok_or_else(|| anyhow!("mock has no response for {cmd}"))
    }
    async fn detect_platform(&self, _tab: &str) -> Result<(String, String)> {
        Ok(self.platform.clone())
    }
}
