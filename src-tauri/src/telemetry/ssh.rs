//! Isolated exec candidate, proven against a local peer, not actual IOS releases.
//! Keep the owner runtime alive until resolver.shutdown() succeeds, including after Drop.
use super::model::{Capture, CaptureRequest, Diagnostic, Platform, TargetRef};
use parking_lot::Mutex;
use rusqlite::Connection;
use russh::{
    client,
    keys::{self, PrivateKey, PrivateKeyWithHashAlg, PublicKey},
    ChannelMsg,
};
use std::{
    io::{Read, Write},
    net::Shutdown,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, Instant as StdInstant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpStream,
    sync::{mpsc, oneshot, Mutex as AsyncMutex},
    task::JoinHandle,
    time::{timeout, Instant},
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const CLEANUP_BUDGET: Duration = Duration::from_secs(3);
#[cfg(test)]
thread_local! {
    static AFTER_TRUST_READ: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
fn failure(code: &str, message: &str) -> Diagnostic {
    Diagnostic::new(code, message, "ssh")
}
fn cancelled() -> Diagnostic {
    failure("ssh_cancelled", "Telemetry SSH operation was cancelled")
}
fn pending() -> Diagnostic {
    failure(
        "ssh_cleanup_pending",
        "SSH cleanup is pending; keep the runtime alive and retry resolver shutdown",
    )
}

/// One resolver per target/generation; shutdown also owns failed-connect cleanup.
/// Resolution is synchronous DB/file work; call from the service's owned blocking worker.
pub struct TelemetrySshTargetResolver {
    db: Arc<Mutex<Connection>>,
    known_hosts: PathBuf,
    owners: Arc<SshOwners>,
}

pub(crate) struct SavedTargetMetadata {
    pub reference: TargetRef,
    pub display_name: String,
}
fn saved_platform(saved: &str, selected: Platform) -> Result<Platform, Diagnostic> {
    let platform = match saved {
        "ios" => Platform::Ios,
        "iosxe" => Platform::Iosxe,
        "generic" => selected,
        _ => {
            return Err(failure(
                "ssh_platform_unsupported",
                "Saved platform is unsupported by telemetry",
            ))
        }
    };
    if platform != selected {
        return Err(failure(
            "ssh_platform_mismatch",
            "Saved platform differs from the selected telemetry profile",
        ));
    }
    Ok(platform)
}
/// Metadata admission deliberately selects no authentication or filesystem fields.
pub(crate) fn saved_target_metadata(
    db: &Connection,
    target: TargetRef,
) -> Result<SavedTargetMetadata, Diagnostic> {
    let (name, platform): (String, String) = db
        .query_row(
            "SELECT name, platform FROM ssh_connections WHERE id = ?1",
            [&target.connection_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| failure("ssh_saved_target", "Saved SSH connection could not be read"))?;
    saved_platform(&platform, target.platform)?;
    Ok(SavedTargetMetadata {
        reference: target,
        display_name: name,
    })
}
// Deliberately neither Debug nor Serialize: saved auth never becomes diagnostics/events.
enum SavedAuth {
    Password(Zeroizing<String>),
    Identity(Arc<PrivateKey>),
}
pub struct TelemetrySshTarget {
    id: String,
    display_name: String,
    platform: Platform,
    host: String,
    port: u16,
    username: Zeroizing<String>,
    auth: SavedAuth,
    known_keys: Vec<PublicKey>,
    owners: Arc<SshOwners>,
}
impl TelemetrySshTargetResolver {
    pub fn new(db: Arc<Mutex<Connection>>, known_hosts: PathBuf) -> Self {
        Self {
            db,
            known_hosts,
            owners: Arc::new(SshOwners::default()),
        }
    }
    pub fn resolve(&self, target: &TargetRef) -> Result<TelemetrySshTarget, Diagnostic> {
        if self.owners.stop.is_cancelled() {
            return Err(failure("ssh_shutdown", "SSH owner is shut down"));
        }
        let saved =
            crate::commands::ssh::get_connection_impl(&self.db.lock(), &target.connection_id)
                .map_err(|_| {
                    failure("ssh_saved_target", "Saved SSH connection could not be read")
                })?;
        let platform = saved_platform(&saved.platform, target.platform)?;
        let port = u16::try_from(saved.port.unwrap_or(22))
            .ok()
            .filter(|p| *p != 0)
            .ok_or_else(|| failure("ssh_saved_target", "Saved SSH port is invalid"))?;
        let username = saved
            .user
            .filter(|user| !user.trim().is_empty())
            .map(Zeroizing::new)
            .ok_or_else(|| failure("ssh_auth_missing", "Save an explicit SSH username"))?;
        if saved.host.trim().is_empty() {
            return Err(failure("ssh_saved_target", "Saved SSH host is empty"));
        }
        let auth = if let Some(file) = saved.identity_file.filter(|file| !file.is_empty()) {
            let mut encoded = Zeroizing::new(String::new());
            std::fs::File::open(file)
                .and_then(|file| file.take(64 * 1024 + 1).read_to_string(&mut encoded))
                .map_err(|_| {
                    failure(
                        "ssh_identity_unavailable",
                        "Saved SSH identity could not be read; password fallback is disabled",
                    )
                })?;
            if encoded.len() > 64 * 1024 {
                return Err(failure(
                    "ssh_identity_unavailable",
                    "Saved SSH identity exceeds the supported key size",
                ));
            }
            if encoded.lines().any(|line| {
                matches!(
                    line,
                    "-----BEGIN ENCRYPTED PRIVATE KEY-----" | "Proc-Type: 4,ENCRYPTED"
                )
            }) {
                return Err(failure("ssh_identity_passphrase_required", "Saved identity needs a passphrase unavailable to telemetry; password fallback is disabled"));
            }
            let key = keys::decode_secret_key(&encoded, None).map_err(|error| match error {
                keys::Error::KeyIsEncrypted => failure("ssh_identity_passphrase_required", "Saved identity needs a passphrase unavailable to telemetry; password fallback is disabled"),
                _ => failure("ssh_identity_unsupported", "Saved identity format or encryption is unsupported; password fallback is disabled"),
            })?;
            SavedAuth::Identity(Arc::new(key))
        } else {
            let encrypted = saved.password_encrypted.ok_or_else(|| failure("ssh_auth_missing", "Save a password or supported identity; agent and keyboard-interactive authentication are unsupported"))?;
            SavedAuth::Password(Zeroizing::new(
                crate::commands::ssh::decrypt_password(&encrypted).map_err(|_| {
                    failure(
                        "ssh_auth_unavailable",
                        "Saved SSH password could not be decrypted",
                    )
                })?,
            ))
        };
        // Marker policy and the pinned path-only matcher must consume identical owned bytes.
        let trust = match std::fs::read_to_string(&self.known_hosts) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(_) => {
                return Err(failure(
                    "ssh_trust_unavailable",
                    "Known-host trust file could not be read",
                ))
            }
        };
        #[cfg(test)]
        AFTER_TRUST_READ.with(|hook| {
            if let Some(replace) = hook.borrow_mut().take() {
                replace();
            }
        });
        if trust.lines().any(|line| line.trim_start().starts_with('@')) {
            return Err(failure("ssh_trust_unsupported", "Known-host trust markers are unsupported; provide an explicit verified host-key entry in a dedicated trust file"));
        }
        let mut snapshot = tempfile::NamedTempFile::new().map_err(|_| {
            failure(
                "ssh_trust_unavailable",
                "Private trust snapshot could not be created",
            )
        })?;
        snapshot
            .write_all(trust.as_bytes())
            .and_then(|_| snapshot.flush())
            .map_err(|_| {
                failure(
                    "ssh_trust_unavailable",
                    "Private trust snapshot could not be written",
                )
            })?;
        let known_keys =
            keys::known_hosts::known_host_keys_path(&saved.host, port, snapshot.path())
                .map_err(|_| {
                    failure(
                        "ssh_trust_unavailable",
                        "Known-host trust entries could not be read",
                    )
                })?
                .into_iter()
                .map(|(_, key)| key)
                .collect();
        Ok(TelemetrySshTarget {
            id: saved.id,
            display_name: saved.name,
            platform,
            host: saved.host,
            port,
            username,
            auth,
            known_keys,
            owners: self.owners.clone(),
        })
    }
    pub async fn shutdown(&self) -> Result<(), Diagnostic> {
        self.owners.shutdown(CLEANUP_BUDGET).await
    }
}
impl TelemetrySshTarget {
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}
#[derive(Default)]
struct SshOwners {
    stop: CancellationToken,
    tasks: Mutex<Vec<Arc<SessionOwner>>>,
}
impl SshOwners {
    async fn shutdown(&self, budget: Duration) -> Result<(), Diagnostic> {
        let owners = {
            let tasks = self.tasks.lock();
            self.stop.cancel();
            tasks.clone()
        };
        for owner in &owners {
            owner.stop.cancel();
        }
        let result = timeout(budget, async {
            for owner in owners {
                owner.join().await?;
            }
            Ok(())
        })
        .await
        .map_err(|_| pending())?;
        self.tasks
            .lock()
            .retain(|owner| !owner.joined.load(Ordering::Acquire));
        result
    }
}
impl Drop for SshOwners {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
struct SessionOwner {
    stop: CancellationToken,
    task: AsyncMutex<Option<JoinHandle<()>>>,
    joined: AtomicBool,
    runtime: tokio::runtime::Handle,
}
impl SessionOwner {
    async fn join(&self) -> Result<(), Diagnostic> {
        let mut slot = self.task.lock().await;
        if let Some(task) = slot.as_mut() {
            let result = task.await;
            slot.take();
            self.joined.store(true, Ordering::Release);
            result
                .map_err(|_| failure("ssh_owner_failed", "SSH owner task failed during cleanup"))?;
        }
        Ok(())
    }
}
impl Drop for SessionOwner {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(task) = self.task.get_mut().take() {
            // Drop cannot await. The resolver's shutdown is the observable cleanup boundary.
            self.runtime.spawn(async move {
                let _ = task.await;
            });
        }
    }
}
struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
struct Job {
    request: CaptureRequest,
    cancel: CancellationToken,
    deadline: Instant,
    reply: oneshot::Sender<Result<Capture, Diagnostic>>,
}
pub struct TelemetrySshSession {
    jobs: mpsc::Sender<Job>,
    owner: Arc<SessionOwner>,
    _owners: Arc<SshOwners>,
    command_timeout: Duration,
}
impl TelemetrySshSession {
    pub async fn connect(
        target: TelemetrySshTarget,
        cancel: CancellationToken,
    ) -> Result<Self, Diagnostic> {
        if !crate::logging::ssh_privacy_installed() {
            return Err(failure("ssh_logging_privacy_unavailable", "Telemetry SSH requires the app's immutable wire-log privacy boundary; restart after resolving logging initialization errors"));
        }
        if target.owners.stop.is_cancelled() {
            return Err(failure("ssh_shutdown", "SSH owner is shut down"));
        }
        let runtime = tokio::runtime::Handle::current();
        let stop = target.owners.stop.child_token();
        let owners = target.owners.clone();
        let (jobs, receive) = mpsc::channel(1);
        let (ready, mut initialized) = oneshot::channel();
        let owner = {
            let mut tasks = owners.tasks.lock();
            if owners.stop.is_cancelled() {
                return Err(failure("ssh_shutdown", "SSH owner is shut down"));
            }
            let task = runtime.spawn(run_actor(target, stop.clone(), receive, ready));
            let owner = Arc::new(SessionOwner {
                stop,
                task: AsyncMutex::new(Some(task)),
                joined: AtomicBool::new(false),
                runtime,
            });
            tasks.retain(|owner| !owner.joined.load(Ordering::Acquire));
            tasks.push(owner.clone());
            owner
        };
        let mut session = Self {
            jobs,
            owner,
            _owners: owners,
            command_timeout: COMMAND_TIMEOUT,
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(cancelled()),
            _ = tokio::time::sleep(CONNECT_TIMEOUT) => Err(failure("ssh_timeout", "SSH connect/auth deadline exceeded")),
            result = &mut initialized => result.unwrap_or_else(|_| Err(failure("ssh_connect_failed", "SSH owner exited before authentication"))),
        };
        if let Err(error) = result {
            session.close().await?;
            return Err(error);
        }
        Ok(session)
    }
    pub async fn capture(
        &mut self,
        request: &CaptureRequest,
        cancel: CancellationToken,
    ) -> Result<Capture, Diagnostic> {
        if self.owner.stop.is_cancelled() {
            return Err(failure("ssh_closed", "SSH session is closed"));
        }
        let local_cancel = cancel.child_token();
        let _guard = CancelOnDrop(local_cancel.clone());
        let deadline = Instant::now() + self.command_timeout;
        let (reply, mut receive) = oneshot::channel();
        let job = Job {
            request: request.clone(),
            cancel: local_cancel,
            deadline,
            reply,
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(cancelled()),
            _ = tokio::time::sleep_until(deadline) => Err(failure("ssh_timeout", "SSH command deadline exceeded")),
            result = async {
                self.jobs.send(job).await.map_err(|_| failure("ssh_closed", "SSH session is closed"))?;
                (&mut receive).await.unwrap_or_else(|_| Err(failure("ssh_closed", "SSH owner exited")))
            } => result,
        };
        if result.is_err() {
            self.close().await?;
        }
        result
    }
    pub async fn close(&mut self) -> Result<(), Diagnostic> {
        self.owner.stop.cancel();
        timeout(CLEANUP_BUDGET, self.owner.join())
            .await
            .map_err(|_| pending())?
    }
}
impl Drop for TelemetrySshSession {
    fn drop(&mut self) {
        self.owner.stop.cancel();
    }
}

struct VerifyKey {
    known: Vec<PublicKey>,
    rejection: Arc<Mutex<Option<Diagnostic>>>,
}
impl client::Handler for VerifyKey {
    type Error = russh::Error;
    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        // The default handler logs untrusted disconnect descriptions verbatim.
        match reason {
            client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            client::DisconnectReason::Error(error) => Err(error),
        }
    }
    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        // Same conservative multi-key semantics as pinned check_known_hosts_path.
        let changed = self
            .known
            .iter()
            .any(|known| known.algorithm() == key.algorithm() && known != key);
        if !changed && self.known.iter().any(|known| known == key) {
            return Ok(true);
        }
        let code = if changed {
            "ssh_host_key_changed"
        } else {
            "ssh_host_key_unknown"
        };
        *self.rejection.lock() = Some(Diagnostic::new(code, format!("Host key {} is not trusted. Verify the fingerprint and establish trust explicitly before retrying", key.fingerprint(keys::HashAlg::Sha256)), "ssh.host_key"));
        Ok(false)
    }
}
struct SocketControl(std::net::TcpStream);
impl Drop for SocketControl {
    fn drop(&mut self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}
async fn run_actor(
    target: TelemetrySshTarget,
    stop: CancellationToken,
    mut jobs: mpsc::Receiver<Job>,
    ready: oneshot::Sender<Result<(), Diagnostic>>,
) {
    let tcp = tokio::select! {
        biased;
        _ = stop.cancelled() => { let _ = ready.send(Err(cancelled())); return; },
        result = TcpStream::connect((target.host.as_str(), target.port)) => match result {
            Ok(stream) => stream,
            Err(_) => { let _ = ready.send(Err(failure("ssh_connect_failed", "SSH connection failed"))); return; }
        },
    };
    let setup = (|| {
        let tcp = tcp.into_std()?;
        let control = SocketControl(tcp.try_clone()?);
        Ok::<_, std::io::Error>((TcpStream::from_std(tcp)?, control))
    })();
    let (tcp, socket) = match setup {
        Ok(pair) => pair,
        Err(_) => {
            let _ = ready.send(Err(failure(
                "ssh_connect_failed",
                "SSH socket ownership could not be established",
            )));
            return;
        }
    };
    let rejection = Arc::new(Mutex::new(None));
    let handler = VerifyKey {
        known: target.known_keys,
        rejection: rejection.clone(),
    };
    let config = Arc::new(client::Config {
        channel_buffer_size: 4,
        window_size: 64 * 1024,
        maximum_packet_size: 32 * 1024,
        ..Default::default()
    });
    let connect = client::connect_stream(config, tcp, handler);
    tokio::pin!(connect);
    let connected = tokio::select! {
        biased;
        _ = stop.cancelled() => {
            let _ = socket.0.shutdown(Shutdown::Both);
            // connect_stream may already own a spawned russh task: never drop its future.
            (&mut connect).await
        },
        result = &mut connect => result,
    };
    let mut handle = match connected {
        Ok(handle) => handle,
        Err(_) => {
            let diagnostic = rejection.lock().take().unwrap_or_else(|| {
                if stop.is_cancelled() {
                    cancelled()
                } else {
                    failure(
                        "ssh_connect_failed",
                        "SSH handshake or algorithm negotiation failed",
                    )
                }
            });
            let _ = ready.send(Err(diagnostic));
            return;
        }
    };
    let auth = tokio::select! {
        biased;
        _ = stop.cancelled() => Err(cancelled()),
        result = async {
            let result = match target.auth {
                SavedAuth::Password(password) => handle.authenticate_password(target.username.as_str(), password.as_str()).await,
                SavedAuth::Identity(key) => {
                    let hash = handle.best_supported_rsa_hash().await.map_err(|_| failure("ssh_auth_failed", "SSH identity negotiation failed"))?.flatten();
                    handle.authenticate_publickey(target.username.as_str(), PrivateKeyWithHashAlg::new(key, hash)).await
                }
            }.map_err(|_| failure("ssh_auth_failed", "Saved SSH authentication failed; correct saved authentication before explicit retry"))?;
            if result.success() { Ok(()) } else { Err(failure("ssh_auth_failed", "Saved SSH authentication failed or needs an unsupported additional method; explicit retry is required")) }
        } => result,
    };
    if let Err(error) = auth {
        cleanup(handle, socket).await;
        let _ = ready.send(Err(error));
        return;
    }
    if ready.send(Ok(())).is_err() {
        cleanup(handle, socket).await;
        return;
    }
    loop {
        let job = tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            job = jobs.recv() => match job { Some(job) => job, None => break },
        };
        let result = tokio::select! {
            biased;
            _ = stop.cancelled() => Err(cancelled()),
            _ = job.cancel.cancelled() => Err(cancelled()),
            _ = tokio::time::sleep_until(job.deadline) => Err(failure("ssh_timeout", "SSH command deadline exceeded")),
            result = collect(&mut handle, &job.request) => result,
        };
        let result = result.map(|raw| {
            static CLOCK: OnceLock<StdInstant> = OnceLock::new();
            Capture {
                capture_id: uuid::Uuid::new_v4().to_string(),
                target_id: target.id.clone(),
                platform: target.platform,
                command: job.request.command.as_str().into(),
                parser_id: job.request.parser_id.clone(),
                revision: job.request.revision.clone(),
                observed_at_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .min(i64::MAX as u128) as i64,
                monotonic_ms: CLOCK
                    .get_or_init(StdInstant::now)
                    .elapsed()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
                raw,
            }
        });
        if result.is_err() {
            cleanup(handle, socket).await;
            let _ = job.reply.send(result);
            return;
        }
        let _ = job.reply.send(result);
    }
    cleanup(handle, socket).await;
}
async fn cleanup(mut handle: client::Handle<VerifyKey>, socket: SocketControl) {
    let _ = timeout(
        Duration::from_millis(100),
        handle.disconnect(russh::Disconnect::ByApplication, "", ""),
    )
    .await;
    let _ = socket.0.shutdown(Shutdown::Both);
    // Await observes the actual russh session task's JoinHandle, including after socket shutdown.
    let _ = (&mut handle).await;
}
async fn collect(
    handle: &mut client::Handle<VerifyKey>,
    request: &CaptureRequest,
) -> Result<String, Diagnostic> {
    let mut channel = handle.channel_open_session().await.map_err(|_| {
        failure(
            "ssh_channel_failed",
            "SSH session channel could not be opened",
        )
    })?;
    channel
        .exec(true, request.command.as_str().as_bytes())
        .await
        .map_err(|_| {
            failure(
                "ssh_exec_unsupported",
                "SSH exec request failed; actual target channel acceptance remains unverified",
            )
        })?;
    let mut output = Vec::new();
    let mut eof = false;
    let mut status = None;
    let mut accepted = false;
    let mut total = 0usize;
    let mut stderr = false;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => accepted = true,
            Some(ChannelMsg::Failure) => return Err(failure("ssh_exec_unsupported", "Server rejected SSH exec; retain the rejection before evaluating another channel mode")),
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) if eof => { let _ = data; return Err(failure("ssh_incomplete_output", "SSH output arrived after EOF")); },
            Some(ChannelMsg::Data { data }) => {
                total = total.saturating_add(data.len());
                if total > request.command.cost().max_output_bytes.min(2 * 1024 * 1024) { return Err(failure("ssh_output_limit", "SSH output exceeded the admitted capture limit")); }
                output.extend_from_slice(&data);
            },
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                total = total.saturating_add(data.len());
                if total > request.command.cost().max_output_bytes.min(2 * 1024 * 1024) { return Err(failure("ssh_output_limit", "SSH output exceeded the admitted capture limit")); }
                stderr = true;
            },
            Some(ChannelMsg::Eof) => eof = true,
            Some(ChannelMsg::ExitStatus { exit_status }) => { if status.replace(exit_status).is_some() { return Err(failure("ssh_incomplete_output", "SSH sent multiple exit statuses")); } },
            Some(ChannelMsg::ExitSignal { .. }) => return Err(failure("ssh_command_failed", "SSH command terminated by signal")),
            Some(ChannelMsg::Close) | None => break,
            _ => {},
        }
    }
    channel
        .close()
        .await
        .map_err(|_| failure("ssh_channel_failed", "SSH channel close could not be sent"))?;
    if !accepted || !eof || status.is_none() {
        return Err(failure(
            "ssh_incomplete_output",
            "SSH capture needs exec acceptance, EOF, exit status and channel closure",
        ));
    }
    if status != Some(0) {
        return Err(failure(
            "ssh_command_failed",
            "SSH command returned a nonzero exit status",
        ));
    }
    if stderr {
        return Err(failure(
            "ssh_stderr",
            "SSH command produced error output; raw diagnostics are private",
        ));
    }
    String::from_utf8(output)
        .map_err(|_| failure("ssh_output_encoding", "SSH capture is not valid UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        commands::ssh::{save_connection_impl, SaveSshConnectionRequest},
        telemetry::policy::CommandPolicy,
    };
    use russh::{
        keys::{
            ssh_key::{self, private::Ed25519Keypair},
            PrivateKey, PublicKey,
        },
        server, Channel, ChannelId,
    };
    use std::{
        collections::HashSet,
        sync::atomic::{AtomicUsize, Ordering},
    };
    use tokio::{
        net::TcpListener,
        task::{JoinHandle, JoinSet},
    };

    const PASSWORD: &str = "fixture-password-NEVER-LOG-6321";
    fn init_fixture_logging() -> &'static tempfile::TempDir {
        static LOGS: OnceLock<tempfile::TempDir> = OnceLock::new();
        LOGS.get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            crate::logging::init_logging(
                crate::logging::LogConfig::new()
                    .with_log_dir(dir.path().to_path_buf())
                    .with_production_mode(
                        std::env::var("TASK6_LOG_CASE").is_ok_and(|case| case.ends_with("json")),
                    ),
            )
            .unwrap();
            dir
        })
    }
    fn key(seed: u8) -> PrivateKey {
        PrivateKey::new(Ed25519Keypair::from_seed(&[seed; 32]).into(), "fixture").unwrap()
    }
    #[derive(Clone, Copy)]
    enum Reply {
        Complete,
        Hang,
        Reject,
        Nonzero,
        MissingEof,
        MissingStatus,
        Large,
        Stderr,
        Tail,
        Disconnect,
    }
    #[derive(Default)]
    struct PeerState {
        commands: AtomicUsize,
        accepted_connections: AtomicUsize,
        password_attempts: AtomicUsize,
        key_attempts: AtomicUsize,
        owned_open_channels: AtomicUsize,
        sessions: AtomicUsize,
        interactive_terminal_command_count: AtomicUsize,
    }
    struct Handler {
        state: Arc<PeerState>,
        reply: Reply,
        channels: HashSet<ChannelId>,
    }
    impl Drop for Handler {
        fn drop(&mut self) {
            self.state
                .owned_open_channels
                .fetch_sub(self.channels.len(), Ordering::SeqCst);
            self.state.sessions.fetch_sub(1, Ordering::SeqCst);
        }
    }
    impl server::Handler for Handler {
        type Error = russh::Error;
        async fn auth_password(
            &mut self,
            user: &str,
            password: &str,
        ) -> Result<server::Auth, Self::Error> {
            self.state.password_attempts.fetch_add(1, Ordering::SeqCst);
            Ok(if user == "fixture-user" && password == PASSWORD {
                server::Auth::Accept
            } else {
                server::Auth::Reject {
                    proceed_with_methods: None,
                    partial_success: false,
                }
            })
        }
        async fn auth_publickey(
            &mut self,
            user: &str,
            public: &PublicKey,
        ) -> Result<server::Auth, Self::Error> {
            self.state.key_attempts.fetch_add(1, Ordering::SeqCst);
            Ok(
                if user == "fixture-user" && public.key_data() == key(2).public_key().key_data() {
                    server::Auth::Accept
                } else {
                    server::Auth::Reject {
                        proceed_with_methods: None,
                        partial_success: false,
                    }
                },
            )
        }
        async fn channel_open_session(
            &mut self,
            channel: Channel<server::Msg>,
            _session: &mut server::Session,
        ) -> Result<bool, Self::Error> {
            self.channels.insert(channel.id());
            self.state
                .owned_open_channels
                .fetch_add(1, Ordering::SeqCst);
            Ok(true)
        }
        async fn channel_close(
            &mut self,
            channel: ChannelId,
            _session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            if self.channels.remove(&channel) {
                self.state
                    .owned_open_channels
                    .fetch_sub(1, Ordering::SeqCst);
            }
            Ok(())
        }
        async fn shell_request(
            &mut self,
            channel: ChannelId,
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            if self.channels.remove(&channel) {
                self.state
                    .owned_open_channels
                    .fetch_sub(1, Ordering::SeqCst);
            }
            session.channel_success(channel)?;
            Ok(())
        }
        async fn data(
            &mut self,
            _channel: ChannelId,
            _data: &[u8],
            _session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            self.state
                .interactive_terminal_command_count
                .fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn exec_request(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            assert_eq!(data, b"show version");
            self.state.commands.fetch_add(1, Ordering::SeqCst);
            if matches!(self.reply, Reply::Reject) {
                session.channel_failure(channel)?;
                return Ok(());
            }
            session.channel_success(channel)?;
            if matches!(self.reply, Reply::Disconnect) {
                session.disconnect(
                    russh::Disconnect::ByApplication,
                    &format!("{PASSWORD} fixture-user T6RAW-73921"),
                    "",
                )?;
                return Ok(());
            }
            if matches!(self.reply, Reply::Hang) {
                return Ok(());
            }
            if matches!(self.reply, Reply::Large) {
                for _ in 0..17 {
                    session.data(channel, vec![b'x'; 32768])?;
                }
            } else {
                session.data(channel, b"T6RAW-73921 output\n".to_vec())?;
            }
            if matches!(self.reply, Reply::Stderr) {
                session.extended_data(channel, 1, PASSWORD.as_bytes().to_vec())?;
            }
            if !matches!(self.reply, Reply::MissingStatus) {
                session.exit_status_request(
                    channel,
                    if matches!(self.reply, Reply::Nonzero) {
                        7
                    } else {
                        0
                    },
                )?;
            }
            if matches!(self.reply, Reply::Tail) {
                session.data(channel, b"after status\n".to_vec())?;
            }
            if !matches!(self.reply, Reply::MissingEof) {
                session.eof(channel)?;
            }
            session.close(channel)?;
            Ok(())
        }
    }
    struct Peer {
        port: u16,
        state: Arc<PeerState>,
        stop: CancellationToken,
        owner: JoinHandle<()>,
        dir: tempfile::TempDir,
        db: Arc<Mutex<Connection>>,
        id: String,
        resolver: TelemetrySshTargetResolver,
    }
    impl Peer {
        async fn new(reply: Reply) -> Self {
            init_fixture_logging();
            Self::new_unlogged(reply).await
        }
        async fn new_unlogged(reply: Reply) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let state = Arc::new(PeerState::default());
            let stop = CancellationToken::new();
            let actor_stop = stop.clone();
            let actor_state = state.clone();
            let config = Arc::new(server::Config {
                keys: vec![key(1)],
                auth_rejection_time: Duration::ZERO,
                auth_rejection_time_initial: Some(Duration::ZERO),
                ..Default::default()
            });
            let owner = tokio::spawn(async move {
                let mut sessions = JoinSet::new();
                loop {
                    tokio::select! {
                        _ = actor_stop.cancelled() => break,
                        Some(_) = sessions.join_next(), if !sessions.is_empty() => {},
                        accepted = listener.accept() => {
                            let (stream, _) = accepted.unwrap();
                            let state = actor_state.clone();
                            state.accepted_connections.fetch_add(1, Ordering::SeqCst);
                            state.sessions.fetch_add(1, Ordering::SeqCst);
                            let handler = Handler { state, reply, channels: HashSet::new() };
                            let config = config.clone();
                            let stop = actor_stop.clone();
                            sessions.spawn(async move {
                                if let Ok(mut session) = server::run_stream(config, stream, handler).await {
                                    tokio::select! {
                                        _ = &mut session => return,
                                        _ = stop.cancelled() => {},
                                    }
                                    let _ = session.handle().disconnect(russh::Disconnect::ByApplication, String::new(), String::new()).await;
                                    let _ = session.await;
                                }
                            });
                        }
                    }
                }
                while sessions.join_next().await.is_some() {}
            });
            let dir = tempfile::tempdir().unwrap();
            let conn = Connection::open_in_memory().unwrap();
            for migration in [
                include_str!("../../migrations/V0024__ssh_connections.sql"),
                include_str!("../../migrations/V0025__ssh_passwords.sql"),
                include_str!("../../migrations/V0084__ssh_inventory_organization.sql"),
                include_str!("../../migrations/V0085__ssh_syntax_profiles.sql"),
            ] {
                conn.execute_batch(migration).unwrap();
            }
            let request: SaveSshConnectionRequest = serde_json::from_value(serde_json::json!({"name":"Fixture", "host":"127.0.0.1", "user":"fixture-user", "port":port, "password":PASSWORD, "platform":"iosxe"})).unwrap();
            let id = save_connection_impl(&conn, request).unwrap().id;
            let db = Arc::new(Mutex::new(conn));
            let resolver =
                TelemetrySshTargetResolver::new(db.clone(), dir.path().join("known_hosts"));
            let peer = Self {
                port,
                state,
                stop,
                owner,
                dir,
                db,
                id,
                resolver,
            };
            peer.trust(key(1).public_key());
            peer
        }
        fn trust(&self, key: &PublicKey) {
            std::fs::write(
                self.dir.path().join("known_hosts"),
                format!("[127.0.0.1]:{} {}\n", self.port, key.to_openssh().unwrap()),
            )
            .unwrap();
        }
        fn resolve(&self) -> Result<TelemetrySshTarget, Diagnostic> {
            self.resolver.resolve(&TargetRef {
                connection_id: self.id.clone(),
                platform: Platform::Iosxe,
            })
        }
        async fn connect(&self) -> TelemetrySshSession {
            TelemetrySshSession::connect(self.resolve().unwrap(), CancellationToken::new())
                .await
                .unwrap()
        }
        async fn drained(&self) {
            tokio::time::timeout(Duration::from_secs(3), async {
                while self.state.sessions.load(Ordering::SeqCst) != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert_eq!(self.state.owned_open_channels.load(Ordering::SeqCst), 0);
        }
        async fn finish(self) {
            self.resolver.shutdown().await.unwrap();
            self.stop.cancel();
            tokio::time::timeout(Duration::from_secs(3), self.owner)
                .await
                .unwrap()
                .unwrap();
        }
    }
    fn request() -> CaptureRequest {
        CaptureRequest {
            command: CommandPolicy::admit(Platform::Iosxe, "show version").unwrap(),
            parser_id: "fixture.version".into(),
            revision: "trusted-effective-revision".into(),
        }
    }
    async fn adversarial_peer_capture() -> anyhow::Result<()> {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, AsyncReadExt};
        let mut peer = Peer::new(Reply::Complete).await;
        let identity = peer.dir.path().join("peer-key");
        std::fs::write(
            &identity,
            key(1).to_openssh(ssh_key::LineEnding::LF)?.as_bytes(),
        )?;
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar");
        let python = root.join(if cfg!(windows) {
            ".venv/Scripts/python.exe"
        } else {
            ".venv/bin/python"
        });
        let mut child = tokio::process::Command::new(python)
            .args(["-I", "-u"])
            .arg(root.join("tests/telemetry/ssh_peer.py"))
            .arg(identity)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap()).take(4096);
        let outcome = async {
            let mut ready = String::new();
            timeout(Duration::from_secs(8), stdout.read_line(&mut ready)).await??;
            let ready: serde_json::Value = serde_json::from_str(&ready)?;
            peer.port = ready["port"]
                .as_u64()
                .and_then(|port| u16::try_from(port).ok())
                .ok_or_else(|| anyhow::anyhow!("missing fixture port"))?;
            peer.db
                .lock()
                .execute("UPDATE ssh_connections SET port = ?1", [peer.port])?;
            peer.trust(key(1).public_key());
            let target = peer
                .resolve()
                .map_err(|_| anyhow::anyhow!("fixture target resolution failed"))?;
            let mut session = TelemetrySshSession::connect(target, CancellationToken::new())
                .await
                .map_err(|_| anyhow::anyhow!("fixture connection failed"))?;
            let result = session.capture(&request(), CancellationToken::new()).await;
            let closed = session.close().await;
            if let Err(diagnostic) = &result {
                anyhow::ensure!(
                    ![PASSWORD, "fixture-user", "T6RAW-73921"]
                        .iter()
                        .any(|private| format!("{diagnostic:?}").contains(private)),
                    "fixture diagnostic exposed private data"
                );
            }
            closed.map_err(|_| anyhow::anyhow!("fixture client cleanup failed"))?;
            result.map_err(|_| anyhow::anyhow!("adversarial capture failed"))?;
            anyhow::Ok(())
        }
        .await;
        let mut summary = String::new();
        let output = timeout(Duration::from_secs(3), stdout.read_to_string(&mut summary)).await;
        let waited = timeout(Duration::from_secs(3), child.wait()).await;
        if !matches!(&waited, Ok(Ok(_))) {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        peer.finish().await;
        outcome?;
        output.map_err(|_| anyhow::anyhow!("fixture output deadline"))??;
        let status = waited.map_err(|_| anyhow::anyhow!("fixture process deadline"))??;
        anyhow::ensure!(status.success(), "fixture process failed");
        let summary: serde_json::Value = serde_json::from_str(&summary)?;
        assert_eq!(
            summary["sent"],
            serde_json::json!({"early_data":1, "channel_request":1, "global_request":1})
        );
        assert_eq!(summary["authenticated"], 1);
        assert_eq!(summary["joined"], true);
        Ok(())
    }
    struct ForeignLogger;
    static FOREIGN_LOGGER: ForeignLogger = ForeignLogger;
    impl log::Log for ForeignLogger {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, _: &log::Record<'_>) {}
        fn flush(&self) {}
    }
    #[tokio::test]
    async fn ssh_client_debug_trace_never_contains_saved_credentials() {
        let Ok(case) = std::env::var("TASK6_LOG_CASE") else {
            for case in [
                "json",
                "pretty",
                "disconnect_json",
                "disconnect_pretty",
                "adversarial_json",
                "adversarial_pretty",
                "foreign_subscriber",
                "foreign_logger",
            ] {
                let output = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "telemetry::ssh::tests::ssh_client_debug_trace_never_contains_saved_credentials", "--nocapture"])
                    .env("TASK6_LOG_CASE", case)
                    .env("RUST_LOG", "trace,russh=trace,russh::client::encrypted=trace,russh::server::encrypted=trace")
                    .output().unwrap();
                assert!(
                    String::from_utf8_lossy(&output.stdout).contains("running 1 test"),
                    "logger child selected no test"
                );
                assert!(
                    output.status.success(),
                    "logger case {case}: {}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            return;
        };
        if case.starts_with("foreign_") {
            if case == "foreign_logger" {
                log::set_logger(&FOREIGN_LOGGER).unwrap();
            } else {
                use tracing_subscriber::util::SubscriberInitExt;
                tracing_subscriber::registry().try_init().unwrap();
            }
            let dir = tempfile::tempdir().unwrap();
            assert!(crate::logging::init_logging(
                crate::logging::LogConfig::new().with_log_dir(dir.path().to_path_buf())
            )
            .is_err());
            let peer = Peer::new_unlogged(Reply::Complete).await;
            let diagnostic =
                TelemetrySshSession::connect(peer.resolve().unwrap(), CancellationToken::new())
                    .await
                    .err()
                    .unwrap();
            assert_eq!(diagnostic.code, "ssh_logging_privacy_unavailable");
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert_eq!(peer.state.accepted_connections.load(Ordering::SeqCst), 0);
            assert_eq!(peer.state.sessions.load(Ordering::SeqCst), 0);
            assert_eq!(peer.state.password_attempts.load(Ordering::SeqCst), 0);
            peer.finish().await;
            return;
        }
        let logs = init_fixture_logging();
        if case.starts_with("adversarial_") {
            adversarial_peer_capture().await.unwrap();
        } else {
            let peer = Peer::new(if case.starts_with("disconnect_") {
                Reply::Disconnect
            } else {
                Reply::Complete
            })
            .await;
            let mut session = peer.connect().await;
            let result = session.capture(&request(), CancellationToken::new()).await;
            if case.starts_with("disconnect_") {
                let diagnostic = result.unwrap_err();
                for secret in [PASSWORD, "fixture-user", "T6RAW-73921"] {
                    assert!(!format!("{diagnostic:?}").contains(secret));
                }
            } else {
                result.unwrap();
            }
            session.close().await.unwrap();
            peer.drained().await;
            peer.finish().await;
        }
        log::trace!(target: "telemetry.fixture", "unrelated-trace-positive");
        log::warn!(target: "ccie_terminal_lib::telemetry", "app-warning-positive");
        tracing::error!(target: "ccie_terminal_lib::telemetry", "app-error-positive");
        let messages = std::fs::read_dir(logs.path())
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(messages.contains("unrelated-trace-positive"));
        assert!(messages.contains("app-warning-positive"));
        assert!(messages.contains("app-error-positive"));
        for (category, secret) in [PASSWORD, "fixture-user", "T6RAW-73921"]
            .into_iter()
            .enumerate()
        {
            let decimal = secret
                .bytes()
                .map(|byte| byte.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            let offenders = messages
                .lines()
                .filter(|line| line.contains(secret) || line.contains(&decimal))
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .map(|event| format!("target={} level={}", event["target"], event["level"]))
                .collect::<Vec<_>>();
            assert!(
                !messages.contains(secret) && !messages.contains(&decimal),
                "production logger exposes private field category{category}, metadata={offenders:?}"
            );
        }
        if case.ends_with("json") {
            for line in messages.lines().filter(|line| !line.is_empty()) {
                serde_json::from_str::<serde_json::Value>(line).unwrap();
            }
        } else {
            assert!(messages.contains("WARN"));
        }
    }
    #[tokio::test]
    async fn ssh_rejects_unknown_or_changed_host_key() {
        for changed in [false, true] {
            let peer = Peer::new(Reply::Complete).await;
            if changed {
                peer.trust(key(3).public_key());
            } else {
                std::fs::write(peer.dir.path().join("known_hosts"), "").unwrap();
            }
            let target = peer.resolve().unwrap();
            let connection_result =
                TelemetrySshSession::connect(target, CancellationToken::new()).await;
            assert!(connection_result.is_err());
            let diagnostic = connection_result.err().unwrap();
            assert_eq!(
                diagnostic.code,
                if changed {
                    "ssh_host_key_changed"
                } else {
                    "ssh_host_key_unknown"
                }
            );
            assert!(diagnostic.message.contains("SHA256:"));
            let server_command_count = peer.state.commands.load(Ordering::SeqCst);
            assert_eq!(server_command_count, 0);
            assert_eq!(peer.state.password_attempts.load(Ordering::SeqCst), 0);
            peer.drained().await;
            peer.finish().await;
        }
    }
    #[tokio::test]
    async fn ssh_resolves_saved_identity_and_password_without_logging() {
        for identity in [false, true] {
            let peer = Peer::new(Reply::Complete).await;
            if identity {
                let file = peer.dir.path().join("identity");
                std::fs::write(
                    &file,
                    key(2)
                        .to_openssh(ssh_key::LineEnding::LF)
                        .unwrap()
                        .as_bytes(),
                )
                .unwrap();
                peer.db
                    .lock()
                    .execute(
                        "UPDATE ssh_connections SET identity_file = ?1",
                        [file.to_str().unwrap()],
                    )
                    .unwrap();
            }
            let mut session = peer.connect().await;
            let capture = session
                .capture(&request(), CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(capture.target_id, peer.id);
            assert_eq!(capture.platform, Platform::Iosxe);
            assert_eq!(capture.revision, "trusted-effective-revision");
            assert_eq!(capture.command, "show version");
            assert_eq!(capture.parser_id, "fixture.version");
            assert_eq!(capture.raw, "T6RAW-73921 output\n");
            assert!(!capture.capture_id.is_empty());
            assert!(capture.observed_at_ms > 0);
            assert_eq!(
                peer.state.password_attempts.load(Ordering::SeqCst),
                usize::from(!identity)
            );
            assert_eq!(
                peer.state.key_attempts.load(Ordering::SeqCst),
                usize::from(identity)
            );
            session.close().await.unwrap();
            peer.drained().await;
            peer.finish().await;
        }
    }
    #[tokio::test]
    async fn ssh_output_timeout_and_cancel_close_owned_channels() {
        for cancel_capture in [false, true] {
            let peer = Peer::new(Reply::Hang).await;
            let mut session = peer.connect().await;
            session.command_timeout = Duration::from_millis(50);
            let cancel = CancellationToken::new();
            let trigger = cancel.clone();
            let state = peer.state.clone();
            let trigger_task = tokio::spawn(async move {
                while state.commands.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
                if cancel_capture {
                    trigger.cancel();
                }
            });
            let diagnostic = session.capture(&request(), cancel).await.unwrap_err();
            assert_eq!(
                diagnostic.code,
                if cancel_capture {
                    "ssh_cancelled"
                } else {
                    "ssh_timeout"
                }
            );
            trigger_task.await.unwrap();
            peer.drained().await;
            let owned_open_channels = peer.state.owned_open_channels.load(Ordering::SeqCst);
            let interactive_terminal_command_count = peer
                .state
                .interactive_terminal_command_count
                .load(Ordering::SeqCst);
            assert_eq!(owned_open_channels, 0);
            assert_eq!(interactive_terminal_command_count, 0);
            session.close().await.unwrap();
            peer.finish().await;
        }
    }
    #[tokio::test]
    async fn ssh_does_not_touch_interactive_terminal() {
        let peer = Peer::new(Reply::Hang).await;
        let handler = VerifyKey {
            known: vec![PublicKey::from(key(1).public_key().key_data().clone())],
            rejection: Arc::new(Mutex::new(None)),
        };
        let mut interactive = client::connect(
            Arc::new(client::Config::default()),
            ("127.0.0.1", peer.port),
            handler,
        )
        .await
        .unwrap();
        assert!(interactive
            .authenticate_password("fixture-user", PASSWORD)
            .await
            .unwrap()
            .success());
        let mut terminal = interactive.channel_open_session().await.unwrap();
        terminal.request_shell(true).await.unwrap();
        assert!(matches!(terminal.wait().await, Some(ChannelMsg::Success)));
        let mut telemetry = peer.connect().await;
        telemetry.command_timeout = Duration::from_millis(30);
        assert_eq!(
            telemetry
                .capture(&request(), CancellationToken::new())
                .await
                .unwrap_err()
                .code,
            "ssh_timeout"
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            while peer.state.owned_open_channels.load(Ordering::SeqCst) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let interactive_terminal_command_count = peer
            .state
            .interactive_terminal_command_count
            .load(Ordering::SeqCst);
        let owned_open_channels = peer.state.owned_open_channels.load(Ordering::SeqCst);
        assert_eq!(interactive_terminal_command_count, 0);
        assert_eq!(owned_open_channels, 0);
        assert!(!interactive.is_closed());
        terminal.data(&b"still interactive"[..]).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while peer
                .state
                .interactive_terminal_command_count
                .load(Ordering::SeqCst)
                == 0
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        terminal.close().await.unwrap();
        interactive
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await
            .unwrap();
        let _ = interactive.await;
        peer.drained().await;
        peer.finish().await;
    }
    #[tokio::test]
    async fn ssh_requires_success_eof_status_and_bounded_output() {
        for (reply, expected) in [
            (Reply::Reject, "ssh_exec_unsupported"),
            (Reply::Nonzero, "ssh_command_failed"),
            (Reply::MissingEof, "ssh_incomplete_output"),
            (Reply::MissingStatus, "ssh_incomplete_output"),
            (Reply::Large, "ssh_output_limit"),
            (Reply::Stderr, "ssh_stderr"),
        ] {
            let peer = Peer::new(reply).await;
            let mut session = peer.connect().await;
            let diagnostic = session
                .capture(&request(), CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(diagnostic.code, expected);
            assert!(!format!("{diagnostic:?}").contains(PASSWORD));
            session.close().await.unwrap();
            peer.drained().await;
            peer.finish().await;
        }
        let peer = Peer::new(Reply::Tail).await;
        let mut session = peer.connect().await;
        assert_eq!(
            session
                .capture(&request(), CancellationToken::new())
                .await
                .unwrap()
                .raw,
            "T6RAW-73921 output\nafter status\n"
        );
        session.close().await.unwrap();
        peer.drained().await;
        peer.finish().await;
    }
    #[tokio::test]
    async fn ssh_auth_failure_does_not_retry_or_downgrade_identity() {
        let peer = Peer::new(Reply::Complete).await;
        peer.db
            .lock()
            .execute("UPDATE ssh_connections SET user = ?1", [PASSWORD])
            .unwrap();
        let result =
            TelemetrySshSession::connect(peer.resolve().unwrap(), CancellationToken::new()).await;
        let diagnostic = result.err().unwrap();
        assert_eq!(diagnostic.code, "ssh_auth_failed");
        assert!(!format!("{diagnostic:?}").contains(PASSWORD));
        assert_eq!(peer.state.password_attempts.load(Ordering::SeqCst), 1);
        assert_eq!(peer.state.commands.load(Ordering::SeqCst), 0);
        peer.drained().await;
        peer.db
            .lock()
            .execute(
                "UPDATE ssh_connections SET identity_file = ?1",
                [peer.dir.path().join("absent-identity").to_str().unwrap()],
            )
            .unwrap();
        let diagnostic = peer.resolve().err().unwrap();
        assert_eq!(diagnostic.code, "ssh_identity_unavailable");
        assert!(!format!("{diagnostic:?}").contains(PASSWORD));
        assert_eq!(peer.state.password_attempts.load(Ordering::SeqCst), 1);
        peer.finish().await;
    }
    #[tokio::test]
    async fn ssh_drop_and_dropped_capture_future_close_owned_resources() {
        let peer = Peer::new(Reply::Hang).await;
        let mut session = peer.connect().await;
        {
            let request = request();
            let capture = session.capture(&request, CancellationToken::new());
            tokio::pin!(capture);
            tokio::select! {
                _ = &mut capture => panic!("hang fixture completed"),
                _ = async { while peer.state.commands.load(Ordering::SeqCst) == 0 { tokio::task::yield_now().await; } } => {},
            }
        }
        session.close().await.unwrap();
        peer.drained().await;
        let session = peer.connect().await;
        drop(session);
        peer.drained().await;
        peer.finish().await;
    }
    #[tokio::test]
    async fn ssh_resolver_scopes_shutdown_independently() {
        let peer = Peer::new(Reply::Complete).await;
        let other =
            TelemetrySshTargetResolver::new(peer.db.clone(), peer.dir.path().join("known_hosts"));
        let mut first = peer.connect().await;
        let mut second = TelemetrySshSession::connect(
            other
                .resolve(&TargetRef {
                    connection_id: peer.id.clone(),
                    platform: Platform::Iosxe,
                })
                .unwrap(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        peer.resolver.shutdown().await.unwrap();
        assert!(first
            .capture(&request(), CancellationToken::new())
            .await
            .is_err());
        assert_eq!(
            second
                .capture(&request(), CancellationToken::new())
                .await
                .unwrap()
                .raw,
            "T6RAW-73921 output\n"
        );
        second.close().await.unwrap();
        other.shutdown().await.unwrap();
        peer.drained().await;
        peer.finish().await;
    }
    #[tokio::test]
    async fn ssh_failed_connect_pending_cleanup_is_retained_and_retried() {
        use tokio::io::AsyncWriteExt;
        let peer = Peer::new(Reply::Complete).await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        peer.db
            .lock()
            .execute(
                "UPDATE ssh_connections SET port = ?1",
                [listener.local_addr().unwrap().port()],
            )
            .unwrap();
        let (accepted, seen) = oneshot::channel();
        let remote = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(b"SSH-2.0-stalled-fixture\r\n")
                .await
                .unwrap();
            let mut socket = tokio::io::BufReader::new(socket);
            let mut client_id = String::new();
            tokio::io::AsyncBufReadExt::read_line(&mut socket, &mut client_id)
                .await
                .unwrap();
            let mut kex_header = [0; 5];
            tokio::io::AsyncReadExt::read_exact(&mut socket, &mut kex_header)
                .await
                .unwrap();
            // KEX bytes prove the internal russh session task was already spawned.
            let _ = accepted.send(());
            tokio::io::copy(&mut socket, &mut tokio::io::sink())
                .await
                .unwrap();
        });
        let cancel = CancellationToken::new();
        let target = peer.resolve().unwrap();
        let actor_cancel = cancel.clone();
        let connect =
            tokio::spawn(async move { TelemetrySshSession::connect(target, actor_cancel).await });
        seen.await.unwrap();
        let owner = peer.resolver.owners.tasks.lock()[0].clone();
        let slot = owner.task.lock().await;
        cancel.cancel();
        let before = StdInstant::now();
        let diagnostic = connect.await.unwrap().err().unwrap();
        assert_eq!(diagnostic.code, "ssh_cleanup_pending");
        assert!(before.elapsed() < Duration::from_secs(4));
        assert!(slot.is_some());
        assert!(!owner.joined.load(Ordering::Acquire));
        // Socket EOF is observed even while cleanup acknowledgment is deliberately held.
        tokio::time::timeout(Duration::from_secs(1), remote)
            .await
            .unwrap()
            .unwrap();
        drop(slot);
        peer.resolver.shutdown().await.unwrap();
        assert!(owner.joined.load(Ordering::Acquire));
        assert!(owner.task.lock().await.is_none());
        assert!(peer.resolver.owners.tasks.lock().is_empty());
        peer.finish().await;
    }
    #[tokio::test]
    async fn ssh_dropped_connect_future_is_joined_by_resolver_shutdown() {
        use tokio::io::AsyncWriteExt;
        let peer = Peer::new(Reply::Complete).await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        peer.db
            .lock()
            .execute(
                "UPDATE ssh_connections SET port = ?1",
                [listener.local_addr().unwrap().port()],
            )
            .unwrap();
        let (accepted, seen) = oneshot::channel();
        let remote = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(b"SSH-2.0-stalled-fixture\r\n")
                .await
                .unwrap();
            let mut socket = tokio::io::BufReader::new(socket);
            let mut client_id = String::new();
            tokio::io::AsyncBufReadExt::read_line(&mut socket, &mut client_id)
                .await
                .unwrap();
            let mut kex_header = [0; 5];
            tokio::io::AsyncReadExt::read_exact(&mut socket, &mut kex_header)
                .await
                .unwrap();
            // KEX bytes prove the internal russh session task was already spawned.
            let _ = accepted.send(());
            tokio::io::copy(&mut socket, &mut tokio::io::sink())
                .await
                .unwrap();
        });
        let target = peer.resolve().unwrap();
        let connect = tokio::spawn(async move {
            TelemetrySshSession::connect(target, CancellationToken::new()).await
        });
        seen.await.unwrap();
        let owner = peer.resolver.owners.tasks.lock()[0].clone();
        connect.abort();
        assert!(connect.await.err().unwrap().is_cancelled());
        peer.resolver.shutdown().await.unwrap();
        assert!(owner.joined.load(Ordering::Acquire));
        tokio::time::timeout(Duration::from_secs(1), remote)
            .await
            .unwrap()
            .unwrap();
        peer.finish().await;
    }
    #[tokio::test]
    async fn ssh_saved_platform_trust_and_encrypted_identity_fail_closed() {
        let peer = Peer::new(Reply::Complete).await;
        assert_eq!(peer.resolve().unwrap().display_name(), "Fixture");
        peer.db
            .lock()
            .execute("UPDATE ssh_connections SET platform = 'generic'", [])
            .unwrap();
        assert!(peer.resolve().is_ok());
        peer.db
            .lock()
            .execute("UPDATE ssh_connections SET platform = 'ios'", [])
            .unwrap();
        assert_eq!(peer.resolve().err().unwrap().code, "ssh_platform_mismatch");
        peer.db
            .lock()
            .execute("UPDATE ssh_connections SET platform = 'cisco_iosxe'", [])
            .unwrap();
        assert_eq!(
            peer.resolve().err().unwrap().code,
            "ssh_platform_unsupported"
        );
        peer.db
            .lock()
            .execute("UPDATE ssh_connections SET platform = 'iosxe'", [])
            .unwrap();
        let known_hosts = peer.dir.path().join("known_hosts");
        let original = std::fs::read_to_string(&known_hosts).unwrap();
        std::fs::write(&known_hosts, format!("{original}@revoked {original}")).unwrap();
        assert_eq!(peer.resolve().err().unwrap().code, "ssh_trust_unsupported");
        std::fs::write(&known_hosts, original).unwrap();
        let mut encoded = Vec::new();
        keys::encode_pkcs8_pem_encrypted(&key(2), b"fixture-passphrase", 10, &mut encoded).unwrap();
        let identity = peer.dir.path().join("encrypted-identity");
        std::fs::write(&identity, encoded).unwrap();
        peer.db
            .lock()
            .execute(
                "UPDATE ssh_connections SET identity_file = ?1",
                [identity.to_str().unwrap()],
            )
            .unwrap();
        assert_eq!(
            peer.resolve().err().unwrap().code,
            "ssh_identity_passphrase_required"
        );
        assert_eq!(peer.state.password_attempts.load(Ordering::SeqCst), 0);
        peer.finish().await;
    }
    #[tokio::test]
    async fn ssh_atomic_trust_replacement_cannot_mix_snapshots() {
        use std::io::Write;
        let peer = Peer::new(Reply::Complete).await;
        peer.trust(key(3).public_key());
        let trust = peer.dir.path().join("known_hosts");
        let mut replacement = tempfile::NamedTempFile::new_in(peer.dir.path()).unwrap();
        let matching = format!(
            "[127.0.0.1]:{} {}\n",
            peer.port,
            key(1).public_key().to_openssh().unwrap()
        );
        write!(replacement, "{matching}@revoked {matching}").unwrap();
        AFTER_TRUST_READ.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                replacement.persist(trust).unwrap();
            }))
        });
        let target = peer.resolve().unwrap();
        assert!(std::fs::read_to_string(peer.dir.path().join("known_hosts"))
            .unwrap()
            .contains("@revoked"));
        let mut connection = TelemetrySshSession::connect(target, CancellationToken::new()).await;
        if let Ok(session) = &mut connection {
            session.close().await.unwrap();
        }
        let rejected = connection.err();
        peer.drained().await;
        let authentication_attempts = peer.state.password_attempts.load(Ordering::SeqCst);
        peer.finish().await;
        assert_eq!(
            rejected.map(|diagnostic| diagnostic.code).as_deref(),
            Some("ssh_host_key_changed"),
            "replacement must not authorize a key absent from the read snapshot"
        );
        assert_eq!(authentication_attempts, 0);
    }
}
