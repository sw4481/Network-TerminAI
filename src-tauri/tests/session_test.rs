use ccie_terminal_lib::{db, session};
use tempfile::TempDir;

fn open_test_db() -> (TempDir, rusqlite::Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    (dir, conn)
}

#[test]
fn create_list_close_tabs() {
    let (_dir, conn) = open_test_db();

    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/tmp").unwrap();
    assert_eq!(t.title, "zsh");

    let open = session::list_open_tabs(&conn).unwrap();
    assert_eq!(open.len(), 1);

    session::close_tab(&conn, &t.id).unwrap();
    let open = session::list_open_tabs(&conn).unwrap();
    assert_eq!(open.len(), 0);
}

#[test]
fn append_and_read_scrollback_chunks() {
    let (_dir, conn) = open_test_db();
    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/tmp").unwrap();

    session::append_scrollback(&conn, &t.id, b"first\n").unwrap();
    session::append_scrollback(&conn, &t.id, b"second\n").unwrap();

    let all = session::read_scrollback(&conn, &t.id).unwrap();
    assert_eq!(all, b"first\nsecond\n");
}

#[test]
fn record_command_block_lifecycle() {
    let (_dir, conn) = open_test_db();
    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/tmp").unwrap();

    let block_id = session::start_command_block(&conn, &t.id, "ls -la").unwrap();
    session::append_block_output(&conn, &block_id, b"total 0\n").unwrap();
    session::end_command_block(&conn, &block_id, Some(0)).unwrap();

    let blocks = session::list_blocks(&conn, &t.id).unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].cmd, "ls -la");
    assert_eq!(blocks[0].exit_code, Some(0));
    assert_eq!(blocks[0].output, b"total 0\n");
}

#[test]
fn scrollback_ring_buffer_enforces_limit() {
    let (_dir, conn) = open_test_db();
    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/tmp").unwrap();

    // Set a small limit for testing: 100 bytes
    let max_bytes = 100i64;

    // Append chunks that exceed the limit
    // Each chunk is 30 bytes: "data_XX_.....................\n"
    for i in 0..5 {
        let chunk = format!("data_{:02}_.....................\n", i);
        assert_eq!(chunk.len(), 30, "chunk {} has wrong length: '{}'", i, chunk);
        session::append_scrollback_with_limit(&conn, &t.id, chunk.as_bytes(), max_bytes).unwrap();
    }

    // Total appended: 5 * 30 = 150 bytes
    // Should have dropped oldest chunks to stay under 100 bytes

    let stats = session::scrollback_stats(&conn, &t.id).unwrap();
    assert!(
        stats.total_bytes <= max_bytes,
        "total_bytes {} exceeds max {}",
        stats.total_bytes,
        max_bytes
    );

    // Should have kept the newest chunks (data_02, data_03, data_04)
    let all = session::read_scrollback(&conn, &t.id).unwrap();
    let content = String::from_utf8_lossy(&all);

    // Should NOT contain oldest chunks
    assert!(
        !content.contains("data_00"),
        "oldest chunk should be deleted"
    );
    assert!(
        !content.contains("data_01"),
        "second oldest should be deleted"
    );

    // Should contain newest chunks
    assert!(content.contains("data_02"), "should keep newer chunks");
    assert!(content.contains("data_03"), "should keep newer chunks");
    assert!(content.contains("data_04"), "should keep newest chunk");
}

#[test]
fn scrollback_stats_accuracy() {
    let (_dir, conn) = open_test_db();
    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/tmp").unwrap();

    // Append some data
    session::append_scrollback(&conn, &t.id, b"first\n").unwrap();
    session::append_scrollback(&conn, &t.id, b"second\n").unwrap();
    session::append_scrollback(&conn, &t.id, b"third\n").unwrap();

    let stats = session::scrollback_stats(&conn, &t.id).unwrap();

    assert_eq!(stats.total_bytes, 6 + 7 + 6); // "first\n" + "second\n" + "third\n"
    assert_eq!(stats.chunks, 3);
    assert_eq!(stats.oldest_seq, 0);
    assert_eq!(stats.newest_seq, 2);
}

#[test]
fn scrollback_ring_buffer_fifo_behavior() {
    let (_dir, conn) = open_test_db();
    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/tmp").unwrap();

    let max_bytes = 50i64;

    // Append 5 chunks of 20 bytes each (total 100 bytes)
    for i in 0..5 {
        let chunk = format!("data{:015}\n", i); // 20 bytes each
        assert_eq!(chunk.len(), 20);
        session::append_scrollback_with_limit(&conn, &t.id, chunk.as_bytes(), max_bytes).unwrap();
    }

    // Should keep only the last 2 chunks (40 bytes) to stay under 50
    let all = session::read_scrollback(&conn, &t.id).unwrap();
    let content = String::from_utf8_lossy(&all);

    // Verify FIFO: oldest deleted first
    assert!(
        !content.contains("data000000000000000"),
        "chunk 0 should be deleted"
    );
    assert!(
        !content.contains("data000000000000001"),
        "chunk 1 should be deleted"
    );
    assert!(
        !content.contains("data000000000000002"),
        "chunk 2 should be deleted"
    );
    assert!(
        content.contains("data000000000000003"),
        "chunk 3 should remain"
    );
    assert!(
        content.contains("data000000000000004"),
        "chunk 4 (newest) should remain"
    );

    let stats = session::scrollback_stats(&conn, &t.id).unwrap();
    assert!(stats.total_bytes <= max_bytes);
    assert_eq!(stats.chunks, 2);
    assert_eq!(stats.oldest_seq, 3);
    assert_eq!(stats.newest_seq, 4);
}

#[test]
fn scrollback_empty_tab_stats() {
    let (_dir, conn) = open_test_db();
    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/tmp").unwrap();

    let stats = session::scrollback_stats(&conn, &t.id).unwrap();

    assert_eq!(stats.total_bytes, 0);
    assert_eq!(stats.chunks, 0);
    assert_eq!(stats.oldest_seq, 0);
    assert_eq!(stats.newest_seq, 0);
}

#[test]
fn scrollback_preserves_sequences_after_deletion() {
    let (_dir, conn) = open_test_db();
    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/tmp").unwrap();

    let max_bytes = 60i64;

    // Append chunks with known sequences
    for i in 0..4 {
        let chunk = format!("chunk{:014}\n", i); // 20 bytes each
        session::append_scrollback_with_limit(&conn, &t.id, chunk.as_bytes(), max_bytes).unwrap();
    }

    // Should have deleted oldest chunks, but sequences should be preserved
    let stats = session::scrollback_stats(&conn, &t.id).unwrap();

    // Sequences should NOT be renumbered - they represent historical order
    assert_eq!(stats.oldest_seq, 1); // Seq 0 was deleted, seq 1 is now oldest
    assert_eq!(stats.newest_seq, 3); // Seq 3 is newest

    // Verify reading gives us the right data in order
    let all = session::read_scrollback(&conn, &t.id).unwrap();
    let content = String::from_utf8_lossy(&all);

    assert!(!content.contains("chunk00000000000000")); // seq 0 deleted
    assert!(content.contains("chunk00000000000001")); // seq 1 remains
    assert!(content.contains("chunk00000000000002")); // seq 2 remains
    assert!(content.contains("chunk00000000000003")); // seq 3 remains
}
