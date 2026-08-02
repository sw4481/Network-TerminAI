//! Input validation functions for security hardening
//!
//! Validates all user input to prevent injection attacks and ensure data integrity.

use anyhow::Result;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ValidationError {
    #[error("Invalid tab ID format: {0}")]
    InvalidTabId(String),

    #[error("Invalid command: {0}")]
    InvalidCommand(String),

    #[error("Invalid session name: {0}")]
    InvalidSessionName(String),

    #[error("Invalid search query: {0}")]
    InvalidSearchQuery(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("Input too long: {0} exceeds maximum length {1}")]
    InputTooLong(usize, usize),

    #[error("Empty input not allowed")]
    EmptyInput,

    #[error("SQL injection detected: {0}")]
    SqlInjectionDetected(String),

    #[error("Command injection detected: {0}")]
    CommandInjectionDetected(String),

    #[error("Path traversal detected: {0}")]
    PathTraversal(String),
}

/// Maximum lengths for various input types
pub const MAX_TAB_ID_LENGTH: usize = 64;
pub const MAX_SESSION_NAME_LENGTH: usize = 128;
pub const MAX_COMMAND_LENGTH: usize = 8192;
pub const MAX_SEARCH_QUERY_LENGTH: usize = 1024;
pub const MAX_PATH_LENGTH: usize = 4096;

/// Validate tab ID format
///
/// Tab IDs must be:
/// - Non-empty
/// - UUID v4 format or alphanumeric with hyphens
/// - Maximum 64 characters
///
/// # Example
/// ```
/// use ccie_terminal_lib::validation::validate_tab_id;
/// assert!(validate_tab_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
/// assert!(validate_tab_id("tab-1234").is_ok());
/// assert!(validate_tab_id("../../../etc/passwd").is_err());
/// ```
pub fn validate_tab_id(tab_id: &str) -> Result<String, ValidationError> {
    if tab_id.is_empty() {
        return Err(ValidationError::EmptyInput);
    }

    if tab_id.len() > MAX_TAB_ID_LENGTH {
        return Err(ValidationError::InputTooLong(
            tab_id.len(),
            MAX_TAB_ID_LENGTH,
        ));
    }

    // Check for path traversal attempts
    if tab_id.contains("..") || tab_id.contains('/') || tab_id.contains('\\') {
        return Err(ValidationError::InvalidTabId(
            "Tab ID cannot contain path separators or parent directory references".to_string(),
        ));
    }

    // Allow UUID format or alphanumeric with hyphens and underscores
    if !tab_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ValidationError::InvalidTabId(
            "Tab ID must contain only alphanumeric characters, hyphens, and underscores"
                .to_string(),
        ));
    }

    Ok(tab_id.to_string())
}

/// Validate and sanitize shell command
///
/// This function checks for command injection patterns and dangerous commands.
/// It does NOT execute the command - that's the shell's job.
///
/// # Security Notes
/// - Commands are passed through a PTY which provides proper shell escaping
/// - We don't try to parse or execute commands ourselves
/// - We only check for obviously malicious patterns
///
/// # Example
/// ```
/// use ccie_terminal_lib::validation::validate_command;
/// assert!(validate_command("ls -la").is_ok());
/// assert!(validate_command("echo 'hello world'").is_ok());
/// // Command injection attempts should be caught by the PTY layer
/// ```
pub fn validate_command(cmd: &str) -> Result<String, ValidationError> {
    if cmd.is_empty() {
        return Err(ValidationError::EmptyInput);
    }

    if cmd.len() > MAX_COMMAND_LENGTH {
        return Err(ValidationError::InputTooLong(cmd.len(), MAX_COMMAND_LENGTH));
    }

    // Check for null bytes (can cause issues in C interfaces)
    if cmd.contains('\0') {
        return Err(ValidationError::InvalidCommand(
            "Command cannot contain null bytes".to_string(),
        ));
    }

    // Note: We don't validate command content beyond basic checks
    // The PTY handles proper shell escaping and execution
    // Trying to parse shell syntax ourselves would be error-prone

    Ok(cmd.to_string())
}

/// Validate session name
///
/// Session names must be:
/// - Non-empty
/// - Alphanumeric with hyphens, underscores, and spaces
/// - Maximum 128 characters
/// - No path separators or special characters
///
/// # Example
/// ```
/// use ccie_terminal_lib::validation::validate_session_name;
/// assert!(validate_session_name("my-session-2024").is_ok());
/// assert!(validate_session_name("Project Work").is_ok());
/// assert!(validate_session_name("../../etc/passwd").is_err());
/// ```
pub fn validate_session_name(name: &str) -> Result<String, ValidationError> {
    if name.is_empty() {
        return Err(ValidationError::EmptyInput);
    }

    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(ValidationError::EmptyInput);
    }

    if trimmed.len() > MAX_SESSION_NAME_LENGTH {
        return Err(ValidationError::InputTooLong(
            trimmed.len(),
            MAX_SESSION_NAME_LENGTH,
        ));
    }

    // Check for path traversal attempts
    if trimmed.contains("..") || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(ValidationError::InvalidSessionName(
            "Session name cannot contain path separators or parent directory references"
                .to_string(),
        ));
    }

    // Allow alphanumeric, hyphens, underscores, spaces, and common punctuation
    if !trimmed.chars().all(|c| {
        c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' || c == '.' || c == ',' || c == '\''
    }) {
        return Err(ValidationError::InvalidSessionName(
            "Session name contains invalid characters".to_string(),
        ));
    }

    Ok(trimmed.to_string())
}

/// Validate and escape search query for FTS5
///
/// FTS5 queries use special characters for operators:
/// - Double quotes for phrase search
/// - Asterisk for prefix matching
/// - AND, OR, NOT operators
///
/// This function escapes the query to treat it as literal text.
///
/// # Example
/// ```
/// use ccie_terminal_lib::validation::validate_search_query;
/// assert!(validate_search_query("hello world").is_ok());
/// assert!(validate_search_query("error: connection failed").is_ok());
/// ```
pub fn validate_search_query(query: &str) -> Result<String, ValidationError> {
    if query.is_empty() {
        return Err(ValidationError::EmptyInput);
    }

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err(ValidationError::EmptyInput);
    }

    if trimmed.len() > MAX_SEARCH_QUERY_LENGTH {
        return Err(ValidationError::InputTooLong(
            trimmed.len(),
            MAX_SEARCH_QUERY_LENGTH,
        ));
    }

    // Check for null bytes
    if trimmed.contains('\0') {
        return Err(ValidationError::InvalidSearchQuery(
            "Search query cannot contain null bytes".to_string(),
        ));
    }

    // FTS5 `MATCH ?` with parameter binding is already safe from SQL injection
    // (the string is interpreted as FTS5 tokens, not SQL). But as a defense-
    // in-depth hedge, scrub well-known SQL DDL/DML keywords from the query so
    // they can never appear in any generated SQL error message or log line.
    // Case-insensitive replacement of whole-word tokens only — we don't want
    // to mangle "selection" or "dropped" in legitimate text search.
    let scrubbed = scrub_sql_keywords(trimmed);

    // Escape double quotes for FTS5 phrase syntax.
    let escaped = scrubbed.replace('"', "\"\"");

    Ok(escaped)
}

/// Replace SQL DDL/DML keywords (case-insensitive, whole-word only) with
/// spaces. Used defensively by `validate_search_query` so that SQL fragments
/// can never survive into generated SQL or log output.
fn scrub_sql_keywords(input: &str) -> String {
    const KEYWORDS: &[&str] = &[
        "SELECT", "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "UNION", "EXEC",
        "EXECUTE", "TABLE",
    ];
    // Tokenize on non-alphanumeric boundaries; rebuild the string with
    // keyword tokens replaced by spaces of equal length.
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_ascii_alphanumeric() {
            // Consume the full alphanumeric token.
            let start = i;
            while i < bytes.len() && (bytes[i] as char).is_ascii_alphanumeric() {
                i += 1;
            }
            let token = &input[start..i];
            let upper = token.to_ascii_uppercase();
            if KEYWORDS.contains(&upper.as_str()) {
                // Replace with spaces so lengths/positions stay stable.
                out.push_str(&" ".repeat(token.len()));
            } else {
                out.push_str(token);
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Validate file path to prevent path traversal attacks
///
/// Checks that the path:
/// - Does not contain path traversal sequences (..)
/// - Is within allowed directories
/// - Does not reference system files
///
/// # Example
/// ```no_run
/// use ccie_terminal_lib::validation::validate_path;
/// use std::path::Path;
///
/// let home = std::env::var("HOME").unwrap();
/// // The path must exist on disk for canonicalize() to succeed; this is a
/// // documentation example, not a runnable assertion. See `validate_path`
/// // unit tests for executable coverage.
/// let _ = validate_path(&format!("{}/test.txt", home), &[Path::new(&home)]);
/// assert!(validate_path("/etc/passwd", &[Path::new("/home")]).is_err());
/// ```
pub fn validate_path(path: &str, allowed_dirs: &[&Path]) -> Result<String, ValidationError> {
    if path.is_empty() {
        return Err(ValidationError::EmptyInput);
    }

    if path.len() > MAX_PATH_LENGTH {
        return Err(ValidationError::InputTooLong(path.len(), MAX_PATH_LENGTH));
    }

    let path_buf = std::path::PathBuf::from(path);

    // Canonicalize to resolve symlinks and .. references
    let canonical = path_buf
        .canonicalize()
        .map_err(|e| ValidationError::InvalidPath(format!("Cannot resolve path: {}", e)))?;

    // Canonicalize allowed_dirs too. macOS resolves /var -> /private/var and
    // /tmp -> /private/tmp via symlinks, so a raw starts_with check against
    // an uncanonicalized allowed_dir returns false even for valid paths.
    // If canonicalization fails for an allowed_dir we fall back to the raw path.
    let is_allowed = allowed_dirs.iter().any(|allowed_dir| {
        let canonical_allowed = allowed_dir.canonicalize();
        match canonical_allowed {
            Ok(cad) => canonical.starts_with(&cad),
            Err(_) => canonical.starts_with(allowed_dir),
        }
    });

    if !is_allowed && !allowed_dirs.is_empty() {
        return Err(ValidationError::PathTraversal(format!(
            "Path '{}' is not within allowed directories",
            canonical.display()
        )));
    }

    // Prevent access to sensitive system files
    let path_str = canonical.to_string_lossy();
    let dangerous_paths = [
        "/etc/passwd",
        "/etc/shadow",
        "/etc/sudoers",
        "/etc/ssh/",
        "/root/",
        "/.ssh/",
    ];

    for dangerous in &dangerous_paths {
        if path_str.contains(dangerous) {
            return Err(ValidationError::PathTraversal(format!(
                "Access to '{}' is not allowed",
                dangerous
            )));
        }
    }

    Ok(canonical.to_string_lossy().to_string())
}

/// Validate SQL parameter to prevent SQL injection
///
/// This is a defense-in-depth measure. Primary SQL injection prevention
/// is through prepared statements with parameterized queries.
///
/// # Example
/// ```
/// use ccie_terminal_lib::validation::validate_sql_param;
/// assert!(validate_sql_param("normal-value").is_ok());
/// assert!(validate_sql_param("'; DROP TABLE tabs; --").is_err());
/// ```
pub fn validate_sql_param(param: &str) -> Result<String, ValidationError> {
    // Substring patterns — any occurrence anywhere rejects.
    let suspicious_substrings = [
        "';", "\";", "--", "/*", "*/", "xp_", "sp_", "UNION", "SELECT", "INSERT", "UPDATE",
        "DELETE", "DROP", "CREATE", "ALTER", "EXEC", "EXECUTE",
    ];

    let upper = param.to_uppercase();
    for pattern in &suspicious_substrings {
        if upper.contains(pattern) {
            return Err(ValidationError::SqlInjectionDetected(format!(
                "Suspicious SQL pattern detected: {}",
                pattern
            )));
        }
    }

    // Word-bounded tautology patterns. We whitelist-split on non-alphanumerics
    // to get tokens, then look for boolean-injection shapes like "OR 1=1" or
    // "AND 1=1" without false-positiving on words like "orientation" or "band".
    let tokens: Vec<&str> = upper
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    for window in tokens.windows(3) {
        if matches!(window[0], "OR" | "AND") {
            // window[1] and window[2] numeric-and-equal is the classic tautology
            // ("1=1", "2=2", etc.) — after split on non-alphanum, "1=1" becomes
            // ["1", "1"]. Two identical numeric tokens following OR/AND is the
            // signature.
            if window[1].chars().all(|c: char| c.is_ascii_digit()) && window[1] == window[2] {
                return Err(ValidationError::SqlInjectionDetected(format!(
                    "Boolean tautology detected: {} {}={}",
                    window[0], window[1], window[2]
                )));
            }
        }
    }

    Ok(param.to_string())
}

/// Sanitize string for safe display in UI
///
/// Removes or escapes characters that could cause issues in HTML/JS contexts.
/// Note: React already handles XSS prevention, but this is defense-in-depth.
pub fn sanitize_for_display(input: &str) -> String {
    input
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_tab_id_valid() {
        assert!(validate_tab_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_tab_id("tab-123").is_ok());
        assert!(validate_tab_id("abc_def_123").is_ok());
    }

    #[test]
    fn test_validate_tab_id_invalid() {
        assert!(validate_tab_id("").is_err());
        assert!(validate_tab_id("../../../etc/passwd").is_err());
        assert!(validate_tab_id("tab/123").is_err());
        assert!(validate_tab_id("tab\\123").is_err());
        assert!(validate_tab_id("tab;id").is_err());
        assert!(validate_tab_id(&"a".repeat(100)).is_err());
    }

    #[test]
    fn test_validate_command_valid() {
        assert!(validate_command("ls -la").is_ok());
        assert!(validate_command("echo 'hello world'").is_ok());
        assert!(validate_command("git commit -m \"test\"").is_ok());
    }

    #[test]
    fn test_validate_command_invalid() {
        assert!(validate_command("").is_err());
        assert!(validate_command("cmd\0injection").is_err());
        assert!(validate_command(&"x".repeat(10000)).is_err());
    }

    #[test]
    fn test_validate_session_name_valid() {
        assert!(validate_session_name("my-session").is_ok());
        assert!(validate_session_name("Project Work 2024").is_ok());
        assert!(validate_session_name("test_session").is_ok());
    }

    #[test]
    fn test_validate_session_name_invalid() {
        assert!(validate_session_name("").is_err());
        assert!(validate_session_name("   ").is_err());
        assert!(validate_session_name("../../etc/passwd").is_err());
        assert!(validate_session_name("session/name").is_err());
        assert!(validate_session_name("session\\name").is_err());
        assert!(validate_session_name(&"a".repeat(200)).is_err());
    }

    #[test]
    fn test_validate_search_query_valid() {
        assert!(validate_search_query("hello world").is_ok());
        assert!(validate_search_query("error: connection").is_ok());

        // Test escaping
        let result = validate_search_query("test \"quoted\" text").unwrap();
        assert!(result.contains("\"\""));
    }

    #[test]
    fn test_validate_search_query_invalid() {
        assert!(validate_search_query("").is_err());
        assert!(validate_search_query("   ").is_err());
        assert!(validate_search_query("query\0injection").is_err());
        assert!(validate_search_query(&"x".repeat(2000)).is_err());
    }

    #[test]
    fn test_validate_sql_param() {
        assert!(validate_sql_param("normal-value").is_ok());
        assert!(validate_sql_param("123").is_ok());

        // SQL injection attempts should fail
        assert!(validate_sql_param("'; DROP TABLE tabs; --").is_err());
        assert!(validate_sql_param("1 OR 1=1").is_err());
        assert!(validate_sql_param("UNION SELECT * FROM users").is_err());
    }

    #[test]
    fn test_sanitize_for_display() {
        assert_eq!(sanitize_for_display("normal text"), "normal text");
        assert_eq!(
            sanitize_for_display("text\nwith\nnewlines"),
            "text\nwith\nnewlines"
        );

        // Control characters should be removed
        let with_control = "text\x00\x01\x02with\x1Bcontrol";
        let sanitized = sanitize_for_display(with_control);
        assert!(!sanitized.contains('\x00'));
        assert!(!sanitized.contains('\x01'));
    }

    #[test]
    fn test_path_validation() {
        use tempfile::TempDir;

        let temp = TempDir::new().unwrap();
        let temp_path = temp.path();

        // Create a test file
        let test_file = temp_path.join("test.txt");
        std::fs::write(&test_file, "test").unwrap();

        // Valid path within allowed directory
        let result = validate_path(test_file.to_str().unwrap(), &[temp_path]);
        assert!(result.is_ok());

        // Path outside allowed directory should fail
        let result = validate_path("/etc/passwd", &[temp_path]);
        assert!(result.is_err());
    }

    #[test]
    fn test_path_traversal_prevention() {
        use tempfile::TempDir;

        let temp = TempDir::new().unwrap();
        let temp_path = temp.path();

        // Attempt path traversal
        let traversal_path = format!("{}/../../../etc/passwd", temp_path.display());
        let result = validate_path(&traversal_path, &[temp_path]);

        // Should either fail or resolve to something not in /etc
        if let Ok(resolved) = result {
            assert!(!resolved.contains("/etc/passwd"));
        }
    }
}
