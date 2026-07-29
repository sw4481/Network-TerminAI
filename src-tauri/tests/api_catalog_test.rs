//! Catalog assembly: seed_builtin_manifests + load_all + summaries.

use ccie_terminal_lib::api_runner::catalog::{load_all, seed_builtin_manifests};
use tempfile::TempDir;

#[test]
fn seed_writes_builtin_manifests_on_first_run() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("builtin");

    seed_builtin_manifests(&dir).unwrap();
    let meraki = dir.join("meraki.yaml");
    assert!(meraki.exists(), "meraki.yaml should be seeded");
}

#[test]
fn seed_is_content_idempotent_when_on_disk_matches_bundled() {
    // Calling seed twice in a row without changes must be a no-op — we
    // don't touch the file if its bytes already match the bundled copy.
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("builtin");
    seed_builtin_manifests(&dir).unwrap();
    let meraki = dir.join("meraki.yaml");
    let mtime1 = std::fs::metadata(&meraki).unwrap().modified().unwrap();

    std::thread::sleep(std::time::Duration::from_millis(10));
    seed_builtin_manifests(&dir).unwrap();
    let mtime2 = std::fs::metadata(&meraki).unwrap().modified().unwrap();
    assert_eq!(
        mtime1, mtime2,
        "identical-content seeding must NOT re-write the file",
    );
}

#[test]
fn seed_overwrites_stale_builtin_manifests() {
    // Built-in files are app-owned. If a shipped version has a bug that
    // gets fixed in a later release (e.g. SNA's JSON -> form-urlencoded
    // auth body), we must re-seed the corrected content over the stale
    // file. Users who want to customize should drop a separate YAML in
    // the neighboring user directory.
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("builtin");
    seed_builtin_manifests(&dir).unwrap();
    let meraki = dir.join("meraki.yaml");
    let fresh_bytes = std::fs::read(&meraki).unwrap();

    // Corrupt the on-disk file (simulates either a stale old version or a
    // user edit inside the app-owned directory).
    std::fs::write(&meraki, b"id: stale\ndisplay_name: old\nbase_url: https://x\n").unwrap();

    seed_builtin_manifests(&dir).unwrap();
    let after = std::fs::read(&meraki).unwrap();
    assert_eq!(
        after, fresh_bytes,
        "stale builtin must be overwritten with the current bundled copy",
    );
}

#[test]
fn load_all_assembles_builtin_and_user_targets() {
    let tmp = TempDir::new().unwrap();
    let builtin = tmp.path().join("builtin");
    let user = tmp.path().join("user");
    seed_builtin_manifests(&builtin).unwrap();
    std::fs::create_dir_all(&user).unwrap();
    std::fs::write(
        user.join("labgear.yaml"),
        "id: labgear\ndisplay_name: Lab Gear\nbase_url: https://lab.local\n",
    )
    .unwrap();

    let loaded = load_all(&builtin, &user).unwrap();
    // 4 built-in targets ship as of Step 8: catalyst_center, ise, meraki, sna.
    assert!(
        loaded.builtin.len() >= 4,
        "expected all built-in targets to load, got {}",
        loaded.builtin.len()
    );
    assert_eq!(loaded.user.len(), 1);

    let summaries = loaded.summaries();
    // Built-ins come first, sorted; the user manifest appears after.
    let builtin_ids: Vec<_> = summaries
        .iter()
        .filter(|s| s.builtin)
        .map(|s| s.id.as_str())
        .collect();
    assert!(builtin_ids.contains(&"meraki"));
    assert!(builtin_ids.contains(&"catalyst_center"));
    assert!(builtin_ids.contains(&"ise"));
    assert!(builtin_ids.contains(&"sna"));
    let user_labgear = summaries.iter().find(|s| s.id == "labgear").unwrap();
    assert!(!user_labgear.builtin);
}

#[test]
fn find_returns_first_match_across_both_dirs() {
    let tmp = TempDir::new().unwrap();
    let builtin = tmp.path().join("b");
    let user = tmp.path().join("u");
    seed_builtin_manifests(&builtin).unwrap();
    std::fs::create_dir_all(&user).unwrap();
    let loaded = load_all(&builtin, &user).unwrap();
    assert!(loaded.find("meraki").is_some());
    assert!(loaded.find("nonexistent").is_none());
}
