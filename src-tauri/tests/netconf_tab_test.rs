//! Integration test: netconf tab creation round-trip.

use ccie_terminal_lib::netconf_runner::session_store::create_netconf_tab;
use ccie_terminal_lib::{db, session};
use tempfile::TempDir;

#[test]
fn netconf_tab_round_trip() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("nc.db")).unwrap();

    let tab = create_netconf_tab(&conn, "New NETCONF Session").unwrap();
    assert_eq!(tab.tab_type, "netconf");
    assert_eq!(tab.title, "New NETCONF Session");
    assert_eq!(tab.shell_cmd, "");
    assert_eq!(tab.cwd, "");

    let (mode, content, ds): (String, String, String) = conn
        .query_row(
            "SELECT editor_mode, editor_content, target_datastore FROM netconf_tab_state WHERE tab_id = ?",
            [&tab.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(mode, "raw_xml");
    assert_eq!(content, "");
    assert_eq!(ds, "running");

    let tabs = session::list_open_tabs(&conn).unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].tab_type, "netconf");
}

#[test]
fn netconf_and_terminal_and_api_coexist() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("mix.db")).unwrap();

    session::create_tab(&conn, "t", "/bin/zsh", "/").unwrap();
    session::create_api_tab(&conn, "a", None, None).unwrap();
    create_netconf_tab(&conn, "n").unwrap();

    let tabs = session::list_open_tabs(&conn).unwrap();
    let types: Vec<&str> = tabs.iter().map(|t| t.tab_type.as_str()).collect();
    assert!(types.contains(&"terminal"));
    assert!(types.contains(&"api"));
    assert!(types.contains(&"netconf"));
}

#[test]
fn close_removes_netconf_tab_from_open_list() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("close.db")).unwrap();

    let tab = create_netconf_tab(&conn, "to-close").unwrap();
    session::close_tab(&conn, &tab.id).unwrap();

    let tabs = session::list_open_tabs(&conn).unwrap();
    assert_eq!(tabs.len(), 0);
}
