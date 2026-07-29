//! Phase 1 — vault envelope CRUD integration tests.
//!
//! These tests use the `InMemoryKeyringStore` so the host's real OS
//! keychain is never touched.

use ccie_terminal_lib::db::open_and_migrate;
use ccie_terminal_lib::vault::{
    InMemoryKeyringStore, KeyringStore, VaultError, VaultLock, VaultStore,
};
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use zeroize::Zeroizing;

fn fresh_store() -> (TempDir, rusqlite::Connection, VaultStore, VaultLock, Arc<InMemoryKeyringStore>) {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("test.db");
    let conn = open_and_migrate(&path).unwrap();
    let kr = Arc::new(InMemoryKeyringStore::new());
    let kr_dyn: Arc<dyn KeyringStore> = kr.clone();
    let store = VaultStore::new(kr_dyn);
    let lock = VaultLock::new(Duration::from_secs(60));
    (tmp, conn, store, lock, kr)
}

#[test]
fn create_envelope_inserts_row_and_canary() {
    let (_tmp, conn, store, _lock, _kr) = fresh_store();
    let pp = Zeroizing::new(b"correct-horse".to_vec());
    let env = store.create_envelope(&conn, "site-A", Some("primary"), pp).unwrap();
    assert_eq!(env.name, "site-A");

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM vault_envelopes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);

    // Canary stub row exists in vault_secrets with __canary__ label.
    let canary_label: String = conn
        .query_row(
            "SELECT label FROM vault_secrets WHERE envelope_id = ?1",
            rusqlite::params![env.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(canary_label, "__canary__");
}

#[test]
fn create_envelope_rejects_duplicate_name() {
    let (_tmp, conn, store, _lock, _kr) = fresh_store();
    store
        .create_envelope(
            &conn,
            "site-A",
            None,
            Zeroizing::new(b"pp".to_vec()),
        )
        .unwrap();
    let err = store
        .create_envelope(
            &conn,
            "site-A",
            None,
            Zeroizing::new(b"pp".to_vec()),
        )
        .unwrap_err();
    assert!(matches!(err, VaultError::EnvelopeNameTaken));
}

#[test]
fn unlock_with_wrong_passphrase_records_audit_row_and_errors_generically() {
    let (_tmp, conn, store, lock, _kr) = fresh_store();
    let _ = store
        .create_envelope(&conn, "site-A", None, Zeroizing::new(b"correct".to_vec()))
        .unwrap();

    let err = store
        .unlock_envelope(&conn, &lock, "site-A", Zeroizing::new(b"wrong".to_vec()))
        .unwrap_err();
    assert!(matches!(err, VaultError::InvalidPassphrase));

    // Same generic error for an envelope that doesn't even exist —
    // prevents existence oracle.
    let err2 = store
        .unlock_envelope(
            &conn,
            &lock,
            "site-DOESNOTEXIST",
            Zeroizing::new(b"x".to_vec()),
        )
        .unwrap_err();
    assert!(matches!(err2, VaultError::InvalidPassphrase));

    // Audit row inserted for the wrong-passphrase attempt.
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_sessions WHERE reason = 'wrong_passphrase'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn unlock_with_correct_passphrase_inserts_session_and_unlocks() {
    let (_tmp, conn, store, lock, _kr) = fresh_store();
    let env = store
        .create_envelope(&conn, "site-A", None, Zeroizing::new(b"correct".to_vec()))
        .unwrap();
    let session_id = store
        .unlock_envelope(&conn, &lock, "site-A", Zeroizing::new(b"correct".to_vec()))
        .unwrap();
    assert!(!session_id.is_empty());
    assert!(lock.is_unlocked(&env.id));
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_sessions WHERE id = ?1 AND locked_at IS NULL",
            rusqlite::params![session_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn add_then_read_secret_roundtrip() {
    let (_tmp, conn, store, lock, _kr) = fresh_store();
    let env = store
        .create_envelope(&conn, "site-A", None, Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    store
        .unlock_envelope(&conn, &lock, "site-A", Zeroizing::new(b"pp".to_vec()))
        .unwrap();

    let s = store
        .add_secret(
            &conn,
            &lock,
            &env.id,
            "password",
            "rtr1-enable",
            Zeroizing::new(b"S3cret!".to_vec()),
            Default::default(),
        )
        .unwrap();
    assert_eq!(s.label, "rtr1-enable");

    let pt = store.read_secret(&conn, &lock, &s.id).unwrap();
    let pt_slice: &[u8] = &pt;
    assert_eq!(pt_slice, b"S3cret!");
}

#[test]
fn read_secret_when_locked_errors_and_does_not_leak() {
    let (_tmp, conn, store, lock, _kr) = fresh_store();
    let env = store
        .create_envelope(&conn, "site-A", None, Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    store
        .unlock_envelope(&conn, &lock, "site-A", Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    let s = store
        .add_secret(
            &conn,
            &lock,
            &env.id,
            "password",
            "x",
            Zeroizing::new(b"plain".to_vec()),
            Default::default(),
        )
        .unwrap();
    store
        .lock_envelope(&conn, &lock, &env.id, "manual")
        .unwrap();

    let err = store.read_secret(&conn, &lock, &s.id).unwrap_err();
    assert!(matches!(err, VaultError::Locked));
}

#[test]
fn keyring_missing_entry_surfaces_as_typed_error_not_panic() {
    let (_tmp, conn, store, lock, kr) = fresh_store();
    let env = store
        .create_envelope(&conn, "site-A", None, Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    store
        .unlock_envelope(&conn, &lock, "site-A", Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    let s = store
        .add_secret(
            &conn,
            &lock,
            &env.id,
            "password",
            "x",
            Zeroizing::new(b"plain".to_vec()),
            Default::default(),
        )
        .unwrap();
    // Manually nuke the keyring entry to simulate corruption.
    let kref: String = conn
        .query_row(
            "SELECT keyring_ref FROM vault_secrets WHERE id = ?1",
            rusqlite::params![s.id],
            |r| r.get(0),
        )
        .unwrap();
    kr.delete(&kref).unwrap();
    let err = store.read_secret(&conn, &lock, &s.id).unwrap_err();
    assert!(matches!(err, VaultError::KeyringMissing));
}

#[test]
fn delete_secret_removes_keyring_and_db() {
    let (_tmp, conn, store, lock, kr) = fresh_store();
    let env = store
        .create_envelope(&conn, "site-A", None, Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    store
        .unlock_envelope(&conn, &lock, "site-A", Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    let s = store
        .add_secret(
            &conn,
            &lock,
            &env.id,
            "password",
            "x",
            Zeroizing::new(b"plain".to_vec()),
            Default::default(),
        )
        .unwrap();
    let kref: String = conn
        .query_row(
            "SELECT keyring_ref FROM vault_secrets WHERE id = ?1",
            rusqlite::params![s.id],
            |r| r.get(0),
        )
        .unwrap();
    store.delete_secret(&conn, &s.id).unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_secrets WHERE id = ?1",
            rusqlite::params![s.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    assert!(matches!(kr.get(&kref).unwrap_err(), VaultError::KeyringMissing));
}

#[test]
fn aad_binding_prevents_cross_envelope_swap() {
    let (_tmp, conn, store, lock, kr) = fresh_store();
    let a = store
        .create_envelope(&conn, "envA", None, Zeroizing::new(b"shared".to_vec()))
        .unwrap();
    let b = store
        .create_envelope(&conn, "envB", None, Zeroizing::new(b"shared".to_vec()))
        .unwrap();
    store
        .unlock_envelope(&conn, &lock, "envA", Zeroizing::new(b"shared".to_vec()))
        .unwrap();
    let sa = store
        .add_secret(
            &conn,
            &lock,
            &a.id,
            "password",
            "x",
            Zeroizing::new(b"only-A".to_vec()),
            Default::default(),
        )
        .unwrap();

    // Manually copy A's ciphertext into B's keyring and add a row pointing
    // there. Reading the B-row should fail because AAD differs.
    let a_kref: String = conn
        .query_row(
            "SELECT keyring_ref FROM vault_secrets WHERE id = ?1",
            rusqlite::params![sa.id],
            |r| r.get(0),
        )
        .unwrap();
    let stolen = kr.get(&a_kref).unwrap();
    let b_kref = format!("ccie-terminal.vault.{}.smuggled", b.id);
    kr.set(&b_kref, &stolen).unwrap();
    conn.execute(
        "INSERT INTO vault_secrets
           (id, envelope_id, kind, label, keyring_ref, metadata_json)
         VALUES (?1, ?2, 'password', 'smuggled', ?3, '{}')",
        rusqlite::params!["smug-id", b.id, b_kref],
    )
    .unwrap();

    store
        .unlock_envelope(&conn, &lock, "envB", Zeroizing::new(b"shared".to_vec()))
        .unwrap();
    let err = store.read_secret(&conn, &lock, "smug-id").unwrap_err();
    // Decrypt fails because AAD = envelope_id and the AADs differ.
    assert!(matches!(err, VaultError::Aead(_)));
}

#[test]
fn idle_timeout_auto_locks_after_threshold() {
    let (_tmp, conn, store, _lock_unused, _kr) = fresh_store();
    let lock = VaultLock::new(Duration::from_millis(50));
    let env = store
        .create_envelope(&conn, "site-A", None, Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    store
        .unlock_envelope(&conn, &lock, "site-A", Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    assert!(lock.is_unlocked(&env.id));
    std::thread::sleep(Duration::from_millis(120));
    assert!(!lock.is_unlocked(&env.id));
    let swept = lock.sweep_idle();
    assert_eq!(swept.len(), 1);
    assert_eq!(swept[0].0, env.id);
}

#[test]
fn canary_decrypt_confirms_passphrase_before_revealing_anything() {
    // Passphrase-correctness goes through the canary, not a real secret.
    // Verifies the unlock path doesn't read or expose any non-canary
    // plaintext when the passphrase is wrong.
    let (_tmp, conn, store, lock, _kr) = fresh_store();
    let env = store
        .create_envelope(&conn, "site-A", None, Zeroizing::new(b"correct".to_vec()))
        .unwrap();
    store
        .unlock_envelope(&conn, &lock, "site-A", Zeroizing::new(b"correct".to_vec()))
        .unwrap();
    let _ = store
        .add_secret(
            &conn,
            &lock,
            &env.id,
            "password",
            "real",
            Zeroizing::new(b"super-real-pw".to_vec()),
            Default::default(),
        )
        .unwrap();
    store.lock_envelope(&conn, &lock, &env.id, "manual").unwrap();

    // Wrong passphrase: must fail without trying to open any real secret.
    let err = store
        .unlock_envelope(&conn, &lock, "site-A", Zeroizing::new(b"wrong".to_vec()))
        .unwrap_err();
    assert!(matches!(err, VaultError::InvalidPassphrase));
    assert!(!lock.is_unlocked(&env.id));
}

#[test]
fn delete_envelope_cascades() {
    let (_tmp, conn, store, lock, _kr) = fresh_store();
    let env = store
        .create_envelope(&conn, "site-A", None, Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    store
        .unlock_envelope(&conn, &lock, "site-A", Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    store
        .add_secret(
            &conn,
            &lock,
            &env.id,
            "password",
            "x",
            Zeroizing::new(b"x".to_vec()),
            Default::default(),
        )
        .unwrap();
    store.delete_envelope(&conn, &env.id).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM vault_secrets", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "cascading delete should remove secret rows");
}

#[test]
fn rotate_secret_replaces_ciphertext() {
    let (_tmp, conn, store, lock, _kr) = fresh_store();
    let env = store
        .create_envelope(&conn, "site-A", None, Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    store
        .unlock_envelope(&conn, &lock, "site-A", Zeroizing::new(b"pp".to_vec()))
        .unwrap();
    let s = store
        .add_secret(
            &conn,
            &lock,
            &env.id,
            "password",
            "x",
            Zeroizing::new(b"v1".to_vec()),
            Default::default(),
        )
        .unwrap();
    store
        .rotate_secret(&conn, &lock, &s.id, Zeroizing::new(b"v2".to_vec()))
        .unwrap();
    let pt = store.read_secret(&conn, &lock, &s.id).unwrap();
    let pt_slice: &[u8] = &pt;
    assert_eq!(pt_slice, b"v2");
}
