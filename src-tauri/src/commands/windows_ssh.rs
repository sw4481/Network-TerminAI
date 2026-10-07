//! App-owned ssh.exe directly in the visible ConPTY. Terminal text is never
//! authentication evidence: OpenSSH's post-userauth LocalCommand writes a
//! one-use nonce inherited by ssh.exe/LocalCommand to a local, inbound-only
//! pipe instead. This does not isolate against a same-user process with access
//! to the app or the SSH child's memory/environment.

#[cfg(windows)]
use super::AppState;
#[cfg(windows)]
use rusqlite::OptionalExtension;
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
#[cfg(windows)]
use uuid::Uuid;
#[cfg(windows)]
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

#[cfg(windows)]
fn windows_system_directory() -> Result<std::path::PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    let mut buffer = [0u16; 512];
    // Windows supplies the actual system directory; process environment is
    // attacker-controlled and must never select our trusted ssh.exe binary.
    let len = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if len == 0 || len >= buffer.len() {
        return Err("Windows system directory is unavailable".into());
    }
    Ok(std::ffi::OsString::from_wide(&buffer[..len]).into())
}

#[cfg(windows)]
pub(super) struct PreparedManagedSsh {
    pub binary: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub connection_id: String,
    pub nonce: String,
    pub pipe: NamedPipeServer,
}

#[cfg(windows)]
pub(super) fn prepare_managed_ssh(
    state: &AppState,
    connection_id: &str,
) -> Result<PreparedManagedSsh, String> {
    let saved: Option<(String, Option<String>, Option<i64>, Option<String>)> = state
        .db
        .lock()
        .query_row(
            "SELECT host, user, port, identity_file FROM ssh_connections WHERE id = ?1",
            rusqlite::params![connection_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (host, user, port, identity_file) =
        saved.ok_or_else(|| "saved SSH connection no longer exists".to_string())?;

    let system_dir = windows_system_directory()?;
    let binary = system_dir.join("OpenSSH").join("ssh.exe");
    let binary = binary
        .canonicalize()
        .map_err(|_| "Windows system OpenSSH executable is unavailable".to_string())?;
    let binary = binary
        .to_str()
        .ok_or_else(|| "Windows system OpenSSH path is invalid".to_string())?
        .to_string();
    let pipe_path = format!(r"\\.\pipe\terminai-ssh-{}", Uuid::new_v4().simple());
    let pipe = ServerOptions::new()
        .access_outbound(false)
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(&pipe_path)
        .map_err(|_| "could not create managed SSH authentication channel".to_string())?;
    let argv = managed_ssh_argv(
        &host,
        user.as_deref(),
        port,
        identity_file.as_deref(),
        &pipe_path,
    )?;
    Ok(PreparedManagedSsh {
        binary,
        argv,
        cwd: system_dir.to_string_lossy().into_owned(),
        connection_id: connection_id.to_string(),
        nonce: Uuid::new_v4().to_string(),
        pipe,
    })
}

#[cfg(any(windows, test))]
fn managed_ssh_argv(
    host: &str,
    user: Option<&str>,
    port: Option<i64>,
    identity_file: Option<&str>,
    pipe_path: &str,
) -> Result<Vec<String>, String> {
    if host.is_empty()
        || host.starts_with('-')
        || host.len() > 253
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-[]".contains(&byte))
    {
        return Err("saved SSH host is not safe for managed launch".into());
    }
    if user.is_some_and(|value| {
        value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    }) {
        return Err("saved SSH user is not safe for managed launch".into());
    }
    if identity_file.is_some_and(|value| value.chars().any(char::is_control)) {
        return Err("saved SSH identity file contains control characters".into());
    }
    let port = port.unwrap_or(22);
    if !(1..=65535).contains(&port) {
        return Err("saved SSH port is invalid".into());
    }
    let destination = user
        .map(|value| format!("{value}@{host}"))
        .unwrap_or_else(|| host.to_string());
    // OpenSSH expands %% to a literal percent before system() calls cmd.exe.
    // cmd.exe then expands this inherited environment variable; neither the
    // secret nor an attacker-controlled target value is embedded in argv.
    // Redirect first: a UUID ending in a digit followed by > could be parsed
    // as an output-descriptor redirect instead of echoing all 36 bytes.
    let callback = format!("LocalCommand=>{pipe_path} echo %%CCIE_SSH_AUTH%%");
    let mut argv = vec![
        "-F".into(),
        "none".into(),
        "-e".into(),
        "none".into(),
        "-o".into(),
        "ProxyCommand=none".into(),
        "-o".into(),
        "ProxyJump=none".into(),
        "-o".into(),
        "ControlMaster=no".into(),
        "-o".into(),
        "ControlPath=none".into(),
        "-o".into(),
        "ClearAllForwardings=yes".into(),
        "-o".into(),
        "PermitLocalCommand=yes".into(),
        "-o".into(),
        callback,
        "-tt".into(),
        "-p".into(),
        port.to_string(),
    ];
    if let Some(identity_file) = identity_file.filter(|value| !value.is_empty()) {
        argv.extend(["-i".into(), identity_file.to_string()]);
    }
    argv.extend(["--".into(), destination]);
    Ok(argv)
}

#[cfg(windows)]
impl PreparedManagedSsh {
    pub async fn await_authentication(mut self) -> Result<String, String> {
        use tokio::io::AsyncReadExt;
        tokio::time::timeout(std::time::Duration::from_secs(120), async {
            self.pipe
                .connect()
                .await
                .map_err(|_| "managed SSH callback did not connect".to_string())?;
            let mut response = [0u8; 38]; // UUID (36 bytes), CRLF (2 bytes)
            self.pipe
                .read_exact(&mut response)
                .await
                .map_err(|_| "managed SSH callback was incomplete".to_string())?;
            if response.get(..36) != Some(self.nonce.as_bytes())
                || response.get(36..) != Some(b"\r\n".as_slice())
            {
                return Err("managed SSH callback did not match this launch".into());
            }
            Ok(self.nonce)
        })
        .await
        .map_err(|_| "managed SSH authentication callback timed out".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::managed_ssh_argv;

    #[test]
    fn managed_ssh_disables_config_proxy_mux_and_escapes_without_exposing_nonce() {
        let argv = managed_ssh_argv(
            "switch.example",
            Some("operator"),
            Some(2222),
            None,
            r"\\.\pipe\terminai-ssh-test",
        )
        .unwrap();
        let joined = argv.join(" ");
        assert!(joined.contains("-F none -e none"));
        assert!(joined.contains("ProxyCommand=none"));
        assert!(joined.contains("ControlMaster=no"));
        assert!(joined.contains("PermitLocalCommand=yes"));
        assert!(joined.contains("%%CCIE_SSH_AUTH%%"));
        assert_eq!(
            argv.last().map(String::as_str),
            Some("operator@switch.example")
        );
        assert!(managed_ssh_argv("-oProxyCommand=evil", None, None, None, "pipe").is_err());
        assert!(managed_ssh_argv("host\nLocalCommand=evil", None, None, None, "pipe").is_err());
        assert!(managed_ssh_argv("host", Some("a@other"), None, None, "pipe").is_err());
    }

    #[test]
    fn callback_redirects_before_echoing_a_digit_ending_nonce() {
        let pipe = r"\\.\pipe\terminai-ssh-test";
        let argv = managed_ssh_argv("switch.example", None, None, None, pipe).unwrap();
        let callback = argv
            .iter()
            .find(|arg| arg.starts_with("LocalCommand="))
            .unwrap();
        assert_eq!(
            callback,
            &format!("LocalCommand=>{pipe} echo %%CCIE_SSH_AUTH%%")
        );
        for digit in ['0', '2', '9'] {
            let nonce = format!("00000000-0000-0000-0000-00000000000{digit}");
            assert_eq!(nonce.len(), 36);
            assert!(callback
                .replace("%%CCIE_SSH_AUTH%%", &nonce)
                .ends_with(&format!(" echo {nonce}")));
            assert!(!argv.iter().any(|arg| arg.contains(&nonce)));
        }
    }
}
