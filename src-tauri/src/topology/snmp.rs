//! Isolated, read-only SNMP worker boundary. Credentials never enter reports or cache.
use super::{discovery_transport, CaptureStatus, NeighborRecord};
use crate::commands::VaultState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionMode {
    #[default]
    Ssh,
    SnmpV3,
    SnmpV2c,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "version", deny_unknown_fields)]
pub(crate) enum Credential {
    #[serde(rename = "3")]
    V3 {
        schema: u8,
        username: String,
        auth_key: String,
        priv_key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
    },
    #[serde(rename = "2c")]
    V2c {
        schema: u8,
        community: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
    },
}
impl Drop for Credential {
    fn drop(&mut self) {
        match self {
            Self::V3 {
                username,
                auth_key,
                priv_key,
                context,
                ..
            } => {
                username.zeroize();
                auth_key.zeroize();
                priv_key.zeroize();
                if let Some(context) = context {
                    context.zeroize();
                }
            }
            Self::V2c { community, .. } => community.zeroize(),
        }
    }
}
impl Credential {
    pub(crate) fn parse(bytes: &[u8], mode: CollectionMode) -> Result<Self, String> {
        if bytes.len() > 8192 {
            return Err("Invalid topology SNMP credential".into());
        }
        let credential: Self =
            serde_json::from_slice(bytes).map_err(|_| "Invalid topology SNMP credential")?;
        let text = |s: &str, min: usize, max: usize| {
            s.len() >= min && s.len() <= max && !s.chars().any(char::is_control)
        };
        let valid = match &credential {
            Self::V3 {
                schema,
                username,
                auth_key,
                priv_key,
                context,
                port,
            } => {
                mode == CollectionMode::SnmpV3
                    && *schema == 1
                    && text(username, 1, 32)
                    && text(auth_key, 8, 1024)
                    && text(priv_key, 8, 1024)
                    && context.as_ref().is_none_or(|s| text(s, 0, 32))
                    && *port != Some(0)
            }
            Self::V2c {
                schema,
                community,
                port,
            } => {
                mode == CollectionMode::SnmpV2c
                    && *schema == 1
                    && text(community, 1, 255)
                    && *port != Some(0)
            }
        };
        if !valid {
            return Err("SNMP credential does not match the selected mode or schema".into());
        }
        Ok(credential)
    }
    pub(crate) fn read(
        conn: &Connection,
        vault: &VaultState,
        id: &str,
        mode: CollectionMode,
    ) -> Result<Arc<Self>, String> {
        if id.is_empty() || id.len() > 256 {
            return Err("Select a topology SNMP credential".into());
        }
        let (kind, metadata): (String, String) = conn
            .query_row(
                "SELECT kind,metadata_json FROM vault_secrets WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| "Topology SNMP credential unavailable")?;
        let metadata: serde_json::Value = serde_json::from_str(&metadata)
            .map_err(|_| "Invalid topology SNMP credential metadata")?;
        if kind != "snmp_community"
            || metadata.get("format").and_then(|v| v.as_str()) != Some("topology-snmp-v1")
        {
            return Err(
                "Select a versioned topology SNMP credential; legacy communities are unsupported"
                    .into(),
            );
        }
        let bytes = vault
            .store
            .read_secret(conn, &vault.lock, id)
            .map_err(|_| "Topology SNMP credential unavailable; unlock its envelope")?;
        Self::parse(&bytes, mode).map(Arc::new)
    }
    fn request(&self, host: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        #[derive(Serialize)]
        struct Request<'a> {
            host: &'a str,
            credential: &'a Credential,
        }
        let bytes = Zeroizing::new(
            serde_json::to_vec(&Request {
                host,
                credential: self,
            })
            .map_err(|_| "Invalid topology SNMP request")?,
        );
        if bytes.len() > 16 * 1024 {
            return Err("Topology SNMP request exceeds limit".into());
        }
        Ok(bytes)
    }
}

/// Only normalized table provenance; never raw varbinds, request data or error text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnmpObservation {
    pub index: Vec<u32>,
    pub neighbor_name: String,
    pub local_port_id: String,
    pub local_port_description: String,
    pub remote_port_id: String,
    pub remote_port_description: String,
    pub remote_port_subtype: Option<u8>,
    pub local_ifindex: Option<u32>,
    pub mapping: Option<String>,
    pub reason: Option<String>,
    pub management_addresses: Vec<String>,
    pub management_indexes: Vec<Vec<u32>>,
    /// Native receipt metadata, never accepted from worker stdout.
    #[serde(default)]
    pub captured_at: i64,
    #[serde(default)]
    pub in_latest_attempt: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Capture {
    pub protocol: String,
    pub status: CaptureStatus,
    pub records: Vec<NeighborRecord>,
    pub observations: Vec<SnmpObservation>,
    pub error: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Output {
    captures: Vec<Capture>,
}

pub(crate) fn decode(raw: &str) -> Result<Vec<Capture>, String> {
    let invalid = || "Topology SNMP worker output failed validation".to_string();
    if raw.len() > 2 * 1024 * 1024 {
        return Err(invalid());
    }
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| invalid())?;
    if value
        .get("captures")
        .and_then(|v| v.as_array())
        .is_some_and(|captures| {
            captures.iter().any(|c| {
                c.get("records")
                    .and_then(|v| v.as_array())
                    .is_some_and(|records| {
                        records.iter().any(|r| {
                            r.as_object().is_none_or(|r| {
                                r.keys().any(|key| {
                                    !matches!(
                                        key.as_str(),
                                        "protocol"
                                            | "local_port"
                                            | "neighbor_name"
                                            | "neighbor_port"
                                            | "neighbor_mgmt_ip"
                                            | "neighbor_platform"
                                            | "neighbor_vendor"
                                            | "capabilities"
                                    )
                                })
                            })
                        })
                    })
            })
        })
    {
        return Err(invalid());
    }
    if value
        .get("captures")
        .and_then(|v| v.as_array())
        .is_some_and(|captures| {
            captures.iter().any(|capture| {
                capture
                    .get("observations")
                    .and_then(|v| v.as_array())
                    .is_some_and(|observations| {
                        observations.iter().any(|o| {
                            o.get("captured_at").is_some() || o.get("in_latest_attempt").is_some()
                        })
                    })
            })
        })
    {
        return Err(invalid());
    }
    let output: Output = serde_json::from_value(value).map_err(|_| invalid())?;
    if output.captures.len() != 2
        || output
            .captures
            .iter()
            .filter(|c| c.protocol == "cdp")
            .count()
            != 1
        || output
            .captures
            .iter()
            .filter(|c| c.protocol == "lldp")
            .count()
            != 1
    {
        return Err(invalid());
    }
    let text = |s: &str| s.len() <= 1024 && !s.chars().any(char::is_control);
    for capture in &output.captures {
        if capture.status == CaptureStatus::Completed
            && capture
                .records
                .iter()
                .zip(&capture.observations)
                .any(|(r, o)| {
                    let addresses: std::collections::HashSet<_> =
                        o.management_addresses.iter().collect();
                    o.reason.is_some()
                        || o.mapping.is_none()
                        || o.local_ifindex.is_none()
                        || r.neighbor_name != o.neighbor_name
                        || r.neighbor_port != o.remote_port_id
                        || (capture.protocol == "lldp" && o.remote_port_subtype != Some(5))
                        || (capture.protocol == "cdp"
                            && (o.index.first().copied() != o.local_ifindex
                                || o.mapping.as_deref() != Some("cdpCacheIfIndex")))
                        || (if addresses.len() == 1 {
                            addresses.iter().next().map(|s| s.as_str())
                        } else {
                            None
                        }) != r.neighbor_mgmt_ip.as_deref()
                })
        {
            return Err(invalid());
        }
        if capture.records.len() > 2000
            || capture.observations.len() > 2000
            || capture
                .error
                .as_ref()
                .is_some_and(|s| s.len() > 256 || !text(s))
            || (capture.status == CaptureStatus::Completed
                && capture.records.len() != capture.observations.len())
            || (capture.status != CaptureStatus::Completed && !capture.records.is_empty())
            || capture.records.iter().any(|r| {
                r.protocol != capture.protocol
                    || r.routing.is_some()
                    || r.local_port.is_empty()
                    || r.neighbor_port.is_empty()
                    || r.neighbor_name.is_empty()
                    || [&r.local_port, &r.neighbor_port, &r.neighbor_name]
                        .iter()
                        .any(|s| !text(s))
                    || [&r.neighbor_platform, &r.neighbor_vendor]
                        .iter()
                        .any(|s| s.as_ref().is_some_and(|s| !text(s)))
                    || r.neighbor_mgmt_ip
                        .as_ref()
                        .is_some_and(|s| s.parse::<std::net::IpAddr>().is_err())
                    || r.capabilities.len() > 32
                    || r.capabilities.iter().any(|s| !text(s))
            })
            || capture.observations.iter().any(|o| {
                o.index.len() != if capture.protocol == "cdp" { 2 } else { 3 }
                    || o.local_ifindex == Some(0)
                    || o.remote_port_subtype.is_some_and(|s| !(1..=7).contains(&s))
                    || o.mapping.as_ref().is_some_and(|s| {
                        !matches!(
                            s.as_str(),
                            "cdpCacheIfIndex" | "ifName" | "ifAlias" | "ifDescr"
                        )
                    })
                    || o.reason.as_ref().is_some_and(|s| {
                        !matches!(
                            s.as_str(),
                            "unresolved_local_port"
                                | "missing_neighbor_identity"
                                | "remote_port_not_ifName"
                        )
                    })
                    || [
                        &o.neighbor_name,
                        &o.local_port_id,
                        &o.local_port_description,
                        &o.remote_port_id,
                        &o.remote_port_description,
                    ]
                    .iter()
                    .any(|s| !text(s))
                    || [&o.mapping, &o.reason]
                        .iter()
                        .any(|s| s.as_ref().is_some_and(|s| !text(s)))
                    || o.management_addresses.len() > 2000
                    || o.management_addresses.len() != o.management_indexes.len()
                    || o.management_addresses
                        .iter()
                        .any(|s| s.parse::<std::net::IpAddr>().is_err())
                    || o.management_indexes.len() > 2000
                    || o.management_indexes
                        .iter()
                        .any(|i| i.is_empty() || i.len() > 128)
                    || (capture.status == CaptureStatus::Completed && o.reason.is_some())
            })
        {
            return Err(invalid());
        }
    }
    // The worker's error is deliberately not propagated or cached, even if it is valid JSON.
    Ok(output
        .captures
        .into_iter()
        .map(|mut c| {
            c.error = (c.status != CaptureStatus::Completed)
                .then(|| "SNMP table collection failed or unsupported".into());
            c
        })
        .collect())
}

#[cfg(test)]
#[path = "snmp_tests.rs"]
pub(crate) mod tests;

#[derive(Clone)]
pub(crate) struct Worker {
    python: PathBuf,
    source: Option<PathBuf>,
}
impl Worker {
    pub(crate) fn production() -> Result<Self, String> {
        Self::resolve(
            crate::commands::bundled_python_path(),
            cfg!(debug_assertions),
        )
    }
    fn resolve(bundled: Option<PathBuf>, development: bool) -> Result<Self, String> {
        if let Some(python) = bundled {
            return Ok(Self {
                python,
                source: None,
            });
        }
        if !development {
            return Err("Bundled topology SNMP worker unavailable".into());
        }
        // Compile-time checkout in development only; release never imports from a source checkout.
        let sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("Topology SNMP worker unavailable")?
            .join("sidecar");
        let python = sidecar.join(if cfg!(windows) {
            ".venv/Scripts/python.exe"
        } else {
            ".venv/bin/python"
        });
        let source = sidecar.join("src");
        if !python.is_file()
            || !source
                .join("ccie_sidecar/topology/snmp_worker.py")
                .is_file()
        {
            return Err("Topology SNMP worker unavailable".into());
        }
        Ok(Self {
            python,
            source: Some(source),
        })
    }
    pub(crate) async fn run(
        &self,
        host: &str,
        credential: &Credential,
        cancel: CancellationToken,
        deadline: Instant,
        processes: &discovery_transport::DiscoveryProcesses,
    ) -> Result<Vec<Capture>, String> {
        let deadline = deadline.min(Instant::now() + std::time::Duration::from_secs(85));
        let dns = host.len() <= 253
            && !host.ends_with("..")
            && host.trim_end_matches('.').split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.as_bytes()[0].is_ascii_alphanumeric()
                    && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            });
        if host.parse::<std::net::IpAddr>().is_err() && !dns {
            return Err("Invalid saved topology SNMP host".into());
        }
        let mut command = tokio::process::Command::new(&self.python);
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LC_ALL", "C")
            .current_dir("/")
            .arg("-I");
        if let Some(source) = &self.source {
            command.args(["-c", "import sys,runpy;sys.path.insert(0,sys.argv[1]);sys.argv=['ccie_sidecar.topology.snmp_worker'];runpy.run_module('ccie_sidecar.topology.snmp_worker',run_name='__main__')"]).arg(source);
        } else {
            command.args(["-m", "ccie_sidecar.topology.snmp_worker"]);
        }
        let raw = discovery_transport::run_worker(
            command,
            credential.request(host)?,
            cancel,
            deadline,
            processes,
        )
        .await?;
        decode(&raw)
    }
}
