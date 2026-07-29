//! SFTP pull for captured pcaps. Wraps `russh-sftp` over a fresh `russh`
//! session. Vendor on-device paths (`flash:CAP.pcap`) are normalized to
//! POSIX paths SFTP understands (`/flash/CAP.pcap`).
//!
//! `pull_file` writes to a temp file then atomically renames on full
//! success, so a partially-pulled pcap never leaves a half-written file
//! at `local_path`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use russh::client::{self, Handle, Handler};
use russh::keys::ssh_key::PublicKey;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::ssh_exec::DeviceConn;
use super::types::DeviceKind;

/// Map vendor on-device pcap paths to the POSIX paths the device's SFTP
/// server exposes. Documented in `docs/packet-capture/ios-xe-flow.md`.
pub fn normalize_remote_path(device_kind: DeviceKind, raw: &str) -> String {
    match device_kind {
        DeviceKind::IosXe => raw
            .strip_prefix("flash:")
            .map(|s| {
                if s.starts_with('/') {
                    format!("/flash{s}")
                } else {
                    format!("/flash/{s}")
                }
            })
            .unwrap_or_else(|| raw.to_string()),
        DeviceKind::Nxos => raw
            .strip_prefix("bootflash:")
            .map(|s| {
                if s.starts_with('/') {
                    format!("/bootflash{s}")
                } else {
                    format!("/bootflash/{s}")
                }
            })
            .unwrap_or_else(|| raw.to_string()),
        DeviceKind::Junos | DeviceKind::Eos => raw.to_string(),
    }
}

/// Default cache directory for pulled pcaps.
pub fn pcap_cache_dir() -> Result<PathBuf> {
    let dir = dirs::data_dir()
        .ok_or_else(|| anyhow!("no platform data dir"))?
        .join("ccie-terminal")
        .join("pcaps");
    std::fs::create_dir_all(&dir).context("create pcap cache dir")?;
    Ok(dir)
}

struct AcceptAll;

impl Handler for AcceptAll {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn connect(conn: &DeviceConn) -> Result<Handle<AcceptAll>> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..client::Config::default()
    });
    let mut session = client::connect(config, (conn.host.as_str(), conn.port), AcceptAll).await?;
    let auth = session
        .authenticate_password(conn.username.clone(), conn.password.clone())
        .await?;
    if !auth.success() {
        return Err(anyhow!("ssh auth failed"));
    }
    Ok(session)
}

/// Pull `remote_path` over SFTP into `local_path`, calling `progress_cb` as
/// bytes accumulate. Returns total bytes pulled. Atomic: writes to a temp
/// file alongside `local_path` and renames on success only.
pub async fn pull_file(
    conn: &DeviceConn,
    remote_path: &str,
    local_path: &Path,
    progress_cb: impl Fn(u64, Option<u64>) + Send,
) -> Result<u64> {
    let session = connect(conn).await?;
    let channel = session.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .context("sftp handshake")?;

    let metadata = sftp.metadata(remote_path).await.ok();
    let total = metadata.as_ref().and_then(|m| m.size);

    let mut remote = sftp
        .open(remote_path)
        .await
        .with_context(|| format!("open remote {remote_path}"))?;
    let tmp_path = local_path.with_extension("pcap.partial");
    if let Some(parent) = tmp_path.parent() {
        std::fs::create_dir_all(parent).context("create local pcap dir")?;
    }
    let mut local = tokio::fs::File::create(&tmp_path)
        .await
        .with_context(|| format!("create local {}", tmp_path.display()))?;

    let mut buf = vec![0u8; 64 * 1024];
    let mut total_read: u64 = 0;
    loop {
        let n = remote.read(&mut buf).await.context("sftp read")?;
        if n == 0 {
            break;
        }
        local.write_all(&buf[..n]).await.context("local write")?;
        total_read += n as u64;
        progress_cb(total_read, total);
    }
    local.flush().await.context("local flush")?;
    drop(local);
    drop(remote);
    drop(sftp);

    tokio::fs::rename(&tmp_path, local_path)
        .await
        .with_context(|| format!("rename {} -> {}", tmp_path.display(), local_path.display()))?;
    Ok(total_read)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_iosxe_strips_flash_prefix() {
        assert_eq!(
            normalize_remote_path(DeviceKind::IosXe, "flash:CAP.pcap"),
            "/flash/CAP.pcap"
        );
    }

    #[test]
    fn normalize_iosxe_handles_subdir() {
        assert_eq!(
            normalize_remote_path(DeviceKind::IosXe, "flash:/sub/CAP.pcap"),
            "/flash/sub/CAP.pcap"
        );
    }

    #[test]
    fn normalize_iosxe_passthrough_when_no_prefix() {
        assert_eq!(
            normalize_remote_path(DeviceKind::IosXe, "/already/abs.pcap"),
            "/already/abs.pcap"
        );
    }

    #[test]
    fn normalize_nxos_strips_bootflash_prefix() {
        assert_eq!(
            normalize_remote_path(DeviceKind::Nxos, "bootflash:CAP.pcap"),
            "/bootflash/CAP.pcap"
        );
    }

    #[test]
    fn normalize_junos_passthrough() {
        assert_eq!(
            normalize_remote_path(DeviceKind::Junos, "/var/tmp/CAP.pcap"),
            "/var/tmp/CAP.pcap"
        );
    }

    #[test]
    fn normalize_eos_passthrough() {
        assert_eq!(
            normalize_remote_path(DeviceKind::Eos, "/mnt/flash/CAP.pcap"),
            "/mnt/flash/CAP.pcap"
        );
    }

    #[test]
    fn cache_dir_is_creatable() {
        let dir = pcap_cache_dir().unwrap();
        assert!(dir.exists());
    }
}
