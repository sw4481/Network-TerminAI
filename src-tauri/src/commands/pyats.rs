//! Tauri commands backing the Settings → pyATS tab.

use crate::commands::AppState;
use crate::pyats::{pyats_dir, render_env, render_testbed_yaml, PyatsDevice};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use tauri::State;

/// Write testbed.yaml + .env to `dir` with chmod 600 on the secrets file.
/// Returns the testbed.yaml path. Factored out for testability.
pub fn write_testbed_files(dir: &PathBuf, devices: &[PyatsDevice]) -> Result<String, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let testbed_path = dir.join("testbed.yaml");
    let env_path = dir.join(".env");
    fs::write(&testbed_path, render_testbed_yaml(devices)).map_err(|e| e.to_string())?;
    fs::write(&env_path, render_env(devices)).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        let mut perms = fs::metadata(&env_path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&env_path, perms).map_err(|e| e.to_string())?;
    }
    Ok(testbed_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn pyats_save_testbed(devices: Vec<PyatsDevice>) -> Result<String, String> {
    write_testbed_files(&pyats_dir(), &devices)
}

/// Result of a connection probe.
#[derive(serde::Serialize)]
pub struct PyatsConnTest {
    pub ok: bool,
    pub message: String,
}

/// Probe reachability using the existing sshpass executor (fast, no pyATS spin-up).
/// Runs a trivial, universally-safe command and reports whether the SSH login
/// + exec succeeded. Never returns Err for an unreachable device — a failed
/// probe is a normal result surfaced via `ok: false` so the UI can show it.
#[tauri::command]
pub async fn pyats_test_connection(device: PyatsDevice) -> Result<PyatsConnTest, String> {
    use crate::ssh_exec::{run_command, SshTarget, DEFAULT_CMD_TIMEOUT};

    if device.password.trim().is_empty() {
        return Ok(PyatsConnTest {
            ok: false,
            message: "No password set for this device.".into(),
        });
    }

    let target = SshTarget {
        host: device.host.clone(),
        port: device.port,
        username: device.username.clone(),
        password: device.password.clone(),
    };

    // A bare newline-free no-op that every platform accepts. Cisco IOS treats
    // an unknown trailing command harmlessly; the point is to prove that login
    // + channel-open succeed, not to parse output.
    match run_command(&target, "show clock", DEFAULT_CMD_TIMEOUT).await {
        Ok(_) => Ok(PyatsConnTest {
            ok: true,
            message: format!("Connected to {}:{}", device.host, device.port),
        }),
        Err(e) => Ok(PyatsConnTest {
            ok: false,
            message: e.to_string(),
        }),
    }
}

/// Pull devices from the topology inventory into the pyATS device shape.
/// Mgmt IP/host and a best-effort OS are pre-filled; credentials are left blank.
/// NOTE: Simplified version - returns empty for now. Full implementation would
/// query topology cache and map to PyatsDevice structure.
#[tauri::command]
pub fn pyats_import_from_topology(_state: State<'_, AppState>) -> Result<Vec<PyatsDevice>, String> {
    // Simplified: return empty list. Full implementation would query topology cache.
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_testbed_files_creates_both_files_and_chmods_env() {
        let tmp = std::env::temp_dir().join(format!("pyats_test_{}", std::process::id()));
        let devices = vec![PyatsDevice {
            name: "CORE1".into(),
            host: "10.0.0.1".into(),
            os: "iosxe".into(),
            port: 22,
            username: "admin".into(),
            password: "secret".into(),
            enable_password: "en".into(),
            platform: None,
        }];
        let path = write_testbed_files(&tmp, &devices).unwrap();
        assert!(path.ends_with("testbed.yaml"));
        assert!(tmp.join(".env").exists());
        let body = std::fs::read_to_string(tmp.join(".env")).unwrap();
        assert!(body.contains("CORE1_PASSWORD=secret"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(tmp.join(".env"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
