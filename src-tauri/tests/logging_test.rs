use ccie_terminal_lib::logging::{init_logging, LogConfig, LogLevel};
use std::fs;
use tempfile::TempDir;

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
    let temp_dir = TempDir::new().unwrap();
    let log_dir = temp_dir.path().join("logs");

    // Production mode (JSON format)
    let prod_config = LogConfig::new()
        .with_log_dir(log_dir.clone())
        .with_production_mode(true);

    init_logging(prod_config).expect("Failed to initialize logging");

    // Development mode (pretty print)
    let dev_config = LogConfig::new()
        .with_log_dir(log_dir.clone())
        .with_production_mode(false);

    init_logging(dev_config).expect("Failed to initialize logging");
}

#[test]
fn test_structured_logging_fields() {
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
