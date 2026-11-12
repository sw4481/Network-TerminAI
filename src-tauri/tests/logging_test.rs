use ccie_terminal_lib::logging::{init_logging, LogConfig, LogLevel};
use std::fs;
use tempfile::TempDir;

fn run_in_child(name: &str, mode: &str) -> bool {
    let thread = std::thread::current();
    let name = thread.name().unwrap_or(name);
    let tag = format!("{name}/{mode}");
    if std::env::var("LOGGING_TEST_CHILD").as_deref() == Ok(&tag) {
        return false;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture"])
        .env("LOGGING_TEST_CHILD", tag)
        .env(
            "RUST_LOG",
            "trace,russh=trace,russh::client::encrypted=trace,russh::server::encrypted=trace",
        )
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("running 1 test"),
        "isolated child selected no test"
    );
    assert!(
        output.status.success(),
        "isolated logging case: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}
fn log_text(dir: &std::path::Path) -> String {
    fs::read_dir(dir)
        .unwrap()
        .map(|entry| fs::read_to_string(entry.unwrap().path()).unwrap())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn test_log_config_defaults() {
    let config = LogConfig::default();
    assert_eq!(config.level, LogLevel::Info);
    assert_eq!(config.max_file_size_mb, 10);
    assert_eq!(config.max_files, 5);
}

#[test]
fn test_log_config_builder() {
    let config = LogConfig::new()
        .with_level(LogLevel::Debug)
        .with_max_file_size_mb(20)
        .with_max_files(10);

    assert_eq!(config.level, LogLevel::Debug);
    assert_eq!(config.max_file_size_mb, 20);
    assert_eq!(config.max_files, 10);
}

#[test]
fn test_init_logging_creates_log_directory() {
    if run_in_child("test_init_logging_creates_log_directory", "default") {
        return;
    }
    let temp_dir = TempDir::new().unwrap();
    let log_dir = temp_dir.path().join("logs");

    let config = LogConfig::new()
        .with_log_dir(log_dir.clone())
        .with_level(LogLevel::Debug);

    // Initialize logging
    init_logging(config).expect("Failed to initialize logging");

    // Verify log directory was created
    assert!(log_dir.exists());
    assert!(log_dir.is_dir());
}

#[test]
fn test_log_level_from_string() {
    assert_eq!(LogLevel::from_str("debug"), LogLevel::Debug);
    assert_eq!(LogLevel::from_str("DEBUG"), LogLevel::Debug);
    assert_eq!(LogLevel::from_str("info"), LogLevel::Info);
    assert_eq!(LogLevel::from_str("INFO"), LogLevel::Info);
    assert_eq!(LogLevel::from_str("warn"), LogLevel::Warn);
    assert_eq!(LogLevel::from_str("error"), LogLevel::Error);
    assert_eq!(LogLevel::from_str("invalid"), LogLevel::Info);
}

#[test]
fn test_log_rotation_configuration() {
    if run_in_child("test_log_rotation_configuration", "default") {
        return;
    }
    let temp_dir = TempDir::new().unwrap();
    let log_dir = temp_dir.path().join("logs");

    let config = LogConfig::new()
        .with_log_dir(log_dir.clone())
        .with_level(LogLevel::Info)
        .with_max_file_size_mb(5)
        .with_max_files(3);

    init_logging(config).expect("Failed to initialize logging");

    // Log directory should exist
    assert!(log_dir.exists());
}

#[test]
fn test_production_vs_development_format() {
    let mode = std::env::var("LOGGING_TEST_CHILD").unwrap_or_default();
    if mode.is_empty() {
        for mode in ["json", "pretty"] {
            run_in_child("test_production_vs_development_format", mode);
        }
        return;
    }
    let production = mode.ends_with("/json");
    let temp_dir = TempDir::new().unwrap();
    init_logging(
        LogConfig::new()
            .with_log_dir(temp_dir.path().to_path_buf())
            .with_production_mode(production),
    )
    .unwrap();
    tracing::debug!(target: "russh::client::encrypted", "blocked-native-wire");
    log::trace!(target: "russh::server::encrypted", "blocked-bridged-wire");
    log::trace!(target: "russh::session", "blocked-session-packet");
    log::debug!(target: "russh::session", "session-debug-positive");
    tracing::event!(target: "log", tracing::Level::DEBUG, { "log.target" = "russh::client::encrypted", message = "blocked-normalized-wire" });
    tracing::event!(target: "log", tracing::Level::DEBUG, { "log.target" = "unrelated.module", message = "normalized-positive" });
    log::trace!(target: "russh::client::encrypted_extra", "nearby-target-positive");
    tracing::trace!(target: "logging.fixture", "unrelated-trace-positive");
    log::info!(target: "russh::client::encrypted", "wire-info-positive");
    log::warn!(target: "russh::server::encrypted", "wire-warn-positive");
    tracing::error!(target: "russh::client::encrypted", "wire-error-positive");
    let text = log_text(temp_dir.path());
    for marker in [
        "blocked-native-wire",
        "blocked-session-packet",
        "blocked-bridged-wire",
        "blocked-normalized-wire",
    ] {
        assert!(!text.contains(marker));
    }
    for marker in [
        "normalized-positive",
        "session-debug-positive",
        "nearby-target-positive",
        "unrelated-trace-positive",
        "wire-info-positive",
        "wire-warn-positive",
        "wire-error-positive",
    ] {
        assert!(text.contains(marker), "missing {marker}");
    }
    if production {
        for line in text.lines().filter(|line| !line.is_empty()) {
            serde_json::from_str::<serde_json::Value>(line).unwrap();
        }
    } else {
        assert!(text.contains("WARN"));
    }
}

#[test]
fn test_structured_logging_fields() {
    if run_in_child("test_structured_logging_fields", "default") {
        return;
    }
    let temp_dir = TempDir::new().unwrap();
    let log_dir = temp_dir.path().join("logs");

    let config = LogConfig::new()
        .with_log_dir(log_dir.clone())
        .with_level(LogLevel::Debug);

    init_logging(config).expect("Failed to initialize logging");

    // Test that we can log with structured fields
    tracing::info!(
        user_id = "test_user",
        action = "test_action",
        "Test structured log message"
    );

    tracing::error!(error = "test_error", code = 500, "Test error with fields");
}

#[test]
fn test_log_file_naming() {
    if run_in_child("test_log_file_naming", "default") {
        return;
    }
    let temp_dir = TempDir::new().unwrap();
    let log_dir = temp_dir.path().join("logs");

    let config = LogConfig::new()
        .with_log_dir(log_dir.clone())
        .with_level(LogLevel::Info);

    init_logging(config).expect("Failed to initialize logging");

    // Write a log message to ensure file is created
    tracing::info!("Test log message");

    // Give it a moment to flush
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Check that log files were created
    let entries = fs::read_dir(&log_dir).unwrap();
    let log_files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s == "log")
                .unwrap_or(false)
        })
        .collect();

    // Should have at least one log file
    assert!(!log_files.is_empty(), "No log files were created");
}
