//! Final security review — Finding 2.
//!
//! `editor_create_file` / `editor_delete_file` / `editor_rename_file` /
//! `editor_create_directory` previously took raw `String` paths and
//! passed them straight to `fs::*`. They now route through
//! `validate_path` which canonicalizes the candidate and verifies it
//! lives under a workspace root.
//!
//! These tests exercise the validator directly through the public
//! Tauri command surface (which is just an async fn — calling it from
//! tests skips the IPC plumbing but exercises the same body).

use std::fs;
use std::path::PathBuf;

use ccie_terminal_lib::commands::editor::{
    editor_create_directory, editor_create_file, editor_delete_file, editor_rename_file,
};

fn fresh_workspace() -> (tempfile::TempDir, PathBuf) {
    let td = tempfile::tempdir().expect("tempdir");
    // Resolve any platform-level symlinks in the temp parent (macOS puts
    // /tmp -> /private/tmp). The validator canonicalizes the workspace
    // root, so callers must hand it a real path; tempfile::tempdir gives
    // us the unresolved form.
    let canon = fs::canonicalize(td.path()).expect("canonicalize tempdir");
    (td, canon)
}

#[tokio::test]
async fn test_relative_path_with_dotdot_rejected() {
    let (_td, root) = fresh_workspace();
    // `../../tmp/x` — after canonicalization the `..`s walk above the
    // workspace root and the validator must refuse.
    let escapee = format!("{}/../../escapee.txt", root.display());
    let err = editor_create_file(escapee, Some(root.to_string_lossy().into()))
        .await
        .expect_err("expected validate_path to reject ../../");
    assert!(
        err.contains("outside workspace root"),
        "expected containment error, got {err:?}"
    );
}

#[tokio::test]
async fn test_absolute_path_outside_workspace_rejected() {
    let (_td, root) = fresh_workspace();
    let outside = "/etc/passwd-fake-test-file".to_string();
    let err = editor_create_file(outside, Some(root.to_string_lossy().into()))
        .await
        .expect_err("expected validate_path to reject /etc path");
    assert!(
        err.contains("outside workspace root") || err.contains("could not be canonicalized"),
        "expected rejection, got {err:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn test_symlink_escape_rejected() {
    let (_td, root) = fresh_workspace();
    // Place a symlink inside the workspace that points to /tmp (which
    // sits outside the workspace root). Any path that traverses it
    // resolves to outside-the-root and must be rejected.
    let link_path = root.join("link-to-etc");
    std::os::unix::fs::symlink("/etc", &link_path).expect("create symlink");

    let candidate = format!("{}/link-to-etc/passwd-test", root.display());
    let err = editor_delete_file(candidate, Some(root.to_string_lossy().into()))
        .await
        .expect_err("expected validate_path to reject path that traverses symlink");
    assert!(
        err.contains("outside workspace root") || err.contains("could not be canonicalized"),
        "expected rejection, got {err:?}",
    );
}

#[tokio::test]
async fn test_normal_relative_path_accepted() {
    let (_td, root) = fresh_workspace();
    // A path that's plainly inside the workspace must succeed.
    let inside = root.join("hello.txt").to_string_lossy().to_string();
    editor_create_file(inside.clone(), Some(root.to_string_lossy().into()))
        .await
        .expect("expected create to succeed");
    assert!(PathBuf::from(&inside).exists(), "file was not created");
}

#[tokio::test]
async fn test_create_directory_inside_workspace_succeeds() {
    let (_td, root) = fresh_workspace();
    let inside = root.join("a/b/c").to_string_lossy().to_string();
    editor_create_directory(inside.clone(), Some(root.to_string_lossy().into()))
        .await
        .expect("expected directory create to succeed");
    assert!(PathBuf::from(&inside).is_dir());
}

#[tokio::test]
async fn test_rename_with_destination_outside_workspace_rejected() {
    let (_td, root) = fresh_workspace();
    let src = root.join("src.txt");
    fs::write(&src, b"hello").unwrap();

    let dst = format!("{}/../escapee.txt", root.display());
    let err = editor_rename_file(
        src.to_string_lossy().into(),
        dst,
        Some(root.to_string_lossy().into()),
    )
    .await
    .expect_err("destination path escaped workspace; rename must be rejected");
    assert!(
        err.contains("outside workspace root"),
        "expected containment error, got {err:?}"
    );
}

#[tokio::test]
async fn test_delete_inside_workspace_succeeds() {
    let (_td, root) = fresh_workspace();
    let target = root.join("doomed.txt");
    fs::write(&target, b"bye").unwrap();
    editor_delete_file(
        target.to_string_lossy().into(),
        Some(root.to_string_lossy().into()),
    )
    .await
    .expect("delete inside workspace");
    assert!(!target.exists());
}
