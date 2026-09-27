use anyhow::{Context, Result};
use std::path::PathBuf;
use tracing::Level;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Log level configuration
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    /// Convert string to LogLevel (case-insensitive)
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "debug" => LogLevel::Debug,
            "info" => LogLevel::Info,
            "warn" | "warning" => LogLevel::Warn,
            "error" => LogLevel::Error,
            _ => LogLevel::Info, // Default to Info for invalid values
        }
    }

    /// Convert to tracing::Level
    fn to_tracing_level(&self) -> Level {
        match self {
            LogLevel::Debug => Level::DEBUG,
            LogLevel::Info => Level::INFO,
            LogLevel::Warn => Level::WARN,
            LogLevel::Error => Level::ERROR,
        }
    }
}

/// Configuration for logging system
#[derive(Debug, Clone)]
pub struct LogConfig {
    pub level: LogLevel,
    pub log_dir: Option<PathBuf>,
    pub max_file_size_mb: u64,
    pub max_files: usize,
    pub production_mode: bool,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            level: LogLevel::Info,
            log_dir: None,
            max_file_size_mb: 10,
            max_files: 5,
            production_mode: false,
        }
    }
}

impl LogConfig {
    /// Create a new LogConfig with defaults
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the log level
    pub fn with_level(mut self, level: LogLevel) -> Self {
        self.level = level;
        self
    }

    /// Set the log directory
    pub fn with_log_dir(mut self, dir: PathBuf) -> Self {
        self.log_dir = Some(dir);
        self
    }

    /// Set the maximum file size in MB
    pub fn with_max_file_size_mb(mut self, size: u64) -> Self {
        self.max_file_size_mb = size;
        self
    }

    /// Set the maximum number of log files
    pub fn with_max_files(mut self, count: usize) -> Self {
        self.max_files = count;
        self
    }

    /// Set production mode (JSON format) vs development mode (pretty print)
    pub fn with_production_mode(mut self, production: bool) -> Self {
        self.production_mode = production;
        self
    }
}

/// Initialize the logging system with the given configuration
pub fn init_logging(config: LogConfig) -> Result<()> {
    let log_dir = config.log_dir.unwrap_or_else(default_log_dir);

    // Create log directory if it doesn't exist
    std::fs::create_dir_all(&log_dir)
        .context("Failed to create log directory")?;

    // Create a file appender with daily rotation
    let file_appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("ccie-terminal")
        .filename_suffix("log")
        .max_log_files(config.max_files)
        .build(&log_dir)
        .context("Failed to create log file appender")?;

    // Create env filter
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| {
            EnvFilter::new(format!(
                "ccie_terminal_lib={}",
                config.level.to_tracing_level()
            ))
        });

    // Build the subscriber based on mode
    let result = if config.production_mode {
        // JSON format for production
        tracing_subscriber::registry()
            .with(env_filter)
            .with(
                fmt::layer()
                    .json()
                    .with_writer(file_appender)
                    .with_current_span(true)
                    .with_span_list(true)
            )
            .try_init()
    } else {
        // Pretty print for development
        tracing_subscriber::registry()
            .with(env_filter)
            .with(
                fmt::layer()
                    .pretty()
                    .with_writer(file_appender)
                    .with_file(true)
                    .with_line_number(true)
                    .with_thread_ids(true)
                    .with_target(true)
            )
            .try_init()
    };

    // Handle the case where subscriber is already initialized (in tests)
    if let Err(e) = result {
        // Check if it's because a subscriber is already set
        if e.to_string().contains("already been set") {
            // Silently ignore in tests - subscriber is already initialized
            return Ok(());
        } else {
            return Err(anyhow::anyhow!("Failed to initialize tracing subscriber: {}", e));
        }
    }

    tracing::info!(
        log_dir = ?log_dir,
        level = ?config.level,
        production_mode = config.production_mode,
        "Logging initialized"
    );

    Ok(())
}

/// Get the default log directory
/// Returns ~/.local/share/ccie-terminal/logs/ on Unix
/// Returns %APPDATA%/ccie-terminal/logs/ on Windows
pub fn default_log_dir() -> PathBuf {
    let base_dir = if cfg!(target_os = "windows") {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from("."))
    } else {
        dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."))
    };

    base_dir.join("ccie-terminal").join("logs")
}

/// Initialize logging with default configuration
pub fn init_default_logging() -> Result<()> {
    let config = LogConfig::default()
        .with_level(LogLevel::Info)
        .with_production_mode(false);

    init_logging(config)
}

/// Initialize logging for tests (writes to temp directory)
#[cfg(test)]
pub fn init_test_logging() -> Result<()> {
    let temp_dir = std::env::temp_dir().join("ccie-terminal-test-logs");
    let config = LogConfig::default()
        .with_log_dir(temp_dir)
        .with_level(LogLevel::Debug);

    init_logging(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_log_level_to_tracing_level() {
        assert_eq!(LogLevel::Debug.to_tracing_level(), Level::DEBUG);
        assert_eq!(LogLevel::Info.to_tracing_level(), Level::INFO);
        assert_eq!(LogLevel::Warn.to_tracing_level(), Level::WARN);
        assert_eq!(LogLevel::Error.to_tracing_level(), Level::ERROR);
    }

    #[test]
    fn test_default_log_dir_exists() {
        let dir = default_log_dir();
        assert!(dir.to_string_lossy().contains("ccie-terminal"));
        assert!(dir.to_string_lossy().contains("logs"));
    }
}
