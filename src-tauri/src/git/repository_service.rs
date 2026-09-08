use dashmap::DashMap;
use git2::{BranchType, Delta, DiffFindOptions, ErrorCode, Oid, Repository, Status, StatusOptions};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;
use url::Url;
use uuid::Uuid;

const MAX_DISCOVERY_DEPTH: usize = 6;
const MAX_TEXT_DIFF_BYTES: usize = 2 * 1024 * 1024;
const GIT_EVENT_DEBOUNCE: Duration = Duration::from_millis(250);
const SKIPPED_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "node_modules",
    "vendor",
    "target",
    "dist",
    "build",
    "coverage",
    ".next",
    ".cache",
    "__pycache__",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub fetch_url: Option<String>,
    pub push_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryDescriptor {
    pub root: String,
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub remotes: Vec<GitRemote>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeEntry {
    pub path: String,
    pub previous_path: Option<String>,
    pub index_status: Option<String>,
    pub worktree_status: Option<String>,
    pub conflict: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryState {
    pub repository: GitRepositoryDescriptor,
    pub changes: Vec<GitChangeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub full_name: String,
    pub kind: String,
    pub current: bool,
    pub target: Option<String>,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
    pub author: String,
    pub author_email: Option<String>,
    pub timestamp: i64,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub previous_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub commit: GitCommitSummary,
    pub files: Vec<GitCommitFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffPayload {
    pub original_label: String,
    pub modified_label: String,
    pub original: Option<String>,
    pub modified: Option<String>,
    pub language: String,
    pub binary: bool,
    pub oversized: bool,
    pub original_size: usize,
    pub modified_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResult {
    pub ok: bool,
    pub message: String,
    pub stdout: String,
    pub stderr: String,
    pub repository: Option<GitRepositoryState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryChanged {
    pub root: String,
}

struct RepositoryWatch {
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
struct WatchDebouncer {
    generation: AtomicU64,
}

impl WatchDebouncer {
    fn observe(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_latest(&self, observed: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == observed
    }
}

#[derive(Default)]
pub struct GitRepositoryService {
    mutation_locks: DashMap<PathBuf, Arc<AsyncMutex<()>>>,
    watchers: Mutex<HashMap<PathBuf, RepositoryWatch>>,
}

impl GitRepositoryService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn discover(
        &self,
        workspace_path: &str,
        additional_paths: &[String],
    ) -> Result<Vec<GitRepositoryDescriptor>, String> {
        let workspace = canonical_discovery_start(workspace_path)?;
        let mut roots = HashSet::new();

        if let Some(root) = discover_root(&workspace)? {
            roots.insert(root);
        }
        scan_nested_repositories(&workspace, 0, &mut roots)?;

        for extra in additional_paths {
            let start = canonical_discovery_start(extra)?;
            let root = discover_root(&start)?.ok_or_else(|| {
                format!("{} is not inside a Git repository", display_path(&start))
            })?;
            roots.insert(root);
        }

        let mut descriptors = roots
            .into_iter()
            .map(|root| repository_descriptor(&root))
            .collect::<Result<Vec<_>, _>>()?;
        descriptors.sort_by(|left, right| left.root.cmp(&right.root));
        Ok(descriptors)
    }

    pub fn state(&self, repo_path: &str) -> Result<GitRepositoryState, String> {
        let root = canonical_repo_root(repo_path)?;
        repository_state(&root)
    }

    pub fn branches(&self, repo_path: &str) -> Result<Vec<GitBranch>, String> {
        let root = canonical_repo_root(repo_path)?;
        let repo = Repository::open(&root).map_err(git_open_error)?;
        let current = repo
            .head()
            .ok()
            .filter(|head| head.is_branch())
            .and_then(|head| head.shorthand().map(str::to_string));
        let mut branches = Vec::new();

        let iter = repo
            .branches(None)
            .map_err(|error| format!("Failed to list Git branches: {error}"))?;
        for item in iter {
            let (branch, branch_type) =
                item.map_err(|error| format!("Failed to read Git branch: {error}"))?;
            if branch.get().symbolic_target().is_some() {
                continue;
            }
            let Some(name) = branch
                .name()
                .map_err(|error| format!("Failed to read Git branch name: {error}"))?
            else {
                continue;
            };
            let kind = match branch_type {
                BranchType::Local => "local",
                BranchType::Remote => "remote",
            };
            let upstream = if branch_type == BranchType::Local {
                branch
                    .upstream()
                    .ok()
                    .and_then(|upstream| upstream.name().ok().flatten().map(str::to_string))
            } else {
                None
            };
            branches.push(GitBranch {
                name: name.to_string(),
                full_name: branch.get().name().unwrap_or(name).to_string(),
                kind: kind.to_string(),
                current: branch_type == BranchType::Local && current.as_deref() == Some(name),
                target: branch.get().target().map(|oid| oid.to_string()),
                upstream,
            });
        }
        branches.sort_by(|left, right| {
            right
                .current
                .cmp(&left.current)
                .then(left.kind.cmp(&right.kind))
                .then(left.name.cmp(&right.name))
        });
        Ok(branches)
    }

    pub fn history(
        &self,
        repo_path: &str,
        file_path: Option<&str>,
        skip: usize,
        limit: usize,
    ) -> Result<Vec<GitCommitSummary>, String> {
        let root = canonical_repo_root(repo_path)?;
        let limit = limit.clamp(1, 100);
        let mut args = vec![
            OsString::from("log"),
            OsString::from("--date-order"),
            OsString::from("--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%P%x1e"),
            OsString::from(format!("--skip={skip}")),
            OsString::from(format!("--max-count={limit}")),
        ];
        if let Some(file_path) = file_path {
            let relative = validate_relative_path(file_path)?;
            args.push(OsString::from("--follow"));
            args.push(OsString::from("--"));
            args.push(relative.into_os_string());
        }
        let output = run_git_output(&root, &args, None)?;
        if !output.status.success() {
            return Err(format_git_failure("load Git history", &output, None));
        }
        parse_history(&output.stdout)
    }

    pub fn commit_detail(&self, repo_path: &str, sha: &str) -> Result<GitCommitDetail, String> {
        let root = canonical_repo_root(repo_path)?;
        let repo = Repository::open(&root).map_err(git_open_error)?;
        let oid = parse_oid(sha)?;
        let commit = repo
            .find_commit(oid)
            .map_err(|error| format!("Commit {sha} was not found: {error}"))?;
        let commit_tree = commit
            .tree()
            .map_err(|error| format!("Failed to read commit tree: {error}"))?;
        let parent_tree = if commit.parent_count() > 0 {
            Some(
                commit
                    .parent(0)
                    .and_then(|parent| parent.tree())
                    .map_err(|error| format!("Failed to read parent tree: {error}"))?,
            )
        } else {
            None
        };
        let mut diff = repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
            .map_err(|error| format!("Failed to load commit diff: {error}"))?;
        let mut find = DiffFindOptions::new();
        find.renames(true);
        diff.find_similar(Some(&mut find))
            .map_err(|error| format!("Failed to detect commit renames: {error}"))?;
        let mut files = diff
            .deltas()
            .filter_map(|delta| {
                let path = delta
                    .new_file()
                    .path()
                    .or_else(|| delta.old_file().path())?;
                let previous_path = if delta.status() == Delta::Renamed {
                    delta.old_file().path().map(display_path)
                } else {
                    None
                };
                Some(GitCommitFile {
                    path: display_path(path),
                    previous_path,
                    status: delta_name(delta.status()).to_string(),
                })
            })
            .collect::<Vec<_>>();
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(GitCommitDetail {
            commit: commit_summary(&commit),
            files,
        })
    }

    pub fn staged_diff(&self, repo_path: &str, file_path: &str) -> Result<GitDiffPayload, String> {
        let root = canonical_repo_root(repo_path)?;
        let relative = validate_relative_path(file_path)?;
        let repo = Repository::open(&root).map_err(git_open_error)?;
        let original = head_blob(&repo, &relative)?;
        let modified = index_blob(&repo, &relative)?;
        Ok(diff_payload(
            format!("HEAD: {}", display_path(&relative)),
            format!("Index: {}", display_path(&relative)),
            &relative,
            original,
            modified,
        ))
    }

    pub fn unstaged_diff(
        &self,
        repo_path: &str,
        file_path: &str,
        buffer_contents: Option<String>,
    ) -> Result<GitDiffPayload, String> {
        let root = canonical_repo_root(repo_path)?;
        let relative = validate_relative_path(file_path)?;
        let repo = Repository::open(&root).map_err(git_open_error)?;
        let original = index_blob(&repo, &relative)?;
        let modified = match buffer_contents {
            Some(contents) => Some(contents.into_bytes()),
            None => fs::read(root.join(&relative)).ok(),
        };
        Ok(diff_payload(
            format!("Index: {}", display_path(&relative)),
            format!("Working buffer: {}", display_path(&relative)),
            &relative,
            original,
            modified,
        ))
    }

    pub fn historical_diff(
        &self,
        repo_path: &str,
        sha: &str,
        file_path: &str,
        previous_path: Option<&str>,
    ) -> Result<GitDiffPayload, String> {
        let root = canonical_repo_root(repo_path)?;
        let relative = validate_relative_path(file_path)?;
        let previous = previous_path
            .map(validate_relative_path)
            .transpose()?
            .unwrap_or_else(|| relative.clone());
        let repo = Repository::open(&root).map_err(git_open_error)?;
        let oid = parse_oid(sha)?;
        let commit = repo
            .find_commit(oid)
            .map_err(|error| format!("Commit {sha} was not found: {error}"))?;
        let modified = tree_blob(&repo, &commit.tree().map_err(|e| e.to_string())?, &relative)?;
        let original = if commit.parent_count() > 0 {
            let parent = commit.parent(0).map_err(|error| error.to_string())?;
            tree_blob(
                &repo,
                &parent.tree().map_err(|error| error.to_string())?,
                &previous,
            )?
        } else {
            None
        };
        Ok(diff_payload(
            format!("{}^: {}", short_sha(sha), display_path(&previous)),
            format!("{}: {}", short_sha(sha), display_path(&relative)),
            &relative,
            original,
            modified,
        ))
    }

    pub async fn stage_paths(
        &self,
        repo_path: &str,
        paths: &[String],
    ) -> Result<GitOperationResult, String> {
        let root = canonical_repo_root(repo_path)?;
        let lock = self.mutation_lock(&root);
        let _guard = lock.lock().await;
        let mut args = vec![OsString::from("add"), OsString::from("--")];
        for path in paths {
            args.push(validate_relative_path(path)?.into_os_string());
        }
        if paths.is_empty() {
            args = vec![OsString::from("add"), OsString::from("--all")];
        }
        self.finish_operation(
            &root,
            "Staged changes",
            run_git_output(&root, &args, None)?,
            None,
        )
    }

    pub async fn unstage_paths(
        &self,
        repo_path: &str,
        paths: &[String],
    ) -> Result<GitOperationResult, String> {
        let root = canonical_repo_root(repo_path)?;
        let lock = self.mutation_lock(&root);
        let _guard = lock.lock().await;
        let has_head = Repository::open(&root).is_ok_and(|repo| repo.head().is_ok());
        let mut args = if has_head {
            vec![
                OsString::from("reset"),
                OsString::from("HEAD"),
                OsString::from("--"),
            ]
        } else {
            vec![
                OsString::from("rm"),
                OsString::from("-r"),
                OsString::from("--cached"),
                OsString::from("--ignore-unmatch"),
                OsString::from("--"),
            ]
        };
        if paths.is_empty() {
            args.push(OsString::from("."));
        } else {
            for path in paths {
                args.push(validate_relative_path(path)?.into_os_string());
            }
        }
        self.finish_operation(
            &root,
            "Unstaged changes",
            run_git_output(&root, &args, None)?,
            None,
        )
    }

    pub async fn commit(
        &self,
        repo_path: &str,
        message: &str,
    ) -> Result<GitOperationResult, String> {
        let message = message.trim();
        if message.is_empty() {
            return Err("Enter a commit message".to_string());
        }
        let root = canonical_repo_root(repo_path)?;
        let lock = self.mutation_lock(&root);
        let _guard = lock.lock().await;

        let cached = run_git_output(
            &root,
            &[
                OsString::from("diff"),
                OsString::from("--cached"),
                OsString::from("--quiet"),
            ],
            None,
        )?;
        match cached.status.code() {
            Some(0) => {
                let add =
                    run_git_output(&root, &[OsString::from("add"), OsString::from("-u")], None)?;
                if !add.status.success() {
                    return self.finish_operation(
                        &root,
                        "Could not stage tracked files",
                        add,
                        None,
                    );
                }
            }
            Some(1) => {}
            _ => return self.finish_operation(&root, "Could not inspect the index", cached, None),
        }

        let cached_after = run_git_output(
            &root,
            &[
                OsString::from("diff"),
                OsString::from("--cached"),
                OsString::from("--quiet"),
            ],
            None,
        )?;
        match cached_after.status.code() {
            Some(0) => {
                return Ok(GitOperationResult {
                    ok: false,
                    message: "Nothing staged. Untracked files are never staged automatically."
                        .into(),
                    stdout: String::new(),
                    stderr: String::new(),
                    repository: Some(repository_state(&root)?),
                });
            }
            Some(1) => {}
            _ => {
                return self.finish_operation(
                    &root,
                    "Could not inspect the staged changes",
                    cached_after,
                    None,
                )
            }
        }

        let output = run_git_output(
            &root,
            &[
                OsString::from("commit"),
                OsString::from("-m"),
                OsString::from(message),
            ],
            None,
        )?;
        self.finish_operation(&root, "Commit created", output, None)
    }

    pub async fn initialize(&self, workspace: &str) -> Result<GitOperationResult, String> {
        let root = canonical_existing_directory(workspace)?;
        let lock = self.mutation_lock(&root);
        let _guard = lock.lock().await;
        if Repository::discover(&root).is_ok() {
            return Ok(GitOperationResult {
                ok: true,
                message: "Already a Git repository".into(),
                stdout: String::new(),
                stderr: String::new(),
                repository: Some(repository_state(&canonical_repo_root(
                    root.to_string_lossy().as_ref(),
                )?)?),
            });
        }
        let output = run_git_output(&root, &[OsString::from("init")], None)?;
        self.finish_operation(&root, "Repository initialized", output, None)
    }

    pub async fn add_remote(
        &self,
        repo_path: &str,
        name: &str,
        url: &str,
    ) -> Result<GitOperationResult, String> {
        validate_remote_name(name)?;
        validate_remote_url(url)?;
        self.simple_mutation(repo_path, "Remote added", vec!["remote", "add", name, url])
            .await
    }

    pub async fn set_remote(
        &self,
        repo_path: &str,
        name: &str,
        url: &str,
    ) -> Result<GitOperationResult, String> {
        validate_remote_name(name)?;
        validate_remote_url(url)?;
        self.simple_mutation(
            repo_path,
            "Remote updated",
            vec!["remote", "set-url", name, url],
        )
        .await
    }

    pub async fn remove_remote(
        &self,
        repo_path: &str,
        name: &str,
    ) -> Result<GitOperationResult, String> {
        validate_remote_name(name)?;
        self.simple_mutation(repo_path, "Remote removed", vec!["remote", "remove", name])
            .await
    }

    pub async fn switch_branch(
        &self,
        repo_path: &str,
        branch: &GitBranch,
        editor_dirty: bool,
    ) -> Result<GitOperationResult, String> {
        validate_ref_name(&branch.name)?;
        let root = canonical_repo_root(repo_path)?;
        let lock = self.mutation_lock(&root);
        let _guard = lock.lock().await;
        guard_clean(&root, editor_dirty, "switch branches")?;
        let args = if branch.kind == "remote" {
            vec![
                OsString::from("switch"),
                OsString::from("--detach"),
                OsString::from(&branch.name),
            ]
        } else {
            vec![OsString::from("switch"), OsString::from(&branch.name)]
        };
        let output = run_git_output(&root, &args, None)?;
        self.finish_operation(&root, "Branch switched", output, None)
    }

    pub async fn fetch(
        &self,
        repo_path: &str,
        remote: Option<&str>,
        token: Option<&str>,
    ) -> Result<GitOperationResult, String> {
        let root = canonical_repo_root(repo_path)?;
        let selected = selected_remote(&root, remote)?;
        let lock = self.mutation_lock(&root);
        let _guard = lock.lock().await;
        let auth = github_https_auth(&root, Some(&selected), token)?;
        let output = run_git_output(
            &root,
            &[OsString::from("fetch"), OsString::from(&selected)],
            auth.as_ref(),
        )?;
        self.finish_operation(&root, "Fetch complete", output, token)
    }

    pub async fn pull(
        &self,
        repo_path: &str,
        remote: Option<&str>,
        editor_dirty: bool,
        token: Option<&str>,
    ) -> Result<GitOperationResult, String> {
        let root = canonical_repo_root(repo_path)?;
        let lock = self.mutation_lock(&root);
        let _guard = lock.lock().await;
        guard_clean(&root, editor_dirty, "pull")?;
        let selected = remote.map(str::to_string);
        let auth = github_https_auth(&root, selected.as_deref(), token)?;
        let mut args = vec![OsString::from("pull")];
        if let Some(remote) = selected {
            validate_remote_name(&remote)?;
            args.push(OsString::from(remote));
        }
        let output = run_git_output(&root, &args, auth.as_ref())?;
        self.finish_operation(&root, "Pull complete", output, token)
    }

    pub async fn push(
        &self,
        repo_path: &str,
        remote: Option<&str>,
        token: Option<&str>,
    ) -> Result<GitOperationResult, String> {
        let root = canonical_repo_root(repo_path)?;
        let descriptor = repository_descriptor(&root)?;
        let branch = descriptor
            .branch
            .clone()
            .ok_or_else(|| "Push requires a checked-out local branch".to_string())?;
        let selected = if remote.is_some() || descriptor.upstream.is_none() {
            Some(selected_remote(&root, remote)?)
        } else {
            None
        };
        let lock = self.mutation_lock(&root);
        let _guard = lock.lock().await;
        let auth = github_https_auth(&root, selected.as_deref(), token)?;
        let args = match (descriptor.upstream.is_some(), selected) {
            (true, None) => vec![OsString::from("push")],
            (has_upstream, Some(remote)) => {
                let mut args = vec![OsString::from("push")];
                if !has_upstream {
                    args.push(OsString::from("--set-upstream"));
                }
                args.push(OsString::from(remote));
                args.push(OsString::from(branch));
                args
            }
            (false, None) => unreachable!(),
        };
        let output = run_git_output(&root, &args, auth.as_ref())?;
        self.finish_operation(&root, "Push complete", output, token)
    }

    pub async fn clone_repository(
        &self,
        url: &str,
        target: &str,
        into_existing: bool,
        token: Option<&str>,
    ) -> Result<GitOperationResult, String> {
        validate_remote_url(url)?;
        let target_path = if into_existing {
            canonical_existing_directory(target)?
        } else {
            canonical_clone_target(target)?
        };
        let parent = if into_existing {
            target_path.clone()
        } else {
            target_path
                .parent()
                .ok_or_else(|| "Clone target has no parent directory".to_string())?
                .to_path_buf()
        };
        if into_existing
            && fs::read_dir(&target_path)
                .map_err(|e| e.to_string())?
                .next()
                .is_some()
        {
            return Err("Clone into the current workspace requires an empty directory".to_string());
        }
        let lock = self.mutation_lock(&target_path);
        let _guard = lock.lock().await;
        let auth = if is_github_https_url(url) {
            token.map(create_askpass).transpose()?
        } else {
            None
        };
        let destination = if into_existing {
            OsString::from(".")
        } else {
            target_path
                .file_name()
                .ok_or_else(|| "Clone target has no directory name".to_string())?
                .to_os_string()
        };
        let output = run_git_output(
            &parent,
            &[OsString::from("clone"), OsString::from(url), destination],
            auth.as_ref(),
        )?;
        let ok = output.status.success();
        let stdout = redact_output(&String::from_utf8_lossy(&output.stdout), token);
        let stderr = redact_output(&String::from_utf8_lossy(&output.stderr), token);
        let repository = if ok {
            Some(repository_state(&canonical_repo_root(
                target_path.to_string_lossy().as_ref(),
            )?)?)
        } else {
            None
        };
        Ok(GitOperationResult {
            ok,
            message: if ok {
                "Clone complete".to_string()
            } else {
                first_nonempty(&stderr, &stdout, "Clone failed")
            },
            stdout,
            stderr,
            repository,
        })
    }

    pub fn watch_repositories(&self, roots: &[String], app: AppHandle) -> Result<(), String> {
        // Registration is additive because multiple primary editor workspaces
        // can be open at once. Replacing the map here would silently disable
        // watchers installed by another workspace; all watchers are dropped
        // with the shared service at process shutdown.
        let mut watchers = self.watchers.lock();
        for root in roots {
            let root = canonical_repo_root(root)?;
            if watchers.contains_key(&root) {
                continue;
            }
            let event_root = display_path(&root);
            let debouncer = Arc::new(WatchDebouncer::default());
            let debouncer_for_callback = debouncer.clone();
            let app_for_callback = app.clone();
            let event_root_for_callback = event_root.clone();
            let mut watcher =
                notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                    if event.is_err() {
                        return;
                    }
                    let observed = debouncer_for_callback.observe();
                    let debouncer = debouncer_for_callback.clone();
                    let app = app_for_callback.clone();
                    let root = event_root_for_callback.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(GIT_EVENT_DEBOUNCE).await;
                        if debouncer.is_latest(observed) {
                            let _ =
                                app.emit("git-repository-changed", GitRepositoryChanged { root });
                        }
                    });
                })
                .map_err(|error| format!("Failed to create Git watcher: {error}"))?;
            watcher
                .watch(&root, RecursiveMode::Recursive)
                .map_err(|error| format!("Failed to watch {}: {error}", display_path(&root)))?;
            let repo = Repository::open(&root).map_err(git_open_error)?;
            let git_dir = repo.path().to_path_buf();
            if !git_dir.starts_with(&root) {
                watcher
                    .watch(&git_dir, RecursiveMode::Recursive)
                    .map_err(|error| {
                        format!(
                            "Failed to watch Git metadata {}: {error}",
                            display_path(&git_dir)
                        )
                    })?;
            }
            watchers.insert(root, RepositoryWatch { _watcher: watcher });
        }
        Ok(())
    }

    async fn simple_mutation(
        &self,
        repo_path: &str,
        success_message: &str,
        args: Vec<&str>,
    ) -> Result<GitOperationResult, String> {
        let root = canonical_repo_root(repo_path)?;
        let lock = self.mutation_lock(&root);
        let _guard = lock.lock().await;
        let args = args.into_iter().map(OsString::from).collect::<Vec<_>>();
        let output = run_git_output(&root, &args, None)?;
        self.finish_operation(&root, success_message, output, None)
    }

    fn mutation_lock(&self, root: &Path) -> Arc<AsyncMutex<()>> {
        self.mutation_locks
            .entry(root.to_path_buf())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    fn finish_operation(
        &self,
        root: &Path,
        success_message: &str,
        output: Output,
        secret: Option<&str>,
    ) -> Result<GitOperationResult, String> {
        let ok = output.status.success();
        let stdout = redact_output(&String::from_utf8_lossy(&output.stdout), secret);
        let stderr = redact_output(&String::from_utf8_lossy(&output.stderr), secret);
        Ok(GitOperationResult {
            ok,
            message: if ok {
                if stdout.trim().is_empty() {
                    success_message.to_string()
                } else {
                    stdout.lines().last().unwrap_or(success_message).to_string()
                }
            } else {
                first_nonempty(&stderr, &stdout, "Git operation failed")
            },
            stdout,
            stderr,
            repository: repository_state(root).ok(),
        })
    }
}

fn canonical_discovery_start(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("Choose a workspace folder first".to_string());
    }
    let path = PathBuf::from(path);
    let start = if path.is_file() {
        path.parent().unwrap_or(&path)
    } else {
        &path
    };
    fs::canonicalize(start).map_err(|error| {
        format!(
            "Failed to resolve workspace {}: {error}",
            display_path(start)
        )
    })
}

fn canonical_existing_directory(path: &str) -> Result<PathBuf, String> {
    let canonical = canonical_discovery_start(path)?;
    if !canonical.is_dir() {
        return Err(format!("{} is not a directory", display_path(&canonical)));
    }
    Ok(canonical)
}

fn canonical_clone_target(path: &str) -> Result<PathBuf, String> {
    let raw = PathBuf::from(path);
    if raw.as_os_str().is_empty() {
        return Err("Choose a clone destination".to_string());
    }
    if raw.exists() {
        return Err("Clone destination already exists".to_string());
    }
    let parent = raw
        .parent()
        .ok_or_else(|| "Clone destination has no parent directory".to_string())?;
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Failed to resolve clone destination parent: {error}"))?;
    let name = raw
        .file_name()
        .ok_or_else(|| "Clone destination has no directory name".to_string())?;
    Ok(parent.join(name))
}

fn discover_root(path: &Path) -> Result<Option<PathBuf>, String> {
    match Repository::discover(path) {
        Ok(repo) => repo
            .workdir()
            .map(fs::canonicalize)
            .transpose()
            .map_err(|error| format!("Failed to resolve Git worktree: {error}")),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to discover Git repository: {error}")),
    }
}

fn canonical_repo_root(path: &str) -> Result<PathBuf, String> {
    let start = canonical_discovery_start(path)?;
    discover_root(&start)?
        .ok_or_else(|| format!("{} is not a Git repository", display_path(&start)))
}

fn scan_nested_repositories(
    directory: &Path,
    depth: usize,
    roots: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    if depth > MAX_DISCOVERY_DEPTH {
        return Ok(());
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to scan workspace directory {}: {error}",
                display_path(directory)
            ))
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if SKIPPED_DIRECTORY_NAMES.contains(&name.as_ref()) {
            continue;
        }
        let child = entry.path();
        if child.join(".git").exists() {
            if let Ok(root) = fs::canonicalize(&child) {
                roots.insert(root);
            }
        }
        if depth < MAX_DISCOVERY_DEPTH {
            scan_nested_repositories(&child, depth + 1, roots)?;
        }
    }
    Ok(())
}

fn repository_descriptor(root: &Path) -> Result<GitRepositoryDescriptor, String> {
    let repo = Repository::open(root).map_err(git_open_error)?;
    let head = repo.head().ok();
    let branch = head
        .as_ref()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().map(str::to_string))
        .or_else(|| symbolic_head_branch(&repo));
    let head_oid = head.as_ref().and_then(|head| head.target());
    let upstream_branch = branch
        .as_ref()
        .and_then(|name| repo.find_branch(name, BranchType::Local).ok())
        .and_then(|branch| branch.upstream().ok());
    let upstream = upstream_branch
        .as_ref()
        .and_then(|branch| branch.name().ok().flatten().map(str::to_string));
    let (ahead, behind) = match (
        head_oid,
        upstream_branch
            .as_ref()
            .and_then(|branch| branch.get().target()),
    ) {
        (Some(local), Some(upstream)) => repo.graph_ahead_behind(local, upstream).unwrap_or((0, 0)),
        _ => (0, 0),
    };
    let mut remotes = Vec::new();
    let remote_names = repo
        .remotes()
        .map_err(|error| format!("Failed to list Git remotes: {error}"))?;
    for name in remote_names.iter().flatten() {
        let remote = repo.find_remote(name).ok();
        remotes.push(GitRemote {
            name: name.to_string(),
            fetch_url: remote
                .as_ref()
                .and_then(|remote| remote.url())
                .map(sanitize_remote_url),
            push_url: remote
                .as_ref()
                .and_then(|remote| remote.pushurl().or_else(|| remote.url()))
                .map(sanitize_remote_url),
        });
    }
    remotes.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(GitRepositoryDescriptor {
        root: display_path(root),
        name: root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Repository")
            .to_string(),
        branch,
        head: head_oid.map(|oid| oid.to_string()),
        upstream,
        ahead,
        behind,
        remotes,
    })
}

fn repository_state(root: &Path) -> Result<GitRepositoryState, String> {
    let repo = Repository::open(root).map_err(git_open_error)?;
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|error| format!("Failed to read Git status: {error}"))?;
    let mut changes = Vec::new();
    for entry in statuses.iter() {
        let status = entry.status();
        let path = entry
            .index_to_workdir()
            .and_then(|delta| delta.new_file().path().or_else(|| delta.old_file().path()))
            .or_else(|| {
                entry
                    .head_to_index()
                    .and_then(|delta| delta.new_file().path().or_else(|| delta.old_file().path()))
            })
            .or_else(|| entry.path().map(Path::new));
        let Some(path) = path else { continue };
        let previous_path = entry
            .head_to_index()
            .filter(|delta| delta.status() == Delta::Renamed)
            .and_then(|delta| delta.old_file().path())
            .or_else(|| {
                entry
                    .index_to_workdir()
                    .filter(|delta| delta.status() == Delta::Renamed)
                    .and_then(|delta| delta.old_file().path())
            })
            .map(display_path);
        let conflict = status.contains(Status::CONFLICTED);
        let index_status = index_status(status).map(str::to_string);
        let mut worktree_status = worktree_status(status).map(str::to_string);
        if conflict && index_status.is_none() && worktree_status.is_none() {
            // libgit2 exposes an unresolved conflict through CONFLICTED rather
            // than the ordinary worktree flags. Keep it in the Changes group
            // so a manually resolved file remains stageable from the panel.
            worktree_status = Some("modified".to_string());
        }
        changes.push(GitChangeEntry {
            path: display_path(path),
            previous_path,
            index_status,
            worktree_status,
            conflict,
        });
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(GitRepositoryState {
        repository: repository_descriptor(root)?,
        changes,
    })
}

fn symbolic_head_branch(repo: &Repository) -> Option<String> {
    repo.find_reference("HEAD")
        .ok()
        .and_then(|reference| reference.symbolic_target().map(str::to_string))
        .and_then(|target| target.strip_prefix("refs/heads/").map(str::to_string))
}

fn index_status(status: Status) -> Option<&'static str> {
    if status.contains(Status::INDEX_NEW) {
        Some("added")
    } else if status.contains(Status::INDEX_MODIFIED) {
        Some("modified")
    } else if status.contains(Status::INDEX_DELETED) {
        Some("deleted")
    } else if status.contains(Status::INDEX_RENAMED) {
        Some("renamed")
    } else if status.contains(Status::INDEX_TYPECHANGE) {
        Some("typechange")
    } else {
        None
    }
}

fn worktree_status(status: Status) -> Option<&'static str> {
    if status.contains(Status::WT_NEW) {
        Some("untracked")
    } else if status.contains(Status::WT_MODIFIED) {
        Some("modified")
    } else if status.contains(Status::WT_DELETED) {
        Some("deleted")
    } else if status.contains(Status::WT_RENAMED) {
        Some("renamed")
    } else if status.contains(Status::WT_TYPECHANGE) {
        Some("typechange")
    } else {
        None
    }
}

fn commit_summary(commit: &git2::Commit<'_>) -> GitCommitSummary {
    let sha = commit.id().to_string();
    GitCommitSummary {
        short_sha: short_sha(&sha),
        sha,
        message: commit
            .summary()
            .unwrap_or("(no commit message)")
            .to_string(),
        author: commit.author().name().unwrap_or("Unknown").to_string(),
        author_email: commit.author().email().map(str::to_string),
        timestamp: commit.time().seconds(),
        parents: commit.parent_ids().map(|oid| oid.to_string()).collect(),
    }
}

fn parse_history(bytes: &[u8]) -> Result<Vec<GitCommitSummary>, String> {
    let text = String::from_utf8_lossy(bytes);
    let mut commits = Vec::new();
    for record in text.split('\x1e') {
        let record = record.trim_matches(['\n', '\r']);
        if record.is_empty() {
            continue;
        }
        let fields = record.split('\x1f').collect::<Vec<_>>();
        if fields.len() != 7 {
            return Err("Git returned an unexpected history record".to_string());
        }
        commits.push(GitCommitSummary {
            sha: fields[0].to_string(),
            short_sha: fields[1].to_string(),
            author: fields[2].to_string(),
            author_email: (!fields[3].is_empty()).then(|| fields[3].to_string()),
            timestamp: fields[4]
                .parse()
                .map_err(|_| "Git returned an invalid commit timestamp".to_string())?,
            message: fields[5].to_string(),
            parents: fields[6].split_whitespace().map(str::to_string).collect(),
        });
    }
    Ok(commits)
}

fn tree_blob(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    path: &Path,
) -> Result<Option<Vec<u8>>, String> {
    let entry = match tree.get_path(path) {
        Ok(entry) => entry,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to read {}: {error}", display_path(path))),
    };
    let blob = repo
        .find_blob(entry.id())
        .map_err(|error| format!("{} is not a readable Git blob: {error}", display_path(path)))?;
    Ok(Some(blob.content().to_vec()))
}

fn head_blob(repo: &Repository, path: &Path) -> Result<Option<Vec<u8>>, String> {
    let tree = match repo.head().and_then(|head| head.peel_to_tree()) {
        Ok(tree) => tree,
        Err(error) if matches!(error.code(), ErrorCode::NotFound | ErrorCode::UnbornBranch) => {
            return Ok(None)
        }
        Err(error) => return Err(format!("Failed to read Git HEAD: {error}")),
    };
    tree_blob(repo, &tree, path)
}

fn index_blob(repo: &Repository, path: &Path) -> Result<Option<Vec<u8>>, String> {
    let index = repo
        .index()
        .map_err(|error| format!("Failed to read Git index: {error}"))?;
    let Some(entry) = index.get_path(path, 0) else {
        return Ok(None);
    };
    let blob = repo
        .find_blob(entry.id)
        .map_err(|error| format!("Index entry is not a readable blob: {error}"))?;
    Ok(Some(blob.content().to_vec()))
}

fn diff_payload(
    original_label: String,
    modified_label: String,
    path: &Path,
    original: Option<Vec<u8>>,
    modified: Option<Vec<u8>>,
) -> GitDiffPayload {
    let original_size = original.as_ref().map_or(0, Vec::len);
    let modified_size = modified.as_ref().map_or(0, Vec::len);
    let binary = original.as_ref().is_some_and(|bytes| looks_binary(bytes))
        || modified.as_ref().is_some_and(|bytes| looks_binary(bytes));
    let oversized = original_size > MAX_TEXT_DIFF_BYTES || modified_size > MAX_TEXT_DIFF_BYTES;
    let decode = |bytes: Option<Vec<u8>>| {
        if binary || oversized {
            None
        } else {
            Some(String::from_utf8_lossy(bytes.as_deref().unwrap_or_default()).into_owned())
        }
    };
    GitDiffPayload {
        original_label,
        modified_label,
        original: decode(original),
        modified: decode(modified),
        language: language_for_path(path),
        binary,
        oversized,
        original_size,
        modified_size,
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8_000).any(|byte| *byte == 0)
}

fn language_for_path(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "rs" => "rust",
        "ts" => "typescript",
        "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "py" => "python",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "md" => "markdown",
        "css" => "css",
        "html" => "html",
        "sh" | "zsh" | "bash" => "shell",
        "tf" | "hcl" => "hcl",
        "xml" => "xml",
        "sql" => "sql",
        _ => "plaintext",
    }
    .to_string()
}

fn guard_clean(root: &Path, editor_dirty: bool, operation: &str) -> Result<(), String> {
    if editor_dirty {
        return Err(format!(
            "Save or close dirty editor buffers in this repository before you {operation}"
        ));
    }
    if !repository_state(root)?.changes.is_empty() {
        return Err(format!(
            "Commit or clean repository changes before you {operation}"
        ));
    }
    Ok(())
}

fn selected_remote(root: &Path, requested: Option<&str>) -> Result<String, String> {
    if let Some(remote) = requested {
        validate_remote_name(remote)?;
        return Ok(remote.to_string());
    }
    let descriptor = repository_descriptor(root)?;
    if let Some(upstream) = descriptor.upstream {
        if let Some((remote, _)) = upstream.split_once('/') {
            return Ok(remote.to_string());
        }
    }
    if descriptor
        .remotes
        .iter()
        .any(|remote| remote.name == "origin")
    {
        return Ok("origin".to_string());
    }
    descriptor
        .remotes
        .first()
        .map(|remote| remote.name.clone())
        .ok_or_else(|| "Add a remote before using network operations".to_string())
}

fn github_https_auth(
    root: &Path,
    remote: Option<&str>,
    token: Option<&str>,
) -> Result<Option<AskPass>, String> {
    let Some(token) = token else { return Ok(None) };
    let repo = Repository::open(root).map_err(git_open_error)?;
    let remote_name = match remote {
        Some(remote) => remote.to_string(),
        None => selected_remote(root, None)?,
    };
    let url = repo
        .find_remote(&remote_name)
        .ok()
        .and_then(|remote| remote.url().map(str::to_string));
    if url.as_deref().is_some_and(is_github_https_url) {
        create_askpass(token).map(Some)
    } else {
        Ok(None)
    }
}

struct AskPass {
    directory: PathBuf,
    helper: PathBuf,
    token: String,
}

impl Drop for AskPass {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.helper);
        let _ = fs::remove_dir(&self.directory);
    }
}

fn create_askpass(token: &str) -> Result<AskPass, String> {
    let directory = std::env::temp_dir().join(format!("terminai-git-askpass-{}", Uuid::new_v4()));
    fs::create_dir(&directory)
        .map_err(|error| format!("Failed to create temporary Git credential helper: {error}"))?;
    #[cfg(windows)]
    let (helper, contents) = (
        directory.join("askpass.cmd"),
        "@echo off\r\necho %1 | findstr /I Username >nul\r\nif %errorlevel%==0 (echo x-access-token) else (echo %TERMINAI_GITHUB_TOKEN%)\r\n",
    );
    #[cfg(not(windows))]
    let (helper, contents) = (
        directory.join("askpass.sh"),
        "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' 'x-access-token' ;; *) printf '%s\\n' \"$TERMINAI_GITHUB_TOKEN\" ;; esac\n",
    );
    fs::write(&helper, contents)
        .map_err(|error| format!("Failed to write temporary Git credential helper: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!("Failed to secure temporary Git credential helper: {error}")
        })?;
    }
    Ok(AskPass {
        directory,
        helper,
        token: token.to_string(),
    })
}

fn run_git_output(
    cwd: &Path,
    args: &[OsString],
    askpass: Option<&AskPass>,
) -> Result<Output, String> {
    let mut command = Command::new("git");
    command.args(args).current_dir(cwd);
    if let Some(askpass) = askpass {
        command
            .env("GIT_ASKPASS", &askpass.helper)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("TERMINAI_GITHUB_TOKEN", &askpass.token);
    }
    command.output().map_err(|error| {
        format!("Could not run git. Make sure it is installed and on PATH: {error}")
    })
}

fn format_git_failure(action: &str, output: &Output, secret: Option<&str>) -> String {
    let stderr = redact_output(&String::from_utf8_lossy(&output.stderr), secret);
    let stdout = redact_output(&String::from_utf8_lossy(&output.stdout), secret);
    format!(
        "Failed to {action}: {}",
        first_nonempty(&stderr, &stdout, "Git failed")
    )
}

fn redact_output(value: &str, secret: Option<&str>) -> String {
    let mut redacted = value.trim().to_string();
    if let Some(secret) = secret.filter(|secret| !secret.is_empty()) {
        redacted = redacted.replace(secret, "[REDACTED]");
    }
    let credential_pattern = Regex::new(
        r"(?i)(authorization|password|access[_-]?token|oauth[_-]?token)(\s*[:=]\s*|\s+)([^\s]+)",
    )
    .expect("credential redaction regex");
    redacted = credential_pattern
        .replace_all(&redacted, "$1$2[REDACTED]")
        .into_owned();
    let url_credentials = Regex::new(r"(?i)(https?://)[^\s/@]+(?::[^\s/@]*)?@")
        .expect("URL credential redaction regex");
    url_credentials
        .replace_all(&redacted, "$1[REDACTED]@")
        .into_owned()
}

fn first_nonempty(first: &str, second: &str, fallback: &str) -> String {
    first
        .lines()
        .find(|line| !line.trim().is_empty())
        .or_else(|| second.lines().find(|line| !line.trim().is_empty()))
        .unwrap_or(fallback)
        .trim()
        .to_string()
}

fn validate_relative_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if path.as_os_str().is_empty()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Git file paths must stay inside the repository".to_string());
    }
    Ok(path)
}

fn validate_remote_name(name: &str) -> Result<(), String> {
    let valid = Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$").expect("remote regex");
    if !valid.is_match(name) || name.starts_with('-') {
        return Err("Remote name contains unsupported characters".to_string());
    }
    Ok(())
}

fn validate_ref_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.starts_with('-') || name.contains(['\0', '\n', '\r']) {
        return Err("Branch name is invalid".to_string());
    }
    Ok(())
}

fn validate_remote_url(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.contains(['\0', '\n', '\r']) || value.starts_with('-') {
        return Err("Remote URL is invalid".to_string());
    }
    if let Ok(url) = Url::parse(value) {
        if matches!(url.scheme(), "http" | "https")
            && (!url.username().is_empty() || url.password().is_some())
        {
            return Err("Credentials must not be embedded in remote URLs".to_string());
        }
    }
    Ok(())
}

fn sanitize_remote_url(value: &str) -> String {
    let Ok(mut url) = Url::parse(value) else {
        return value.to_string();
    };
    if matches!(url.scheme(), "http" | "https")
        && (!url.username().is_empty() || url.password().is_some())
    {
        let _ = url.set_username("");
        let _ = url.set_password(None);
    }
    url.to_string()
}

fn is_github_https_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url
                .host_str()
                .is_some_and(|host| host.eq_ignore_ascii_case("github.com"))
    })
}

fn parse_oid(value: &str) -> Result<Oid, String> {
    Oid::from_str(value).map_err(|_| "Commit SHA is invalid".to_string())
}

fn short_sha(value: &str) -> String {
    value.chars().take(7).collect()
}

fn delta_name(delta: Delta) -> &'static str {
    match delta {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Modified => "modified",
        Delta::Renamed => "renamed",
        Delta::Copied => "copied",
        Delta::Typechange => "typechange",
        _ => "modified",
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn git_open_error(error: git2::Error) -> String {
    format!("Failed to open Git repository: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git installed");
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_stdout(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git installed");
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn repo() -> TempDir {
        let temp = TempDir::new().unwrap();
        git(temp.path(), &["init"]);
        git(temp.path(), &["config", "user.name", "Test User"]);
        git(temp.path(), &["config", "user.email", "test@example.com"]);
        temp
    }

    #[test]
    fn discovers_containing_and_nested_repositories_but_skips_dependencies_and_symlinks() {
        let outer = repo();
        fs::create_dir_all(outer.path().join("workspace/nested")).unwrap();
        git(&outer.path().join("workspace/nested"), &["init"]);
        fs::create_dir_all(outer.path().join("workspace/node_modules/hidden")).unwrap();
        git(
            &outer.path().join("workspace/node_modules/hidden"),
            &["init"],
        );
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            outer.path().join("workspace/nested"),
            outer.path().join("workspace/link"),
        )
        .unwrap();

        let found = GitRepositoryService::new()
            .discover(outer.path().join("workspace").to_str().unwrap(), &[])
            .unwrap();

        assert_eq!(found.len(), 2);
        let outer_root = fs::canonicalize(outer.path()).unwrap();
        assert!(found
            .iter()
            .any(|repo| repo.root == display_path(&outer_root)));
        assert!(found
            .iter()
            .any(|repo| repo.root.ends_with("workspace/nested")));
    }

    #[tokio::test]
    async fn state_keeps_index_and_worktree_edits_on_the_same_path() {
        let temp = repo();
        fs::write(temp.path().join("both.txt"), "one\n").unwrap();
        git(temp.path(), &["add", "both.txt"]);
        git(temp.path(), &["commit", "-m", "initial"]);
        fs::write(temp.path().join("both.txt"), "two\n").unwrap();
        git(temp.path(), &["add", "both.txt"]);
        fs::write(temp.path().join("both.txt"), "three\n").unwrap();

        let state = GitRepositoryService::new()
            .state(temp.path().to_str().unwrap())
            .unwrap();
        assert_eq!(state.changes.len(), 1);
        assert_eq!(state.changes[0].index_status.as_deref(), Some("modified"));
        assert_eq!(
            state.changes[0].worktree_status.as_deref(),
            Some("modified")
        );
    }

    #[tokio::test]
    async fn empty_index_commit_stages_tracked_changes_but_not_untracked_files() {
        let temp = repo();
        fs::write(temp.path().join("tracked.txt"), "one\n").unwrap();
        git(temp.path(), &["add", "tracked.txt"]);
        git(temp.path(), &["commit", "-m", "initial"]);
        fs::write(temp.path().join("tracked.txt"), "two\n").unwrap();
        fs::write(temp.path().join("untracked.txt"), "secret\n").unwrap();

        let result = GitRepositoryService::new()
            .commit(temp.path().to_str().unwrap(), "tracked only")
            .await
            .unwrap();

        assert!(result.ok, "{}", result.stderr);
        let state = result.repository.unwrap();
        assert_eq!(state.changes.len(), 1);
        assert_eq!(state.changes[0].path, "untracked.txt");
        assert_eq!(
            state.changes[0].worktree_status.as_deref(),
            Some("untracked")
        );
    }

    #[tokio::test]
    async fn nonempty_index_commit_leaves_other_worktree_changes_unstaged() {
        let temp = repo();
        fs::write(temp.path().join("staged.txt"), "one\n").unwrap();
        fs::write(temp.path().join("unstaged.txt"), "one\n").unwrap();
        git(temp.path(), &["add", "."]);
        git(temp.path(), &["commit", "-m", "initial"]);
        fs::write(temp.path().join("staged.txt"), "two\n").unwrap();
        fs::write(temp.path().join("unstaged.txt"), "two\n").unwrap();
        git(temp.path(), &["add", "staged.txt"]);

        let result = GitRepositoryService::new()
            .commit(temp.path().to_str().unwrap(), "index only")
            .await
            .unwrap();

        assert!(result.ok, "{}", result.stderr);
        let state = result.repository.unwrap();
        assert_eq!(state.changes.len(), 1);
        assert_eq!(state.changes[0].path, "unstaged.txt");
        assert!(state.changes[0].index_status.is_none());
        assert_eq!(
            state.changes[0].worktree_status.as_deref(),
            Some("modified")
        );
    }

    #[tokio::test]
    async fn dirty_repository_blocks_pull_and_branch_switch() {
        let temp = repo();
        fs::write(temp.path().join("file.txt"), "dirty\n").unwrap();
        let service = GitRepositoryService::new();
        let branch = GitBranch {
            name: "main".into(),
            full_name: "refs/heads/main".into(),
            kind: "local".into(),
            current: true,
            target: None,
            upstream: None,
        };
        assert!(service
            .switch_branch(temp.path().to_str().unwrap(), &branch, false)
            .await
            .unwrap_err()
            .contains("clean repository changes"));
        assert!(service
            .pull(temp.path().to_str().unwrap(), None, false, None)
            .await
            .unwrap_err()
            .contains("clean repository changes"));
    }

    #[tokio::test]
    async fn dirty_editor_buffer_blocks_branch_switch_even_when_disk_is_clean() {
        let temp = repo();
        fs::write(temp.path().join("file.txt"), "clean\n").unwrap();
        git(temp.path(), &["add", "file.txt"]);
        git(temp.path(), &["commit", "-m", "initial"]);
        let branch_name = git_stdout(temp.path(), &["branch", "--show-current"]);
        let branch = GitRepositoryService::new()
            .branches(temp.path().to_str().unwrap())
            .unwrap()
            .into_iter()
            .find(|branch| branch.name == branch_name)
            .unwrap();

        let error = GitRepositoryService::new()
            .switch_branch(temp.path().to_str().unwrap(), &branch, true)
            .await
            .unwrap_err();
        assert!(error.contains("dirty editor buffers"));
    }

    #[tokio::test]
    async fn conflicts_remain_visible_and_can_be_staged_after_resolution() {
        let temp = repo();
        fs::write(temp.path().join("conflict.txt"), "base\n").unwrap();
        git(temp.path(), &["add", "conflict.txt"]);
        git(temp.path(), &["commit", "-m", "base"]);
        let base_branch = git_stdout(temp.path(), &["branch", "--show-current"]);
        git(temp.path(), &["switch", "-c", "other"]);
        fs::write(temp.path().join("conflict.txt"), "other\n").unwrap();
        git(temp.path(), &["commit", "-am", "other"]);
        git(temp.path(), &["switch", &base_branch]);
        fs::write(temp.path().join("conflict.txt"), "main\n").unwrap();
        git(temp.path(), &["commit", "-am", "main"]);
        let merge = Command::new("git")
            .args(["merge", "other"])
            .current_dir(temp.path())
            .output()
            .unwrap();
        assert!(!merge.status.success());

        let service = GitRepositoryService::new();
        let state = service.state(temp.path().to_str().unwrap()).unwrap();
        assert_eq!(state.changes.len(), 1);
        assert!(state.changes[0].conflict);
        assert!(state.changes[0].worktree_status.is_some());

        fs::write(temp.path().join("conflict.txt"), "resolved\n").unwrap();
        let result = service
            .stage_paths(temp.path().to_str().unwrap(), &["conflict.txt".into()])
            .await
            .unwrap();
        assert!(result.ok, "{}", result.stderr);
        let resolved = result.repository.unwrap();
        assert!(!resolved.changes[0].conflict);
        assert_eq!(
            resolved.changes[0].index_status.as_deref(),
            Some("modified")
        );
    }

    #[tokio::test]
    async fn remotes_first_push_upstream_and_local_clone_round_trip() {
        let source = repo();
        fs::write(source.path().join("README.md"), "source\n").unwrap();
        git(source.path(), &["add", "README.md"]);
        git(source.path(), &["commit", "-m", "source"]);
        let hosting = TempDir::new().unwrap();
        let bare = hosting.path().join("remote.git");
        git(hosting.path(), &["init", "--bare", bare.to_str().unwrap()]);

        let service = GitRepositoryService::new();
        let added = service
            .add_remote(
                source.path().to_str().unwrap(),
                "origin",
                bare.to_str().unwrap(),
            )
            .await
            .unwrap();
        assert!(added.ok, "{}", added.stderr);
        let pushed = service
            .push(source.path().to_str().unwrap(), Some("origin"), None)
            .await
            .unwrap();
        assert!(pushed.ok, "{}", pushed.stderr);
        assert!(pushed
            .repository
            .as_ref()
            .unwrap()
            .repository
            .upstream
            .as_deref()
            .is_some_and(|upstream| upstream.starts_with("origin/")));
        let remote_branch = service
            .branches(source.path().to_str().unwrap())
            .unwrap()
            .into_iter()
            .find(|branch| branch.kind == "remote")
            .expect("remote-tracking branch");
        let switched = service
            .switch_branch(source.path().to_str().unwrap(), &remote_branch, false)
            .await
            .unwrap();
        assert!(switched.ok, "{}", switched.stderr);
        assert!(switched.repository.unwrap().repository.branch.is_none());

        let clone_parent = TempDir::new().unwrap();
        let clone_target = clone_parent.path().join("clone");
        let cloned = service
            .clone_repository(
                bare.to_str().unwrap(),
                clone_target.to_str().unwrap(),
                false,
                None,
            )
            .await
            .unwrap();
        assert!(cloned.ok, "{}", cloned.stderr);
        assert_eq!(
            cloned.repository.unwrap().repository.root,
            display_path(&fs::canonicalize(clone_target).unwrap())
        );
    }

    #[tokio::test]
    async fn remote_urls_can_be_edited_and_removed() {
        let temp = repo();
        let hosting = TempDir::new().unwrap();
        let first = hosting.path().join("first.git");
        let second = hosting.path().join("second.git");
        git(hosting.path(), &["init", "--bare", first.to_str().unwrap()]);
        git(
            hosting.path(),
            &["init", "--bare", second.to_str().unwrap()],
        );
        let service = GitRepositoryService::new();
        assert!(
            service
                .add_remote(
                    temp.path().to_str().unwrap(),
                    "backup",
                    first.to_str().unwrap(),
                )
                .await
                .unwrap()
                .ok
        );
        assert!(
            service
                .set_remote(
                    temp.path().to_str().unwrap(),
                    "backup",
                    second.to_str().unwrap(),
                )
                .await
                .unwrap()
                .ok
        );
        let edited = service.state(temp.path().to_str().unwrap()).unwrap();
        assert_eq!(
            fs::canonicalize(
                edited.repository.remotes[0]
                    .fetch_url
                    .as_deref()
                    .expect("edited remote fetch URL"),
            )
            .unwrap(),
            fs::canonicalize(&second).unwrap()
        );
        assert!(
            service
                .remove_remote(temp.path().to_str().unwrap(), "backup")
                .await
                .unwrap()
                .ok
        );
        assert!(service
            .state(temp.path().to_str().unwrap())
            .unwrap()
            .repository
            .remotes
            .is_empty());
    }

    #[test]
    fn history_follows_file_renames_and_pages() {
        let temp = repo();
        fs::write(temp.path().join("old.txt"), "one\n").unwrap();
        git(temp.path(), &["add", "old.txt"]);
        git(temp.path(), &["commit", "-m", "old name"]);
        git(temp.path(), &["mv", "old.txt", "new.txt"]);
        git(temp.path(), &["commit", "-m", "rename"]);
        let history = GitRepositoryService::new()
            .history(temp.path().to_str().unwrap(), Some("new.txt"), 0, 100)
            .unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1].message, "old name");
        let second_page = GitRepositoryService::new()
            .history(temp.path().to_str().unwrap(), None, 1, 1)
            .unwrap();
        assert_eq!(second_page.len(), 1);
    }

    #[test]
    fn binary_and_oversized_diffs_do_not_cross_as_text() {
        let binary = diff_payload(
            "old".into(),
            "new".into(),
            Path::new("image.bin"),
            Some(vec![0, 1, 2]),
            Some(vec![0, 3]),
        );
        assert!(binary.binary);
        assert!(binary.original.is_none());

        let oversized = diff_payload(
            "old".into(),
            "new".into(),
            Path::new("large.txt"),
            Some(vec![b'a'; MAX_TEXT_DIFF_BYTES + 1]),
            None,
        );
        assert!(oversized.oversized);
        assert!(oversized.original.is_none());
    }

    #[test]
    fn command_output_redacts_exact_and_labeled_tokens() {
        let token = "EXAMPLE_OAUTH_TOKEN";
        let value = format!(
            "failed {token} Authorization: bearer-value access_token=<REDACTED> https://example.invalid"
        );
        let redacted = redact_output(&value, Some(token));
        assert!(!redacted.contains(token));
        assert!(!redacted.contains("bearer-value"));
        assert!(!redacted.contains("other"));
    }

    #[test]
    fn remote_urls_reject_http_credentials_and_sanitize_legacy_values() {
        let credentialed_url = [
            "https://",
            "example-user",
            ":",
            "example-password",
            "@example.invalid/repo.git",
        ]
        .concat();
        assert!(validate_remote_url(&credentialed_url).is_err());
        let legacy_url = [
            "https://",
            "legacy-user",
            ":",
            "legacy-password",
            "@example.invalid/repo.git",
        ]
        .concat();
        assert!(validate_remote_url(&legacy_url).is_err());
        assert!(validate_remote_url("git@github.com:org/repo.git").is_ok());
        let sanitized = sanitize_remote_url(&credentialed_url);
        assert!(!sanitized.contains("example-user"));
        assert!(!sanitized.contains("example-password"));
    }

    #[test]
    fn watcher_debounce_only_keeps_the_latest_generation() {
        let debouncer = WatchDebouncer::default();
        let first = debouncer.observe();
        assert!(debouncer.is_latest(first));
        let second = debouncer.observe();
        assert!(!debouncer.is_latest(first));
        assert!(debouncer.is_latest(second));
    }
}
