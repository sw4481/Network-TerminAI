//! Production `WorkerFactory` that wires real SSH/NETCONF transports.

use crate::fanout::auth::DeviceCreds;
use crate::fanout::model::DeviceKind;
use crate::fanout::worker::{DeviceWorker, WorkerError, WorkerFactory, WorkerOutcome};
use async_trait::async_trait;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct LiveFactory;

impl LiveFactory {
    pub fn new() -> Arc<dyn WorkerFactory> {
        Arc::new(Self)
    }
}

#[async_trait]
impl WorkerFactory for LiveFactory {
    fn create(&self, kind: DeviceKind, creds: DeviceCreds) -> Box<dyn DeviceWorker> {
        match (kind, creds) {
            (
                DeviceKind::Ssh,
                DeviceCreds::Ssh {
                    host,
                    port,
                    user,
                    identity: _,
                    password,
                },
            ) => Box::new(SshWorker {
                host,
                port,
                user,
                password,
            }),
            (DeviceKind::Netconf, DeviceCreds::Netconf { .. }) => Box::new(NetconfStubWorker),
            _ => Box::new(MismatchedKindWorker),
        }
    }
}

struct SshWorker {
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
}

#[async_trait]
impl DeviceWorker for SshWorker {
    async fn run(&self, command: &str, timeout: Duration) -> Result<WorkerOutcome, WorkerError> {
        let started = Instant::now();
        let exec = ssh_exec_oneshot(
            self.host.clone(),
            self.port,
            self.user.clone(),
            self.password.clone(),
            command.to_string(),
        );
        match tokio::time::timeout(timeout, exec).await {
            Err(_) => Err(WorkerError::Timeout),
            Ok(Err(e)) => Err(e),
            Ok(Ok(raw_output)) => Ok(WorkerOutcome {
                raw_output,
                duration_ms: started.elapsed().as_millis() as u64,
            }),
        }
    }
}

async fn ssh_exec_oneshot(
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    command: String,
) -> Result<String, WorkerError> {
    use russh::client::{self, Handler};
    use russh::keys::ssh_key::PublicKey;

    struct AcceptAll;
    impl Handler for AcceptAll {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            _key: &PublicKey,
        ) -> std::result::Result<bool, Self::Error> {
            Ok(true)
        }
    }

    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        ..client::Config::default()
    });
    let mut session = client::connect(config, (host.as_str(), port), AcceptAll)
        .await
        .map_err(|e| WorkerError::Connect(e.to_string()))?;

    let pw = password.ok_or_else(|| WorkerError::Auth("no password".into()))?;
    let auth = session
        .authenticate_password(user, pw)
        .await
        .map_err(|e| WorkerError::Auth(e.to_string()))?;
    if !auth.success() {
        return Err(WorkerError::Auth("authentication failed".into()));
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| WorkerError::Protocol(e.to_string()))?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| WorkerError::Protocol(e.to_string()))?;

    let mut stdout = Vec::<u8>::new();
    let mut stream = channel.into_stream();
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => stdout.extend_from_slice(&buf[..n]),
            Err(e) => return Err(WorkerError::Protocol(e.to_string())),
        }
    }
    let _ = stream.shutdown().await;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

struct NetconfStubWorker;

#[async_trait]
impl DeviceWorker for NetconfStubWorker {
    async fn run(&self, _command: &str, _timeout: Duration) -> Result<WorkerOutcome, WorkerError> {
        Err(WorkerError::Protocol(
            "netconf fan-out worker requires raw <rpc> payload (not yet implemented)".into(),
        ))
    }
}

struct MismatchedKindWorker;

#[async_trait]
impl DeviceWorker for MismatchedKindWorker {
    async fn run(&self, _command: &str, _timeout: Duration) -> Result<WorkerOutcome, WorkerError> {
        Err(WorkerError::Other("device kind / credential mismatch".into()))
    }
}
