use ccie_terminal_lib::drift::intent::{IntentKind, IntentRepo, IntentSelector, IntentTemplate, MatchMode};

fn open_db() -> rusqlite::Connection {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let path = tmp.path().to_path_buf();
    std::mem::forget(tmp);
    ccie_terminal_lib::db::open_and_migrate(&path).unwrap()
}

#[test]
fn intent_crud_roundtrip() {
    let conn = open_db();
    let id = IntentRepo::create(
        &conn,
        IntentTemplate {
            id: String::new(),
            name: "core-switch-golden".into(),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
            kind: IntentKind::Golden,
            body: "hostname core-01\n!\n".into(),
            vars_yaml: String::new(),
            selector: IntentSelector {
                device_ids: vec![],
                tags: vec!["core".into()],
                ..Default::default()
            },
            match_mode: MatchMode::Baseline,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();
    assert!(!id.is_empty());

    let got = IntentRepo::get(&conn, &id).unwrap().unwrap();
    assert_eq!(got.name, "core-switch-golden");
    assert_eq!(got.selector.tags, vec!["core".to_string()]);
    assert_eq!(got.kind, IntentKind::Golden);

    let list = IntentRepo::list_filtered(&conn, Some("cisco"), Some("iosxe")).unwrap();
    assert_eq!(list.len(), 1);

    IntentRepo::update_body(&conn, &id, "hostname core-01\nno service pad\n!\n").unwrap();
    let updated = IntentRepo::get(&conn, &id).unwrap().unwrap();
    assert!(updated.body.contains("no service pad"));
    assert!(updated.updated_at >= got.updated_at);

    IntentRepo::rename(&conn, &id, "core-golden-v2").unwrap();
    let renamed = IntentRepo::get(&conn, &id).unwrap().unwrap();
    assert_eq!(renamed.name, "core-golden-v2");

    IntentRepo::update_selector(
        &conn,
        &id,
        &IntentSelector {
            device_ids: vec!["d1".into()],
            tags: vec![],
            ..Default::default()
        },
    )
    .unwrap();
    let with_dev = IntentRepo::get(&conn, &id).unwrap().unwrap();
    assert_eq!(with_dev.selector.device_ids, vec!["d1".to_string()]);

    IntentRepo::delete(&conn, &id).unwrap();
    assert!(IntentRepo::get(&conn, &id).unwrap().is_none());
}

#[test]
fn selector_persists_group_id_and_ssh_connection_id() {
    let conn = open_db();
    let id = IntentRepo::create(
        &conn,
        IntentTemplate {
            id: String::new(),
            name: "grp".into(),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
            kind: IntentKind::Golden,
            body: String::new(),
            vars_yaml: String::new(),
            selector: IntentSelector {
                group_id: Some("g-123".into()),
                ..Default::default()
            },
            match_mode: MatchMode::Baseline,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();

    let got = IntentRepo::get(&conn, &id).unwrap().unwrap();
    assert_eq!(got.selector.group_id.as_deref(), Some("g-123"));
    assert_eq!(got.selector.ssh_connection_id, None);

    // Switch the selector to a single SSH connection.
    IntentRepo::update_selector(
        &conn,
        &id,
        &IntentSelector {
            ssh_connection_id: Some("conn-9".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let updated = IntentRepo::get(&conn, &id).unwrap().unwrap();
    assert_eq!(updated.selector.ssh_connection_id.as_deref(), Some("conn-9"));
    assert_eq!(updated.selector.group_id, None);
}

/// Old selector_json rows (no group_id/ssh_connection_id keys) must still
/// deserialize — the new fields default to None.
#[test]
fn legacy_selector_json_deserializes_with_defaults() {
    let legacy = r#"{"device_ids":["ssh:abc"],"tags":["core"]}"#;
    let sel: IntentSelector = serde_json::from_str(legacy).unwrap();
    assert_eq!(sel.device_ids, vec!["ssh:abc".to_string()]);
    assert_eq!(sel.tags, vec!["core".to_string()]);
    assert_eq!(sel.group_id, None);
    assert_eq!(sel.ssh_connection_id, None);
}

#[test]
fn list_filtered_separates_vendor_platform() {
    let conn = open_db();
    let _a = IntentRepo::create(
        &conn,
        IntentTemplate {
            id: String::new(),
            name: "a".into(),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
            kind: IntentKind::Golden,
            body: String::new(),
            vars_yaml: String::new(),
            selector: IntentSelector::default(),
            match_mode: MatchMode::Baseline,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();
    let _b = IntentRepo::create(
        &conn,
        IntentTemplate {
            id: String::new(),
            name: "b".into(),
            vendor: "cisco".into(),
            platform: "nxos".into(),
            kind: IntentKind::Jinja,
            body: "hostname {{name}}".into(),
            vars_yaml: "name: r1\n".into(),
            selector: IntentSelector::default(),
            match_mode: MatchMode::Baseline,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();
    let _c = IntentRepo::create(
        &conn,
        IntentTemplate {
            id: String::new(),
            name: "c".into(),
            vendor: "juniper".into(),
            platform: "junos".into(),
            kind: IntentKind::Golden,
            body: String::new(),
            vars_yaml: String::new(),
            selector: IntentSelector::default(),
            match_mode: MatchMode::Baseline,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();

    assert_eq!(
        IntentRepo::list_filtered(&conn, Some("cisco"), None)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        IntentRepo::list_filtered(&conn, Some("cisco"), Some("iosxe"))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(IntentRepo::list_all(&conn).unwrap().len(), 3);
}

#[test]
fn delete_cascades_drift_reports() {
    let conn = open_db();
    let id = IntentRepo::create(
        &conn,
        IntentTemplate {
            id: String::new(),
            name: "t".into(),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
            kind: IntentKind::Golden,
            body: String::new(),
            vars_yaml: String::new(),
            selector: IntentSelector::default(),
            match_mode: MatchMode::Baseline,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();
    conn.execute(
        "INSERT INTO drift_reports(id, template_id, device_id, device_kind, status, severity, diff_patch)
         VALUES('r1', ?1, 'd1', 'ssh', 'drift', 'additive', '{}')",
        [&id],
    )
    .unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM drift_reports", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    IntentRepo::delete(&conn, &id).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM drift_reports", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "drift_reports should cascade-delete with intent");
}
