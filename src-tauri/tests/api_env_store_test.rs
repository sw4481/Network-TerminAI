//! env_store coverage: round-trip, atomic writes, chmod 0600 on Unix,
//! name/key/value validation, delete, list.

use ccie_terminal_lib::api_runner::env_store::{
    create_environment, delete_environment, delete_var, list_environments, load_env, set_var,
    validate_env_name, validate_key, EnvVar,
};
use tempfile::TempDir;

fn tmp() -> TempDir {
    TempDir::new().unwrap()
}

// ---- validators ----------------------------------------------------------

#[test]
fn validate_env_name_accepts_alphanumeric_and_dashes() {
    assert!(validate_env_name("lab").is_ok());
    assert!(validate_env_name("prod-us").is_ok());
    assert!(validate_env_name("dev_1").is_ok());
    assert!(validate_env_name("A-99").is_ok());
}

#[test]
fn validate_env_name_rejects_path_traversal_and_specials() {
    for bad in [
        "",
        "..",
        "../etc",
        "lab/prod",
        "lab\\prod",
        "lab prod",
        "lab.env",
        "lab\n",
    ] {
        assert!(
            validate_env_name(bad).is_err(),
            "expected {bad:?} to be rejected"
        );
    }
}

#[test]
fn validate_env_name_rejects_too_long() {
    let long = "a".repeat(65);
    assert!(validate_env_name(&long).is_err());
}

#[test]
fn validate_key_rejects_equals_newline_and_control() {
    assert!(validate_key("MY_KEY").is_ok());
    assert!(validate_key("a-b-c").is_ok());
    for bad in ["", "has=equals", "has\nnewline", "has\rcr", "has tab\t"] {
        assert!(
            validate_key(bad).is_err(),
            "expected {bad:?} to be rejected"
        );
    }
}

// ---- create/delete/list --------------------------------------------------

#[test]
fn create_environment_creates_file_and_is_idempotent() {
    let tmp = tmp();
    let dir = tmp.path();
    assert!(create_environment(dir, "lab").unwrap());
    assert!(dir.join("lab.env").exists());
    assert!(dir.join("lab.env.meta.json").exists());
    // Second call returns false (already exists).
    assert!(!create_environment(dir, "lab").unwrap());
}

#[test]
fn delete_environment_removes_both_files() {
    let tmp = tmp();
    let dir = tmp.path();
    create_environment(dir, "lab").unwrap();
    delete_environment(dir, "lab").unwrap();
    assert!(!dir.join("lab.env").exists());
    assert!(!dir.join("lab.env.meta.json").exists());
    // Delete-missing is silent success.
    assert!(delete_environment(dir, "lab").is_ok());
}

#[test]
fn list_environments_is_alphabetical_and_skips_meta() {
    let tmp = tmp();
    let dir = tmp.path();
    create_environment(dir, "zulu").unwrap();
    create_environment(dir, "alpha").unwrap();
    create_environment(dir, "mike").unwrap();
    // Random stray files in the dir must not appear as environments.
    std::fs::write(dir.join("notes.txt"), "hi").unwrap();
    std::fs::write(dir.join("zulu.env.meta.json"), "{}").unwrap();
    let list = list_environments(dir).unwrap();
    assert_eq!(list, vec!["alpha", "mike", "zulu"]);
}

#[test]
fn list_returns_empty_for_missing_dir() {
    let list = list_environments(std::path::Path::new("/nonexistent-xyz-123")).unwrap();
    assert!(list.is_empty());
}

// ---- set / get / delete vars --------------------------------------------

#[test]
fn set_var_round_trip_preserves_all_fields() {
    let tmp = tmp();
    let dir = tmp.path();
    set_var(dir, "lab", "MERAKI_API_KEY", "deadbeef", true).unwrap();
    set_var(dir, "lab", "MERAKI_ORG_ID", "L_12345", false).unwrap();

    let vars = load_env(dir, "lab").unwrap();
    assert_eq!(vars.len(), 2);

    let key = vars.iter().find(|v| v.key == "MERAKI_API_KEY").unwrap();
    assert_eq!(key.value, "deadbeef");
    assert!(key.is_secret);

    let org = vars.iter().find(|v| v.key == "MERAKI_ORG_ID").unwrap();
    assert_eq!(org.value, "L_12345");
    assert!(!org.is_secret);
}

#[test]
fn set_var_overwrites_existing_and_can_toggle_secret() {
    let tmp = tmp();
    let dir = tmp.path();
    set_var(dir, "lab", "TOKEN", "old", true).unwrap();
    set_var(dir, "lab", "TOKEN", "new", false).unwrap();
    let vars = load_env(dir, "lab").unwrap();
    assert_eq!(vars.len(), 1);
    assert_eq!(vars[0].value, "new");
    assert!(!vars[0].is_secret);
}

#[test]
fn delete_var_removes_key_and_secret_flag() {
    let tmp = tmp();
    let dir = tmp.path();
    set_var(dir, "lab", "A", "1", false).unwrap();
    set_var(dir, "lab", "B", "2", true).unwrap();
    delete_var(dir, "lab", "B").unwrap();
    let vars = load_env(dir, "lab").unwrap();
    assert_eq!(vars.len(), 1);
    assert_eq!(vars[0].key, "A");
    // Delete-missing is silent success.
    assert!(delete_var(dir, "lab", "B").is_ok());
    assert!(delete_var(dir, "lab", "NEVER_EXISTED").is_ok());
}

#[test]
fn load_env_skips_malformed_lines() {
    let tmp = tmp();
    let dir = tmp.path();
    create_environment(dir, "lab").unwrap();
    // Mix good + bad lines manually.
    std::fs::write(
        dir.join("lab.env"),
        "# comment\n\nGOOD=yes\nmissing_equals\n=noKey\nbad key=oops\n",
    )
    .unwrap();
    let vars = load_env(dir, "lab").unwrap();
    // Only GOOD=yes survives.
    let keys: Vec<_> = vars.iter().map(|v| v.key.as_str()).collect();
    assert_eq!(keys, vec!["GOOD"]);
    assert_eq!(vars[0].value, "yes");
}

#[test]
fn set_var_rejects_bad_keys() {
    let tmp = tmp();
    let dir = tmp.path();
    assert!(set_var(dir, "lab", "BAD=KEY", "v", false).is_err());
    assert!(set_var(dir, "lab", "BAD\nKEY", "v", false).is_err());
    assert!(set_var(dir, "lab", "", "v", false).is_err());
}

#[test]
fn set_var_rejects_values_with_nul() {
    let tmp = tmp();
    let dir = tmp.path();
    assert!(set_var(dir, "lab", "KEY", "pre\0post", false).is_err());
}

#[test]
fn set_var_rejects_env_name_with_traversal() {
    let tmp = tmp();
    let dir = tmp.path();
    assert!(set_var(dir, "../evil", "K", "V", false).is_err());
    assert!(set_var(dir, "lab/sub", "K", "V", false).is_err());
}

// ---- filesystem permissions + atomicity ---------------------------------

#[cfg(unix)]
#[test]
fn env_file_is_chmod_0600_after_write() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tmp();
    let dir = tmp.path();
    set_var(dir, "lab", "SECRET", "shh", true).unwrap();
    let mode = std::fs::metadata(dir.join("lab.env"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "env file must be 0600; got {mode:o}");
    let mode2 = std::fs::metadata(dir.join("lab.env.meta.json"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode2, 0o600, "meta file must be 0600; got {mode2:o}");
}

#[test]
fn set_var_leaves_no_tmp_files_behind_on_success() {
    let tmp = tmp();
    let dir = tmp.path();
    set_var(dir, "lab", "A", "1", false).unwrap();
    set_var(dir, "lab", "B", "2", false).unwrap();
    let mut tmps = Vec::new();
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if name.starts_with('.') && name.contains(".tmp.") {
            tmps.push(name);
        }
    }
    assert!(tmps.is_empty(), "expected no leftover .tmp files: {tmps:?}");
}

#[test]
fn concurrent_set_var_calls_do_not_lose_data() {
    // Run several set_var calls sequentially but with interleaved keys —
    // regression for the bug where two atomic writes race and one clobbers
    // the other. We're not trying to prove thread safety (the GUI serializes
    // through a single Tauri command), just that the on-disk merge is correct.
    let tmp = tmp();
    let dir = tmp.path();
    for i in 0..10 {
        set_var(dir, "lab", &format!("K{i}"), &format!("v{i}"), i % 2 == 0).unwrap();
    }
    let vars = load_env(dir, "lab").unwrap();
    assert_eq!(vars.len(), 10);
    for i in 0..10 {
        let want = EnvVar {
            key: format!("K{i}"),
            value: format!("v{i}"),
            is_secret: i % 2 == 0,
        };
        assert!(vars.contains(&want), "missing {want:?} in {vars:?}");
    }
}
