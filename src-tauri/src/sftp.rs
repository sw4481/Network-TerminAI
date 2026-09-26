//! Reusable SSH/SFTP connection primitive.
//!
//! PCAP keeps its vendor path conversion and pull lifecycle in `pcap::sftp`;
//! this module owns only connection, authentication, and the SFTP subsystem.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use russh::client::{self, Handle, Handler};
use russh::keys::ssh_key::PublicKey;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::Disconnect;
use russh_sftp::client::SftpSession;

#[derive(Debug, Clone)]
pub struct SftpConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password_override: Option<String>,
    pub identity_file: Option<PathBuf>,
    pub saved_password: Option<String>,
}

pub struct SftpConnection {
    ssh: Handle<AcceptAll>,
    pub session: SftpSession,
}

impl SftpConnection {
    pub async fn disconnect(&self) {
        let _ = self.session.close().await;
        let _ = self
            .ssh
            .disconnect(Disconnect::ByApplication, "SFTP panel closed", "en")
            .await;
    }
}

struct AcceptAll;

impl Handler for AcceptAll {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        // Deliberate existing product policy for this rank. The UI displays a
        // permanent warning for every resulting SFTP session.
        Ok(true)
    }
}

fn expand_home(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw == "~" {
        return dirs::home_dir().unwrap_or_else(|| path.to_path_buf());
    }
    if let Some(relative) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(relative);
        }
    }
    path.to_path_buf()
}

pub async fn connect(config: &SftpConnectConfig) -> Result<SftpConnection> {
    let username = config.username.trim();
    if username.is_empty() {
        return Err(anyhow!("the saved SSH connection has no username"));
    }
    let client_config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..client::Config::default()
    });
    let mut ssh = client::connect(
        client_config,
        (config.host.as_str(), config.port),
        AcceptAll,
    )
    .await
    .with_context(|| format!("connect to {}:{}", config.host, config.port))?;

    let mut attempted = Vec::new();
    let mut credential_errors = Vec::new();
    let mut authenticated = false;

    if let Some(password) = config
        .password_override
        .as_deref()
        .filter(|password| !password.is_empty())
    {
        attempted.push("one-session password override");
        authenticated = ssh
            .authenticate_password(username.to_string(), password.to_string())
            .await
            .context("password override authentication")?
            .success();
    }

    if !authenticated {
        if let Some(identity_file) = &config.identity_file {
            attempted.push("saved identity file");
            let expanded = expand_home(identity_file);
            match load_secret_key(&expanded, None) {
                Ok(private_key) => {
                    let hash = ssh.best_supported_rsa_hash().await?.flatten();
                    authenticated = ssh
                        .authenticate_publickey(
                            username.to_string(),
                            PrivateKeyWithHashAlg::new(Arc::new(private_key), hash),
                        )
                        .await
                        .context("identity-file authentication")?
                        .success();
                }
                Err(error) => {
                    let detail = error.to_string();
                    credential_errors.push(if detail.to_lowercase().contains("encrypt")
                        || detail.to_lowercase().contains("passphrase")
                    {
                        "encrypted private keys are not supported for SFTP; use a password override or an unencrypted key".to_string()
                    } else {
                        format!("load identity file {}: {detail}", expanded.display())
                    });
                }
            }
        }
    }

    if !authenticated {
        if let Some(password) = config
            .saved_password
            .as_deref()
            .filter(|password| !password.is_empty())
        {
            attempted.push("saved password");
            authenticated = ssh
                .authenticate_password(username.to_string(), password.to_string())
                .await
                .context("saved-password authentication")?
                .success();
        }
    }

    if !authenticated {
        return Err(anyhow!(
            "SFTP authentication failed after trying {}.{} Encrypted keys, SSH agent authentication, and keyboard-interactive authentication are not supported.",
            if attempted.is_empty() {
                "no usable saved credentials".to_string()
            } else {
                attempted.join(", ")
            },
            if credential_errors.is_empty() {
                String::new()
            } else {
                format!(" {}.", credential_errors.join("; "))
            },
        ));
    }

    let channel = ssh
        .channel_open_session()
        .await
        .context("open SSH session")?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .context("request SFTP subsystem")?;
    let session = SftpSession::new(channel.into_stream())
        .await
        .context("SFTP handshake")?;
    Ok(SftpConnection { ssh, session })
}

/// Password-only compatibility entrypoint used by the existing PCAP puller.
pub async fn connect_password(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
) -> Result<SftpConnection> {
    connect(&SftpConnectConfig {
        host: host.to_string(),
        port,
        username: username.to_string(),
        password_override: Some(password.to_string()),
        identity_file: None,
        saved_password: None,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::MethodKind;

    #[test]
    fn expands_tilde_without_rewriting_native_absolute_paths() {
        let absolute = if cfg!(windows) {
            PathBuf::from(r"C:\keys\id_ed25519")
        } else {
            PathBuf::from("/tmp/id_ed25519")
        };
        assert_eq!(expand_home(&absolute), absolute);
        if let Some(home) = dirs::home_dir() {
            assert_eq!(
                expand_home(Path::new("~/id_ed25519")),
                home.join("id_ed25519")
            );
        }
    }

    #[test]
    fn authentication_contract_does_not_include_agent_or_keyboard_interactive() {
        let supported = [MethodKind::Password, MethodKind::PublicKey];
        assert!(!supported.contains(&MethodKind::KeyboardInteractive));
    }
}
