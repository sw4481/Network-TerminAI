//! SCP pull for captured pcaps, via the system `scp` client through `sshpass`.
//!
//! Why SCP (not the russh-sftp path in `sftp.rs`): Cisco IOS-XE switches
//! (verified against a live Catalyst 9000, IOS-XE 17.19) enable an **SCP**
//! server (`ip scp server enable`) but do **not** expose an SFTP subsystem, so
//! the russh-sftp handshake just times out. They also reject pure-Rust russh
//! `exec`/sftp channels the same way command execution does. The system `scp`
//! binary speaks the protocol these devices actually implement — mirroring the
//! `crate::ssh_exec` decision for command execution.
//!
//! Path handling: IOS-XE's SCP server resolves a **bare filename** against the
//! default filesystem (flash:). A `flash:CAP.pcap` or `/flash/CAP.pcap` request
//! fails ("No such file or directory" / "filename does not match request"),
//! whereas the basename `CAP.pcap` pulls correctly with modern scp (`-O`). We
//! therefore strip any `flash:` / `/flash/` (or `bootflash:`) prefix to the
//! basename before requesting it.

use std::path::Path;
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use tokio::process::Command;

use super::ssh_exec::DeviceConn;

/// Reduce a vendor on-device path to the basename the SCP server expects.
/// `flash:CAP.pcap` -> `CAP.pcap`, `/flash/CAP.pcap` -> `CAP.pcap`.
pub fn scp_remote_name(raw: &str) -> String {
    // Strip a `prefix:` device specifier if present, then take the basename.
    let after_colon = raw.rsplit(':').next().unwrap_or(raw);
    after_colon
        .rsplit('/')
        .next()
        .unwrap_or(after_colon)
        .to_string()
}

/// Build the `sshpass`/`scp` argument vector. Pure (no IO) for unit testing.
/// Uses `-O` (the SCP protocol IOS implements; the default `sftp` backend
/// fails on these devices) and disables host-key prompts, matching
/// `crate::ssh_exec::build_ssh_args`. Password is supplied via the `SSHPASS`
/// env var by the caller, never argv.
pub fn build_scp_args(conn: &DeviceConn, remote_name: &str, local: &Path) -> Vec<String> {
    vec![
        "-e".to_string(),
        "scp".to_string(),
        "-O".to_string(),
        "-o".to_string(),
        "PubkeyAuthentication=no".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=no".to_string(),
        "-o".to_string(),
        "UserKnownHostsFile=/dev/null".to_string(),
        "-o".to_string(),
        "ConnectTimeout=15".to_string(),
        "-P".to_string(),
        conn.port.to_string(),
        format!("{}@{}:{}", conn.username, conn.host, remote_name),
        local.to_string_lossy().into_owned(),
    ]
}

/// Pull `remote_path` off the device via SCP into `local_path`. Returns the
/// number of bytes written. Writes to a `.partial` temp then renames on
/// success, so a failed/partial pull never leaves a half file at `local_path`.
pub async fn pull_file(conn: &DeviceConn, remote_path: &str, local_path: &Path) -> Result<u64> {
    let remote_name = scp_remote_name(remote_path);
    let tmp_path = local_path.with_extension("pcap.partial");
    if let Some(parent) = tmp_path.parent() {
        std::fs::create_dir_all(parent).context("create local pcap dir")?;
    }
    let _ = std::fs::remove_file(&tmp_path);

    let args = build_scp_args(conn, &remote_name, &tmp_path);
    let output = Command::new("sshpass")
        .args(&args)
        .env("SSHPASS", &conn.password)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn sshpass/scp (is sshpass installed?)")?
        .wait_with_output()
        .await
        .context("scp wait")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&tmp_path);
        return Err(anyhow!("scp pull failed: {}", stderr.trim()));
    }

    let bytes = std::fs::metadata(&tmp_path)
        .with_context(|| format!("stat pulled file {}", tmp_path.display()))?
        .len();

    std::fs::rename(&tmp_path, local_path)
        .with_context(|| format!("rename {} -> {}", tmp_path.display(), local_path.display()))?;

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn conn() -> DeviceConn {
        DeviceConn {
            host: "device.example.test".into(),
            port: 22,
            username: "cisco".into(),
            password: "password1".into(),
        }
    }

    #[test]
    fn scp_remote_name_strips_flash_prefix() {
        assert_eq!(scp_remote_name("flash:CAP.pcap"), "CAP.pcap");
        assert_eq!(scp_remote_name("/flash/CAP.pcap"), "CAP.pcap");
        assert_eq!(scp_remote_name("bootflash:CAP.pcap"), "CAP.pcap");
        assert_eq!(scp_remote_name("CAP.pcap"), "CAP.pcap");
    }

    #[test]
    fn build_scp_args_keeps_password_out_of_argv() {
        let args = build_scp_args(&conn(), "CAP.pcap", &PathBuf::from("/tmp/x.pcap"));
        assert_eq!(args[0], "-e");
        assert_eq!(args[1], "scp");
        assert!(args.contains(&"-O".to_string()), "must use -O: {args:?}");
        assert!(
            !args.iter().any(|a| a.contains("password1")),
            "password must not be in argv: {args:?}"
        );
    }

    #[test]
    fn build_scp_args_targets_user_host_basename() {
        let args = build_scp_args(&conn(), "CAP.pcap", &PathBuf::from("/tmp/x.pcap"));
        assert!(args.contains(&"cisco@device.example.test:CAP.pcap".to_string()), "{args:?}");
        assert_eq!(args.last().unwrap(), "/tmp/x.pcap");
    }

    #[test]
    fn build_scp_args_sets_port() {
        let mut c = conn();
        c.port = 2222;
        let args = build_scp_args(&c, "CAP.pcap", &PathBuf::from("/tmp/x.pcap"));
        let p = args.iter().position(|a| a == "-P").unwrap();
        assert_eq!(args[p + 1], "2222");
    }
}
