//! Git metadata gatherer (Phase 3E). Reuses git2 (already a dep). A non-repo
//! cwd yields None — the common case, not a failure.

use super::GitInfo;

pub fn gather_git(cwd: &str) -> Option<GitInfo> {
    let repo = git2::Repository::discover(cwd).ok()?;

    // Branch name (or detached short sha).
    let head = repo.head().ok();
    let branch = match &head {
        Some(h) if h.is_branch() => h.shorthand().unwrap_or("HEAD").to_string(),
        Some(h) => {
            let sha = h.target().map(|o| o.to_string()).unwrap_or_default();
            format!("(detached @ {})", sha.chars().take(7).collect::<String>())
        }
        None => "HEAD".to_string(),
    };

    // Working-tree status (exclude ignored).
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).ok()?;
    let changed_count = statuses
        .iter()
        .filter(|e| !e.status().is_empty() && !e.status().contains(git2::Status::IGNORED))
        .count() as u32;
    let dirty = changed_count > 0;

    // ahead/behind vs upstream (default 0/0 when no upstream).
    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Some(h) = &head {
        if let Some(local_oid) = h.target() {
            if let Ok(local_branch) =
                repo.find_branch(h.shorthand().unwrap_or(""), git2::BranchType::Local)
            {
                if let Ok(upstream) = local_branch.upstream() {
                    if let Some(up_oid) = upstream.get().target() {
                        if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, up_oid) {
                            ahead = a as u32;
                            behind = b as u32;
                        }
                    }
                }
            }
        }
    }

    Some(GitInfo {
        branch,
        dirty,
        changed_count,
        ahead,
        behind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &std::path::Path, args: &[&str]) {
        let status = Command::new(args[0])
            .args(&args[1..])
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success(), "cmd failed: {args:?}");
    }

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        sh(p, &["git", "init", "-q", "-b", "main"]);
        sh(p, &["git", "config", "user.email", "t@t.com"]);
        sh(p, &["git", "config", "user.name", "t"]);
        std::fs::write(p.join("a.txt"), "hello").unwrap();
        sh(p, &["git", "add", "."]);
        sh(p, &["git", "commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn test_gather_git_clean_repo_on_main() {
        let dir = init_repo();
        let info = gather_git(dir.path().to_str().unwrap()).expect("some");
        assert_eq!(info.branch, "main");
        assert!(!info.dirty);
        assert_eq!(info.changed_count, 0);
    }

    #[test]
    fn test_gather_git_dirty_counts_changed() {
        let dir = init_repo();
        std::fs::write(dir.path().join("b.txt"), "new").unwrap(); // untracked
        let info = gather_git(dir.path().to_str().unwrap()).expect("some");
        assert!(info.dirty);
        assert_eq!(info.changed_count, 1);
    }

    #[test]
    fn test_gather_git_non_repo_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(gather_git(dir.path().to_str().unwrap()).is_none());
    }
}
