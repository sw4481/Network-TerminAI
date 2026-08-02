//! SSH-context gatherer (Phase 3E). The chain-binding (authoritative) path is
//! handled in the command layer (needs the DB); this module provides the
//! process-fallback: find an ssh/telnet descendant and parse its argv.

use super::{SshInfo, SshSource};

/// Parse an `ssh`/`telnet` argv into SshInfo. Handles `user@host`, `-p PORT`,
/// `-l USER`, and a bare host. Returns None if no host can be determined or
/// argv is not an ssh/telnet invocation.
pub(crate) fn parse_ssh_argv(argv: &[String]) -> Option<SshInfo> {
    let prog = argv.first()?.rsplit('/').next().unwrap_or("");
    if prog != "ssh" && prog != "telnet" {
        return None;
    }
    let mut user: Option<String> = None;
    let mut port: Option<u16> = None;
    let mut host: Option<String> = None;

    let mut i = 1;
    while i < argv.len() {
        let a = &argv[i];
        match a.as_str() {
            "-p" | "-P" => {
                i += 1;
                if let Some(p) = argv.get(i) {
                    port = p.parse::<u16>().ok();
                }
            }
            "-l" => {
                i += 1;
                user = argv.get(i).cloned();
            }
            s if s.starts_with('-') => { /* skip other flags */ }
            s => {
                // first non-flag positional is the destination
                if host.is_none() {
                    if let Some((u, h)) = s.split_once('@') {
                        user = Some(u.to_string());
                        host = Some(h.to_string());
                    } else {
                        host = Some(s.to_string());
                    }
                }
            }
        }
        i += 1;
    }

    host.map(|host| SshInfo {
        host,
        user,
        port,
        source: SshSource::Process,
    })
}

/// Read a pid's argv (macOS/Unix `ps -o command= -p <pid>`), split on spaces.
fn argv_of(pid: u32) -> Vec<String> {
    let out = match std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

/// Walk the pane pid's descendants for an ssh/telnet process and parse it.
pub fn gather_ssh_from_process(pid: u32) -> Option<SshInfo> {
    for p in super::proc::child_pids(pid) {
        let argv = argv_of(p);
        if let Some(info) = parse_ssh_argv(&argv) {
            return Some(info);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_parse_user_at_host_with_port() {
        let info = parse_ssh_argv(&argv(&["ssh", "admin@192.168.1.1", "-p", "2222"])).unwrap();
        assert_eq!(info.host, "192.168.1.1");
        assert_eq!(info.user.as_deref(), Some("admin"));
        assert_eq!(info.port, Some(2222));
        assert_eq!(info.source, SshSource::Process);
    }

    #[test]
    fn test_parse_bare_host() {
        let info = parse_ssh_argv(&argv(&["ssh", "core-sw-01"])).unwrap();
        assert_eq!(info.host, "core-sw-01");
        assert!(info.user.is_none());
        assert!(info.port.is_none());
    }

    #[test]
    fn test_parse_dash_l_user() {
        let info = parse_ssh_argv(&argv(&["ssh", "-l", "operator", "10.0.0.5"])).unwrap();
        assert_eq!(info.host, "10.0.0.5");
        assert_eq!(info.user.as_deref(), Some("operator"));
    }

    #[test]
    fn test_full_path_ssh_binary() {
        let info = parse_ssh_argv(&argv(&["/usr/bin/ssh", "host"])).unwrap();
        assert_eq!(info.host, "host");
    }

    #[test]
    fn test_non_ssh_is_none() {
        assert!(parse_ssh_argv(&argv(&["vim", "file.txt"])).is_none());
        assert!(parse_ssh_argv(&argv(&[])).is_none());
    }
}
