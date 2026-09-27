//! Device-worker abstraction. Real implementations talk russh / NETCONF;
//! tests inject a `MockWorkerFactory` that records peak concurrency without
//! touching the network.

use crate::fanout::auth::DeviceCreds;
use crate::fanout::events::FailureKind;
use crate::fanout::model::DeviceKind;
use async_trait::async_trait;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

#[derive(Debug)]
pub struct WorkerOutcome {
    pub raw_output: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub enum WorkerError {
    Timeout,
    Auth(String),
    Connect(String),
    Protocol(String),
    Other(String),
}

impl WorkerError {
    pub fn kind(&self) -> FailureKind {
        match self {
            WorkerError::Timeout => FailureKind::Timeout,
            WorkerError::Auth(_) => FailureKind::Auth,
            WorkerError::Connect(_) => FailureKind::Connect,
            WorkerError::Protocol(_) => FailureKind::Protocol,
            WorkerError::Other(_) => FailureKind::Other,
        }
    }
    pub fn message(&self) -> String {
        match self {
            WorkerError::Timeout => "timed out".to_string(),
            WorkerError::Auth(s)
            | WorkerError::Connect(s)
            | WorkerError::Protocol(s)
            | WorkerError::Other(s) => s.clone(),
        }
    }
}

#[async_trait]
pub trait DeviceWorker: Send + Sync {
    async fn run(&self, command: &str, timeout: Duration) -> Result<WorkerOutcome, WorkerError>;
}

#[async_trait]
pub trait WorkerFactory: Send + Sync {
    fn create(
        &self,
        kind: DeviceKind,
        creds: DeviceCreds,
    ) -> Box<dyn DeviceWorker>;
}

// ---------- Mock factory used by tests ----------

#[derive(Clone)]
pub struct MockWorkerFactory {
    inner: Arc<MockInner>,
}

struct MockInner {
    delay: Duration,
    fail_kind: Option<WorkerError>,
    inflight: AtomicUsize,
    peak: AtomicUsize,
    history: Mutex<Vec<String>>,
}

impl MockWorkerFactory {
    pub fn with_delay(delay: Duration) -> Self {
        Self {
            inner: Arc::new(MockInner {
                delay,
                fail_kind: None,
                inflight: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
                history: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn failing(delay: Duration, err: WorkerError) -> Self {
        Self {
            inner: Arc::new(MockInner {
                delay,
                fail_kind: Some(err),
                inflight: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
                history: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn peak_concurrency(&self) -> usize {
        self.inner.peak.load(Ordering::SeqCst)
    }

    pub async fn history(&self) -> Vec<String> {
        self.inner.history.lock().await.clone()
    }
}

#[async_trait]
impl WorkerFactory for MockWorkerFactory {
    fn create(&self, _kind: DeviceKind, _creds: DeviceCreds) -> Box<dyn DeviceWorker> {
        Box::new(MockWorker {
            inner: self.inner.clone(),
        })
    }
}

struct MockWorker {
    inner: Arc<MockInner>,
}

#[async_trait]
impl DeviceWorker for MockWorker {
    async fn run(&self, command: &str, timeout: Duration) -> Result<WorkerOutcome, WorkerError> {
        // peak concurrency tracking
        let now = self.inner.inflight.fetch_add(1, Ordering::SeqCst) + 1;
        loop {
            let cur = self.inner.peak.load(Ordering::SeqCst);
            if now <= cur {
                break;
            }
            if self
                .inner
                .peak
                .compare_exchange_weak(cur, now, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                break;
            }
        }
        self.inner.history.lock().await.push(command.to_string());

        let start = std::time::Instant::now();
        let elapsed = self.inner.delay;
        let result = if let Some(err) = &self.inner.fail_kind {
            tokio::time::sleep(elapsed.min(Duration::from_millis(50))).await;
            Err(err.clone())
        } else {
            // Honor caller-supplied timeout
            let work = tokio::time::sleep(elapsed);
            tokio::select! {
                _ = work => Ok(WorkerOutcome {
                    raw_output: format!("MOCK_OUTPUT cmd={command}\n"),
                    duration_ms: start.elapsed().as_millis() as u64,
                }),
                _ = tokio::time::sleep(timeout) => Err(WorkerError::Timeout),
            }
        };

        self.inner.inflight.fetch_sub(1, Ordering::SeqCst);
        result
    }
}
