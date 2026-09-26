//! Phase 3E — pane metadata gathering. Three independent, partial-failure-
//! tolerant gatherers (git, ports, ssh) assembled into a `PaneMetadata`
//! snapshot for the focused terminal pane. macOS-first.

pub mod proc;
pub mod git;
pub mod ports;
pub mod ssh;

use serde::Serialize;

/// Assemble pane metadata from the three gatherers. `pid` is the pane's shell
/// pid (None ⇒ ports/ssh-fallback skipped). `ssh_from_chain` is the
/// authoritative SSH context resolved by the caller (command layer) from the
/// tab's bound session chain; when present it wins over the process fallback.
pub fn get_metadata(
    cwd: &str,
    pid: Option<u32>,
    ssh_from_chain: Option<SshInfo>,
    now: i64,
) -> PaneMetadata {
    let git = git::gather_git(cwd);
    let ports = pid.map(ports::gather_ports).unwrap_or_default();
    let ssh = ssh_from_chain.or_else(|| pid.and_then(ssh::gather_ssh_from_process));
    PaneMetadata { git, ports, ssh, gathered_at: now }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaneMetadata {
    pub git: Option<GitInfo>,
    pub ports: Vec<PortInfo>,
    pub ssh: Option<SshInfo>,
    pub gathered_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: String,
    pub dirty: bool,
    pub changed_count: u32,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub port: u16,
    pub proc_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshInfo {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub source: SshSource,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SshSource {
    Chain,
    Process,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_source_serializes_lowercase() {
        let j = serde_json::to_string(&SshSource::Chain).unwrap();
        assert_eq!(j, "\"chain\"");
        let j = serde_json::to_string(&SshSource::Process).unwrap();
        assert_eq!(j, "\"process\"");
    }

    #[test]
    fn test_pane_metadata_serializes_camel_case() {
        let m = PaneMetadata {
            git: None,
            ports: vec![],
            ssh: None,
            gathered_at: 42,
        };
        let j = serde_json::to_string(&m).unwrap();
        assert!(j.contains("\"gatheredAt\":42"), "got {j}");
    }

    #[test]
    fn test_get_metadata_chain_ssh_wins_over_process() {
        let chain = SshInfo {
            host: "chain-host".into(),
            user: None,
            port: None,
            source: SshSource::Chain,
        };
        // pid None ⇒ no process fallback; chain value must pass through.
        let m = get_metadata("/nonexistent-xyz", None, Some(chain.clone()), 7);
        assert_eq!(m.ssh, Some(chain));
        assert!(m.git.is_none());
        assert!(m.ports.is_empty());
        assert_eq!(m.gathered_at, 7);
    }
}
