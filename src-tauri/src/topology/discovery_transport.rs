//! Discovery-only, strict-host-verifying OpenSSH transport. No shared SSH API changes.

use crate::ssh_exec::SshTarget;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
pub use unix::DiscoveryProcesses;

#[cfg(not(unix))]
#[derive(Clone, Default)]
pub struct DiscoveryProcesses;

#[cfg(not(unix))]
impl DiscoveryProcesses {
    pub fn shutdown(&self) -> Result<(), String> {
        Err("Topology SSH discovery is unsupported on this platform".into())
    }
}

/// Only fixed neighbor/routing/interface discovery commands are accepted.
pub async fn run_command(
    target: &SshTarget,
    command: &str,
    cancel: CancellationToken,
    deadline: Instant,
    processes: &DiscoveryProcesses,
) -> Result<String, String> {
    #[cfg(unix)]
    {
        let args = unix::ssh_args(target, command)?;
        if cancel.is_cancelled() {
            return Err("Topology SSH cancelled".into());
        }
        let deadline = deadline.min(Instant::now() + std::time::Duration::from_secs(30));
        if deadline <= Instant::now() {
            return Err("Topology SSH timed out".into());
        }
        let mut ssh = tokio::process::Command::new("/usr/bin/ssh");
        ssh.args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LC_ALL", "C")
            .env("DISPLAY", ":0")
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("CCIE_TOPOLOGY_PASSWORD", &target.password);
        unix::execute(ssh, cancel, deadline, processes, true).await
    }
    #[cfg(not(unix))]
    {
        let _ = (target, command, cancel, deadline, processes);
        Err("Topology SSH discovery is unsupported on this platform".into())
    }
}

/// Standalone worker reuses the same kill/reap/drop/shutdown ownership as SSH.
pub async fn run_worker(
    command: tokio::process::Command,
    input: zeroize::Zeroizing<Vec<u8>>,
    cancel: CancellationToken,
    deadline: Instant,
    processes: &DiscoveryProcesses,
) -> Result<String, String> {
    if input.len() > 16 * 1024 {
        return Err("Topology SNMP input limit exceeded".into());
    }
    #[cfg(unix)]
    {
        unix::execute_input(command, cancel, deadline, processes, false, Some(input))
            .await
            .map_err(|error| {
                error
                    .replace("Topology SSH", "Topology SNMP")
                    .replace("topology SSH", "topology SNMP")
            })
    }
    #[cfg(not(unix))]
    {
        let _ = (command, input, cancel, deadline, processes);
        Err("Topology SNMP discovery is unsupported on this platform".into())
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use parking_lot::{Condvar, Mutex};
    use std::collections::HashMap;
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
    use tokio::process::Command;
    use uuid::Uuid;

    const STDOUT_LIMIT: usize = 2 * 1024 * 1024;
    const STDERR_LIMIT: usize = 64 * 1024;
    const SHUTDOWN_LIMIT: Duration = Duration::from_secs(5);
    const ASKPASS_SCRIPT: &[u8] = b"#!/bin/sh\nprintf '%s\\n' \"$CCIE_TOPOLOGY_PASSWORD\"\n";

    struct Entry {
        cancel: CancellationToken,
        group: Option<i32>,
        supervising: bool,
        helper: Option<Askpass>,
    }

    #[derive(Default)]
    struct State {
        stopped: bool,
        entries: HashMap<Uuid, Entry>,
    }

    #[derive(Default)]
    struct Registry {
        state: Mutex<State>,
        drained: Condvar,
        #[cfg(test)]
        fail_signals: std::sync::atomic::AtomicBool,
    }

    impl Registry {
        fn kill_group(&self, group: i32) -> Result<(), String> {
            #[cfg(test)]
            if self.fail_signals.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("Topology SSH process-group cleanup failed".into());
            }
            kill_group(group)
        }
    }

    /// Clones share admission and ownership. Shutdown permanently closes admission.
    #[derive(Clone, Default)]
    pub struct DiscoveryProcesses(Arc<Registry>);

    impl DiscoveryProcesses {
        /// Synchronous app-shutdown boundary; does not depend on the caller's runtime.
        /// A timeout is an explicit failure, never a claim that cleanup completed.
        pub fn shutdown(&self) -> Result<(), String> {
            let deadline = std::time::Instant::now() + SHUTDOWN_LIMIT;
            let mut state = self.0.state.lock();
            state.stopped = true;
            let mut signal_failed = false;
            for entry in state.entries.values_mut() {
                entry.cancel.cancel();
                if let Some(group) = entry.group.take() {
                    if self.0.kill_group(group).is_err() {
                        entry.group = Some(group);
                        signal_failed = true;
                    }
                }
            }
            // A completed supervisor may leave unresolved groups after signal failure.
            // Each shutdown retries those groups once; only successful cleanup releases them.
            state
                .entries
                .retain(|_, entry| entry.supervising || entry.group.is_some());
            while !state.entries.is_empty() {
                if state.entries.values().any(|entry| !entry.supervising) {
                    return Err(
                        "Topology SSH process-group cleanup failed; ownership retained for retry"
                            .into(),
                    );
                }
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    return Err(
                        "Topology SSH cleanup did not finish before shutdown deadline".into(),
                    );
                }
                self.0.drained.wait_for(&mut state, left);
            }
            if signal_failed {
                Err("Topology SSH process-group cleanup failed".into())
            } else {
                Ok(())
            }
        }

        fn admit(&self, cancel: CancellationToken) -> Result<Registration, String> {
            let mut state = self.0.state.lock();
            if state.stopped || cancel.is_cancelled() {
                return Err("Topology SSH cancelled".into());
            }
            let id = Uuid::new_v4();
            state.entries.insert(
                id,
                Entry {
                    cancel,
                    group: None,
                    supervising: true,
                    helper: None,
                },
            );
            Ok(Registration {
                processes: self.clone(),
                id,
            })
        }
    }

    struct Registration {
        processes: DiscoveryProcesses,
        id: Uuid,
    }

    impl Registration {
        fn kill_group(&self) -> Result<(), String> {
            let mut state = self.processes.0.state.lock();
            let entry = state.entries.get_mut(&self.id).expect("owned registration");
            if let Some(group) = entry.group {
                self.processes.0.kill_group(group)?;
                entry.group = None;
            }
            Ok(())
        }
    }

    impl Drop for Registration {
        fn drop(&mut self) {
            let mut state = self.processes.0.state.lock();
            if let Some(entry) = state.entries.get_mut(&self.id) {
                entry.supervising = false;
                if let Some(group) = entry.group {
                    if self.processes.0.kill_group(group).is_ok() {
                        entry.group = None;
                    }
                }
                if entry.group.is_none() {
                    state.entries.remove(&self.id);
                }
            }
            self.processes.0.drained.notify_all();
        }
    }

    fn kill_group(group: i32) -> Result<(), String> {
        // group is a positive child PID created with process_group(0), never caller input.
        let result = unsafe { libc::kill(-group, libc::SIGKILL) };
        let errno = std::io::Error::last_os_error().raw_os_error();
        if result == 0 || errno == Some(libc::ESRCH) {
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        if errno == Some(libc::EPERM) && group_has_no_live_members(group) {
            // Darwin can report EPERM for a group containing only zombies.
            // Do not suppress permission failures against any live member.
            return Ok(());
        }
        Err("Topology SSH process-group cleanup failed".into())
    }

    #[cfg(target_os = "macos")]
    fn group_has_no_live_members(group: i32) -> bool {
        // PROC_PGRP_ONLY from the installed sys/proc_info.h; libc omits this constant.
        const PROC_PGRP_ONLY: u32 = 2;
        // ponytail: bounded ownership probe; fail closed if a group fills this buffer.
        let mut pids = [0i32; 256];
        let size = std::mem::size_of_val(&pids);
        let count = unsafe {
            *libc::__error() = 0;
            libc::proc_listpids(
                PROC_PGRP_ONLY,
                group as u32,
                pids.as_mut_ptr().cast(),
                size as i32,
            )
        };
        if count == 0 {
            return std::io::Error::last_os_error().raw_os_error() == Some(0);
        }
        if count < 0
            || count as usize >= size
            || !(count as usize).is_multiple_of(std::mem::size_of::<i32>())
        {
            return false;
        }
        pids[..count as usize / std::mem::size_of::<i32>()]
            .iter()
            .all(|pid| {
                let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
                let size = std::mem::size_of_val(&info) as i32;
                let read = unsafe {
                    *libc::__error() = 0;
                    libc::proc_pidinfo(
                        *pid,
                        libc::PROC_PIDTBSDINFO,
                        0,
                        (&mut info as *mut libc::proc_bsdinfo).cast(),
                        size,
                    )
                };
                let errno = std::io::Error::last_os_error().raw_os_error();
                if read == size {
                    info.pbi_pgid == group as u32 && info.pbi_status == libc::SZOMB
                } else {
                    // The group list includes zombies; proc_pidinfo excludes them.
                    // EPERM/EACCES or incomplete metadata remain failures, not absence.
                    read <= 0 && errno == Some(libc::ESRCH)
                }
            })
    }

    struct Askpass(PathBuf);

    impl Askpass {
        fn create() -> Result<Self, String> {
            let path =
                std::env::temp_dir().join(format!("ccie-topology-askpass-{}", Uuid::new_v4()));
            let mut file: File = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o700)
                .open(&path)
                .map_err(|_| "Cannot create topology SSH askpass helper")?;
            let helper = Self(path);
            file.write_all(ASKPASS_SCRIPT)
                .map_err(|_| "Cannot write topology SSH askpass helper")?;
            Ok(helper)
        }
    }

    impl Drop for Askpass {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    pub(super) fn ssh_args(target: &SshTarget, command: &str) -> Result<Vec<String>, String> {
        if !matches!(
            command,
            "show cdp neighbors detail"
                | "show lldp neighbors detail"
                | "show ip bgp summary"
                | "show ip ospf neighbor"
                | "show isis neighbors"
                | "show ip eigrp neighbors"
                | "show ip interface"
        ) {
            return Err("Unsupported topology discovery command".into());
        }
        let host = &target.host;
        let dns = host.len() <= 253
            && host.trim_end_matches('.').split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.as_bytes()[0].is_ascii_alphanumeric()
                    && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    && label
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
            && !host.ends_with("..");
        if host.is_empty() || (host.parse::<std::net::IpAddr>().is_err() && !dns) {
            return Err("Invalid topology SSH host".into());
        }
        let user = &target.username;
        if user.is_empty()
            || user.len() > 128
            || !(user.as_bytes()[0].is_ascii_alphanumeric() || user.starts_with('_'))
            || !user
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        {
            return Err("Invalid topology SSH username".into());
        }
        if target.port == 0 {
            return Err("Invalid topology SSH port".into());
        }
        if target.password.contains('\0') {
            return Err("Invalid topology SSH password".into());
        }
        let mut args = vec!["-F".into(), "/dev/null".into()];
        for option in [
            "StrictHostKeyChecking=yes",
            "UpdateHostKeys=no",
            "VerifyHostKeyDNS=no",
            "GlobalKnownHostsFile=/dev/null",
            "ProxyCommand=none",
            "ProxyJump=none",
            "CanonicalizeHostname=no",
            "PreferredAuthentications=password",
            "PasswordAuthentication=yes",
            "PubkeyAuthentication=no",
            "KbdInteractiveAuthentication=no",
            "GSSAPIAuthentication=no",
            "HostbasedAuthentication=no",
            "IdentityFile=none",
            "IdentityAgent=none",
            "IdentitiesOnly=yes",
            "CertificateFile=none",
            "NumberOfPasswordPrompts=1",
            "BatchMode=no",
            "RequestTTY=no",
            "ControlMaster=no",
            "ControlPath=none",
            "ControlPersist=no",
            "PermitLocalCommand=no",
            "ClearAllForwardings=yes",
            "ConnectionAttempts=1",
            "ConnectTimeout=10",
        ] {
            args.extend(["-o".into(), option.into()]);
        }
        args.extend([
            "-p".into(),
            target.port.to_string(),
            "-l".into(),
            user.clone(),
            "--".into(),
            host.clone(),
            command.into(),
        ]);
        Ok(args)
    }

    struct CancelOnDrop(CancellationToken);

    impl Drop for CancelOnDrop {
        fn drop(&mut self) {
            self.0.cancel();
        }
    }

    pub(super) async fn execute(
        command: Command,
        cancel: CancellationToken,
        deadline: Instant,
        processes: &DiscoveryProcesses,
        askpass: bool,
    ) -> Result<String, String> {
        execute_input(command, cancel, deadline, processes, askpass, None).await
    }

    pub(super) async fn execute_input(
        command: Command,
        cancel: CancellationToken,
        deadline: Instant,
        processes: &DiscoveryProcesses,
        askpass: bool,
        input: Option<zeroize::Zeroizing<Vec<u8>>>,
    ) -> Result<String, String> {
        let cancel = cancel.child_token();
        let _cancel_on_drop = CancelOnDrop(cancel.clone());
        let registration = processes.admit(cancel.clone())?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        // A dedicated supervisor owns cleanup even if the request future/runtime stops.
        // ponytail: one thread/runtime per command; discovery admits at most four devices.
        std::thread::Builder::new()
            .name("topology-ssh".into())
            .spawn(move || {
                let result = (|| {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|_| "Cannot start topology SSH supervisor")?;
                    runtime.block_on(supervise(
                        command,
                        &cancel,
                        deadline,
                        &registration,
                        askpass,
                        input,
                    ))
                })();
                // Readers/direct child finish before registration releases the helper.
                // Failed group cleanup keeps the group/helper owned for shutdown retry.
                drop(registration);
                let _ = tx.send(result);
            })
            .map_err(|_| "Cannot start topology SSH supervisor")?;
        rx.await
            .map_err(|_| "Topology SSH supervisor failed".to_string())?
    }

    async fn read_bounded(
        mut pipe: impl AsyncRead + Unpin,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let count = pipe
                .read(&mut buffer)
                .await
                .map_err(|_| "Topology SSH output read failed")?;
            if count == 0 {
                return Ok(bytes);
            }
            if count > limit.saturating_sub(bytes.len()) {
                return Err("Topology SSH output limit exceeded".into());
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
    }

    async fn wait_exited(pid: u32) -> Result<(), String> {
        loop {
            // Observe exit without reaping: retain the owned group leader until its
            // group is signalled, avoiding stale/reused PGIDs after a normal exit.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0 && unsafe { info.si_pid() } != 0 {
                return Ok(());
            }
            if result != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                return Err("Topology SSH exit observation failed".into());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn ssh_failure(stderr: &[u8]) -> &'static str {
        let text = String::from_utf8_lossy(stderr);
        if text.contains("Host key verification failed")
            || text.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
        {
            "Topology SSH host-key verification failed. Verify this saved host and port in OpenSSH known_hosts; discovery does not accept keys automatically."
        } else if text.contains("Permission denied") || text.contains("Authentication failed") {
            "Topology SSH authentication failed. Verify the saved username/password and that the switch permits password authentication; keyboard-interactive and key-only authentication are not currently supported."
        } else if text.contains("no matching ") {
            "Topology SSH algorithm negotiation failed. Check the switch's SSH algorithms against the system OpenSSH client."
        } else if text.contains("exec request failed") {
            "Topology SSH remote command was rejected. Interactive SSH may work even when the switch rejects non-interactive command execution."
        } else if [
            "Connection refused",
            "Connection timed out",
            "Connection reset",
            "No route to host",
            "Network is unreachable",
            "Could not resolve hostname",
        ]
        .iter()
        .any(|message| text.contains(message))
        {
            "Topology SSH connection failed. Check the saved host/port, name resolution, network route and switch SSH service."
        } else {
            "Topology SSH failed (authentication, host trust, or transport error)"
        }
    }

    async fn supervise(
        mut command: Command,
        cancel: &CancellationToken,
        deadline: Instant,
        registration: &Registration,
        askpass: bool,
        input: Option<zeroize::Zeroizing<Vec<u8>>>,
    ) -> Result<String, String> {
        let strict_utf8 = input.is_some();
        let helper = if askpass {
            Some(Askpass::create()?)
        } else {
            None
        };
        if let Some(helper) = &helper {
            command.env("SSH_ASKPASS", &helper.0);
        }
        command
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        let mut child = {
            // Admission, spawn and registration are serialized against synchronous shutdown.
            let mut state = registration.processes.0.state.lock();
            if state.stopped || cancel.is_cancelled() {
                return Err("Topology SSH cancelled".into());
            }
            if Instant::now() >= deadline {
                return Err("Topology SSH timed out".into());
            }
            let child = command
                .spawn()
                .map_err(|_| "Cannot start topology SSH process")?;
            let entry = state
                .entries
                .get_mut(&registration.id)
                .expect("owned registration");
            entry.group = child.id().map(|pid| pid as i32);
            entry.helper = helper;
            child
        };
        let pid = child.id().expect("spawned child");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let result = {
            let wait = async {
                wait_exited(pid).await?;
                // A normal parent exit does not imply that its descendants have exited.
                registration.kill_group()?;
                child
                    .wait()
                    .await
                    .map_err(|_| "Topology SSH wait failed".to_string())
            };
            let write = async move {
                if let (Some(mut stdin), Some(input)) = (stdin, input) {
                    stdin
                        .write_all(&input)
                        .await
                        .map_err(|_| "Topology SSH input write failed".to_string())?;
                    stdin
                        .shutdown()
                        .await
                        .map_err(|_| "Topology SSH input close failed".to_string())?;
                }
                Ok::<_, String>(())
            };
            let output = async {
                let (stdout, stderr, ()) = tokio::try_join!(
                    read_bounded(stdout, STDOUT_LIMIT),
                    read_bounded(stderr, STDERR_LIMIT),
                    write,
                )?;
                Ok::<_, String>((stdout, stderr))
            };
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Err("Topology SSH cancelled".into()),
                _ = tokio::time::sleep_until(deadline) => Err("Topology SSH timed out".into()),
                result = async { tokio::try_join!(wait, output) } => result.map(|(status, (stdout, stderr))| (status, stdout, stderr)),
            }
        };
        let killed = registration.kill_group();
        // Never drop a pending wait as cleanup: explicitly kill and reap the direct child.
        let _ = child.start_kill();
        let reaped = child.wait().await.map_err(|_| "Topology SSH reap failed");
        killed?;
        reaped?;
        let (status, stdout, stderr) = result?;
        if !status.success() {
            // Never expose raw stderr: it can contain credentials or hostile device text.
            return Err(if askpass {
                ssh_failure(&stderr).into()
            } else {
                "Topology SSH failed (authentication, host trust, or transport error)".into()
            });
        }
        if cancel.is_cancelled() {
            return Err("Topology SSH cancelled".into());
        }
        if strict_utf8 {
            String::from_utf8(stdout).map_err(|_| "Topology SSH output is not UTF-8".into())
        } else {
            Ok(String::from_utf8_lossy(&stdout).into_owned())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[tokio::test]
        async fn discovery_transport_failed_signal_retains_ownership_until_shutdown_retry() {
            use std::sync::atomic::Ordering;
            struct Cleanup {
                processes: DiscoveryProcesses,
                group: Option<i32>,
            }
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    self.processes.0.fail_signals.store(false, Ordering::SeqCst);
                    if let Some(group) = self.group {
                        let _ = kill_group(group);
                    }
                    let _ = self.processes.shutdown();
                }
            }
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("pid");
            let helperfile = dir.path().join("helper");
            let script = format!("sleep 60 >/dev/null 2>&1 & printf '%s %s' \"$$\" \"$!\" > '{}'; printf '%s' \"$SSH_ASKPASS\" > '{}'; wait", pidfile.display(), helperfile.display());
            let mut command = Command::new("/bin/sh");
            command.args(["-c", &script]);
            let processes = DiscoveryProcesses::default();
            let cancel = CancellationToken::new();
            let task = tokio::spawn({
                let processes = processes.clone();
                let cancel = cancel.clone();
                async move {
                    execute(
                        command,
                        cancel,
                        Instant::now() + Duration::from_secs(10),
                        &processes,
                        true,
                    )
                    .await
                }
            });
            let (pids, helper) = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let (Ok(text), Ok(path)) = (
                        std::fs::read_to_string(&pidfile),
                        std::fs::read_to_string(&helperfile),
                    ) {
                        let pids: Vec<i32> = text
                            .split_whitespace()
                            .filter_map(|s| s.parse().ok())
                            .collect();
                        if pids.len() == 2 && !path.is_empty() {
                            break (pids, PathBuf::from(path));
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let mut cleanup = Cleanup {
                processes: processes.clone(),
                group: Some(pids[0]),
            };
            processes.0.fail_signals.store(true, Ordering::SeqCst);
            cancel.cancel();
            assert!(task.await.unwrap().unwrap_err().contains("cleanup failed"));
            {
                let state = processes.0.state.lock();
                assert_eq!(
                    state.entries.len(),
                    1,
                    "failed signal must retain unresolved ownership after registration drop"
                );
                assert_eq!(state.entries.values().next().unwrap().group, Some(pids[0]));
            }
            assert!(
                helper.exists(),
                "unresolved descendants retain their static askpass helper"
            );
            let started = std::time::Instant::now();
            assert!(processes.shutdown().is_err());
            assert!(
                processes.shutdown().is_err(),
                "repeated shutdown cannot falsely report drain"
            );
            assert!(
                started.elapsed() < Duration::from_secs(1),
                "unresolved finished supervisors report without waiting the full drain budget"
            );
            processes.0.fail_signals.store(false, Ordering::SeqCst);
            processes.shutdown().unwrap();
            cleanup.group = None;
            assert!(processes.0.state.lock().entries.is_empty());
            assert!(!helper.exists());
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if pids.iter().all(|pid| unsafe { libc::kill(*pid, 0) } == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)) { break; }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.expect("direct child reaped and retained descendant killed on retry");
        }

        #[cfg(target_os = "macos")]
        #[tokio::test]
        async fn discovery_transport_darwin_probe_rejects_live_group_and_accepts_zombies() {
            let mut child = Command::new("/bin/sleep")
                .arg("60")
                .process_group(0)
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let pid = child.id().unwrap();
            let live = group_has_no_live_members(pid as i32);
            kill_group(pid as i32).unwrap();
            wait_exited(pid).await.unwrap();
            let zombie = group_has_no_live_members(pid as i32);
            child.wait().await.unwrap();
            assert!(
                !live,
                "live owned groups must never suppress a signaling failure"
            );
            assert!(
                zombie,
                "zombie-only group is finished before direct child reap"
            );
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;

    fn target() -> SshTarget {
        SshTarget {
            host: "switch.example.test".into(),
            port: 2222,
            username: "net_admin".into(),
            password: "not-in-argv".into(),
        }
    }

    fn shell(script: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    async fn local(
        script: &str,
        cancel: CancellationToken,
        deadline: Instant,
        processes: &DiscoveryProcesses,
    ) -> Result<String, String> {
        unix::execute(shell(script), cancel, deadline, processes, false).await
    }

    #[test]
    fn discovery_transport_strict_args_and_validation() {
        let args = unix::ssh_args(&target(), "show cdp neighbors detail").unwrap();
        assert_eq!(&args[..2], ["-F", "/dev/null"]);
        assert_eq!(
            &args[args.len() - 7..],
            [
                "-p",
                "2222",
                "-l",
                "net_admin",
                "--",
                "switch.example.test",
                "show cdp neighbors detail"
            ]
        );
        for required in [
            "StrictHostKeyChecking=yes",
            "UpdateHostKeys=no",
            "VerifyHostKeyDNS=no",
            "GlobalKnownHostsFile=/dev/null",
            "ProxyCommand=none",
            "ProxyJump=none",
            "PubkeyAuthentication=no",
            "IdentityFile=none",
            "IdentityAgent=none",
        ] {
            assert!(args.iter().any(|arg| arg == required));
        }
        assert!(!args.iter().any(|arg| arg.contains("UserKnownHostsFile")
            || arg.contains("not-in-argv")
            || arg == "sshpass"));
        for host in [
            "-oProxyCommand=bad",
            "host user",
            "host\n",
            "user@host",
            "host;id",
            "host/path",
            "[::1]",
            "a..b",
            "host..",
            "",
        ] {
            let mut t = target();
            t.host = host.into();
            assert!(
                unix::ssh_args(&t, "show lldp neighbors detail").is_err(),
                "accepted {host:?}"
            );
        }
        for host in ["192.0.2.1", "2001:db8::1", "switch-1.example.test."] {
            let mut t = target();
            t.host = host.into();
            assert!(unix::ssh_args(&t, "show lldp neighbors detail").is_ok());
        }
        for user in ["-root", "root@host", "root user", "root\n", "root;id", ""] {
            let mut t = target();
            t.username = user.into();
            assert!(unix::ssh_args(&t, "show lldp neighbors detail").is_err());
        }
        let mut t = target();
        t.port = 0;
        assert!(unix::ssh_args(&t, "show cdp neighbors detail").is_err());
        for command in [
            "show ip bgp summary",
            "show ip ospf neighbor",
            "show isis neighbors",
            "show ip eigrp neighbors",
        ] {
            let args = unix::ssh_args(&target(), command).unwrap();
            assert_eq!(args.last().unwrap(), command);
            assert!(args.iter().any(|arg| arg == "StrictHostKeyChecking=yes"));
        }
        for command in [
            "show ip bgp summary; id",
            "show ip eigrp neighbors; id",
            "show ip eigrp neighbors\n",
            "show ip eigrp vrf blue neighbors",
            "show isis neighbors\n",
            "show version",
            "show cdp neighbors detail; id",
            "show lldp neighbors detail\n",
        ] {
            assert!(unix::ssh_args(&target(), command).is_err());
        }
    }

    #[tokio::test]
    async fn discovery_transport_precancel_and_expired_deadline_do_not_spawn() {
        let processes = DiscoveryProcesses::default();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(run_command(
            &target(),
            "show cdp neighbors detail",
            cancel,
            Instant::now() + Duration::from_secs(1),
            &processes
        )
        .await
        .unwrap_err()
        .contains("cancelled"));
        assert!(run_command(
            &target(),
            "show cdp neighbors detail",
            CancellationToken::new(),
            Instant::now(),
            &processes
        )
        .await
        .unwrap_err()
        .contains("timed out"));
        processes.shutdown().unwrap();
    }

    #[tokio::test]
    async fn discovery_transport_output_and_failure_are_bounded_and_sanitized() {
        let p = DiscoveryProcesses::default();
        let deadline = || Instant::now() + Duration::from_secs(3);
        assert_eq!(
            local(
                "printf 'neighbors'",
                CancellationToken::new(),
                deadline(),
                &p
            )
            .await
            .unwrap(),
            "neighbors"
        );
        assert!(!local(
            "printf 'secret' >&2; exit 1",
            CancellationToken::new(),
            deadline(),
            &p
        )
        .await
        .unwrap_err()
        .contains("secret"));
        for script in ["yes x", "yes secret >&2"] {
            let error = local(script, CancellationToken::new(), deadline(), &p)
                .await
                .unwrap_err();
            assert!(error.contains("output limit"), "{script}: {error}");
        }
        p.shutdown().unwrap();
    }

    #[tokio::test]
    async fn discovery_transport_reports_sanitized_ssh_failure_categories() {
        for (stderr, expected) in [
            (
                "No ED25519 host key is known for synthetic.example and you have requested strict checking.\nHost key verification failed.",
                "host-key verification failed",
            ),
            (
                "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.",
                "host-key verification failed",
            ),
            (
                "synthetic-user@synthetic.example: Permission denied (publickey,keyboard-interactive,password).",
                "authentication failed",
            ),
            (
                "Unable to negotiate with synthetic.example port 22: no matching host key type found. Their offer: synthetic-algorithm",
                "algorithm negotiation failed",
            ),
            (
                "ssh: connect to host synthetic.example port 22: Connection refused",
                "connection failed",
            ),
            (
                "exec request failed on channel 0",
                "remote command was rejected",
            ),
        ] {
            let processes = DiscoveryProcesses::default();
            let mut command = shell("printf '%s\\n' \"$SYNTHETIC_ERROR\" >&2; printf 'synthetic-secret' >&2; exit 255");
            command.env("SYNTHETIC_ERROR", stderr);
            let error = unix::execute(
                command,
                CancellationToken::new(),
                Instant::now() + Duration::from_secs(3),
                &processes,
                true,
            )
            .await
            .unwrap_err();
            processes.shutdown().unwrap();
            assert!(error.contains(expected), "Expected {expected}; received {error}");
            for private in ["synthetic-user", "synthetic.example", "synthetic-algorithm", "synthetic-secret"] {
                assert!(!error.contains(private), "Raw process stderr must not escape");
            }
        }
    }

    #[tokio::test]
    async fn discovery_transport_timeout_and_cancel_reap_children() {
        for cancelled in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("pid");
            let script = format!("sleep 60 & echo $$ $! > '{}'; wait", pidfile.display());
            let p = DiscoveryProcesses::default();
            let cancel = CancellationToken::new();
            let task = tokio::spawn({
                let p = p.clone();
                let cancel = cancel.clone();
                async move {
                    local(
                        &script,
                        cancel,
                        Instant::now() + Duration::from_millis(400),
                        &p,
                    )
                    .await
                }
            });
            let pids = wait_pids(&pidfile).await;
            if cancelled {
                cancel.cancel();
            }
            let error = task.await.unwrap().unwrap_err();
            assert!(error.contains(if cancelled { "cancelled" } else { "timed out" }));
            p.shutdown().unwrap();
            assert_gone(&pids).await;
        }
    }

    #[tokio::test]
    async fn discovery_transport_normal_exit_kills_remaining_descendant() {
        for redirection in ["", ">/dev/null 2>&1"] {
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("pid");
            let script = format!(
                "sleep 60 {redirection} & echo $$ $! > '{}'; printf done",
                pidfile.display()
            );
            let p = DiscoveryProcesses::default();
            assert_eq!(
                local(
                    &script,
                    CancellationToken::new(),
                    Instant::now() + Duration::from_secs(2),
                    &p
                )
                .await
                .unwrap(),
                "done"
            );
            let pids = wait_pids(&pidfile).await;
            p.shutdown().unwrap();
            assert_gone(&pids).await;
        }
    }

    #[tokio::test]
    async fn discovery_transport_sync_shutdown_drains_on_current_thread_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let script = format!("sleep 60 & echo $$ $! > '{}'; wait", pidfile.display());
        let p = DiscoveryProcesses::default();
        let task = tokio::spawn({
            let p = p.clone();
            async move {
                local(
                    &script,
                    CancellationToken::new(),
                    Instant::now() + Duration::from_secs(10),
                    &p,
                )
                .await
            }
        });
        let pids = wait_pids(&pidfile).await;
        p.shutdown().unwrap();
        assert!(task.await.unwrap().unwrap_err().contains("cancelled"));
        assert_gone(&pids).await;
        assert!(local(
            "exit 99",
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(1),
            &p
        )
        .await
        .unwrap_err()
        .contains("cancelled"));
    }

    #[tokio::test]
    async fn discovery_transport_askpass_is_static_private_and_removed_after_shutdown() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let helperfile = dir.path().join("helper");
        let script = format!(
            "printf '%s' \"$SSH_ASKPASS\" > '{}'; sleep 60 & echo $$ $! > '{}'; wait",
            helperfile.display(),
            pidfile.display()
        );
        let mut command = shell(&script);
        command.env("CCIE_TOPOLOGY_PASSWORD", "synthetic-password-never-written");
        let p = DiscoveryProcesses::default();
        let task = tokio::spawn({
            let p = p.clone();
            async move {
                unix::execute(
                    command,
                    CancellationToken::new(),
                    Instant::now() + Duration::from_secs(10),
                    &p,
                    true,
                )
                .await
            }
        });
        let pids = wait_pids(&pidfile).await;
        let path = std::path::PathBuf::from(std::fs::read_to_string(helperfile).unwrap());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "#!/bin/sh\nprintf '%s\\n' \"$CCIE_TOPOLOGY_PASSWORD\"\n"
        );
        p.shutdown().unwrap();
        assert!(!path.exists(), "askpass removed before registry drains");
        assert!(task.await.unwrap().is_err());
        assert_gone(&pids).await;
    }

    #[tokio::test]
    async fn discovery_transport_spawn_errors_and_shutdown_registration_race() {
        let p = DiscoveryProcesses::default();
        let command = tokio::process::Command::new("/nonexistent/ccie-topology-test");
        assert!(unix::execute(
            command,
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(2),
            &p,
            true
        )
        .await
        .unwrap_err()
        .contains("Cannot start"));
        let mut tasks = Vec::new();
        for _ in 0..20 {
            let p = p.clone();
            tasks.push(tokio::spawn(async move {
                local(
                    "sleep 60",
                    CancellationToken::new(),
                    Instant::now() + Duration::from_secs(10),
                    &p,
                )
                .await
            }));
        }
        tokio::task::yield_now().await;
        p.shutdown().unwrap();
        for task in tasks {
            let error = task.await.unwrap().unwrap_err();
            assert!(error.contains("cancelled"), "{error}");
        }
        p.shutdown().unwrap();
    }

    #[tokio::test]
    async fn discovery_transport_dropped_request_still_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let script = format!("sleep 60 & echo $$ $! > '{}'; wait", pidfile.display());
        let p = DiscoveryProcesses::default();
        let task = tokio::spawn({
            let p = p.clone();
            async move {
                local(
                    &script,
                    CancellationToken::new(),
                    Instant::now() + Duration::from_secs(10),
                    &p,
                )
                .await
            }
        });
        let pids = wait_pids(&pidfile).await;
        task.abort();
        let _ = task.await;
        p.shutdown().unwrap();
        assert_gone(&pids).await;
    }

    #[tokio::test]
    async fn snmp_worker_stdin_only_secrets_bounded_io_and_sanitized_errors() {
        let processes = DiscoveryProcesses::default();
        let secret = b"synthetic-snmp-secret-never-argv-env";
        let mut command = shell("IFS= read -r value; test -n \"$value\" || exit 1; /usr/bin/env; /bin/ps -p $$ -o command=; printf done");
        command.env_clear().env("PATH", "/usr/bin:/bin");
        let raw = run_worker(
            command,
            zeroize::Zeroizing::new(secret.to_vec()),
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(3),
            &processes,
        )
        .await
        .unwrap();
        assert!(raw.ends_with("done"));
        assert!(!raw.contains(std::str::from_utf8(secret).unwrap()));
        for script in [
            "IFS= read -r value; printf '%s' \"$value\" >&2; exit 1",
            "yes x",
            "yes x >&2",
        ] {
            let error = run_worker(
                shell(script),
                zeroize::Zeroizing::new(secret.to_vec()),
                CancellationToken::new(),
                Instant::now() + Duration::from_secs(3),
                &processes,
            )
            .await
            .unwrap_err();
            assert!(!error.contains(std::str::from_utf8(secret).unwrap()));
            assert!(error.contains("SNMP"));
        }
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("must-not-spawn");
        let script = format!("touch '{}'", marker.display());
        assert!(run_worker(
            shell(&script),
            zeroize::Zeroizing::new(vec![0; 16385]),
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(3),
            &processes
        )
        .await
        .is_err());
        assert!(!marker.exists());
        processes.shutdown().unwrap();
    }

    #[tokio::test]
    async fn snmp_worker_hang_cancel_drop_and_shutdown_kill_and_reap_owned_children() {
        for mode in ["timeout", "cancel", "drop", "shutdown"] {
            let dir = tempfile::tempdir().unwrap();
            let pidfile = dir.path().join("pid");
            let script = format!(
                "sleep 60 & printf '%s %s' \"$$\" \"$!\" > '{}'; wait",
                pidfile.display()
            );
            let processes = DiscoveryProcesses::default();
            let cancel = CancellationToken::new();
            let task = tokio::spawn({
                let processes = processes.clone();
                let cancel = cancel.clone();
                async move {
                    run_worker(
                        shell(&script),
                        zeroize::Zeroizing::new(vec![b'x'; 16384]),
                        cancel,
                        Instant::now()
                            + if mode == "timeout" {
                                Duration::from_millis(400)
                            } else {
                                Duration::from_secs(10)
                            },
                        &processes,
                    )
                    .await
                }
            });
            let pids = wait_pids(&pidfile).await;
            match mode {
                "cancel" => cancel.cancel(),
                "drop" => task.abort(),
                "shutdown" => processes.shutdown().unwrap(),
                _ => (),
            }
            let result = task.await;
            if mode != "drop" {
                assert!(result.unwrap().is_err());
            }
            processes.shutdown().unwrap();
            assert_gone(&pids).await;
        }
    }

    async fn wait_pids(path: &std::path::Path) -> Vec<i32> {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(path) {
                    let pids: Vec<i32> = text
                        .split_whitespace()
                        .filter_map(|s| s.parse().ok())
                        .collect();
                    if pids.len() == 2 {
                        return pids;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("synthetic child started")
    }

    async fn assert_gone(pids: &[i32]) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if pids.iter().all(|pid| unsafe { libc::kill(*pid, 0) } == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("direct child reaped and descendant terminated");
    }
}
