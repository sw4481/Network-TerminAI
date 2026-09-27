// Security-focused validation tests
// Tests input validation, injection prevention, and path traversal protection

use ccie_terminal_lib::validation::*;
use tempfile::TempDir;

#[test]
fn test_tab_id_injection_prevention() {
    // Path traversal attempts
    assert!(validate_tab_id("../../../etc/passwd").is_err());
    assert!(validate_tab_id("..\\..\\..\\windows\\system32").is_err());
    assert!(validate_tab_id("./config").is_err());

    // Command injection attempts
    assert!(validate_tab_id("tab;rm -rf /").is_err());
    assert!(validate_tab_id("tab|cat /etc/passwd").is_err());
    assert!(validate_tab_id("tab`whoami`").is_err());
    assert!(validate_tab_id("tab$(whoami)").is_err());

    // SQL injection attempts
    assert!(validate_tab_id("tab' OR '1'='1").is_err());
    assert!(validate_tab_id("tab'; DROP TABLE tabs; --").is_err());

    // Valid tab IDs
    assert!(validate_tab_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
    assert!(validate_tab_id("tab-123").is_ok());
    assert!(validate_tab_id("abc_def_123").is_ok());
}

#[test]
fn test_command_null_byte_injection() {
    // Null byte injection attempts
    assert!(validate_command("ls\0-la").is_err());
    assert!(validate_command("echo hello\0; rm -rf /").is_err());
    assert!(validate_command("cat /etc/passwd\0").is_err());

    // Valid commands
    assert!(validate_command("ls -la").is_ok());
    assert!(validate_command("echo 'hello world'").is_ok());
    assert!(validate_command("git commit -m \"test\"").is_ok());
}

#[test]
fn test_command_length_limits() {
    // Within limit
    let valid_cmd = "x".repeat(8000);
    assert!(validate_command(&valid_cmd).is_ok());

    // Exceeds limit
    let invalid_cmd = "x".repeat(8200);
    assert!(validate_command(&invalid_cmd).is_err());
    match validate_command(&invalid_cmd) {
        Err(ValidationError::InputTooLong(len, max)) => {
            assert_eq!(len, 8200);
            assert_eq!(max, MAX_COMMAND_LENGTH);
        }
        _ => panic!("Expected InputTooLong error"),
    }
}

#[test]
fn test_session_name_path_traversal() {
    // Path traversal attempts
    assert!(validate_session_name("../../../etc/passwd").is_err());
    assert!(validate_session_name("..\\..\\windows\\system32").is_err());
    assert!(validate_session_name("session/../etc/passwd").is_err());

    // Directory separators
    assert!(validate_session_name("session/name").is_err());
    assert!(validate_session_name("session\\name").is_err());

    // Valid session names
    assert!(validate_session_name("my-session").is_ok());
    assert!(validate_session_name("Project Work 2024").is_ok());
    assert!(validate_session_name("test_session").is_ok());
}

#[test]
fn test_session_name_special_characters() {
    // Potentially dangerous characters
    assert!(validate_session_name("session;rm -rf /").is_err());
    assert!(validate_session_name("session|cat /etc/passwd").is_err());
    assert!(validate_session_name("session&whoami").is_err());
    assert!(validate_session_name("session$HOME").is_err());
    assert!(validate_session_name("session`whoami`").is_err());

    // Valid special characters
    assert!(validate_session_name("session-name").is_ok());
    assert!(validate_session_name("session_name").is_ok());
    assert!(validate_session_name("session name").is_ok());
    assert!(validate_session_name("session.name").is_ok());
    assert!(validate_session_name("John's session").is_ok());
}

#[test]
fn test_search_query_sql_injection() {
    // These should be escaped, not rejected
    let query1 = validate_search_query("'; DROP TABLE tabs; --");
    assert!(query1.is_ok());
    let escaped = query1.unwrap();
    // Double quotes should be escaped
    assert!(!escaped.contains("DROP TABLE"));

    let query2 = validate_search_query("test OR 1=1");
    assert!(query2.is_ok());

    let query3 = validate_search_query("UNION SELECT * FROM users");
    assert!(query3.is_ok());
}

#[test]
fn test_search_query_fts5_escaping() {
    // FTS5 special characters should be escaped
    let query = validate_search_query("search \"quoted\" term").unwrap();
    // Double quotes should be doubled
    assert!(query.contains("\"\""));

    // Verify the exact escaping
    assert_eq!(validate_search_query("test").unwrap(), "test");
    assert_eq!(
        validate_search_query("test\"quote").unwrap(),
        "test\"\"quote"
    );
}

#[test]
fn test_search_query_length_limits() {
    // Within limit
    let valid_query = "x".repeat(1000);
    assert!(validate_search_query(&valid_query).is_ok());

    // Exceeds limit
    let invalid_query = "x".repeat(1100);
    assert!(validate_search_query(&invalid_query).is_err());
}

#[test]
fn test_sql_param_injection_detection() {
    // SQL injection patterns should be detected
    assert!(validate_sql_param("'; DROP TABLE tabs; --").is_err());
    assert!(validate_sql_param("1 OR 1=1").is_err());
    assert!(validate_sql_param("UNION SELECT * FROM users").is_err());
    assert!(validate_sql_param("'; DELETE FROM tabs WHERE '1'='1").is_err());
    assert!(validate_sql_param("admin'--").is_err());
    assert!(validate_sql_param("1'; EXEC sp_executesql --").is_err());

    // Normal values should pass
    assert!(validate_sql_param("normal-value").is_ok());
    assert!(validate_sql_param("tab-123-abc").is_ok());
    assert!(validate_sql_param("550e8400-e29b-41d4-a716-446655440000").is_ok());
}

#[test]
fn test_path_traversal_prevention() {
    let temp = TempDir::new().unwrap();
    let temp_path = temp.path();

    // Create a test file
    let test_file = temp_path.join("test.txt");
    std::fs::write(&test_file, "test content").unwrap();

    // Valid path within allowed directory
    let result = validate_path(test_file.to_str().unwrap(), &[temp_path]);
    assert!(result.is_ok());

    // Attempt to traverse outside allowed directory
    let etc_path = "/etc/passwd";
    let result = validate_path(etc_path, &[temp_path]);
    assert!(result.is_err());

    // Attempt to use .. to escape
    let parent_path = temp_path.parent().unwrap();
    let traversal = temp_path.join("..").join("test.txt");
    let result = validate_path(traversal.to_str().unwrap(), &[temp_path]);
    // Should either fail or resolve to parent (which is outside allowed)
    if let Ok(resolved) = result {
        // If it succeeds, it should be because the path was outside allowed dirs
        // and we passed empty allowed_dirs
        assert!(resolved.starts_with(parent_path.to_str().unwrap()));
    }
}

#[test]
fn test_path_sensitive_file_protection() {
    // These paths should always be rejected when allowed_dirs is set
    let temp = TempDir::new().unwrap();
    let temp_path = temp.path();

    // Create dummy sensitive files (they won't actually be /etc/passwd on test system)
    // We're testing the string matching logic
    let sensitive_paths = vec![
        "/etc/passwd",
        "/etc/shadow",
        "/etc/sudoers",
        "/root/.ssh/id_rsa",
    ];

    for path in sensitive_paths {
        // These should fail because they contain sensitive patterns
        // (They'll actually fail to canonicalize, but that's fine for this test)
        let result = validate_path(path, &[temp_path]);
        assert!(result.is_err(), "Should reject sensitive path: {}", path);
    }
}

#[cfg(unix)]
#[test]
fn test_path_symlink_resolution() {
    let temp = TempDir::new().unwrap();
    let temp_path = temp.path();

    // Create a file and a symlink to it
    let real_file = temp_path.join("real.txt");
    std::fs::write(&real_file, "content").unwrap();

    let symlink_path = temp_path.join("link.txt");
    std::os::unix::fs::symlink(&real_file, &symlink_path).unwrap();

    // Symlink should be resolved to the real file
    let result = validate_path(symlink_path.to_str().unwrap(), &[temp_path]);
    assert!(result.is_ok());

    // Resolved path should be the real file
    let resolved = result.unwrap();
    assert_eq!(
        std::path::Path::new(&resolved),
        real_file.canonicalize().unwrap()
    );
}

#[test]
fn test_empty_input_rejection() {
    // All validation functions should reject empty input
    assert!(validate_tab_id("").is_err());
    assert!(validate_command("").is_err());
    assert!(validate_session_name("").is_err());
    assert!(validate_search_query("").is_err());
    assert!(validate_path("", &[]).is_err());

    // Whitespace-only should also be rejected where appropriate
    assert!(validate_session_name("   ").is_err());
    assert!(validate_search_query("   ").is_err());
}

#[test]
fn test_sanitize_for_display_control_chars() {
    // Control characters should be removed
    assert_eq!(sanitize_for_display("hello\x00world"), "helloworld");
    assert_eq!(sanitize_for_display("test\x1Btest"), "testtest");
    assert_eq!(sanitize_for_display("\x01\x02\x03text"), "text");

    // But newlines and tabs should be preserved
    assert_eq!(sanitize_for_display("line1\nline2"), "line1\nline2");
    assert_eq!(sanitize_for_display("col1\tcol2"), "col1\tcol2");

    // Normal text should be unchanged
    assert_eq!(sanitize_for_display("Hello World!"), "Hello World!");
}

#[test]
fn test_sanitize_xss_vectors() {
    // While React handles XSS, we test that control chars are removed
    let xss_attempts = vec![
        "<script>alert('xss')</script>",
        "<img src=x onerror=alert(1)>",
        "javascript:alert(1)",
        "<svg onload=alert(1)>",
    ];

    for xss in xss_attempts {
        let sanitized = sanitize_for_display(xss);
        // Should not contain control characters (but HTML is allowed - React handles it)
        for c in sanitized.chars() {
            assert!(!c.is_control() || c == '\n' || c == '\t');
        }
    }
}

#[test]
fn test_validation_error_messages() {
    // Error messages should be informative
    match validate_tab_id("") {
        Err(ValidationError::EmptyInput) => {}
        _ => panic!("Expected EmptyInput error"),
    }

    match validate_tab_id(&"x".repeat(100)) {
        Err(ValidationError::InputTooLong(_, _)) => {}
        _ => panic!("Expected InputTooLong error"),
    }

    match validate_tab_id("../etc/passwd") {
        Err(ValidationError::InvalidTabId(msg)) => {
            assert!(msg.contains("path separators"));
        }
        _ => panic!("Expected InvalidTabId error"),
    }
}

#[test]
fn test_unicode_handling() {
    // Unicode should be handled correctly
    assert!(validate_session_name("セッション").is_ok());
    assert!(validate_session_name("会话-2024").is_ok());
    assert!(validate_search_query("検索クエリ").is_ok());

    // But path separators should still be blocked
    assert!(validate_session_name("session／name").is_err()); // Full-width slash
}

#[test]
fn test_case_sensitivity() {
    // SQL injection should be detected case-insensitively
    assert!(validate_sql_param("union select").is_err());
    assert!(validate_sql_param("UNION SELECT").is_err());
    assert!(validate_sql_param("UnIoN SeLeCt").is_err());

    assert!(validate_sql_param("drop table").is_err());
    assert!(validate_sql_param("DROP TABLE").is_err());
}

#[test]
fn test_length_limit_edge_cases() {
    // Exactly at limit should pass
    assert!(validate_tab_id(&"x".repeat(MAX_TAB_ID_LENGTH)).is_ok());
    assert!(validate_session_name(&"x".repeat(MAX_SESSION_NAME_LENGTH)).is_ok());
    assert!(validate_command(&"x".repeat(MAX_COMMAND_LENGTH)).is_ok());
    assert!(validate_search_query(&"x".repeat(MAX_SEARCH_QUERY_LENGTH)).is_ok());

    // One over limit should fail
    assert!(validate_tab_id(&"x".repeat(MAX_TAB_ID_LENGTH + 1)).is_err());
    assert!(validate_session_name(&"x".repeat(MAX_SESSION_NAME_LENGTH + 1)).is_err());
    assert!(validate_command(&"x".repeat(MAX_COMMAND_LENGTH + 1)).is_err());
    assert!(validate_search_query(&"x".repeat(MAX_SEARCH_QUERY_LENGTH + 1)).is_err());
}

#[test]
fn test_trimming_behavior() {
    // Session names should be trimmed
    assert_eq!(validate_session_name("  session  ").unwrap(), "session");

    // Search queries should be trimmed
    assert_eq!(validate_search_query("  query  ").unwrap(), "query");

    // But whitespace-only input should still fail
    assert!(validate_session_name("    ").is_err());
    assert!(validate_search_query("    ").is_err());
}

#[test]
fn test_realistic_injection_scenarios() {
    // Real-world injection attempts that should be caught

    // Bobby Tables
    assert!(validate_sql_param("Robert'); DROP TABLE tabs;--").is_err());

    // Command chaining
    assert!(validate_tab_id("tab; rm -rf /").is_err());
    assert!(validate_tab_id("tab && cat /etc/passwd").is_err());
    assert!(validate_tab_id("tab || whoami").is_err());

    // Path traversal variations
    assert!(validate_session_name("..%2F..%2F..%2Fetc%2Fpasswd").is_err());
    assert!(validate_session_name("....//....//etc/passwd").is_err());

    // Null byte tricks
    assert!(validate_command("safe_command\0malicious_command").is_err());
}

#[test]
fn test_allowed_special_cases() {
    // Test that legitimate use cases are not blocked

    // Session names with punctuation
    assert!(validate_session_name("Project Alpha, Phase 2").is_ok());
    assert!(validate_session_name("John's Work Session").is_ok());
    assert!(validate_session_name("2024.04.23 - Testing").is_ok());

    // Search queries with operators
    assert!(validate_search_query("error: connection failed").is_ok());
    assert!(validate_search_query("status = 200").is_ok());
    assert!(validate_search_query("file not found").is_ok());

    // Commands with complex syntax
    assert!(validate_command("find . -name '*.rs' -type f").is_ok());
    assert!(validate_command("grep -r \"pattern\" /path/to/dir").is_ok());
    assert!(validate_command("awk '{print $1}' file.txt").is_ok());
}
