//! Tauri commands that expose limited, read-only Git repository info to the
//! editor UI (status badges, diff viewer, repo detection).
//!
//! Read paths use `git2` (libgit2). WRITE paths (init/commit/remote/push) shell
//! out to the system `git` binary on purpose: it transparently reuses the
//! user's existing credentials (gh CLI, credential helper, SSH agent), whereas
//! libgit2 credential callbacks are fragile and would re-implement auth badly.
//! Anyone doing IaC pipelines already has `git` installed.

use git2::{DiffOptions, Repository, Status, StatusOptions};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

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
    let repo = Repository::discover(&repo_path)
        .map_err(|e| format!("Not a git repository: {}", e))?;

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
    let repo = Repository::discover(&repo_path)
        .map_err(|e| format!("Not a git repository: {}", e))?;

    // Limit the diff to the requested file to keep payloads small.
    let mut opts = DiffOptions::new();
    opts.pathspec(&file_path).context_lines(3);

    let tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok());

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
    } else if flags.intersects(Status::WT_MODIFIED | Status::INDEX_MODIFIED) {
        "modified"
    } else {
        "modified"
    }
}

// ── GitHub Actions runs (read-only) ────────────────────────────────────────
// The IaC Studio "Runs" panel lists recent workflow runs for the repo's remote.
// Read-only: needs a PAT with `actions:read` (a fine-grained or classic token).

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
    let tail = if let Some(idx) = remote.find("github.com") {
        let after = &remote[idx + "github.com".len()..];
        after.trim_start_matches([':', '/']) // strip ':' (ssh) or '/' (https)
    } else {
        return None;
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
/// lives in `cwd`. `token` is a GitHub PAT with `actions:read`. Returns up to
/// `limit` runs (most recent first). Errors are surfaced as human strings so
/// the panel can show them (bad token, no remote, rate limit, etc.).
#[tauri::command]
pub async fn github_list_runs(
    cwd: String,
    token: String,
    limit: Option<u32>,
) -> Result<Vec<GhWorkflowRun>, String> {
    if token.trim().is_empty() {
        return Err("No GitHub token set. Add one in Settings → Git / CI.".into());
    }
    let remote = git_get_remote(cwd, None)
        .await?
        .ok_or_else(|| "No 'origin' remote on this workspace.".to_string())?;
    let (owner, repo) = parse_owner_repo(&remote)
        .ok_or_else(|| format!("Could not parse a GitHub owner/repo from remote: {remote}"))?;

    let per_page = limit.unwrap_or(20).clamp(1, 100);
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/actions/runs?per_page={per_page}"
    );

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token.trim()))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "ccie-terminal")
        .send()
        .await
        .map_err(|e| format!("GitHub request failed: {e}"))?;

    let code = resp.status();
    if !code.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(match code.as_u16() {
            401 => "GitHub rejected the token (401). Check it has 'actions:read'.".into(),
            403 => "GitHub returned 403 (rate limit or insufficient scope).".into(),
            404 => format!("Repo {owner}/{repo} not found (or token lacks access)."),
            _ => format!("GitHub API error {code}: {body}"),
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
