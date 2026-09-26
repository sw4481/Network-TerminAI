//! Classify a foreground process command line into an agent CLI id (or nothing).
//!
//! Phase 3 (Warp-style toolbelt): the PTY poll resolves the foreground
//! process-group leader's command line (exe path + argv, via sysctl); this maps
//! it to `claude`/`codex`. Kept separate from `is_agent_command` (which parses a
//! shell command line) so the process path is independently testable.
//!
//! Detection must survive two real-world install shapes:
//!   - NATIVE binary via symlink: `claude` → `.../claude/versions/2.1.207`
//!     (`proc_pidpath` resolves the symlink, so the basename is `2.1.207`).
//!   - SCRIPT-WRAPPED via node: Codex runs as
//!     `node $HOME/.npm-global/bin/codex resume` — the executable is `node`,
//!     but the `codex` token lives in argv.
//! So we tokenize the whole command line on whitespace AND `/`, strip a single
//! file extension per token (`codex.js` → `codex`), and match any token against
//! a known agent name.

/// The agent CLIs the toolbelt recognizes. Mirrors `manager::AGENT_CLIS`.
const AGENT_PROCESS_NAMES: &[&str] = &["claude", "codex"];

/// Map a foreground process command line (or bare name/path) to its agent id,
/// if it is one. Matches when any whitespace/`/`-separated token — with a
/// single file extension like `.js` removed — equals a known agent name.
pub fn foreground_agent_for(command: &str) -> Option<String> {
    command
        .split(|c: char| c == '/' || c.is_whitespace())
        .filter(|c| !c.is_empty())
        .map(strip_extension)
        .find_map(|token| {
            AGENT_PROCESS_NAMES
                .iter()
                .find(|a| **a == token)
                .map(|a| a.to_string())
        })
}

/// Drop a trailing `.<ext>` from a single path component (e.g. `codex.js` ->
/// `codex`). Leaves dotfiles and multi-segment names otherwise intact.
fn strip_extension(component: &str) -> &str {
    match component.rsplit_once('.') {
        // Don't treat a leading-dot name (".codex") as an extension.
        Some((stem, _ext)) if !stem.is_empty() => stem,
        _ => component,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_bare_names() {
        assert_eq!(foreground_agent_for("claude").as_deref(), Some("claude"));
        assert_eq!(foreground_agent_for("codex").as_deref(), Some("codex"));
    }

    #[test]
    fn matches_symlink_resolved_claude_versioned_path() {
        // Real installs: `claude` -> `.../claude/versions/2.1.207`.
        assert_eq!(
            foreground_agent_for("$HOME/.local/share/claude/versions/2.1.207").as_deref(),
            Some("claude"),
        );
    }

    #[test]
    fn matches_codex_js_path() {
        // Real installs: `codex` -> `.../@openai/codex/bin/codex.js`.
        assert_eq!(
            foreground_agent_for("$HOME/.npm-global/lib/node_modules/@openai/codex/bin/codex.js")
                .as_deref(),
            Some("codex"),
        );
    }

    #[test]
    fn matches_node_wrapped_codex_command_line() {
        // Codex runs as a node script: the exe is `node`, `codex` is in argv.
        // This is the exact shape sysctl(KERN_PROCARGS2) returns.
        assert_eq!(
            foreground_agent_for("node $HOME/.npm-global/bin/codex resume").as_deref(),
            Some("codex"),
        );
        assert_eq!(
            foreground_agent_for(
                "$HOME/.hermes/node/bin/node $HOME/.npm-global/bin/codex"
            )
            .as_deref(),
            Some("codex"),
        );
    }

    #[test]
    fn ignores_shell_and_others() {
        assert_eq!(foreground_agent_for("/bin/zsh"), None);
        assert_eq!(foreground_agent_for("/bin/zsh -il"), None);
        assert_eq!(foreground_agent_for("zsh"), None);
        assert_eq!(foreground_agent_for("/usr/bin/vim"), None);
        assert_eq!(foreground_agent_for("node $HOME/app/server.js"), None);
        assert_eq!(foreground_agent_for(""), None);
    }

    #[test]
    fn does_not_match_substring_only() {
        // A path merely CONTAINING the substring must not match — only a full
        // component (after extension strip) counts.
        assert_eq!(foreground_agent_for("/opt/claudexyz/bin/tool"), None);
        assert_eq!(foreground_agent_for("$HOME/codexterous/run"), None);
    }

    #[test]
    fn trims_whitespace() {
        assert_eq!(foreground_agent_for(" claude\n").as_deref(), Some("claude"));
    }
}
