use ccie_terminal_lib::fanout::model::DeviceKind;
use ccie_terminal_lib::fanout::store::FanoutStore;

#[test]
fn csv_imports_resolved_devices_and_warns_on_unknown() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut conn = ccie_terminal_lib::db::open_and_migrate(tmp.path()).unwrap();
    let g = FanoutStore::create_group(&mut conn, "csv-group", None).unwrap();

    FanoutStore::seed_test_ssh(&conn, "r1-atl", "10.0.0.1").unwrap();
    FanoutStore::seed_test_ssh(&conn, "r2-atl", "10.0.0.2").unwrap();
    FanoutStore::seed_test_netconf(&conn, "xe1-atl", "10.1.0.1").unwrap();

    let csv = "device_kind,identifier
ssh,r1-atl
ssh,r2-atl
netconf,xe1-atl
ssh,r99-bogus
";
    let result = FanoutStore::import_csv(&mut conn, &g.id, csv).unwrap();
    assert_eq!(result.added, 3);
    assert_eq!(result.warnings.len(), 1);
    assert!(result.warnings[0].contains("r99-bogus"));

    let members = FanoutStore::list_members(&conn, &g.id).unwrap();
    assert_eq!(members.len(), 3);
}

#[test]
fn csv_resolves_by_id_and_by_name_case_insensitive() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut conn = ccie_terminal_lib::db::open_and_migrate(tmp.path()).unwrap();
    let g = FanoutStore::create_group(&mut conn, "g", None).unwrap();
    let ssh_id = FanoutStore::seed_test_ssh(&conn, "MixedCase", "10.0.0.1").unwrap();
    let nc_id = FanoutStore::seed_test_netconf(&conn, "NX1", "10.1.0.1").unwrap();

    let csv = format!(
        "device_kind,identifier\nssh,{}\nssh,mixedcase\nnetconf,{}\nnetconf,nx1\n",
        ssh_id, nc_id
    );
    let result = FanoutStore::import_csv(&mut conn, &g.id, &csv).unwrap();
    assert_eq!(result.warnings.len(), 0);
    // duplicates collapse — only 2 actually inserted (one per kind)
    assert_eq!(FanoutStore::list_members(&conn, &g.id).unwrap().len(), 2);
}

#[test]
fn csv_skips_blank_lines_and_comments() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut conn = ccie_terminal_lib::db::open_and_migrate(tmp.path()).unwrap();
    let g = FanoutStore::create_group(&mut conn, "g", None).unwrap();
    FanoutStore::seed_test_ssh(&conn, "r1", "10.0.0.1").unwrap();

    let csv = "device_kind,identifier\n\n# comment\nssh,r1\n";
    let result = FanoutStore::import_csv(&mut conn, &g.id, csv).unwrap();
    assert_eq!(result.added, 1);
    assert!(result.warnings.is_empty());
}

#[test]
fn csv_handles_no_header_row() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut conn = ccie_terminal_lib::db::open_and_migrate(tmp.path()).unwrap();
    let g = FanoutStore::create_group(&mut conn, "g", None).unwrap();
    FanoutStore::seed_test_ssh(&conn, "r1", "10.0.0.1").unwrap();

    // No header: first line is data
    let csv = "ssh,r1\n";
    let result = FanoutStore::import_csv(&mut conn, &g.id, csv).unwrap();
    assert_eq!(result.added, 1);
}

#[test]
fn csv_warns_on_bad_kind() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut conn = ccie_terminal_lib::db::open_and_migrate(tmp.path()).unwrap();
    let g = FanoutStore::create_group(&mut conn, "g", None).unwrap();
    let csv = "device_kind,identifier\ntelnet,foo\n";
    let result = FanoutStore::import_csv(&mut conn, &g.id, csv).unwrap();
    assert_eq!(result.added, 0);
    assert_eq!(result.warnings.len(), 1);
    assert!(result.warnings[0].to_lowercase().contains("telnet"));
}

#[test]
fn resolve_identifier_returns_none_for_unknown() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let conn = ccie_terminal_lib::db::open_and_migrate(tmp.path()).unwrap();
    assert!(FanoutStore::resolve_identifier(&conn, DeviceKind::Ssh, "nope")
        .unwrap()
        .is_none());
    assert!(
        FanoutStore::resolve_identifier(&conn, DeviceKind::Netconf, "nope")
            .unwrap()
            .is_none()
    );
}
