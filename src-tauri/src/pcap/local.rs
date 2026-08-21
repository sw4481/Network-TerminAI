//! Local-interface capture through the external Wireshark `dumpcap` binary.
//!
//! Keeping the process boundary here gives every desktop platform one capture
//! implementation while avoiding a bundled libpcap/Npcap dependency.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LocalCaptureInterface {
    pub selector: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalCaptureSpec {
    pub interface_selector: String,
    pub capture_filter: Option<String>,
    pub duration_seconds: u32,
    pub max_size_mib: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostPlatform {
    Windows,
    Macos,
    Linux,
}

fn current_platform() -> HostPlatform {
    if cfg!(target_os = "windows") {
        HostPlatform::Windows
    } else if cfg!(target_os = "macos") {
        HostPlatform::Macos
    } else {
        HostPlatform::Linux
    }
}

fn candidate_paths(
    platform: HostPlatform,
    path_env: Option<&OsStr>,
    program_files: Option<&OsStr>,
) -> Vec<PathBuf> {
    let binary = if platform == HostPlatform::Windows {
        "dumpcap.exe"
    } else {
        "dumpcap"
    };
    let mut candidates = path_env
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .map(|dir| dir.join(binary))
        .collect::<Vec<_>>();

    match platform {
        HostPlatform::Windows => {
            if let Some(root) = program_files {
                candidates.push(PathBuf::from(root).join("Wireshark").join("dumpcap.exe"));
            }
        }
        HostPlatform::Macos => candidates.extend([
            PathBuf::from("/Applications/Wireshark.app/Contents/MacOS/dumpcap"),
            PathBuf::from("/opt/homebrew/bin/dumpcap"),
            PathBuf::from("/usr/local/bin/dumpcap"),
        ]),
        HostPlatform::Linux => candidates.extend([
            PathBuf::from("/usr/bin/dumpcap"),
            PathBuf::from("/usr/local/bin/dumpcap"),
        ]),
    }
    candidates.dedup();
    candidates
}

pub fn resolve_dumpcap() -> Result<PathBuf> {
    let path_env = std::env::var_os("PATH");
    let program_files = std::env::var_os("ProgramFiles");
    candidate_paths(
        current_platform(),
        path_env.as_deref(),
        program_files.as_deref(),
    )
    .into_iter()
    .find(|path| path.is_file())
    .ok_or_else(|| {
        anyhow!(
            "dumpcap was not found. Install Wireshark (including dumpcap). {}",
            platform_guidance()
        )
    })
}

pub fn platform_guidance() -> &'static str {
    if cfg!(target_os = "windows") {
        "On Windows, install Wireshark with Npcap and allow the capture driver during setup."
    } else if cfg!(target_os = "macos") {
        "On macOS, install Wireshark's ChmodBPF helper or grant the user BPF device access."
    } else {
        "On Linux, add the user to the Wireshark capture group or grant dumpcap the documented capture capabilities; TerminAI will not invoke sudo."
    }
}

/// Parse `dumpcap -D`. The stable selector for an immediate launch is the
/// numeric token before the first period; the remainder is retained verbatim
/// so start can reject an interface-list change between selection and launch.
pub fn parse_interfaces(stdout: &str) -> Result<Vec<LocalCaptureInterface>> {
    let mut interfaces = Vec::new();
    for raw in stdout.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let Some((selector, label)) = line.split_once('.') else {
            continue;
        };
        let selector = selector.trim();
        let label = label.trim();
        if selector.parse::<u32>().is_err() || label.is_empty() {
            continue;
        }
        interfaces.push(LocalCaptureInterface {
            selector: selector.to_string(),
            label: label.to_string(),
        });
    }
    if interfaces.is_empty() {
        return Err(anyhow!(
            "dumpcap did not report any capture interfaces. {}",
            platform_guidance()
        ));
    }
    Ok(interfaces)
}

pub fn capture_args(spec: &LocalCaptureSpec, output_path: &Path) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-i"),
        OsString::from(&spec.interface_selector),
    ];
    if let Some(filter) = spec
        .capture_filter
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.extend([OsString::from("-f"), OsString::from(filter)]);
    }
    args.extend([
        OsString::from("-F"),
        OsString::from("pcap"),
        OsString::from("-a"),
        OsString::from(format!("duration:{}", spec.duration_seconds)),
        OsString::from("-a"),
        OsString::from(format!("filesize:{}", spec.max_size_mib * 1024)),
        OsString::from("-w"),
        output_path.as_os_str().to_owned(),
    ]);
    args
}

#[async_trait::async_trait]
pub trait DumpcapBackend: Send + Sync {
    async fn list_interfaces(&self) -> Result<Vec<LocalCaptureInterface>>;
    async fn capture(&self, spec: &LocalCaptureSpec, output_path: &Path) -> Result<u64>;
}

#[derive(Debug, Clone)]
pub struct RealDumpcap {
    path: PathBuf,
}

impl RealDumpcap {
    pub fn resolve() -> Result<Self> {
        Ok(Self {
            path: resolve_dumpcap()?,
        })
    }

    #[cfg(all(test, unix))]
    fn at(path: PathBuf) -> Self {
        Self { path }
    }
}

#[async_trait::async_trait]
impl DumpcapBackend for RealDumpcap {
    async fn list_interfaces(&self) -> Result<Vec<LocalCaptureInterface>> {
        let output = Command::new(&self.path)
            .arg("-D")
            .kill_on_drop(true)
            .output()
            .await
            .with_context(|| format!("launch {} -D", self.path.display()))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(anyhow!(
                "dumpcap could not enumerate interfaces{}{}. {}",
                if detail.is_empty() { "" } else { ": " },
                detail,
                platform_guidance()
            ));
        }
        parse_interfaces(&String::from_utf8_lossy(&output.stdout))
    }

    async fn capture(&self, spec: &LocalCaptureSpec, output_path: &Path) -> Result<u64> {
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent).context("create local pcap directory")?;
        }
        let _ = std::fs::remove_file(output_path);

        let output = Command::new(&self.path)
            .args(capture_args(spec, output_path))
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
            .with_context(|| format!("launch {}", self.path.display()));

        let output = match output {
            Ok(output) => output,
            Err(err) => {
                let _ = std::fs::remove_file(output_path);
                return Err(err);
            }
        };
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let _ = std::fs::remove_file(output_path);
            return Err(anyhow!(
                "dumpcap capture failed{}{}. {}",
                if detail.is_empty() { "" } else { ": " },
                detail,
                platform_guidance()
            ));
        }
        let size = std::fs::metadata(output_path)
            .with_context(|| format!("dumpcap did not create {}", output_path.display()))?
            .len();
        Ok(size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unix_and_windows_interface_labels() {
        let rows = parse_interfaces(
            "1. en0\n2. \\Device\\NPF_{ABC} (Ethernet 2)\r\n3. any (Pseudo-device)\n",
        )
        .unwrap();
        assert_eq!(rows[0].selector, "1");
        assert_eq!(rows[0].label, "en0");
        assert_eq!(rows[1].label, r"\Device\NPF_{ABC} (Ethernet 2)");
    }

    #[test]
    fn rejects_empty_or_unparseable_interface_output() {
        assert!(parse_interfaces("dumpcap: permission denied\n").is_err());
    }

    #[test]
    fn builds_exact_bounded_capture_arguments() {
        let spec = LocalCaptureSpec {
            interface_selector: "3".into(),
            capture_filter: Some("tcp port 443".into()),
            duration_seconds: 30,
            max_size_mib: 100,
        };
        let args = capture_args(&spec, Path::new("capture.pcap"));
        let args = args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            [
                "-i",
                "3",
                "-f",
                "tcp port 443",
                "-F",
                "pcap",
                "-a",
                "duration:30",
                "-a",
                "filesize:102400",
                "-w",
                "capture.pcap",
            ]
        );
    }

    #[test]
    fn candidate_paths_cover_each_supported_platform() {
        let path = std::env::join_paths([Path::new("/custom/bin")]).unwrap();
        assert!(
            candidate_paths(HostPlatform::Macos, Some(&path), None).contains(&PathBuf::from(
                "/Applications/Wireshark.app/Contents/MacOS/dumpcap"
            ))
        );
        assert!(candidate_paths(HostPlatform::Linux, Some(&path), None)
            .contains(&PathBuf::from("/usr/bin/dumpcap")));
        assert!(candidate_paths(
            HostPlatform::Windows,
            Some(&path),
            Some(OsStr::new(r"C:\Program Files")),
        )
        .contains(
            &PathBuf::from(r"C:\Program Files")
                .join("Wireshark")
                .join("dumpcap.exe")
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_failure_removes_partial_output_and_reports_guidance() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("dumpcap-mock");
        std::fs::write(
            &script,
            "#!/bin/sh\nfor output_path do :; done\nprintf 'partial' > \"$output_path\"\nprintf 'permission denied' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let output = temp.path().join("out.pcap");
        let backend = RealDumpcap::at(script);
        let err = backend
            .capture(
                &LocalCaptureSpec {
                    interface_selector: "1".into(),
                    capture_filter: None,
                    duration_seconds: 1,
                    max_size_mib: 1,
                },
                &output,
            )
            .await
            .unwrap_err();
        assert!(!output.exists());
        assert!(err.to_string().contains("permission denied"));
    }
}
