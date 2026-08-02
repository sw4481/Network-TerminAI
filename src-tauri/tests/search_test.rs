//! Test FTS5 full-text search across commands, AI messages, and skills.

use ccie_terminal_lib::search::{search_all, search_commands, search_skills};
use ccie_terminal_lib::session::{create_tab, end_command_block, start_command_block};
use rusqlite::{params, Connection};

fn test_db() -> Connection {
    // Use in-memory database - each test gets a fresh database
    let conn = Connection::open(":memory:").expect("open in-memory db");

    // Enable FTS5
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();

    // Run migrations inline since we can't access the migrations module
    // Based on V0006__sessions_ai_and_fts5.sql
    conn.execute_batch(
        r#"
        -- Tabs (matches V0002 + V0013 schema)
        CREATE TABLE IF NOT EXISTS tabs (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          shell_cmd TEXT NOT NULL,
          cwd TEXT NOT NULL,
          profile_id TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          closed_at INTEGER,
          tab_type TEXT NOT NULL DEFAULT 'terminal'
        );

        -- Command blocks
        CREATE TABLE IF NOT EXISTS command_blocks (
          id TEXT PRIMARY KEY,
          tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
          cmd TEXT NOT NULL,
          output BLOB NOT NULL,
          exit_code INTEGER,
          started_at INTEGER NOT NULL,
          ended_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_blocks_tab ON command_blocks(tab_id, started_at);

        -- AI messages
        CREATE TABLE IF NOT EXISTS ai_messages (
          id TEXT PRIMARY KEY,
          tab_id TEXT REFERENCES tabs(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        -- Skills
        CREATE TABLE IF NOT EXISTS skills (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            when_to_use TEXT NOT NULL,
            playbook TEXT NOT NULL,
            scripts TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );

        -- FTS5 tables
        CREATE VIRTUAL TABLE IF NOT EXISTS command_blocks_fts USING fts5(
          cmd, output, content='command_blocks', content_rowid='rowid'
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS ai_messages_fts USING fts5(
          content, content='ai_messages', content_rowid='rowid'
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
          name, description, when_to_use, playbook, content='skills', content_rowid='rowid'
        );

        -- Triggers for command_blocks_fts
        CREATE TRIGGER IF NOT EXISTS command_blocks_ai AFTER INSERT ON command_blocks BEGIN
          INSERT INTO command_blocks_fts(rowid, cmd, output)
          VALUES (new.rowid, new.cmd, new.output);
        END;

        -- Triggers for ai_messages_fts
        CREATE TRIGGER IF NOT EXISTS ai_messages_ai AFTER INSERT ON ai_messages BEGIN
          INSERT INTO ai_messages_fts(rowid, content)
          VALUES (new.rowid, new.content);
        END;

        -- Triggers for skills_fts
        CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
          INSERT INTO skills_fts(rowid, name, description, when_to_use, playbook)
          VALUES (new.rowid, new.name, new.description, new.when_to_use, new.playbook);
        END;
        "#,
    )
    .expect("create test schema");

    conn
}

#[test]
fn test_search_commands() {
    let conn = test_db();

    // Create a tab
    let tab = create_tab(&conn, "test", "bash", "/tmp").unwrap();

    // Insert some commands with output
    let block1 = start_command_block(&conn, &tab.id, "git status").unwrap();
    conn.execute(
        "UPDATE command_blocks SET output = ?, ended_at = strftime('%s','now') WHERE id = ?",
        params![b"On branch main\nnothing to commit".to_vec(), block1],
    )
    .unwrap();
    end_command_block(&conn, &block1, Some(0)).unwrap();

    let block2 = start_command_block(&conn, &tab.id, "npm install express").unwrap();
    conn.execute(
        "UPDATE command_blocks SET output = ?, ended_at = strftime('%s','now') WHERE id = ?",
        params![b"added 57 packages in 3s\nexpress@4.18.2".to_vec(), block2],
    )
    .unwrap();
    end_command_block(&conn, &block2, Some(0)).unwrap();

    let block3 = start_command_block(&conn, &tab.id, "ls -la /home").unwrap();
    conn.execute(
        "UPDATE command_blocks SET output = ?, ended_at = strftime('%s','now') WHERE id = ?",
        params![b"total 12\ndrwxr-xr-x 3 user".to_vec(), block3],
    )
    .unwrap();
    end_command_block(&conn, &block3, Some(0)).unwrap();

    // Sync FTS5 (normally done by triggers, but we updated directly)
    conn.execute(
        "INSERT INTO command_blocks_fts(rowid, cmd, output)
         SELECT rowid, cmd, output FROM command_blocks",
        [],
    )
    .unwrap();

    // Test search by command
    let results = search_commands(&conn, "git status", 10).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].cmd, "git status");
    assert!(results[0].output_snippet.contains("branch main"));

    // Test search by output
    let results = search_commands(&conn, "express", 10).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].cmd, "npm install express");
    assert!(results[0].output_snippet.contains("57 packages"));

    // Test search with multiple matches
    let results = search_commands(&conn, "ls", 10).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].cmd, "ls -la /home");

    // Test search with no matches
    let results = search_commands(&conn, "nonexistent", 10).unwrap();
    assert_eq!(results.len(), 0);
}

#[test]
fn test_search_skills() {
    let conn = test_db();

    // Insert test skills
    conn.execute(
        "INSERT INTO skills (id, name, description, when_to_use, playbook) VALUES (?, ?, ?, ?, ?)",
        params![
            "test-skill-1",
            "git-workflow",
            "Manage git workflows and branching strategies",
            "Use when working with git repositories",
            "Step 1: Check status\nStep 2: Create branch"
        ],
    )
    .unwrap();

    conn.execute(
        "INSERT INTO skills (id, name, description, when_to_use, playbook) VALUES (?, ?, ?, ?, ?)",
        params![
            "test-skill-2",
            "docker-deploy",
            "Deploy applications using Docker containers",
            "Use when deploying containerized apps",
            "Step 1: Build image\nStep 2: Push to registry"
        ],
    )
    .unwrap();

    conn.execute(
        "INSERT INTO skills (id, name, description, when_to_use, playbook) VALUES (?, ?, ?, ?, ?)",
        params![
            "test-skill-3",
            "npm-package",
            "Manage npm packages and dependencies",
            "Use when working with Node.js projects",
            "Step 1: npm install\nStep 2: npm test"
        ],
    )
    .unwrap();

    // Sync FTS5
    conn.execute(
        "INSERT INTO skills_fts(rowid, name, description, when_to_use, playbook)
         SELECT rowid, name, description, when_to_use, playbook FROM skills",
        [],
    )
    .unwrap();

    // Test search by name
    let results = search_skills(&conn, "git", 10).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "test-skill-1");
    assert_eq!(results[0].name, "git-workflow");

    // Test search by description
    let results = search_skills(&conn, "docker containers", 10).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].name, "docker-deploy");

    // Test search by when_to_use
    let results = search_skills(&conn, "Node.js", 10).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].name, "npm-package");

    // Test search by playbook content
    let results = search_skills(&conn, "registry", 10).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].name, "docker-deploy");

    // Test multiple matches ranked by relevance
    let results = search_skills(&conn, "npm", 10).unwrap();
    assert!(!results.is_empty());
    assert_eq!(results[0].name, "npm-package"); // Should rank highest
}

#[test]
fn test_search_all() {
    let conn = test_db();

    // Create a tab with command
    let tab = create_tab(&conn, "test", "bash", "/tmp").unwrap();
    let block = start_command_block(&conn, &tab.id, "docker build -t myapp .").unwrap();
    conn.execute(
        "UPDATE command_blocks SET output = ?, ended_at = strftime('%s','now') WHERE id = ?",
        params![b"Successfully built image myapp".to_vec(), block],
    )
    .unwrap();
    end_command_block(&conn, &block, Some(0)).unwrap();

    // Insert a skill
    conn.execute(
        "INSERT INTO skills (id, name, description, when_to_use, playbook) VALUES (?, ?, ?, ?, ?)",
        params![
            "docker-skill",
            "docker-workflow",
            "Docker build and deployment",
            "Use for containerization",
            "Build docker images"
        ],
    )
    .unwrap();

    // Sync FTS5
    conn.execute(
        "INSERT INTO command_blocks_fts(rowid, cmd, output)
         SELECT rowid, cmd, output FROM command_blocks",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO skills_fts(rowid, name, description, when_to_use, playbook)
         SELECT rowid, name, description, when_to_use, playbook FROM skills",
        [],
    )
    .unwrap();

    // Test combined search
    let results = search_all(&conn, "docker", 10).unwrap();

    // Should find both command and skill
    assert!(!results.commands.is_empty());
    assert!(!results.skills.is_empty());

    // Verify command result
    assert_eq!(results.commands[0].cmd, "docker build -t myapp .");

    // Verify skill result
    assert_eq!(results.skills[0].name, "docker-workflow");
}

#[test]
fn test_fts5_ranking() {
    let conn = test_db();

    // Insert commands with varying relevance
    let tab = create_tab(&conn, "test", "bash", "/tmp").unwrap();

    let block1 = start_command_block(&conn, &tab.id, "git").unwrap();
    conn.execute(
        "UPDATE command_blocks SET output = ?, ended_at = strftime('%s','now') WHERE id = ?",
        params![b"usage: git [options]".to_vec(), block1],
    )
    .unwrap();
    end_command_block(&conn, &block1, Some(0)).unwrap();

    let block2 = start_command_block(&conn, &tab.id, "git status").unwrap();
    conn.execute(
        "UPDATE command_blocks SET output = ?, ended_at = strftime('%s','now') WHERE id = ?",
        params![b"On branch main".to_vec(), block2],
    )
    .unwrap();
    end_command_block(&conn, &block2, Some(0)).unwrap();

    let block3 = start_command_block(&conn, &tab.id, "npm install git-url-parse").unwrap();
    conn.execute(
        "UPDATE command_blocks SET output = ?, ended_at = strftime('%s','now') WHERE id = ?",
        params![b"added git-url-parse package".to_vec(), block3],
    )
    .unwrap();
    end_command_block(&conn, &block3, Some(0)).unwrap();

    // Sync FTS5
    conn.execute(
        "INSERT INTO command_blocks_fts(rowid, cmd, output)
         SELECT rowid, cmd, output FROM command_blocks",
        [],
    )
    .unwrap();

    // Search for "git"
    let results = search_commands(&conn, "git", 10).unwrap();
    assert!(results.len() >= 2);

    // Print ranks for debugging
    println!("Results:");
    for (i, r) in results.iter().enumerate() {
        println!("  {}: cmd='{}' rank={}", i, r.cmd, r.rank);
    }

    // BM25 returns negative numbers - closer to 0 means better match
    // Results are ordered by rank (ORDER BY rank), so first should be best
    // In BM25, lower (more negative) is worse, higher (closer to 0) is better
    assert!(results[0].rank > results[results.len() - 1].rank);

    // All ranks should be negative (BM25 characteristic)
    for result in &results {
        assert!(result.rank < 0.0);
    }
}

#[test]
fn test_snippet_generation() {
    let conn = test_db();

    let tab = create_tab(&conn, "test", "bash", "/tmp").unwrap();

    // Create a command with long output
    let long_output = "a".repeat(500);
    let block = start_command_block(&conn, &tab.id, "cat largefile.txt").unwrap();
    conn.execute(
        "UPDATE command_blocks SET output = ?, ended_at = strftime('%s','now') WHERE id = ?",
        params![long_output.as_bytes().to_vec(), block],
    )
    .unwrap();
    end_command_block(&conn, &block, Some(0)).unwrap();

    // Sync FTS5
    conn.execute(
        "INSERT INTO command_blocks_fts(rowid, cmd, output)
         SELECT rowid, cmd, output FROM command_blocks",
        [],
    )
    .unwrap();

    let results = search_commands(&conn, "cat", 10).unwrap();
    assert_eq!(results.len(), 1);

    // Snippet should be truncated to ~200 chars
    assert!(results[0].output_snippet.len() <= 203); // 200 + "..."
    assert!(results[0].output_snippet.ends_with("..."));
}

#[test]
fn test_search_limit() {
    let conn = test_db();
    let tab = create_tab(&conn, "test", "bash", "/tmp").unwrap();

    // Insert 15 commands with "test" in them
    for i in 0..15 {
        let cmd = format!("echo test{}", i);
        let block = start_command_block(&conn, &tab.id, &cmd).unwrap();
        conn.execute(
            "UPDATE command_blocks SET output = ?, ended_at = strftime('%s','now') WHERE id = ?",
            params![format!("test output {}", i).as_bytes().to_vec(), block],
        )
        .unwrap();
        end_command_block(&conn, &block, Some(0)).unwrap();
    }

    // Sync FTS5
    conn.execute(
        "INSERT INTO command_blocks_fts(rowid, cmd, output)
         SELECT rowid, cmd, output FROM command_blocks",
        [],
    )
    .unwrap();

    // Test limit=5
    let results = search_commands(&conn, "test", 5).unwrap();
    assert_eq!(results.len(), 5);

    // Test limit=10
    let results = search_commands(&conn, "test", 10).unwrap();
    assert_eq!(results.len(), 10);

    // Test limit larger than results
    let results = search_commands(&conn, "test", 20).unwrap();
    assert_eq!(results.len(), 15);
}
