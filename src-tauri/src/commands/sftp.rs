//! Focused dual-pane SFTP service. Sessions and transfers are deliberately
//! independent from terminal tabs, persistence, recording, and AI routing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::commands::AppState;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SftpSide {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SftpMutation {
    Mkdir,
    Rename,
    Delete,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SftpTransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SftpListing {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SftpTransferEvent {
    Started {
        transfer_id: String,
        total: Option<u64>,
    },
    Progress {
        transfer_id: String,
        bytes: u64,
        total: Option<u64>,
    },
    Completed {
        transfer_id: String,
        bytes: u64,
    },
    Cancelled {
        transfer_id: String,
    },
    Error {
        transfer_id: String,
        message: String,
    },
}

trait TransferEventSink: Send + Sync {
    fn send(&self, event: SftpTransferEvent);
}

struct ChannelTransferSink(Channel<SftpTransferEvent>);

impl TransferEventSink for ChannelTransferSink {
    fn send(&self, event: SftpTransferEvent) {
        let _ = self.0.send(event);
    }
}

struct ManagedSession {
    connection: crate::sftp::SftpConnection,
}

struct ActiveTransfer {
    id: String,
    session_id: String,
    cancel: CancellationToken,
}

pub struct SftpService {
    sessions: AsyncMutex<HashMap<String, Arc<AsyncMutex<ManagedSession>>>>,
    transfer: AsyncMutex<Option<ActiveTransfer>>,
}

impl Default for SftpService {
    fn default() -> Self {
        Self::new()
    }
}

impl SftpService {
    pub fn new() -> Self {
        Self {
            sessions: AsyncMutex::new(HashMap::new()),
            transfer: AsyncMutex::new(None),
        }
    }

    async fn insert(&self, connection: crate::sftp::SftpConnection) -> String {
        let id = Uuid::new_v4().to_string();
        self.sessions.lock().await.insert(
            id.clone(),
            Arc::new(AsyncMutex::new(ManagedSession { connection })),
        );
        id
    }

    async fn session(&self, id: &str) -> Result<Arc<AsyncMutex<ManagedSession>>> {
        self.sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("SFTP session is closed or unknown"))
    }

    async fn cancel_transfer(&self, transfer_id: &str) -> bool {
        let transfer = self.transfer.lock().await;
        if let Some(active) = transfer.as_ref().filter(|active| active.id == transfer_id) {
            active.cancel.cancel();
            true
        } else {
            false
        }
    }

    async fn finish_transfer(&self, transfer_id: &str) {
        let mut slot = self.transfer.lock().await;
        if slot.as_ref().is_some_and(|active| active.id == transfer_id) {
            *slot = None;
        }
    }

    async fn disconnect(&self, session_id: &str) -> Result<()> {
        let transfer_id = {
            let transfer = self.transfer.lock().await;
            transfer
                .as_ref()
                .filter(|active| active.session_id == session_id)
                .map(|active| {
                    active.cancel.cancel();
                    active.id.clone()
                })
        };
        if let Some(transfer_id) = transfer_id {
            for _ in 0..80 {
                let finished = self
                    .transfer
                    .lock()
                    .await
                    .as_ref()
                    .is_none_or(|active| active.id != transfer_id);
                if finished {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
        if let Some(session) = self.sessions.lock().await.remove(session_id) {
            session.lock().await.connection.disconnect().await;
        }
        Ok(())
    }

    async fn start_transfer(
        self: &Arc<Self>,
        session_id: String,
        direction: SftpTransferDirection,
        local_path: PathBuf,
        remote_path: String,
        sink: Arc<dyn TransferEventSink>,
    ) -> Result<String> {
        let session = self.session(&session_id).await?;
        let transfer_id = Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        {
            let mut slot = self.transfer.lock().await;
            if slot.is_some() {
                return Err(anyhow!(
                    "another SFTP transfer is active; wait for it to finish or cancel it"
                ));
            }
            *slot = Some(ActiveTransfer {
                id: transfer_id.clone(),
                session_id,
                cancel: cancel.clone(),
            });
        }

        let service = self.clone();
        let id_for_task = transfer_id.clone();
        tokio::spawn(async move {
            let result = match direction {
                SftpTransferDirection::Upload => {
                    upload(
                        &session,
                        &local_path,
                        &remote_path,
                        &id_for_task,
                        &cancel,
                        sink.as_ref(),
                    )
                    .await
                }
                SftpTransferDirection::Download => {
                    download(
                        &session,
                        &local_path,
                        &remote_path,
                        &id_for_task,
                        &cancel,
                        sink.as_ref(),
                    )
                    .await
                }
            };
            match result {
                Ok(bytes) => sink.send(SftpTransferEvent::Completed {
                    transfer_id: id_for_task.clone(),
                    bytes,
                }),
                Err(_) if cancel.is_cancelled() => sink.send(SftpTransferEvent::Cancelled {
                    transfer_id: id_for_task.clone(),
                }),
                Err(error) => sink.send(SftpTransferEvent::Error {
                    transfer_id: id_for_task.clone(),
                    message: format!("{error:#}"),
                }),
            }
            service.finish_transfer(&id_for_task).await;
        });
        Ok(transfer_id)
    }
}

fn local_path(raw: &str) -> Result<PathBuf> {
    if raw.contains('\0') {
        return Err(anyhow!("local path contains a NUL byte"));
    }
    if raw.trim().is_empty() {
        return dirs::home_dir().ok_or_else(|| anyhow!("could not resolve the local home folder"));
    }
    Ok(PathBuf::from(raw))
}

fn remote_path(raw: &str) -> Result<String> {
    let value = if raw.trim().is_empty() {
        "."
    } else {
        raw.trim()
    };
    if value.contains('\0') {
        return Err(anyhow!("remote path contains a NUL byte"));
    }
    if value.contains('\\') {
        return Err(anyhow!("remote paths use POSIX '/' separators"));
    }
    Ok(value.to_string())
}

fn remote_join(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else if parent == "." {
        name.to_string()
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

fn sort_entries(entries: &mut [SftpEntry]) {
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
}

fn list_local(raw: &str) -> Result<SftpListing> {
    let path = local_path(raw)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path)
        .with_context(|| format!("list local directory {}", path.display()))?
    {
        let entry = entry?;
        let metadata = std::fs::symlink_metadata(entry.path())?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs());
        entries.push(SftpEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: metadata.is_dir(),
            is_symlink: metadata.file_type().is_symlink(),
            size: metadata.is_file().then_some(metadata.len()),
            modified_at,
        });
    }
    sort_entries(&mut entries);
    Ok(SftpListing {
        path: path.to_string_lossy().into_owned(),
        entries,
    })
}

async fn list_remote(session: &AsyncMutex<ManagedSession>, raw: &str) -> Result<SftpListing> {
    let path = remote_path(raw)?;
    let session = session.lock().await;
    let canonical = session
        .connection
        .session
        .canonicalize(path)
        .await
        .context("resolve remote path")?;
    let read_dir = session
        .connection
        .session
        .read_dir(canonical.clone())
        .await
        .with_context(|| format!("list remote directory {canonical}"))?;
    let mut entries = read_dir
        .map(|entry| {
            let metadata = entry.metadata();
            let name = entry.file_name();
            SftpEntry {
                path: remote_join(&canonical, &name),
                name,
                is_dir: metadata.is_dir(),
                is_symlink: metadata.is_symlink(),
                size: metadata.is_regular().then_some(metadata.len()),
                modified_at: metadata.mtime.map(u64::from),
            }
        })
        .collect::<Vec<_>>();
    sort_entries(&mut entries);
    Ok(SftpListing {
        path: canonical,
        entries,
    })
}

fn mutate_local(operation: SftpMutation, raw: &str, destination: Option<&str>) -> Result<()> {
    let path = local_path(raw)?;
    match operation {
        SftpMutation::Mkdir => std::fs::create_dir(&path)
            .with_context(|| format!("create local directory {}", path.display()))?,
        SftpMutation::Rename => {
            let destination =
                destination.ok_or_else(|| anyhow!("rename destination is required"))?;
            let destination = local_path(destination)?;
            std::fs::rename(&path, &destination).with_context(|| {
                format!("rename {} to {}", path.display(), destination.display())
            })?;
        }
        SftpMutation::Delete => {
            if path.parent().is_none() {
                return Err(anyhow!("refusing to delete a filesystem root"));
            }
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                // remove_dir is intentionally empty-directory-only.
                std::fs::remove_dir(&path)?;
            } else {
                std::fs::remove_file(&path)?;
            }
        }
    }
    Ok(())
}

async fn mutate_remote(
    session: &AsyncMutex<ManagedSession>,
    operation: SftpMutation,
    raw: &str,
    destination: Option<&str>,
) -> Result<()> {
    let path = remote_path(raw)?;
    if operation == SftpMutation::Delete && path == "/" {
        return Err(anyhow!("refusing to delete the remote root"));
    }
    let session = session.lock().await;
    match operation {
        SftpMutation::Mkdir => session.connection.session.create_dir(path).await?,
        SftpMutation::Rename => {
            let destination =
                remote_path(destination.ok_or_else(|| anyhow!("rename destination is required"))?)?;
            session.connection.session.rename(path, destination).await?;
        }
        SftpMutation::Delete => {
            let metadata = session
                .connection
                .session
                .symlink_metadata(path.clone())
                .await?;
            if metadata.is_dir() && !metadata.is_symlink() {
                // The protocol's rmdir fails for non-empty directories.
                session.connection.session.remove_dir(path).await?;
            } else {
                session.connection.session.remove_file(path).await?;
            }
        }
    }
    Ok(())
}

fn local_partial_path(destination: &Path, transfer_id: &str) -> Result<PathBuf> {
    let name = destination
        .file_name()
        .ok_or_else(|| anyhow!("download destination must name a file"))?
        .to_string_lossy();
    Ok(destination.with_file_name(format!(".{name}.{transfer_id}.partial")))
}

fn remote_partial_path(destination: &str, transfer_id: &str) -> Result<String> {
    let destination = remote_path(destination)?;
    let (parent, name) = destination
        .rsplit_once('/')
        .map_or((".", destination.as_str()), |(parent, name)| {
            (if parent.is_empty() { "/" } else { parent }, name)
        });
    if name.is_empty() {
        return Err(anyhow!("upload destination must name a file"));
    }
    Ok(remote_join(
        parent,
        &format!(".{name}.{transfer_id}.partial"),
    ))
}

async fn upload(
    session: &AsyncMutex<ManagedSession>,
    local: &Path,
    remote: &str,
    transfer_id: &str,
    cancel: &CancellationToken,
    sink: &dyn TransferEventSink,
) -> Result<u64> {
    let remote = remote_path(remote)?;
    let partial = remote_partial_path(&remote, transfer_id)?;
    let total = std::fs::metadata(local)
        .with_context(|| format!("read upload source {}", local.display()))?
        .len();
    sink.send(SftpTransferEvent::Started {
        transfer_id: transfer_id.to_string(),
        total: Some(total),
    });
    let result = async {
        let mut local_file = tokio::fs::File::open(local).await?;
        let session = session.lock().await;
        let mut remote_file = session.connection.session.create(partial.clone()).await?;
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut bytes = 0_u64;
        loop {
            let read = tokio::select! {
                _ = cancel.cancelled() => return Err(anyhow!("transfer cancelled")),
                read = local_file.read(&mut buffer) => read?,
            };
            if read == 0 {
                break;
            }
            tokio::select! {
                _ = cancel.cancelled() => return Err(anyhow!("transfer cancelled")),
                write = remote_file.write_all(&buffer[..read]) => write?,
            }
            bytes += read as u64;
            sink.send(SftpTransferEvent::Progress {
                transfer_id: transfer_id.to_string(),
                bytes,
                total: Some(total),
            });
        }
        remote_file.flush().await?;
        remote_file.shutdown().await?;
        drop(remote_file);
        session
            .connection
            .session
            .rename(partial.clone(), remote)
            .await?;
        Ok(bytes)
    }
    .await;
    if result.is_err() {
        let session = session.lock().await;
        let _ = session.connection.session.remove_file(partial).await;
    }
    result
}

async fn download(
    session: &AsyncMutex<ManagedSession>,
    local: &Path,
    remote: &str,
    transfer_id: &str,
    cancel: &CancellationToken,
    sink: &dyn TransferEventSink,
) -> Result<u64> {
    let remote = remote_path(remote)?;
    let partial = local_partial_path(local, transfer_id)?;
    if let Some(parent) = partial.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let result = async {
        let session = session.lock().await;
        let total = session
            .connection
            .session
            .metadata(remote.clone())
            .await
            .ok()
            .and_then(|metadata| metadata.size);
        sink.send(SftpTransferEvent::Started {
            transfer_id: transfer_id.to_string(),
            total,
        });
        let mut remote_file = session.connection.session.open(remote).await?;
        let mut local_file = tokio::fs::File::create(&partial).await?;
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut bytes = 0_u64;
        loop {
            let read = tokio::select! {
                _ = cancel.cancelled() => return Err(anyhow!("transfer cancelled")),
                read = remote_file.read(&mut buffer) => read?,
            };
            if read == 0 {
                break;
            }
            tokio::select! {
                _ = cancel.cancelled() => return Err(anyhow!("transfer cancelled")),
                write = local_file.write_all(&buffer[..read]) => write?,
            }
            bytes += read as u64;
            sink.send(SftpTransferEvent::Progress {
                transfer_id: transfer_id.to_string(),
                bytes,
                total,
            });
        }
        local_file.flush().await?;
        local_file.sync_all().await?;
        drop(local_file);
        drop(remote_file);
        tokio::fs::rename(&partial, local).await?;
        Ok(bytes)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
    }
    result
}

#[tauri::command]
pub async fn sftp_connect(
    state: State<'_, AppState>,
    connection_id: String,
    password_override: Option<String>,
) -> Result<String, String> {
    let saved = {
        let db = state.db.lock();
        crate::commands::ssh::get_connection_impl(&db, &connection_id)
            .map_err(|error| error.to_string())?
    };
    let username = saved
        .user
        .clone()
        .ok_or_else(|| "the saved SSH connection has no username".to_string())?;
    let saved_password = saved
        .password_encrypted
        .as_deref()
        .map(crate::commands::ssh::decrypt_password)
        .transpose()?;
    let connection = crate::sftp::connect(&crate::sftp::SftpConnectConfig {
        host: saved.host,
        port: saved
            .port
            .unwrap_or(22)
            .try_into()
            .map_err(|_| "invalid SSH port")?,
        username,
        password_override,
        identity_file: saved.identity_file.map(PathBuf::from),
        saved_password,
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(state.sftp.insert(connection).await)
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    side: SftpSide,
    path: String,
    session_id: Option<String>,
) -> Result<SftpListing, String> {
    match side {
        SftpSide::Local => list_local(&path).map_err(|error| error.to_string()),
        SftpSide::Remote => {
            let id = session_id.ok_or_else(|| "remote listing requires sessionId".to_string())?;
            let session = state
                .sftp
                .session(&id)
                .await
                .map_err(|error| error.to_string())?;
            list_remote(&session, &path)
                .await
                .map_err(|error| error.to_string())
        }
    }
}

#[tauri::command]
pub async fn sftp_mutate(
    state: State<'_, AppState>,
    side: SftpSide,
    operation: SftpMutation,
    path: String,
    destination: Option<String>,
    session_id: Option<String>,
) -> Result<(), String> {
    match side {
        SftpSide::Local => mutate_local(operation, &path, destination.as_deref())
            .map_err(|error| error.to_string()),
        SftpSide::Remote => {
            let id = session_id.ok_or_else(|| "remote mutation requires sessionId".to_string())?;
            let session = state
                .sftp
                .session(&id)
                .await
                .map_err(|error| error.to_string())?;
            mutate_remote(&session, operation, &path, destination.as_deref())
                .await
                .map_err(|error| error.to_string())
        }
    }
}

#[tauri::command]
pub async fn sftp_transfer(
    state: State<'_, AppState>,
    session_id: String,
    direction: SftpTransferDirection,
    local_path: String,
    remote_path: String,
    on_event: Channel<SftpTransferEvent>,
) -> Result<String, String> {
    let local_path =
        crate::commands::sftp::local_path(&local_path).map_err(|error| error.to_string())?;
    let remote_path =
        crate::commands::sftp::remote_path(&remote_path).map_err(|error| error.to_string())?;
    state
        .sftp
        .start_transfer(
            session_id,
            direction,
            local_path,
            remote_path,
            Arc::new(ChannelTransferSink(on_event)),
        )
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<bool, String> {
    Ok(state.sftp.cancel_transfer(&transfer_id).await)
}

#[tauri::command]
pub async fn sftp_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state
        .sftp
        .disconnect(&session_id)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_are_posix_only() {
        assert_eq!(
            remote_path("/var/tmp/file.txt").unwrap(),
            "/var/tmp/file.txt"
        );
        assert!(remote_path(r"C:\temp\file.txt").is_err());
    }

    #[test]
    fn partial_paths_are_unique_siblings_on_native_paths() {
        let destination = if cfg!(windows) {
            PathBuf::from(r"C:\Temp\Downloads\capture.pcap")
        } else {
            PathBuf::from("/tmp/capture.pcap")
        };
        let partial = local_partial_path(&destination, "abc").unwrap();
        assert_eq!(partial.parent(), destination.parent());
        assert_eq!(
            partial.file_name().unwrap().to_string_lossy(),
            ".capture.pcap.abc.partial"
        );
        assert_eq!(
            remote_partial_path("/var/tmp/capture.pcap", "abc").unwrap(),
            "/var/tmp/.capture.pcap.abc.partial"
        );
    }

    #[test]
    fn local_listing_and_mutations_are_native_and_non_recursive() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("folder");
        mutate_local(SftpMutation::Mkdir, folder.to_str().unwrap(), None).unwrap();
        let file = folder.join("hello.txt");
        std::fs::write(&file, b"hello").unwrap();
        let listing = list_local(folder.to_str().unwrap()).unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].size, Some(5));

        assert!(mutate_local(SftpMutation::Delete, folder.to_str().unwrap(), None).is_err());
        let renamed = folder.join("renamed.txt");
        mutate_local(
            SftpMutation::Rename,
            file.to_str().unwrap(),
            Some(renamed.to_str().unwrap()),
        )
        .unwrap();
        mutate_local(SftpMutation::Delete, renamed.to_str().unwrap(), None).unwrap();
        mutate_local(SftpMutation::Delete, folder.to_str().unwrap(), None).unwrap();
        assert!(!folder.exists());
    }
}
