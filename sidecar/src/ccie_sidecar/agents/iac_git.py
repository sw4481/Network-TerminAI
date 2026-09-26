"""Small git helpers for IaC (Python side).

The Rust backend has its own get_git_branch/get_git_commit; the sidecar needs
its own to classify blast radius (production detection uses the branch).
"""
from __future__ import annotations

import subprocess


def current_git_branch(working_dir: str) -> str:
    """Return the current git branch in working_dir, or "" if unavailable."""
    if not working_dir:
        return ""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=working_dir,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return ""
