//! Tauri commands that expose limited, read-only Git repository info to the
//! editor UI (status badges, diff viewer, repo detection).
//!
//! Read paths use `git2` (libgit2). WRITE paths (init/commit/remote/push) shell
//! out to the system `git` binary on purpose: it transparently reuses the
//! user's existing credentials (gh CLI, credential helper, SSH agent), whereas
//! libgit2 credential callbacks are fragile and would re-implement auth badly.
//! Anyone doing IaC pipelines already has `git` installed.

use git2::{DiffOptions, ErrorCode, Repository, Status, StatusOptions};
use serde::{Deserialize, Serialize};
use similar::{DiffTag, TextDiff};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use super::AppState;
use crate::git::github_auth::{
    GitHubAccount, GitHubAuthPollResult, GitHubDeviceAuthorization, GitHubRepositoryPage,
};
use crate::git::repository_service::{
    GitBranch, GitCommitDetail, GitCommitSummary, GitDiffPayload, GitOperationResult,
    GitRepositoryDescriptor, GitRepositoryState,
};

/// Result of a shelled-out git invocation.
#[derive(Debug, Serialize)]
pub struct GitCmdResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Run `git <args>` in `cwd`, capturing output. Never panics; a non-zero exit
/// is returned as `ok: false` with stderr, not an Err — callers surface it.
fn run_git(cwd: &str, args: &[&str]) -> Result<GitCmdResult, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| {
            format!(
                "Could not run git — is it installed and on your PATH? ({})",
                e
            )
        })?;
    Ok(GitCmdResult {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

/// `git init` (idempotent — a no-op if `cwd` is already a repo).
#[tauri::command]
pub async fn git_init(cwd: String) -> Result<GitCmdResult, String> {
    if Repository::discover(&cwd).is_ok() {
        return Ok(GitCmdResult {
            ok: true,
            stdout: "Already a git repository".into(),
            stderr: String::new(),
        });
    }
    run_git(&cwd, &["init"])
}

/// Stage the given repo-relative paths (or all changes when empty) and commit.
/// Skips the commit cleanly when there is nothing staged, so the caller can
/// call it unconditionally.
#[tauri::command]
pub async fn git_commit_paths(
    cwd: String,
    paths: Vec<String>,
    message: String,
) -> Result<GitCmdResult, String> {
    // Stage.
    if paths.is_empty() {
        let add = run_git(&cwd, &["add", "-A"])?;
        if !add.ok {
            return Ok(add);
        }
    } else {
        let mut args = vec!["add", "--"];
        for p in &paths {
            args.push(p.as_str());
        }
        let add = run_git(&cwd, &args)?;
        if !add.ok {
            return Ok(add);
        }
    }

    // Nothing staged → not an error, just report it.
    let diff = run_git(&cwd, &["diff", "--cached", "--quiet"])?;
    if diff.ok {
        return Ok(GitCmdResult {
            ok: true,
            stdout: "Nothing to commit — working tree already matches HEAD".into(),
            stderr: String::new(),
        });
    }

    run_git(&cwd, &["commit", "-m", &message])
}

/// Fetch the URL of the named remote (default "origin"), or None if unset.
#[tauri::command]
pub async fn git_get_remote(cwd: String, name: Option<String>) -> Result<Option<String>, String> {
    let remote = name.unwrap_or_else(|| "origin".to_string());
    let res = run_git(&cwd, &["remote", "get-url", &remote])?;
    if res.ok && !res.stdout.is_empty() {
        Ok(Some(res.stdout))
    } else {
        Ok(None)
    }
}

/// Set (or add) the named remote's URL.
#[tauri::command]
pub async fn git_set_remote(
    cwd: String,
    name: Option<String>,
    url: String,
) -> Result<GitCmdResult, String> {
    let remote = name.unwrap_or_else(|| "origin".to_string());
    // `set-url` fails if the remote doesn't exist yet → fall back to `add`.
    let set = run_git(&cwd, &["remote", "set-url", &remote, &url])?;
    if set.ok {
        return Ok(set);
    }
    run_git(&cwd, &["remote", "add", &remote, &url])
}

/// Push the current branch to the remote, setting upstream. Relies on the
/// user's ambient git credentials — this is the step that can fail for auth
/// reasons, which we surface verbatim from stderr.
#[tauri::command]
pub async fn git_push(cwd: String, name: Option<String>) -> Result<GitCmdResult, String> {
    let remote = name.unwrap_or_else(|| "origin".to_string());
    // Determine the current branch name (empty repo → default to "main").
    let branch = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch_name = if branch.ok && !branch.stdout.is_empty() && branch.stdout != "HEAD" {
        branch.stdout
    } else {
        "main".to_string()
    };
    run_git(&cwd, &["push", "-u", &remote, &branch_name])
}

/// Current branch name, or None in an empty repo / detached HEAD.
#[tauri::command]
pub async fn git_current_branch(cwd: String) -> Result<Option<String>, String> {
    let res = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if res.ok && !res.stdout.is_empty() && res.stdout != "HEAD" {
        Ok(Some(res.stdout))
    } else {
        Ok(None)
    }
}

/// Whether a path looks like a git repo — thin wrapper over discover for the
/// write-flow UI (mirrors git_is_repo but takes an explicit dir path).
#[allow(dead_code)]
fn is_repo(path: &str) -> bool {
    Repository::discover(Path::new(path)).is_ok()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitFileStatus {
    /// Repo-root-relative path, forward-slashed.
    pub path: String,
    /// One of: "modified" | "added" | "deleted" | "untracked" | "renamed".
    pub status: String,
}

#[tauri::command]
pub async fn git_get_status(repo_path: String) -> Result<Vec<GitFileStatus>, String> {
    let repo =
        Repository::discover(&repo_path).map_err(|e| format!("Not a git repository: {}", e))?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to get git status: {}", e))?;

    let mut results = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let Some(path) = entry.path() else {
            continue;
        };
        let flags = entry.status();

        let status = classify(flags);
        results.push(GitFileStatus {
            path: path.to_string(),
            status: status.to_string(),
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn git_get_diff(repo_path: String, file_path: String) -> Result<String, String> {
    let repo =
        Repository::discover(&repo_path).map_err(|e| format!("Not a git repository: {}", e))?;

    // Limit the diff to the requested file to keep payloads small.
    let mut opts = DiffOptions::new();
    opts.pathspec(&file_path).context_lines(3);

    let tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    let diff = repo
        .diff_tree_to_workdir_with_index(tree.as_ref(), Some(&mut opts))
        .map_err(|e| format!("Failed to create diff: {}", e))?;

    let mut diff_text = String::new();
    diff.print(git2::DiffFormat::Patch, |_, _, line| {
        match line.origin() {
            '+' | '-' | ' ' => diff_text.push(line.origin()),
            _ => {}
        }
        diff_text.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|e| format!("Failed to format diff: {}", e))?;

    Ok(diff_text)
}

#[tauri::command]
pub async fn git_is_repo(path: String) -> Result<bool, String> {
    Ok(Repository::discover(path).is_ok())
}

fn classify(flags: Status) -> &'static str {
    if flags.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
        "renamed"
    } else if flags.intersects(Status::WT_DELETED | Status::INDEX_DELETED) {
        "deleted"
    } else if flags.intersects(Status::INDEX_NEW) {
        "added"
    } else if flags.intersects(Status::WT_NEW) {
        "untracked"
    } else {
        "modified"
    }
}

// ── Zed Mode Phase 3: editor Git awareness ─────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitLineChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLineChange {
    /// One-based line number in the current Monaco buffer.
    pub line_number: u32,
    pub kind: GitLineChangeKind,
    /// Non-zero only for a deletion marker anchored to a surviving line.
    pub deleted_lines: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChanges {
    pub repo_root: String,
    pub relative_path: String,
    pub binary: bool,
    pub changes: Vec<GitLineChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLineBlame {
    pub line_number: u32,
    pub commit: Option<String>,
    pub author: String,
    pub author_email: Option<String>,
    /// Unix seconds from the commit author's signature.
    pub timestamp: Option<i64>,
    pub summary: Option<String>,
    pub uncommitted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositorySummary {
    pub repo_root: String,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub dirty: bool,
    pub changed_files: usize,
    pub staged_files: usize,
    pub unstaged_files: usize,
    pub untracked_files: usize,
}

fn discovery_start(path: &Path) -> &Path {
    if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    }
}

/// Discover the nearest non-bare worktree from a directory or file path.
///
/// A path outside Git is a normal editor state and returns `Ok(None)`. Other
/// libgit2 failures are surfaced because silently converting permissions or
/// repository corruption into "not a repo" would make Phase 3 misleading.
fn discover_worktree(path: &str) -> Result<Option<(Repository, PathBuf)>, String> {
    if path.trim().is_empty() {
        return Ok(None);
    }
    let raw = PathBuf::from(path);
    let repo = match Repository::discover(discovery_start(&raw)) {
        Ok(repo) => repo,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to discover Git repository: {error}")),
    };
    let Some(workdir) = repo.workdir() else {
        return Ok(None);
    };
    let workdir = fs::canonicalize(workdir)
        .map_err(|error| format!("Failed to resolve Git worktree: {error}"))?;
    Ok(Some((repo, workdir)))
}

fn repo_relative_file(file_path: &str, workdir: &Path) -> Result<PathBuf, String> {
    let resolved = fs::canonicalize(file_path)
        .map_err(|error| format!("Failed to resolve editor file {file_path:?}: {error}"))?;
    resolved
        .strip_prefix(workdir)
        .map(Path::to_path_buf)
        .map_err(|_| {
            format!(
                "Editor file {:?} is outside Git worktree {:?}",
                resolved, workdir
            )
        })
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn head_file_contents(
    repo: &Repository,
    relative_path: &Path,
) -> Result<Option<(Vec<u8>, bool)>, String> {
    let tree = match repo.head().and_then(|head| head.peel_to_tree()) {
        Ok(tree) => tree,
        Err(error) if matches!(error.code(), ErrorCode::NotFound | ErrorCode::UnbornBranch) => {
            return Ok(None);
        }
        Err(error) => return Err(format!("Failed to read Git HEAD: {error}")),
    };
    let entry = match tree.get_path(relative_path) {
        Ok(entry) => entry,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to read {:?} from Git HEAD: {error}",
                relative_path
            ))
        }
    };
    let blob = repo
        .find_blob(entry.id())
        .map_err(|error| format!("Git HEAD entry is not a readable blob: {error}"))?;
    Ok(Some((blob.content().to_vec(), blob.is_binary())))
}

fn deletion_anchor(new_index: usize, current_line_count: usize) -> u32 {
    (new_index + 1).clamp(1, current_line_count.max(1)) as u32
}

fn structured_line_changes(base: &str, current: &str) -> Vec<GitLineChange> {
    // Monaco and Git may choose different EOL sequences for the same logical
    // text. Gutter semantics are line-based, so EOL-only differences must not
    // paint every line as modified.
    let base = base.replace("\r\n", "\n").replace('\r', "\n");
    let current = current.replace("\r\n", "\n").replace('\r', "\n");
    let diff = TextDiff::from_lines(&base, &current);
    let current_line_count = current.split('\n').count().max(1);
    let mut changes = Vec::new();

    for op in diff.ops() {
        let old = op.old_range();
        let new = op.new_range();
        match op.tag() {
            DiffTag::Equal => {}
            DiffTag::Insert => {
                changes.extend(new.map(|index| GitLineChange {
                    line_number: (index + 1) as u32,
                    kind: GitLineChangeKind::Added,
                    deleted_lines: 0,
                }));
            }
            DiffTag::Delete => {
                changes.push(GitLineChange {
                    line_number: deletion_anchor(new.start, current_line_count),
                    kind: GitLineChangeKind::Deleted,
                    deleted_lines: old.len() as u32,
                });
            }
            DiffTag::Replace => {
                let shared = old.len().min(new.len());
                changes.extend((new.start..new.start + shared).map(|index| GitLineChange {
                    line_number: (index + 1) as u32,
                    kind: GitLineChangeKind::Modified,
                    deleted_lines: 0,
                }));
                changes.extend((new.start + shared..new.end).map(|index| GitLineChange {
                    line_number: (index + 1) as u32,
                    kind: GitLineChangeKind::Added,
                    deleted_lines: 0,
                }));
                if old.len() > shared {
                    changes.push(GitLineChange {
                        line_number: deletion_anchor(new.end, current_line_count),
                        kind: GitLineChangeKind::Deleted,
                        deleted_lines: (old.len() - shared) as u32,
                    });
                }
            }
        }
    }

    changes
}

fn git_file_changes_impl(
    file_path: &str,
    contents: &str,
) -> Result<Option<GitFileChanges>, String> {
    let Some((repo, workdir)) = discover_worktree(file_path)? else {
        return Ok(None);
    };
    let relative_path = repo_relative_file(file_path, &workdir)?;
    let base = head_file_contents(&repo, &relative_path)?;
    let binary = base.as_ref().is_some_and(|(_, binary)| *binary);
    let changes = if binary {
        Vec::new()
    } else {
        let base_text = base
            .as_ref()
            .map(|(bytes, _)| String::from_utf8_lossy(bytes))
            .unwrap_or_default();
        structured_line_changes(&base_text, contents)
    };

    Ok(Some(GitFileChanges {
        repo_root: display_path(&workdir),
        relative_path: display_path(&relative_path),
        binary,
        changes,
    }))
}

/// Structured line changes between `HEAD` and the current in-memory editor
/// contents. This intentionally includes unsaved Monaco edits.
#[tauri::command]
pub async fn git_get_file_changes(
    file_path: String,
    contents: String,
) -> Result<Option<GitFileChanges>, String> {
    git_file_changes_impl(&file_path, &contents)
}

fn uncommitted_blame(line_number: u32) -> GitLineBlame {
    GitLineBlame {
        line_number,
        commit: None,
        author: "You".to_string(),
        author_email: None,
        timestamp: None,
        summary: None,
        uncommitted: true,
    }
}

fn git_line_blame_impl(
    file_path: &str,
    contents: &str,
    line_number: u32,
) -> Result<Option<GitLineBlame>, String> {
    if line_number == 0 {
        return Err("Git blame line number must be one or greater".to_string());
    }
    let current_line_count = contents.split('\n').count().max(1);
    if line_number as usize > current_line_count {
        return Ok(None);
    }
    let Some((repo, workdir)) = discover_worktree(file_path)? else {
        return Ok(None);
    };
    let relative_path = repo_relative_file(file_path, &workdir)?;
    match repo.head() {
        Ok(_) => {}
        Err(error) if matches!(error.code(), ErrorCode::NotFound | ErrorCode::UnbornBranch) => {
            return Ok(Some(uncommitted_blame(line_number)));
        }
        Err(error) => return Err(format!("Failed to read Git HEAD for blame: {error}")),
    }
    let base_blame = match repo.blame_file(&relative_path, None) {
        Ok(blame) => blame,
        Err(error) if matches!(error.code(), ErrorCode::NotFound | ErrorCode::UnbornBranch) => {
            return Ok(Some(uncommitted_blame(line_number)));
        }
        Err(error) => return Err(format!("Failed to blame Git file: {error}")),
    };
    let blame = base_blame
        .blame_buffer(contents.as_bytes())
        .map_err(|error| format!("Failed to blame current editor buffer: {error}"))?;
    let Some(hunk) = blame.get_line(line_number as usize) else {
        return Ok(None);
    };
    let commit_id = hunk.final_commit_id();
    if commit_id.is_zero() {
        return Ok(Some(uncommitted_blame(line_number)));
    }

    let signature = hunk.final_signature();
    let commit = repo.find_commit(commit_id).ok();
    Ok(Some(GitLineBlame {
        line_number,
        commit: Some(commit_id.to_string()),
        author: signature.name().unwrap_or("Unknown").to_string(),
        author_email: signature.email().map(str::to_string),
        timestamp: Some(signature.when().seconds()),
        summary: commit
            .as_ref()
            .and_then(|commit| commit.summary())
            .map(str::to_string),
        uncommitted: false,
    }))
}

/// Blame one current-buffer line. `blame_buffer` keeps unsaved line numbering
/// honest and identifies edited lines with libgit2's zero OID.
#[tauri::command]
pub async fn git_get_line_blame(
    file_path: String,
    contents: String,
    line_number: u32,
) -> Result<Option<GitLineBlame>, String> {
    git_line_blame_impl(&file_path, &contents, line_number)
}

fn symbolic_head_branch(repo: &Repository) -> Option<String> {
    repo.find_reference("HEAD")
        .ok()
        .and_then(|reference| reference.symbolic_target().map(str::to_string))
        .and_then(|target| target.strip_prefix("refs/heads/").map(str::to_string))
}

fn repository_summary_impl(path: &str) -> Result<Option<GitRepositorySummary>, String> {
    let Some((repo, workdir)) = discover_worktree(path)? else {
        return Ok(None);
    };
    let head = repo.head().ok();
    let branch = head
        .as_ref()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().map(str::to_string))
        .or_else(|| symbolic_head_branch(&repo));
    let head_oid = head
        .as_ref()
        .and_then(|head| head.target())
        .map(|oid| oid.to_string());

    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|error| format!("Failed to summarize Git status: {error}"))?;

    let mut changed_files = 0;
    let mut staged_files = 0;
    let mut unstaged_files = 0;
    let mut untracked_files = 0;
    for entry in statuses.iter() {
        let flags = entry.status();
        if flags.is_empty() {
            continue;
        }
        changed_files += 1;
        if flags.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) {
            staged_files += 1;
        }
        if flags.intersects(
            Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_RENAMED | Status::WT_TYPECHANGE,
        ) {
            unstaged_files += 1;
        }
        if flags.contains(Status::WT_NEW) {
            untracked_files += 1;
        }
    }

    Ok(Some(GitRepositorySummary {
        repo_root: display_path(&workdir),
        branch,
        head_oid,
        dirty: changed_files > 0,
        changed_files,
        staged_files,
        unstaged_files,
        untracked_files,
    }))
}

/// Lightweight branch/dirty summary for an attached workspace or a detached
/// editor file path.
#[tauri::command]
pub async fn git_get_repository_summary(
    path: String,
) -> Result<Option<GitRepositorySummary>, String> {
    repository_summary_impl(&path)
}

// ── Zed Mode Phase 6: repository service commands ──────────────────────────

#[tauri::command]
pub fn git_discover_repositories(
    workspace_path: String,
    additional_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<GitRepositoryDescriptor>, String> {
    state
        .git_repository_service
        .discover(&workspace_path, &additional_paths)
}

#[tauri::command]
pub fn git_get_repository_state(
    repo_path: String,
    state: State<'_, AppState>,
) -> Result<GitRepositoryState, String> {
    state.git_repository_service.state(&repo_path)
}

#[tauri::command]
pub fn git_watch_repositories(
    roots: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.git_repository_service.watch_repositories(&roots, app)
}

#[tauri::command]
pub async fn git_stage_paths(
    repo_path: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    state
        .git_repository_service
        .stage_paths(&repo_path, &paths)
        .await
}

#[tauri::command]
pub async fn git_unstage_paths(
    repo_path: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    state
        .git_repository_service
        .unstage_paths(&repo_path, &paths)
        .await
}

#[tauri::command]
pub async fn git_repository_commit(
    repo_path: String,
    message: String,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    state
        .git_repository_service
        .commit(&repo_path, &message)
        .await
}

#[tauri::command]
pub async fn git_initialize_repository(
    workspace_path: String,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    state
        .git_repository_service
        .initialize(&workspace_path)
        .await
}

#[tauri::command]
pub async fn git_clone_repository(
    url: String,
    target: String,
    into_existing: bool,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    let token = state.github_auth_manager.token_for_git()?;
    state
        .git_repository_service
        .clone_repository(&url, &target, into_existing, token.as_deref())
        .await
}

#[tauri::command]
pub fn git_list_branches(
    repo_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<GitBranch>, String> {
    state.git_repository_service.branches(&repo_path)
}

#[tauri::command]
pub async fn git_switch_branch(
    repo_path: String,
    branch: GitBranch,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    let repository = state.git_repository_service.state(&repo_path)?;
    let editor_dirty = state
        .editor_buffer_manager
        .has_dirty_within(Path::new(&repository.repository.root));
    state
        .git_repository_service
        .switch_branch(&repo_path, &branch, editor_dirty)
        .await
}

#[tauri::command]
pub async fn git_repository_fetch(
    repo_path: String,
    remote: Option<String>,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    let token = state.github_auth_manager.token_for_git()?;
    state
        .git_repository_service
        .fetch(&repo_path, remote.as_deref(), token.as_deref())
        .await
}

#[tauri::command]
pub async fn git_repository_pull(
    repo_path: String,
    remote: Option<String>,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    let repository = state.git_repository_service.state(&repo_path)?;
    let editor_dirty = state
        .editor_buffer_manager
        .has_dirty_within(Path::new(&repository.repository.root));
    let token = state.github_auth_manager.token_for_git()?;
    state
        .git_repository_service
        .pull(
            &repo_path,
            remote.as_deref(),
            editor_dirty,
            token.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn git_repository_push(
    repo_path: String,
    remote: Option<String>,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    let token = state.github_auth_manager.token_for_git()?;
    state
        .git_repository_service
        .push(&repo_path, remote.as_deref(), token.as_deref())
        .await
}

#[tauri::command]
pub async fn git_add_remote(
    repo_path: String,
    name: String,
    url: String,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    state
        .git_repository_service
        .add_remote(&repo_path, &name, &url)
        .await
}

#[tauri::command]
pub async fn git_update_remote(
    repo_path: String,
    name: String,
    url: String,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    state
        .git_repository_service
        .set_remote(&repo_path, &name, &url)
        .await
}

#[tauri::command]
pub async fn git_remove_remote(
    repo_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<GitOperationResult, String> {
    state
        .git_repository_service
        .remove_remote(&repo_path, &name)
        .await
}

#[tauri::command]
pub fn git_repository_history(
    repo_path: String,
    file_path: Option<String>,
    skip: usize,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Vec<GitCommitSummary>, String> {
    state
        .git_repository_service
        .history(&repo_path, file_path.as_deref(), skip, limit)
}

#[tauri::command]
pub fn git_commit_detail(
    repo_path: String,
    sha: String,
    state: State<'_, AppState>,
) -> Result<GitCommitDetail, String> {
    state.git_repository_service.commit_detail(&repo_path, &sha)
}

#[tauri::command]
pub fn git_staged_diff(
    repo_path: String,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<GitDiffPayload, String> {
    state
        .git_repository_service
        .staged_diff(&repo_path, &file_path)
}

#[tauri::command]
pub fn git_unstaged_diff(
    repo_path: String,
    file_path: String,
    buffer_contents: Option<String>,
    state: State<'_, AppState>,
) -> Result<GitDiffPayload, String> {
    state
        .git_repository_service
        .unstaged_diff(&repo_path, &file_path, buffer_contents)
}

#[tauri::command]
pub fn git_historical_diff(
    repo_path: String,
    sha: String,
    file_path: String,
    previous_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<GitDiffPayload, String> {
    state.git_repository_service.historical_diff(
        &repo_path,
        &sha,
        &file_path,
        previous_path.as_deref(),
    )
}

// ── Zed Mode Phase 6: GitHub OAuth/account commands ─────────────────────────

#[tauri::command]
pub async fn github_auth_start(
    session_only: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitHubDeviceAuthorization, String> {
    let authorization = state
        .github_auth_manager
        .start_device_flow(session_only)
        .await?;
    if let Err(error) = app
        .opener()
        .open_url(authorization.verification_uri.clone(), None::<&str>)
    {
        state
            .github_auth_manager
            .cancel_device_flow(&authorization.authorization_id)
            .await;
        return Err(format!("Could not open GitHub verification page: {error}"));
    }
    Ok(authorization)
}

#[tauri::command]
pub async fn github_auth_poll(
    authorization_id: String,
    state: State<'_, AppState>,
) -> Result<GitHubAuthPollResult, String> {
    state
        .github_auth_manager
        .poll_device_flow(&authorization_id)
        .await
}

#[tauri::command]
pub async fn github_auth_cancel(
    authorization_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .github_auth_manager
        .cancel_device_flow(&authorization_id)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn github_account_status(
    state: State<'_, AppState>,
) -> Result<Option<GitHubAccount>, String> {
    state.github_auth_manager.account_status().await
}

#[tauri::command]
pub fn github_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    state.github_auth_manager.disconnect()
}

#[tauri::command]
pub async fn github_list_repositories(
    page: u32,
    query: Option<String>,
    state: State<'_, AppState>,
) -> Result<GitHubRepositoryPage, String> {
    state
        .github_auth_manager
        .list_repositories(page, query.as_deref())
        .await
}

#[cfg(test)]
mod phase3_git_awareness_tests {
    use super::*;
    use git2::{RepositoryInitOptions, Signature};
    use tempfile::TempDir;

    fn repository() -> (TempDir, Repository) {
        let temp = TempDir::new().expect("temp repo");
        let mut options = RepositoryInitOptions::new();
        options.initial_head("main");
        let repo = Repository::init_opts(temp.path(), &options).expect("init repo");
        (temp, repo)
    }

    fn commit_file(repo: &Repository, root: &Path, path: &str, contents: &str) {
        fs::write(root.join(path), contents).expect("write fixture");
        let mut index = repo.index().expect("index");
        index.add_path(Path::new(path)).expect("stage fixture");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let signature = Signature::now("Alice Example", "alice@example.com").expect("signature");
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "initial fixture",
            &tree,
            &[],
        )
        .expect("commit fixture");
    }

    #[test]
    fn non_repository_paths_return_none() {
        let temp = TempDir::new().expect("temp");
        let file = temp.path().join("plain.txt");
        fs::write(&file, "plain\n").expect("write");
        assert_eq!(
            git_file_changes_impl(file.to_str().unwrap(), "plain\n").unwrap(),
            None
        );
        assert_eq!(
            repository_summary_impl(temp.path().to_str().unwrap()).unwrap(),
            None
        );
    }

    #[test]
    fn maps_clean_modified_added_and_deleted_current_lines() {
        let (temp, repo) = repository();
        commit_file(&repo, temp.path(), "file.txt", "one\ntwo\nthree\n");
        let file = temp.path().join("file.txt");

        let clean = git_file_changes_impl(file.to_str().unwrap(), "one\ntwo\nthree\n")
            .unwrap()
            .unwrap();
        assert!(clean.changes.is_empty());

        let changed = git_file_changes_impl(file.to_str().unwrap(), "one\nTWO\nthree\nfour\n")
            .unwrap()
            .unwrap();
        assert!(changed.changes.contains(&GitLineChange {
            line_number: 2,
            kind: GitLineChangeKind::Modified,
            deleted_lines: 0,
        }));
        assert!(changed.changes.contains(&GitLineChange {
            line_number: 4,
            kind: GitLineChangeKind::Added,
            deleted_lines: 0,
        }));

        let deleted = git_file_changes_impl(file.to_str().unwrap(), "one\nthree\n")
            .unwrap()
            .unwrap();
        assert!(deleted.changes.contains(&GitLineChange {
            line_number: 2,
            kind: GitLineChangeKind::Deleted,
            deleted_lines: 1,
        }));
    }

    #[test]
    fn ignores_line_ending_only_differences() {
        let (temp, repo) = repository();
        commit_file(&repo, temp.path(), "file.txt", "one\r\ntwo\r\n");
        let file = temp.path().join("file.txt");
        let changes = git_file_changes_impl(file.to_str().unwrap(), "one\ntwo\n")
            .unwrap()
            .unwrap();
        assert!(changes.changes.is_empty());
    }

    #[test]
    fn treats_every_untracked_buffer_line_as_added() {
        let (temp, _repo) = repository();
        let file = temp.path().join("new.txt");
        fs::write(&file, "first\nsecond\n").expect("write untracked");
        let changes = git_file_changes_impl(file.to_str().unwrap(), "first\nsecond\n")
            .unwrap()
            .unwrap();
        assert_eq!(
            changes
                .changes
                .iter()
                .filter(|change| change.kind == GitLineChangeKind::Added)
                .map(|change| change.line_number)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn blame_distinguishes_committed_and_in_memory_lines() {
        let (temp, repo) = repository();
        commit_file(&repo, temp.path(), "file.txt", "one\ntwo\nthree\n");
        let file = temp.path().join("file.txt");

        let committed = git_line_blame_impl(file.to_str().unwrap(), "one\ntwo\nthree\n", 2)
            .unwrap()
            .unwrap();
        assert!(!committed.uncommitted);
        assert_eq!(committed.author, "Alice Example");
        assert_eq!(committed.summary.as_deref(), Some("initial fixture"));
        assert!(committed.commit.is_some());
        assert!(committed.timestamp.is_some());

        let edited = git_line_blame_impl(file.to_str().unwrap(), "one\nTWO\nthree\n", 2)
            .unwrap()
            .unwrap();
        assert!(edited.uncommitted);
        assert_eq!(edited.author, "You");
        assert_eq!(edited.commit, None);
    }

    #[test]
    fn untracked_blame_is_honestly_uncommitted() {
        let (temp, repo) = repository();
        commit_file(&repo, temp.path(), "tracked.txt", "tracked\n");
        let file = temp.path().join("new.txt");
        fs::write(&file, "new\n").expect("write untracked");
        let blame = git_line_blame_impl(file.to_str().unwrap(), "new\n", 1)
            .unwrap()
            .unwrap();
        assert!(blame.uncommitted);
        assert_eq!(blame.author, "You");
    }

    #[test]
    fn unborn_repository_blame_is_honestly_uncommitted() {
        let (temp, _repo) = repository();
        let file = temp.path().join("new.txt");
        fs::write(&file, "new\n").expect("write untracked");
        let blame = git_line_blame_impl(file.to_str().unwrap(), "new\n", 1)
            .unwrap()
            .unwrap();
        assert!(blame.uncommitted);
        assert_eq!(blame.author, "You");
    }

    #[test]
    fn repository_summary_counts_each_status_class() {
        let (temp, repo) = repository();
        commit_file(&repo, temp.path(), "tracked.txt", "base\n");

        fs::write(temp.path().join("tracked.txt"), "changed\n").expect("modify tracked");
        fs::write(temp.path().join("staged.txt"), "staged\n").expect("write staged");
        let mut index = repo.index().expect("index");
        index
            .add_path(Path::new("staged.txt"))
            .expect("stage new file");
        index.write().expect("write index");
        fs::write(temp.path().join("untracked.txt"), "untracked\n").expect("write untracked");

        let summary = repository_summary_impl(temp.path().to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(summary.branch.as_deref(), Some("main"));
        assert!(summary.dirty);
        assert_eq!(summary.changed_files, 3);
        assert_eq!(summary.staged_files, 1);
        assert_eq!(summary.unstaged_files, 1);
        assert_eq!(summary.untracked_files, 1);

        let from_file = repository_summary_impl(temp.path().join("tracked.txt").to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(from_file.repo_root, summary.repo_root);
        assert_eq!(from_file.branch, summary.branch);
    }
}

// ── GitHub Actions runs (read-only) ────────────────────────────────────────
// The IaC Studio "Runs" panel lists recent workflow runs for the repo's remote.
// Its credential is resolved by GitHubAuthManager and never crosses Tauri IPC.

/// One workflow run row shown in the IaC Studio Runs panel.
#[derive(Debug, Serialize)]
pub struct GhWorkflowRun {
    pub id: u64,
    pub name: String,
    /// "queued" | "in_progress" | "completed"
    pub status: String,
    /// "success" | "failure" | "cancelled" | null (when not completed yet)
    pub conclusion: Option<String>,
    pub branch: String,
    pub event: String,
    /// Head commit message (first line).
    pub title: String,
    /// ISO-8601 timestamp of the run's creation.
    pub created_at: String,
    /// Browser URL for the run (opened when the user clicks a row).
    pub html_url: String,
}

/// Parse `owner/repo` from a git remote URL (SSH or HTTPS form). Returns
/// (owner, repo) with any trailing `.git` stripped.
fn parse_owner_repo(remote: &str) -> Option<(String, String)> {
    // SSH: git@github.com:owner/repo.git   HTTPS: https://github.com/owner/repo(.git)
    let tail = {
        let idx = remote.find("github.com")?;
        let after = &remote[idx + "github.com".len()..];
        after.trim_start_matches([':', '/']) // strip ':' (ssh) or '/' (https)
    };
    let tail = tail.strip_suffix(".git").unwrap_or(tail);
    let mut parts = tail.splitn(2, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.trim_end_matches('/').to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

#[cfg(test)]
mod owner_repo_tests {
    use super::parse_owner_repo;

    #[test]
    fn parses_ssh_form() {
        assert_eq!(
            parse_owner_repo("git@github.com:sw4481/network-iac.git"),
            Some(("sw4481".into(), "network-iac".into()))
        );
    }

    #[test]
    fn parses_https_form_with_and_without_dotgit() {
        assert_eq!(
            parse_owner_repo("https://github.com/sw4481/network-iac.git"),
            Some(("sw4481".into(), "network-iac".into()))
        );
        assert_eq!(
            parse_owner_repo("https://github.com/sw4481/network-iac"),
            Some(("sw4481".into(), "network-iac".into()))
        );
    }

    #[test]
    fn rejects_non_github_or_malformed() {
        assert_eq!(parse_owner_repo("git@gitlab.com:x/y.git"), None);
        assert_eq!(parse_owner_repo("git@github.com:onlyowner"), None);
    }
}

/// List recent GitHub Actions workflow runs for the repo whose `origin` remote
/// lives in `cwd`. Returns up to `limit` runs (most recent first). Errors are
/// surfaced as human strings so the panel can show them (expired connection,
/// no remote, rate limit, etc.).
#[tauri::command]
pub async fn github_list_runs(
    cwd: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<GhWorkflowRun>, String> {
    let token = state
        .github_auth_manager
        .token_for_git()?
        .ok_or_else(|| "Connect GitHub in the Git panel first.".to_string())?;
    let remote = git_get_remote(cwd, None)
        .await?
        .ok_or_else(|| "No 'origin' remote on this workspace.".to_string())?;
    let (owner, repo) = parse_owner_repo(&remote).ok_or_else(|| {
        "Could not parse a GitHub owner/repo from the configured remote.".to_string()
    })?;

    let per_page = limit.unwrap_or(20).clamp(1, 100);
    let url =
        format!("https://api.github.com/repos/{owner}/{repo}/actions/runs?per_page={per_page}");

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "ccie-terminal")
        .send()
        .await
        .map_err(|e| format!("GitHub request failed: {e}"))?;

    let code = resp.status();
    if !code.is_success() {
        return Err(match code.as_u16() {
            401 => "GitHub rejected the saved connection (401). Reconnect GitHub.".into(),
            403 => "GitHub returned 403 (rate limit or insufficient scope).".into(),
            404 => format!("Repo {owner}/{repo} not found (or token lacks access)."),
            _ => format!("GitHub API error {code}"),
        });
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Bad JSON from GitHub: {e}"))?;

    let runs = json
        .get("workflow_runs")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Unexpected GitHub response shape".to_string())?;

    let out = runs
        .iter()
        .map(|r| GhWorkflowRun {
            id: r.get("id").and_then(|v| v.as_u64()).unwrap_or(0),
            name: r
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("workflow")
                .to_string(),
            status: r
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string(),
            conclusion: r
                .get("conclusion")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            branch: r
                .get("head_branch")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            event: r
                .get("event")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            title: r
                .get("head_commit")
                .and_then(|c| c.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .lines()
                .next()
                .unwrap_or("")
                .to_string(),
            created_at: r
                .get("created_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            html_url: r
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect();

    Ok(out)
}
