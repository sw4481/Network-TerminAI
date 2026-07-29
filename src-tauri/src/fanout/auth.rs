//! Credential resolution for the fan-out executor. Looks up host/port/user
//! from `ssh_connections` or `netconf_devices`. Decryption of saved passwords
//! is XOR-with-fixed-key — the same scheme `commands::ssh::decrypt_password`
//! uses (kept here to avoid a public-API change to that module).

use crate::fanout::events::FailureKind;
use crate::fanout::model::DeviceKind;
use base64::{engine::general_purpose, Engine as _};
use rusqlite::{Connection, OptionalExtension};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub enum DeviceCreds {
    Ssh {
        host: String,
        port: u16,
        user: String,
        identity: Option<PathBuf>,
        password: Option<String>,
    },
    Netconf {
        host: String,
        port: u16,
        user: String,
        password: Option<String>,
        platform: String,
        hostkey_verify: bool,
    },
}

const SSH_KEY: &[u8] = b"ccie-terminal-ssh-key-v1";

fn decrypt_password(encrypted: &str) -> Option<String> {
    let decoded = general_purpose::STANDARD.decode(encrypted).ok()?;
    let bytes: Vec<u8> = decoded
        .iter()
        .enumerate()
        .map(|(i, &b)| b ^ SSH_KEY[i % SSH_KEY.len()])
        .collect();
    String::from_utf8(bytes).ok()
}

pub fn resolve_creds(
    conn: &Connection,
    kind: DeviceKind,
    id: &str,
) -> Result<DeviceCreds, FailureKind> {
    match kind {
        DeviceKind::Ssh => {
            let row: Option<(String, Option<i64>, Option<String>, Option<String>, Option<String>)> =
                conn.query_row(
                    "SELECT host, port, user, identity_file, password_encrypted
                     FROM ssh_connections WHERE id = ?1",
                    [id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, Option<i64>>(1)?,
                            r.get::<_, Option<String>>(2)?,
                            r.get::<_, Option<String>>(3)?,
                            r.get::<_, Option<String>>(4)?,
                        ))
                    },
                )
                .optional()
                .map_err(|_| FailureKind::Auth)?;

            let (host, port, user, identity, password_enc) =
                row.ok_or(FailureKind::Auth)?;
            let password = password_enc.as_deref().and_then(decrypt_password);
            Ok(DeviceCreds::Ssh {
                host,
                port: port.unwrap_or(22) as u16,
                user: user.unwrap_or_else(|| "root".to_string()),
                identity: identity.map(PathBuf::from),
                password,
            })
        }
        DeviceKind::Netconf => {
            let dev_id: i64 = id.parse().map_err(|_| FailureKind::Auth)?;
            let row: Option<(String, i64, String, String, i64)> = conn
                .query_row(
                    "SELECT host, port, username, platform, hostkey_verify
                     FROM netconf_devices WHERE id = ?1",
                    [dev_id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, i64>(4)?,
                        ))
                    },
                )
                .optional()
                .map_err(|_| FailureKind::Auth)?;
            let (host, port, user, platform, hostkey_verify) =
                row.ok_or(FailureKind::Auth)?;
            // Real password resolution lives in `keyring` for NETCONF; in fan-out
            // we leave it None here and the executor's auth phase will fail
            // fast with FailureKind::Auth (UI must collect the password before
            // dispatching the run).
            Ok(DeviceCreds::Netconf {
                host,
                port: port as u16,
                user,
                password: None,
                platform,
                hostkey_verify: hostkey_verify != 0,
            })
        }
    }
}
