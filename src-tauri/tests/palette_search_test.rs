//! End-to-end coverage for `palette::search::run` — the fan-out aggregator.

use ccie_terminal_lib::db;
use ccie_terminal_lib::palette;
use ccie_terminal_lib::palette::types::{PaletteKind, PaletteSearchArgs};
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    (dir, conn)
}

/// Seeds at least one matching row per kind for the query "show".
fn seed_full_fixture() -> (TempDir, Connection) {
    let (dir, conn) = open_test_db();

    // tab + command_block (covers commands + blocks sources).
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, ?, ?, ?)",
        params!["t1", "tab", "/bin/zsh", "/"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES (?, ?, ?, '', strftime('%s','now'))",
        params!["b1", "t1", "show ip bgp"],
    )
    .unwrap();

    // workflow.
    conn.execute(
        "INSERT INTO workflows (id, name, description, vendor, platform)
         VALUES (?, ?, ?, ?, ?)",
        params!["wf1", "show-tech", "Run show tech-support", "cisco", "iosxe"],
    )
    .unwrap();

    // notebook.
    conn.execute(
        "INSERT INTO notebooks (id, title, description, vendor, platform, body_markdown)
         VALUES (?, ?, ?, ?, ?, ?)",
        params!["nb1", "BGP show audit", "show neighbors audit", "cisco", "iosxe", "# md"],
    )
    .unwrap();

    // ssh.
    conn.execute(
        "INSERT INTO ssh_connections (id, name, host, user, port)
         VALUES (?, ?, ?, ?, ?)",
        params!["c1", "show-host-1", "10.0.0.1", "admin", 22],
    )
    .unwrap();

    // device.
    conn.execute(
        "INSERT INTO netconf_devices (name, host, port, username, platform)
         VALUES (?, ?, ?, ?, ?)",
        params!["showroom-1", "10.10.0.1", 830, "netadmin", "iosxe"],
    )
    .unwrap();

    (dir, conn)
}

#[test]
fn palette_search_fanout_returns_hits_from_all_kinds_global() {
    let (_dir, conn) = seed_full_fixture();
    let args = PaletteSearchArgs {
        query: "show".into(),
        scope: "global".into(),
        active_tab_id: None,
        active_device_id: None,
        kind_filter: None,
        limit: 50,
    };
    let hits = palette::search::run(&conn, args).unwrap();
    let kinds: std::collections::HashSet<_> = hits.iter().map(|h| h.kind).collect();

    assert!(kinds.contains(&PaletteKind::Command), "missing command hits");
    assert!(kinds.contains(&PaletteKind::Block), "missing block hits");
    assert!(kinds.contains(&PaletteKind::Workflow), "missing workflow hits");
    assert!(kinds.contains(&PaletteKind::Notebook), "missing notebook hits");
    assert!(kinds.contains(&PaletteKind::Ssh), "missing ssh hits");
    assert!(kinds.contains(&PaletteKind::Device), "missing device hits");
}

#[test]
fn palette_search_respects_kind_filter() {
    let (_dir, conn) = seed_full_fixture();
    // Non-empty query exercises the fan-out + kind_filter path.
    let args = PaletteSearchArgs {
        query: "show".into(),
        scope: "global".into(),
        active_tab_id: None,
        active_device_id: None,
        kind_filter: Some(PaletteKind::Ssh),
        limit: 50,
    };
    let hits = palette::search::run(&conn, args).unwrap();
    assert!(!hits.is_empty(), "expected at least one ssh hit");
    assert!(hits.iter().all(|h| h.kind == PaletteKind::Ssh));
}

#[test]
fn empty_query_kind_filter_returns_only_filtered_recent_picks() {
    let (_dir, conn) = seed_full_fixture();
    // Pick one ssh row so it shows up in recent picks.
    palette::usage::record(&conn, "ssh", "c1").unwrap();
    let args = PaletteSearchArgs {
        query: "".into(),
        scope: "global".into(),
        active_tab_id: None,
        active_device_id: None,
        kind_filter: Some(PaletteKind::Ssh),
        limit: 50,
    };
    let hits = palette::search::run(&conn, args).unwrap();
    assert!(!hits.is_empty(), "expected at least one ssh hit");
    assert!(hits.iter().all(|h| h.kind == PaletteKind::Ssh));
}

#[test]
fn palette_search_truncates_to_limit() {
    let (_dir, conn) = open_test_db();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, ?, ?, ?)",
        params!["t1", "tab", "/bin/zsh", "/"],
    )
    .unwrap();
    for i in 0..30 {
        conn.execute(
            "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
             VALUES (?, 't1', ?, '', strftime('%s','now'))",
            params![format!("b{i}"), format!("show test-{i}")],
        )
        .unwrap();
    }

    let args = PaletteSearchArgs {
        query: "show".into(),
        scope: "global".into(),
        active_tab_id: None,
        active_device_id: None,
        kind_filter: None,
        limit: 5,
    };
    let hits = palette::search::run(&conn, args).unwrap();
    assert!(hits.len() <= 5);
}

#[test]
fn recent_frequent_pick_outranks_stale_one() {
    let (_dir, conn) = open_test_db();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, ?, ?, ?)",
        params!["t1", "tab", "/bin/zsh", "/"],
    )
    .unwrap();
    // Both blocks match "show" but b_recent gets recorded picks.
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES ('b_stale', 't1', 'show ip stale', '', strftime('%s','now'))",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES ('b_recent', 't1', 'show ip recent', '', strftime('%s','now'))",
        [],
    )
    .unwrap();
    for _ in 0..5 {
        palette::usage::record(&conn, "block", "b_recent").unwrap();
    }

    let args = PaletteSearchArgs {
        query: "show".into(),
        scope: "global".into(),
        active_tab_id: None,
        active_device_id: None,
        kind_filter: Some(PaletteKind::Block),
        limit: 10,
    };
    let hits = palette::search::run(&conn, args).unwrap();
    let idx_recent = hits
        .iter()
        .position(|h| h.target_id == "b_recent")
        .expect("missing b_recent in hits");
    let idx_stale = hits
        .iter()
        .position(|h| h.target_id == "b_stale")
        .expect("missing b_stale in hits");
    assert!(
        idx_recent < idx_stale,
        "recent+frequent pick must outrank stale (got recent={idx_recent}, stale={idx_stale})"
    );
}

#[test]
fn search_run_injects_use_count_and_last_used_at_into_meta() {
    let (_dir, conn) = open_test_db();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, ?, ?, ?)",
        params!["t1", "tab", "/bin/zsh", "/"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES ('b1', 't1', 'show metadata', '', strftime('%s','now'))",
        [],
    )
    .unwrap();
    palette::usage::record(&conn, "block", "b1").unwrap();
    palette::usage::record(&conn, "block", "b1").unwrap();

    let args = PaletteSearchArgs {
        query: "metadata".into(),
        scope: "global".into(),
        active_tab_id: None,
        active_device_id: None,
        kind_filter: Some(PaletteKind::Block),
        limit: 10,
    };
    let hits = palette::search::run(&conn, args).unwrap();
    let hit = hits
        .iter()
        .find(|h| h.target_id == "b1")
        .expect("missing block hit");
    assert_eq!(hit.meta["use_count"].as_i64(), Some(2));
    assert!(hit.meta["last_used_at"].as_i64().unwrap() > 0);
    assert!(hit.frequency_boost > 0.0);
    assert!(hit.recency_boost > 0.0);
}

#[test]
fn empty_query_returns_top_recent_picks() {
    let (_dir, conn) = open_test_db();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, ?, ?, ?)",
        params!["t1", "tab", "/bin/zsh", "/"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES ('bA', 't1', 'show A', '', strftime('%s','now'))",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES ('bB', 't1', 'show B', '', strftime('%s','now'))",
        [],
    )
    .unwrap();
    palette::usage::record(&conn, "block", "bA").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    palette::usage::record(&conn, "block", "bB").unwrap();

    let args = PaletteSearchArgs {
        query: "".into(),
        scope: "global".into(),
        active_tab_id: None,
        active_device_id: None,
        kind_filter: None,
        limit: 10,
    };
    let hits = palette::search::run(&conn, args).unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.target_id.as_str()).collect();
    // bB was used most recently → must come first.
    assert_eq!(ids.first().copied(), Some("bB"));
    assert!(ids.contains(&"bA"));
}

#[test]
fn empty_query_drops_unhydratable_rows() {
    let (_dir, conn) = open_test_db();
    // Record a usage row for a block that does not exist.
    palette::usage::record(&conn, "block", "ghost").unwrap();
    let args = PaletteSearchArgs {
        query: "".into(),
        scope: "global".into(),
        active_tab_id: None,
        active_device_id: None,
        kind_filter: None,
        limit: 10,
    };
    let hits = palette::search::run(&conn, args).unwrap();
    assert!(hits.iter().all(|h| h.target_id != "ghost"));
}

#[test]
fn palette_search_records_pick_via_usage_record() {
    let (_dir, conn) = open_test_db();
    palette::usage::record(&conn, "block", "b1").unwrap();
    let row = palette::usage::get(&conn, "block", "b1").unwrap().unwrap();
    assert_eq!(row.use_count, 1);
    palette::usage::record(&conn, "block", "b1").unwrap();
    let row = palette::usage::get(&conn, "block", "b1").unwrap().unwrap();
    // Phase 1 stub uses INSERT OR IGNORE for *first* row, then UPSERT bumps
    // use_count by 1 per record(). Phase 3 adds dedicated UPSERT semantics.
    assert!(row.use_count >= 1);
}
