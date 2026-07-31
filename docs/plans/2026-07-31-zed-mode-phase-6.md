# Zed Mode Phase 6 — Git Panel and GitHub Integration

**Status:** implemented; automated and native sidecar health validation complete;
packaged GitHub workflow validation requires the OAuth App below.

## Delivered surface

- The primary Zed editor owns a 360px right-docked Git panel, resizable from
  280px to 55% of the editor. Open state, width, active repository, selected
  tab, diff style, and manually added repository roots persist per workspace.
- Repository discovery finds the containing worktree and nested repositories
  up to six levels deep while skipping symlinks and dependency/build folders.
- Changes keeps index and worktree states separate, including showing the same
  path in both groups. Commit auto-stages only modified/deleted tracked files
  when the index is empty; untracked files are never auto-staged.
- Repository and rename-following current-file history load 100 commits at a
  time. Commit files open parent-to-commit reviews in a transient Monaco diff
  surface; binary and files over 2 MiB use a non-text explanation.
- Pull and branch switching require clean on-disk state and clean TerminAI
  editor buffers. Fetch and push remain available, and a first push configures
  the selected remote as upstream.
- Initialization, clone, remotes, local/remote-tracking branch switching,
  GitHub account login, account repository browsing, and clone actions are
  available from the panel. Conflicts remain visible and stageable after the
  operator resolves them in the editor.

## GitHub OAuth App prerequisite

Create a GitHub.com OAuth App for TerminAI and enable **Device Flow**. No client
secret is used or embedded. Add the app's public client ID as the GitHub Actions
repository variable `TERMINAI_GITHUB_CLIENT_ID`; the release workflow requires
and passes that value at Rust compile time.

For a local development override, export the same public value before launch:

```bash
TERMINAI_GITHUB_CLIENT_ID=your_public_client_id ./run.sh
```

TerminAI requests `repo read:user`. The token stays behind the Tauri boundary:
production persistence uses the platform credential service, while an explicit
or automatically labeled session-only connection lives only until the process
exits. Git never receives it in arguments or remote URLs.

## Manual packaged-build matrix

Run this on packaged macOS, Windows, and Linux builds after configuring the
OAuth App:

1. Connect GitHub persistently; repeat with the credential service unavailable
   and confirm the session-only warning and restart behavior.
2. List, search, and paginate public, private, and organization repositories.
3. Clone into an empty current workspace and open a clone as a new workspace.
4. Exercise staged-only commit, empty-index tracked auto-stage, and confirm an
   untracked file is left behind.
5. Fetch with dirty files; push with and without an upstream; pull only clean.
6. Confirm dirty on-disk or unsaved editor buffers block pull and branch switch.
7. Select nested repositories, restart, and confirm panel preferences persist.
8. Review staged, unstaged-buffer, repository-history, and rename-following file
   diffs in split and unified modes, including binary and oversized files.
9. Verify the existing IaC GitHub Actions panel works after device login and no
   frontend payload or local storage contains a token.

Force push, reset/discard, stash, branch creation/deletion, rebase UI, hunk
staging, worktree management, pull-request review, and in-app conflict
resolution remain deliberately excluded.
