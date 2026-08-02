/// Performance tests to validate Phase 7 optimizations
/// These tests ensure our performance targets are met
use ccie_terminal_lib::db;
use rusqlite::Connection;
use std::time::Instant;
use uuid::Uuid;

/// Helper to create a test database with migrations
fn setup_test_db() -> Connection {
    ccie_terminal_lib::rag::vec::register_vec_auto_extension();
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    ccie_terminal_lib::rag::vec::enable_vec_extension(&conn).unwrap();
    db::apply_migrations(&mut conn).unwrap();
    conn
}

/// Test that database indexes improve query performance
#[test]
fn test_indexed_query_performance() {
    let conn = setup_test_db();

    // Create a tab
    let tab_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![&tab_id, "test-tab", "/bin/bash", "/tmp"],
    )
    .unwrap();

    // Insert 1000 command blocks
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    for i in 0..1000 {
        let block_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO command_blocks (id, tab_id, cmd, output, exit_code, started_at, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                &block_id,
                &tab_id,
                format!("echo test_{}", i),
                format!("output_{}", i).as_bytes(),
                0,
                now + i,
                now + i + 1
            ],
        )
        .unwrap();
    }

    // Query with index - should be fast (< 50ms for 1000 rows)
    let start = Instant::now();
    let mut stmt = conn
        .prepare(
            "SELECT id, cmd, started_at FROM command_blocks
             WHERE tab_id = ?1
             ORDER BY started_at DESC
             LIMIT 100",
        )
        .unwrap();

    let rows: Vec<_> = stmt
        .query_map([&tab_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect();

    let duration = start.elapsed();

    assert_eq!(rows.len(), 100);
    assert!(
        duration.as_millis() < 50,
        "Query took {}ms, expected < 50ms",
        duration.as_millis()
    );

    println!("✓ Indexed query completed in {}ms", duration.as_millis());
}

/// Test AI message query performance with index
#[test]
fn test_ai_messages_index_performance() {
    let conn = setup_test_db();

    // Create a tab
    let tab_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![&tab_id, "test-tab", "/bin/bash", "/tmp"],
    )
    .unwrap();

    // Insert 5000 AI messages
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    for i in 0..5000 {
        let msg_id = Uuid::new_v4().to_string();
        let role = if i % 2 == 0 { "user" } else { "assistant" };
        conn.execute(
            "INSERT INTO ai_messages (id, tab_id, role, content, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                &msg_id,
                &tab_id,
                role,
                format!("Message content {}", i),
                now + i
            ],
        )
        .unwrap();
    }

    // Query recent messages - should be fast (< 30ms)
    let start = Instant::now();
    let mut stmt = conn
        .prepare(
            "SELECT id, role, content FROM ai_messages
             WHERE tab_id = ?1
             ORDER BY timestamp DESC
             LIMIT 50",
        )
        .unwrap();

    let rows: Vec<_> = stmt
        .query_map([&tab_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect();

    let duration = start.elapsed();

    assert_eq!(rows.len(), 50);
    assert!(
        duration.as_millis() < 30,
        "AI message query took {}ms, expected < 30ms",
        duration.as_millis()
    );

    println!(
        "✓ AI messages indexed query completed in {}ms",
        duration.as_millis()
    );
}

/// Test FTS5 search performance
#[test]
fn test_fts5_search_performance() {
    let conn = setup_test_db();

    // Create a tab
    let tab_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![&tab_id, "test-tab", "/bin/bash", "/tmp"],
    )
    .unwrap();

    // Insert 10,000 command blocks with various commands
    let commands = [
        "kubectl get pods",
        "docker ps",
        "git status",
        "npm install",
        "cargo build",
        "python script.py",
        "go run main.go",
        "terraform apply",
    ];

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    for i in 0..10000 {
        let block_id = Uuid::new_v4().to_string();
        let cmd = commands[i % commands.len()];
        conn.execute(
            "INSERT INTO command_blocks (id, tab_id, cmd, output, exit_code, started_at, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                &block_id,
                &tab_id,
                cmd,
                format!("output_{}", i).as_bytes(),
                0,
                now + i as i64,
                now + i as i64 + 1
            ],
        )
        .unwrap();
    }

    // Search using FTS5 - should be fast (< 200ms for 10k entries)
    let start = Instant::now();
    let mut stmt = conn
        .prepare(
            "SELECT cb.id, cb.cmd, cb.started_at
             FROM command_blocks_fts fts
             JOIN command_blocks cb ON cb.rowid = fts.rowid
             WHERE fts.cmd MATCH ?1
             LIMIT 50",
        )
        .unwrap();

    let rows: Vec<_> = stmt
        .query_map(["kubectl"], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect();

    let duration = start.elapsed();

    assert!(!rows.is_empty());
    assert!(
        duration.as_millis() < 200,
        "FTS5 search took {}ms, expected < 200ms",
        duration.as_millis()
    );

    println!("✓ FTS5 search completed in {}ms", duration.as_millis());
}

/// Test tab query with partial index
#[test]
fn test_active_tabs_query_performance() {
    let conn = setup_test_db();

    // Insert 100 tabs (50 active, 50 closed)
    for i in 0..100 {
        let tab_id = Uuid::new_v4().to_string();
        let closed_at = if i < 50 { None } else { Some(1000 + i) };

        conn.execute(
            "INSERT INTO tabs (id, title, shell_cmd, cwd, closed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                &tab_id,
                format!("Tab {}", i),
                "/bin/bash",
                "/tmp",
                closed_at
            ],
        )
        .unwrap();
    }

    // Query active tabs only - should use partial index
    let start = Instant::now();
    let mut stmt = conn
        .prepare(
            "SELECT id, title FROM tabs
             WHERE closed_at IS NULL
             ORDER BY created_at DESC",
        )
        .unwrap();

    let rows: Vec<_> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect();

    let duration = start.elapsed();

    assert_eq!(rows.len(), 50);
    assert!(
        duration.as_millis() < 20,
        "Active tabs query took {}ms, expected < 20ms",
        duration.as_millis()
    );

    println!(
        "✓ Active tabs query completed in {}ms",
        duration.as_millis()
    );
}

/// Test that indexes don't break existing queries
#[test]
fn test_index_compatibility() {
    let conn = setup_test_db();

    // Verify all indexes exist
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
        .unwrap();

    let indexes: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();

    // Check for our performance indexes
    let expected_indexes = vec![
        "idx_ai_messages_recent",
        "idx_ai_messages_tab",
        "idx_blocks_tab",
        "idx_command_blocks_ended_at",
        "idx_command_blocks_exit_code",
        "idx_saved_sessions_created",
        "idx_scrollback_tab_seq",
        "idx_snapshot_tabs",
        "idx_tabs_closed",
        "idx_tabs_created",
    ];

    for expected in &expected_indexes {
        assert!(
            indexes.iter().any(|idx| idx.contains(expected)),
            "Missing index: {}",
            expected
        );
    }

    println!(
        "✓ All {} performance indexes present",
        expected_indexes.len()
    );
}
