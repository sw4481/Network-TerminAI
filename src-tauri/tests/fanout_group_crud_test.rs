use ccie_terminal_lib::fanout::model::DeviceKind;
use ccie_terminal_lib::fanout::store::FanoutStore;

#[test]
fn group_crud_and_member_roundtrip() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut conn = ccie_terminal_lib::db::open_and_migrate(tmp.path()).unwrap();

    let g = FanoutStore::create_group(&mut conn, "site-atl-core", Some("atlanta core")).unwrap();
    assert_eq!(g.name, "site-atl-core");
    assert_eq!(g.member_count, 0);
    assert!(FanoutStore::list_groups(&conn)
        .unwrap()
        .iter()
        .any(|x| x.id == g.id));

    let ssh_id = FanoutStore::seed_test_ssh(&conn, "r1", "10.0.0.1").unwrap();
    let nc_id = FanoutStore::seed_test_netconf(&conn, "r2", "10.0.0.2").unwrap();

    FanoutStore::add_member(&conn, &g.id, &ssh_id, DeviceKind::Ssh).unwrap();
    FanoutStore::add_member(&conn, &g.id, &nc_id, DeviceKind::Netconf).unwrap();

    let members = FanoutStore::list_members(&conn, &g.id).unwrap();
    assert_eq!(members.len(), 2);
    assert!(members.iter().any(|m| m.device_kind == DeviceKind::Ssh));
    assert!(members.iter().any(|m| m.device_kind == DeviceKind::Netconf));
    assert!(members.iter().all(|m| !m.display_name.is_empty()));

    FanoutStore::remove_member(&conn, &g.id, &ssh_id, DeviceKind::Ssh).unwrap();
    assert_eq!(FanoutStore::list_members(&conn, &g.id).unwrap().len(), 1);

    // member_count rolls up
    let g2 = FanoutStore::get_group(&conn, &g.id).unwrap();
    assert_eq!(g2.member_count, 1);

    FanoutStore::delete_group(&conn, &g.id).unwrap();
    assert!(FanoutStore::list_groups(&conn).unwrap().is_empty());
}

#[test]
fn add_member_idempotent() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut conn = ccie_terminal_lib::db::open_and_migrate(tmp.path()).unwrap();
    let g = FanoutStore::create_group(&mut conn, "g1", None).unwrap();
    let ssh_id = FanoutStore::seed_test_ssh(&conn, "r1", "10.0.0.1").unwrap();

    FanoutStore::add_member(&conn, &g.id, &ssh_id, DeviceKind::Ssh).unwrap();
    FanoutStore::add_member(&conn, &g.id, &ssh_id, DeviceKind::Ssh).unwrap();
    assert_eq!(FanoutStore::list_members(&conn, &g.id).unwrap().len(), 1);
}

#[test]
fn bulk_add_returns_inserted_count() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut conn = ccie_terminal_lib::db::open_and_migrate(tmp.path()).unwrap();
    let g = FanoutStore::create_group(&mut conn, "g1", None).unwrap();
    let s1 = FanoutStore::seed_test_ssh(&conn, "r1", "10.0.0.1").unwrap();
    let s2 = FanoutStore::seed_test_ssh(&conn, "r2", "10.0.0.2").unwrap();
    let n1 = FanoutStore::seed_test_netconf(&conn, "x1", "10.1.0.1").unwrap();

    let added = FanoutStore::add_members_bulk(
        &mut conn,
        &g.id,
        &[
            (s1.clone(), DeviceKind::Ssh),
            (s2, DeviceKind::Ssh),
            (n1, DeviceKind::Netconf),
            (s1, DeviceKind::Ssh), // duplicate
        ],
    )
    .unwrap();
    assert_eq!(added, 3);
}

#[test]
fn group_unique_name_constraint() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut conn = ccie_terminal_lib::db::open_and_migrate(tmp.path()).unwrap();
    FanoutStore::create_group(&mut conn, "dup", None).unwrap();
    let err = FanoutStore::create_group(&mut conn, "dup", None);
    assert!(err.is_err());
}
