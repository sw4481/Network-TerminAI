use ccie_terminal_lib::db::open_and_migrate;
use ccie_terminal_lib::vault::import::{import_csv, ImportFormat};
use ccie_terminal_lib::vault::{InMemoryKeyringStore, KeyringStore, VaultLock, VaultStore};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use zeroize::Zeroizing;

fn setup_unlocked() -> (TempDir, rusqlite::Connection, VaultStore, VaultLock, String) {
    let tmp = TempDir::new().unwrap();
    let conn = open_and_migrate(&tmp.path().join("t.db")).unwrap();
    let kr: Arc<dyn KeyringStore> = Arc::new(InMemoryKeyringStore::new());
    let store = VaultStore::new(kr);
    let lock = VaultLock::new(Duration::from_secs(60));
    let env = store
        .create_envelope(&conn, "imp", None, Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    store
        .unlock_envelope(&conn, &lock, "imp", Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    (tmp, conn, store, lock, env.id)
}

fn fixture_path(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests");
    p.push("fixtures");
    p.push(name);
    p
}

fn fixture_with_ssh_key_marker(tmp: &TempDir, name: &str) -> PathBuf {
    let contents = std::fs::read_to_string(fixture_path(name)).unwrap();
    let marker = ["-----BEGIN ", "OPENSSH PRIVATE KEY-----"].concat();
    let contents = contents.replace("EXAMPLE_ONLY_SSH_KEY_MARKER", &marker);
    let path = tmp.path().join(name);
    std::fs::write(&path, contents).unwrap();
    path
}

#[test]
fn imports_1password_csv_into_envelope() {
    let (_tmp, conn, store, lock, env_id) = setup_unlocked();
    let fixture = fixture_with_ssh_key_marker(&_tmp, "1password_export_sample.csv");
    let result = import_csv(
        &conn,
        &lock,
        &store,
        &env_id,
        &fixture,
        ImportFormat::OnePassword,
    )
    .unwrap();
    assert!(result.imported >= 2, "imported {}", result.imported);
    let secrets = store.list_secrets(&conn, &env_id).unwrap();
    let labels: Vec<_> = secrets.iter().map(|s| s.label.clone()).collect();
    assert!(labels.contains(&"rtr1-enable".to_string()));
    let ssh_key_row = secrets
        .iter()
        .find(|s| s.label == "ssh-key-prod")
        .expect("ssh-key-prod row");
    assert_eq!(ssh_key_row.kind, "ssh_key");
}

#[test]
fn imports_bitwarden_csv_with_totp_metadata() {
    let (_tmp, conn, store, lock, env_id) = setup_unlocked();
    let result = import_csv(
        &conn,
        &lock,
        &store,
        &env_id,
        &fixture_path("bitwarden_export_sample.csv"),
        ImportFormat::Bitwarden,
    )
    .unwrap();
    assert!(result.imported >= 2);
    let secrets = store.list_secrets(&conn, &env_id).unwrap();
    let nms = secrets.iter().find(|s| s.label == "nms-svc").unwrap();
    assert_eq!(nms.metadata.get("totp"), Some(&serde_json::Value::Bool(true)));
    let gateway = secrets.iter().find(|s| s.label == "gateway-admin").unwrap();
    assert_eq!(
        gateway.metadata.get("username"),
        Some(&serde_json::Value::String("admin".into()))
    );
}

#[test]
fn auto_format_detects_bitwarden_via_login_password_header() {
    let (_tmp, conn, store, lock, env_id) = setup_unlocked();
    let result = import_csv(
        &conn,
        &lock,
        &store,
        &env_id,
        &fixture_path("bitwarden_export_sample.csv"),
        ImportFormat::Auto,
    )
    .unwrap();
    assert!(result.imported >= 2);
}

#[test]
fn rows_without_password_are_skipped() {
    let (_tmp, conn, store, lock, env_id) = setup_unlocked();
    let result = import_csv(
        &conn,
        &lock,
        &store,
        &env_id,
        &fixture_path("1password_export_sample.csv"),
        ImportFormat::OnePassword,
    )
    .unwrap();
    // The "incomplete" row should be skipped (empty title + password).
    assert!(result.skipped >= 1, "result was {result:?}");
}
