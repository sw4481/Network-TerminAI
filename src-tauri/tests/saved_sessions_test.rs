use ccie_terminal_lib::{db, session};
use std::collections::HashMap;
use tempfile::TempDir;

fn open_test_db() -> (TempDir, rusqlite::Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    (dir, conn)
}

#[test]
fn save_and_list_sessions() {
    let (_dir, conn) = open_test_db();

    // Create a tab with some data
    let tab = session::create_tab(&conn, "test-tab", "/bin/zsh", "/tmp").unwrap();
    session::append_scrollback(&conn, &tab.id, b"line 1\n").unwrap();

    // Prepare data for save
    let tabs = vec![tab.clone()];
    let mut scrollback = HashMap::new();
    scrollback.insert(tab.id.clone(), b"line 1\n".to_vec());
    let ai_history = HashMap::new();

    // Save the session
    let session_id = session::save_session(
        &conn,
        "test-session",
        Some("Test description"),
        &tabs,
        &scrollback,
        &ai_history,
    )
    .unwrap();

    assert!(!session_id.is_empty());

    // List sessions
    let sessions = session::list_saved_sessions(&conn).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].name, "test-session");
    assert_eq!(
        sessions[0].description,
        Some("Test description".to_string())
    );
    assert_eq!(sessions[0].tab_count, 1);
}

#[test]
fn load_saved_session() {
    let (_dir, conn) = open_test_db();

    // Create tabs with data
    let tab1 = session::create_tab(&conn, "tab1", "/bin/zsh", "/dir1").unwrap();
    let tab2 = session::create_tab(&conn, "tab2", "/bin/bash", "/dir2").unwrap();

    let tabs = vec![tab1.clone(), tab2.clone()];
    let mut scrollback = HashMap::new();
    scrollback.insert(tab1.id.clone(), b"tab1 data\n".to_vec());
    scrollback.insert(tab2.id.clone(), b"tab2 data\n".to_vec());
    let ai_history = HashMap::new();

    // Save session
    let session_id =
        session::save_session(&conn, "multi-tab", None, &tabs, &scrollback, &ai_history).unwrap();

    // Load the session
    let snapshot = session::load_session(&conn, &session_id).unwrap();
    assert_eq!(snapshot.tabs.len(), 2);
    assert_eq!(snapshot.scrollback.len(), 2);
    assert!(snapshot.scrollback.contains_key(&tab1.id));
    assert!(snapshot.scrollback.contains_key(&tab2.id));
}

#[test]
fn delete_saved_session() {
    let (_dir, conn) = open_test_db();

    let tab = session::create_tab(&conn, "tab1", "/bin/zsh", "/tmp").unwrap();
    let tabs = vec![tab.clone()];
    let scrollback = HashMap::new();
    let ai_history = HashMap::new();

    let session_id =
        session::save_session(&conn, "to-delete", None, &tabs, &scrollback, &ai_history).unwrap();

    // Verify it exists
    let sessions = session::list_saved_sessions(&conn).unwrap();
    assert_eq!(sessions.len(), 1);

    // Delete it
    session::delete_saved_session(&conn, &session_id).unwrap();

    // Verify it's gone
    let sessions = session::list_saved_sessions(&conn).unwrap();
    assert_eq!(sessions.len(), 0);
}

#[test]
fn export_and_import_session() {
    let (_dir, conn) = open_test_db();

    // Create and save a session
    let tab = session::create_tab(&conn, "export-tab", "/bin/zsh", "/export").unwrap();
    let tabs = vec![tab.clone()];
    let mut scrollback = HashMap::new();
    scrollback.insert(tab.id.clone(), b"export data\n".to_vec());
    let ai_history = HashMap::new();

    let session_id = session::save_session(
        &conn,
        "export-session",
        Some("Session to export"),
        &tabs,
        &scrollback,
        &ai_history,
    )
    .unwrap();

    // Export to JSON
    let json = session::export_session_json(&conn, &session_id).unwrap();
    assert!(json.contains("export-session"));
    assert!(json.contains("Session to export"));

    // Create a new database
    let (_dir2, conn2) = open_test_db();

    // Import the session
    let imported_id = session::import_session_json(&conn2, &json).unwrap();
    assert!(!imported_id.is_empty());

    // Verify the imported data
    let sessions = session::list_saved_sessions(&conn2).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].name, "export-session");
    assert_eq!(
        sessions[0].description,
        Some("Session to export".to_string())
    );

    let snapshot = session::load_session(&conn2, &imported_id).unwrap();
    assert_eq!(snapshot.tabs.len(), 1);
    assert_eq!(snapshot.tabs[0].title, "export-tab");
}

#[test]
fn duplicate_session_name_fails() {
    let (_dir, conn) = open_test_db();

    let tab = session::create_tab(&conn, "tab1", "/bin/zsh", "/tmp").unwrap();
    let tabs = vec![tab.clone()];
    let scrollback = HashMap::new();
    let ai_history = HashMap::new();

    // Save first session
    session::save_session(&conn, "duplicate", None, &tabs, &scrollback, &ai_history).unwrap();

    // Try to save another session with the same name
    let result = session::save_session(&conn, "duplicate", None, &tabs, &scrollback, &ai_history);

    assert!(result.is_err());
}

#[test]
fn save_empty_session() {
    let (_dir, conn) = open_test_db();

    // Save a session with no tabs
    let tabs = vec![];
    let scrollback = HashMap::new();
    let ai_history = HashMap::new();

    let result = session::save_session(&conn, "empty", None, &tabs, &scrollback, &ai_history);

    // Should succeed
    assert!(result.is_ok());
    let session_id = result.unwrap();

    let snapshot = session::load_session(&conn, &session_id).unwrap();
    assert_eq!(snapshot.tabs.len(), 0);
}

#[test]
fn session_with_ai_history() {
    let (_dir, conn) = open_test_db();

    let tab = session::create_tab(&conn, "tab1", "/bin/zsh", "/tmp").unwrap();
    let tabs = vec![tab.clone()];
    let scrollback = HashMap::new();

    let mut ai_history = HashMap::new();
    let messages = serde_json::json!([
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi there"}
    ]);
    ai_history.insert(tab.id.clone(), messages.to_string());

    let session_id =
        session::save_session(&conn, "with-ai", None, &tabs, &scrollback, &ai_history).unwrap();

    let snapshot = session::load_session(&conn, &session_id).unwrap();
    assert_eq!(snapshot.ai_history.len(), 1);
    assert!(snapshot.ai_history.contains_key(&tab.id));
}
