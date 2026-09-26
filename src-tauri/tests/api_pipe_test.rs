//! Step 6: pipe-to-terminal validation.
//!
//! The `api_pipe_to_terminal` command does two checks before it ever touches
//! the PTY:
//!   1. `tab_id` passes validation (already covered by validation_test)
//!   2. `tabs.tab_type = 'terminal'` — API tabs cannot be piped into
//!   3. a PTY handle is present
//!
//! Test 3 requires a live `AppState` with a running PTY, which `pty_test.rs`
//! already covers. Here we prove the DB gate: a freshly-created API tab
//! must never be a valid pipe target.

use ccie_terminal_lib::{db, session};
use tempfile::TempDir;

#[test]
fn api_tab_is_not_a_valid_pipe_target_via_db_gate() {
    // We replicate the DB-side gate from `api_pipe_to_terminal` directly
    // (since the command itself requires Tauri's State which isn't
    // available from an integration test). If the assertion breaks the
    // command will also break — and that's the regression we care about.
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("pipe.db");
    let conn = db::open_and_migrate(&db_path).unwrap();

    let api = session::create_api_tab(&conn, "API 1", None, None).unwrap();

    let tab_type: Option<String> = conn
        .query_row(
            "SELECT tab_type FROM tabs WHERE id = ? AND closed_at IS NULL",
            [&api.id],
            |r| r.get(0),
        )
        .ok();

    assert_eq!(tab_type.as_deref(), Some("api"));
    assert_ne!(
        tab_type.as_deref(),
        Some("terminal"),
        "API tabs must not satisfy the pipe-to-terminal gate"
    );
}

#[test]
fn terminal_tab_satisfies_the_pipe_gate() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("pipe.db");
    let conn = db::open_and_migrate(&db_path).unwrap();

    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/").unwrap();
    let tab_type: Option<String> = conn
        .query_row(
            "SELECT tab_type FROM tabs WHERE id = ? AND closed_at IS NULL",
            [&t.id],
            |r| r.get(0),
        )
        .ok();
    assert_eq!(tab_type.as_deref(), Some("terminal"));
}

#[test]
fn closed_tab_is_not_selectable_by_pipe_gate() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("pipe.db");
    let conn = db::open_and_migrate(&db_path).unwrap();

    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/").unwrap();
    session::close_tab(&conn, &t.id).unwrap();

    let tab_type: Option<String> = conn
        .query_row(
            "SELECT tab_type FROM tabs WHERE id = ? AND closed_at IS NULL",
            [&t.id],
            |r| r.get(0),
        )
        .ok();
    assert!(
        tab_type.is_none(),
        "closed tabs must not pass the pipe-to-terminal gate"
    );
}

#[test]
fn list_pipe_targets_contract_filters_by_tab_type_and_live_pty() {
    // `list_pipe_targets` returns only tabs where BOTH:
    //   - the DB row has tab_type='terminal' AND closed_at IS NULL,
    //   - the tab_id is in the live PTY map.
    //
    // We replicate the logic here (the real command needs Tauri State,
    // not exercisable without a full app). Any regression that widens
    // the filter — e.g. including api tabs or stale DB rows from prior
    // runs — would also break the real command.
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("pipe.db");
    let conn = db::open_and_migrate(&db_path).unwrap();

    // Seed: one live terminal, one api tab, one stale terminal (row exists
    // but no PTY in the map, simulating a crashed prior run).
    let live = session::create_tab(&conn, "zsh", "/bin/zsh", "/").unwrap();
    let api = session::create_api_tab(&conn, "API 1", None, None).unwrap();
    let stale = session::create_tab(&conn, "zsh", "/bin/zsh", "/").unwrap();

    // The pretend PTY map — only `live` is currently running.
    let live_ptys: std::collections::HashSet<String> = [live.id.clone()]
        .into_iter()
        .collect();

    // The filter `list_pipe_targets` applies.
    let all = session::list_open_tabs(&conn).unwrap();
    let targets: Vec<_> = all
        .into_iter()
        .filter(|t| t.tab_type == "terminal" && live_ptys.contains(&t.id))
        .collect();

    let ids: Vec<_> = targets.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![live.id.as_str()],
        "pipe targets must be exactly the live-PTY terminal tabs; \
         api tab {} and stale tab {} must be excluded",
        api.id,
        stale.id,
    );
}
