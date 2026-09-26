use ccie_terminal_lib::change_verify::bundles;
use ccie_terminal_lib::change_verify::model::NewCheckBundle;
use ccie_terminal_lib::db;
use rusqlite::Connection;
use tempfile::TempDir;

fn mem_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    (dir, conn)
}

#[test]
fn bundle_roundtrip_create_read_update_delete() {
    let (_dir, mut db) = mem_db();
    let created = bundles::create(&mut db, NewCheckBundle {
        name: "ios-xe baseline".into(),
        description: Some("Routing + interfaces".into()),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        commands: vec![
            "show ip interface brief".into(),
            "show ip route summary".into(),
            "show ip bgp summary".into(),
        ],
    }).unwrap();
    assert_eq!(created.commands.len(), 3);

    let fetched = bundles::get(&db, &created.id).unwrap();
    assert_eq!(fetched.name, "ios-xe baseline");
    assert_eq!(fetched.commands[1], "show ip route summary");

    bundles::update_commands(&mut db, &created.id, vec![
        "show ip interface brief".into(),
        "show ip ospf neighbor".into(),
    ]).unwrap();
    let updated = bundles::get(&db, &created.id).unwrap();
    assert_eq!(updated.commands, vec![
        "show ip interface brief".to_string(),
        "show ip ospf neighbor".to_string(),
    ]);

    let all = bundles::list(&db, Some("cisco"), Some("iosxe")).unwrap();
    assert_eq!(all.len(), 1);

    bundles::delete(&db, &created.id).unwrap();
    assert!(bundles::get(&db, &created.id).is_err());

    let child_count: i64 = db.query_row(
        "SELECT COUNT(*) FROM check_bundle_commands WHERE bundle_id = ?1",
        rusqlite::params![&created.id],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(child_count, 0, "ON DELETE CASCADE failed — child commands still exist");
}

#[test]
fn bundle_commands_preserve_order_after_update() {
    let (_dir, mut db) = mem_db();
    let b = bundles::create(&mut db, NewCheckBundle {
        name: "ordered".into(), description: None,
        vendor: "cisco".into(), platform: "iosxe".into(),
        commands: vec!["a".into(), "b".into(), "c".into()],
    }).unwrap();
    bundles::update_commands(&mut db, &b.id, vec!["z".into(), "y".into(), "x".into()]).unwrap();
    let got = bundles::get(&db, &b.id).unwrap();
    assert_eq!(got.commands, vec!["z".to_string(), "y".to_string(), "x".to_string()]);
}
