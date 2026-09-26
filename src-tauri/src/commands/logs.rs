use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri_plugin_opener::OpenerExt;

const DIRECTORY_ID: &str = "directory";
const APPLICATION_ID: &str = "application";
const SIDECAR_STDERR_ID: &str = "sidecar_stderr";
const AGENT_EXEC_ID: &str = "agent_exec";
const SANDBOX_INCIDENTS_ID: &str = "sandbox_incidents";
const DEVELOPMENT_LAUNCHER_ID: &str = "development_launcher";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogFileLocation {
    pub id: String,
    pub label: String,
    pub description: String,
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogLocations {
    pub directory: String,
    pub files: Vec<LogFileLocation>,
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn latest_application_log(log_dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(log_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("ccie-terminal.") && name.ends_with(".log"))
                .unwrap_or(false)
        })
        .max_by(|left, right| left.file_name().cmp(&right.file_name()))
}

fn expected_application_log(log_dir: &Path) -> PathBuf {
    log_dir.join(format!(
        "ccie-terminal.{}.log",
        chrono::Utc::now().format("%Y-%m-%d")
    ))
}

fn development_launcher_log() -> PathBuf {
    std::env::temp_dir().join("ccie-logs").join("app.log")
}

fn build_log_locations(log_dir: &Path, launcher_log: &Path) -> LogLocations {
    let application =
        latest_application_log(log_dir).unwrap_or_else(|| expected_application_log(log_dir));
    let mut files = vec![
        (
            APPLICATION_ID,
            "Application log",
            "Rust application, scheduler, and heartbeat events",
            application,
        ),
        (
            SIDECAR_STDERR_ID,
            "Sidecar errors",
            "Python sidecar errors, provider failures, and live incident notices",
            log_dir.join("sidecar-stderr.log"),
        ),
        (
            AGENT_EXEC_ID,
            "Agent executions",
            "Generated sandbox code, clipped output, errors, and timing",
            log_dir.join("agent_exec.jsonl"),
        ),
        (
            SANDBOX_INCIDENTS_ID,
            "Sandbox incidents",
            "Timeout IDs, code hashes, worker details, and automatic recovery outcomes",
            log_dir.join("sandbox_incidents.jsonl"),
        ),
    ]
    .into_iter()
    .map(|(id, label, description, path)| LogFileLocation {
        id: id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        exists: path.is_file(),
        path: path_string(&path),
    })
    .collect::<Vec<_>>();

    // run.sh writes this additional combined launcher stream in development.
    // Installed users do not see a misleading path that does not exist.
    if launcher_log.is_file() {
        files.push(LogFileLocation {
            id: DEVELOPMENT_LAUNCHER_ID.to_string(),
            label: "Development launcher".to_string(),
            description: "Combined ./run.sh build and runtime output".to_string(),
            path: path_string(launcher_log),
            exists: true,
        });
    }

    LogLocations {
        directory: path_string(log_dir),
        files,
    }
}

fn resolve_log_location(id: &str, log_dir: &Path, launcher_log: &Path) -> Option<PathBuf> {
    match id {
        DIRECTORY_ID => Some(log_dir.to_path_buf()),
        APPLICATION_ID => Some(
            latest_application_log(log_dir).unwrap_or_else(|| expected_application_log(log_dir)),
        ),
        SIDECAR_STDERR_ID => Some(log_dir.join("sidecar-stderr.log")),
        AGENT_EXEC_ID => Some(log_dir.join("agent_exec.jsonl")),
        SANDBOX_INCIDENTS_ID => Some(log_dir.join("sandbox_incidents.jsonl")),
        DEVELOPMENT_LAUNCHER_ID if launcher_log.is_file() => Some(launcher_log.to_path_buf()),
        _ => None,
    }
}

fn current_log_location(id: &str) -> Result<PathBuf, String> {
    let log_dir = crate::logging::default_log_dir();
    let launcher_log = development_launcher_log();
    let path = resolve_log_location(id, &log_dir, &launcher_log)
        .ok_or_else(|| format!("Unknown TerminAI log location: {id}"))?;
    if !path.exists() {
        return Err(format!(
            "Log location has not been created yet: {}",
            path.display()
        ));
    }
    Ok(path)
}

#[tauri::command]
pub fn get_log_locations() -> LogLocations {
    build_log_locations(
        &crate::logging::default_log_dir(),
        &development_launcher_log(),
    )
}

#[tauri::command]
pub fn open_log_location(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = current_log_location(&id)?;
    app.opener()
        .open_path(path_string(&path), None::<&str>)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))
}

#[tauri::command]
pub fn reveal_log_location(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = current_log_location(&id)?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| format!("Failed to reveal {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locations_include_known_files_and_latest_daily_application_log() {
        let temp = tempfile::tempdir().unwrap();
        let log_dir = temp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("ccie-terminal.2026-07-29.log"), "old").unwrap();
        std::fs::write(log_dir.join("ccie-terminal.2026-07-30.log"), "new").unwrap();
        std::fs::write(log_dir.join("agent_exec.jsonl"), "{}\n").unwrap();

        let locations = build_log_locations(&log_dir, &temp.path().join("missing-launcher.log"));

        assert_eq!(locations.directory, path_string(&log_dir));
        let app = locations
            .files
            .iter()
            .find(|file| file.id == APPLICATION_ID)
            .unwrap();
        assert!(app.path.ends_with("ccie-terminal.2026-07-30.log"));
        assert!(app.exists);

        let incidents = locations
            .files
            .iter()
            .find(|file| file.id == SANDBOX_INCIDENTS_ID)
            .unwrap();
        assert!(!incidents.exists);
        assert!(!locations
            .files
            .iter()
            .any(|file| file.id == DEVELOPMENT_LAUNCHER_ID));
    }

    #[test]
    fn resolver_accepts_only_fixed_log_ids() {
        let log_dir = PathBuf::from("/safe/logs");
        let launcher = PathBuf::from("/missing/app.log");

        assert_eq!(
            resolve_log_location(AGENT_EXEC_ID, &log_dir, &launcher),
            Some(log_dir.join("agent_exec.jsonl"))
        );
        assert_eq!(
            resolve_log_location("../../etc/passwd", &log_dir, &launcher),
            None
        );
        assert_eq!(
            resolve_log_location(DEVELOPMENT_LAUNCHER_ID, &log_dir, &launcher),
            None
        );
    }
}
