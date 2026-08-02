//! Process-tree helper (Phase 3E). Resolves a pid's descendants for the port
//! and ssh-fallback gatherers. macOS/Unix (`pgrep -P`).

use std::collections::{HashSet, VecDeque};

/// Pure BFS over a process tree. `children_of(pid)` returns direct children.
/// Includes `root`. Cycle-guarded (a pid is visited at most once).
pub(crate) fn walk_tree(root: u32, children_of: impl Fn(u32) -> Vec<u32>) -> Vec<u32> {
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    let mut q = VecDeque::new();
    q.push_back(root);
    while let Some(pid) = q.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        order.push(pid);
        for c in children_of(pid) {
            q.push_back(c);
        }
    }
    order
}

/// Direct children of `pid` via `pgrep -P <pid>`. Empty on any failure.
fn pgrep_children(pid: u32) -> Vec<u32> {
    let out = match std::process::Command::new("pgrep")
        .arg("-P")
        .arg(pid.to_string())
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    if !out.status.success() {
        return Vec::new(); // pgrep exits 1 when no children — not an error here
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .collect()
}

/// All descendants of `root` (inclusive), breadth-first. macOS/Unix only;
/// returns just `[root]` if `pgrep` is unavailable.
pub fn child_pids(root: u32) -> Vec<u32> {
    walk_tree(root, pgrep_children)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn tree() -> HashMap<u32, Vec<u32>> {
        // 100 -> 200 -> 400 ; 100 -> 300
        HashMap::from([(100, vec![200, 300]), (200, vec![400]), (300, vec![])])
    }

    #[test]
    fn test_walk_tree_bfs_includes_root_and_descendants() {
        let t = tree();
        let got = walk_tree(100, |p| t.get(&p).cloned().unwrap_or_default());
        assert_eq!(got, vec![100, 200, 300, 400]);
    }

    #[test]
    fn test_walk_tree_handles_cycle_without_infinite_loop() {
        // 1 -> 2 -> 1 (cycle)
        let t: HashMap<u32, Vec<u32>> = HashMap::from([(1, vec![2]), (2, vec![1])]);
        let got = walk_tree(1, |p| t.get(&p).cloned().unwrap_or_default());
        assert_eq!(got, vec![1, 2]);
    }

    #[test]
    fn test_walk_tree_leaf_only() {
        let got = walk_tree(7, |_| vec![]);
        assert_eq!(got, vec![7]);
    }
}
