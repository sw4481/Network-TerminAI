//! Codex (OpenAI) agent activity reporting.
//!
//! Unlike Claude Code, Codex 0.130.0 does NOT honor lifecycle hooks
//! (`features.hooks` did not fire in testing) and its auth/config can't be
//! cleanly isolated via `CODEX_HOME` (a relocated home loses auth.json, the
//! model, MCP servers, and project trust). The only mechanism verified to work
//! is the stable `notify` program, which Codex invokes on `agent-turn-complete`
//! with a JSON payload — and which inherits `CCIE_PANE_ID` from the launching
//! shell (exported per-PTY in `pty.rs`).
//!
//! So instead of an app-managed config dir, we:
//!   1. Write a small notify script into the app config dir.
//!   2. Additively merge a single `notify = [<script>]` key into the user's
//!      real `~/.codex/config.toml`, preserving every existing key. If the user
//!      already has a `notify`, we leave it untouched and report that.
//!
//! Codex only exposes a turn-complete signal (no "started working" event), so
//! the script reports `waiting` — combined with the agent calm-baseline in
//! PaneContextManager, the pane stays calm on launch and settles to
//! "needs attention" when Codex finishes a turn.

use anyhow::{Context, Result};
use std::path::PathBuf;

/// App config dir (shared with other ccie-terminal integration assets).
fn app_dir() -> Result<PathBuf> {
    let dir = dirs::config_dir()
        .context("config_dir")?
        .join("ccie-terminal");
    Ok(dir)
}

/// Path to the notify script we install.
pub fn notify_script_path() -> Result<PathBuf> {
    Ok(app_dir()?.join("codex-notify.sh"))
}

/// The user's real Codex config (honors `CODEX_HOME`, defaults to ~/.codex).
fn codex_config_path() -> Result<PathBuf> {
    let home = std::env::var("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|_| dirs::home_dir().map(|h| h.join(".codex")).context("home_dir"))?;
    Ok(home.join("config.toml"))
}

/// The notify script body. Reads the agent-turn-complete JSON arg only to
/// confirm the event type, then POSTs `state=waiting` for `$CCIE_PANE_ID` to
/// the control server, whose port+token it reads from the discovery file (same
/// file the browser MCP shim uses). Fails silently so it never disrupts Codex.
const NOTIFY_SCRIPT: &str = r#"#!/bin/bash
# ccie-terminal codex notify hook. Arg $1 is the agent-turn-complete JSON.
set -e
[ -n "$CCIE_PANE_ID" ] || exit 0
disc="$HOME/Library/Application Support/ccie-terminal/browser-control.json"
[ -f "$disc" ] || exit 0
port=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$disc" | head -1)
token=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$disc" | head -1)
[ -n "$port" ] || exit 0
curl -s --max-time 2 -X POST "http://127.0.0.1:$port/agent_status" \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d "{\"paneId\":\"$CCIE_PANE_ID\",\"agentType\":\"codex\",\"state\":\"waiting\"}" \
  >/dev/null 2>&1 || true
"#;

/// Outcome of `install`, so the caller can log what happened.
#[derive(Debug, PartialEq)]
pub enum InstallOutcome {
    /// We added our `notify` key.
    Installed,
    /// A `notify` key already existed (possibly ours from a prior run); we
    /// left the user's config untouched.
    AlreadyConfigured,
}

/// Given the current `config.toml` contents (or None if absent), return the
/// updated contents that additively set `notify = [script]`, preserving all
/// other keys. Returns None if a `notify` key already exists (don't clobber).
///
/// Pure + total so it can be unit-tested without touching the filesystem.
pub fn merged_config(existing: Option<&str>, script_path: &str) -> Result<Option<String>> {
    let mut doc: toml::Table = match existing {
        Some(s) if !s.trim().is_empty() => {
            toml::from_str(s).context("parse existing codex config.toml")?
        }
        _ => toml::Table::new(),
    };
    if doc.contains_key("notify") {
        return Ok(None);
    }
    doc.insert(
        "notify".to_string(),
        toml::Value::Array(vec![toml::Value::String(script_path.to_string())]),
    );
    Ok(Some(toml::to_string_pretty(&doc).context("serialize codex config.toml")?))
}

/// Install the notify script and additively wire it into the user's real
/// Codex config. Idempotent: rewrites the script each boot (cheap) but never
/// overwrites an existing `notify` key.
pub fn install() -> Result<InstallOutcome> {
    let dir = app_dir()?;
    std::fs::create_dir_all(&dir).context("create app dir")?;
    let script = notify_script_path()?;
    std::fs::write(&script, NOTIFY_SCRIPT).context("write codex-notify.sh")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))?;
    }

    let cfg_path = codex_config_path()?;
    let existing = std::fs::read_to_string(&cfg_path).ok();
    match merged_config(existing.as_deref(), &script.to_string_lossy())? {
        Some(updated) => {
            if let Some(parent) = cfg_path.parent() {
                std::fs::create_dir_all(parent).context("create ~/.codex")?;
            }
            std::fs::write(&cfg_path, updated).context("write codex config.toml")?;
            tracing::info!(path = %cfg_path.display(), "wired codex notify hook");
            Ok(InstallOutcome::Installed)
        }
        None => {
            tracing::info!(
                path = %cfg_path.display(),
                "codex config already has a notify key; left untouched"
            );
            Ok(InstallOutcome::AlreadyConfigured)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_notify_to_empty_config() {
        let out = merged_config(None, "/x/codex-notify.sh").unwrap().unwrap();
        let doc: toml::Table = toml::from_str(&out).unwrap();
        let arr = doc["notify"].as_array().unwrap();
        assert_eq!(arr[0].as_str().unwrap(), "/x/codex-notify.sh");
    }

    #[test]
    fn preserves_existing_keys_when_adding_notify() {
        let existing = r#"
model = "gpt-5.5"
[projects."/tmp"]
trust_level = "trusted"
[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"
"#;
        let out = merged_config(Some(existing), "/x/codex-notify.sh").unwrap().unwrap();
        let doc: toml::Table = toml::from_str(&out).unwrap();
        // Our key added...
        assert!(doc.contains_key("notify"));
        // ...and everything preserved.
        assert_eq!(doc["model"].as_str().unwrap(), "gpt-5.5");
        assert!(doc["projects"].as_table().unwrap().contains_key("/tmp"));
        assert!(doc["mcp_servers"].as_table().unwrap().contains_key("context7"));
    }

    #[test]
    fn does_not_clobber_existing_notify() {
        let existing = r#"notify = ["/someone/elses/script.sh"]
model = "gpt-5.5"
"#;
        let out = merged_config(Some(existing), "/x/codex-notify.sh").unwrap();
        assert!(out.is_none(), "must not overwrite a user's existing notify");
    }

    #[test]
    fn script_targets_control_route_with_pane_and_waiting() {
        assert!(NOTIFY_SCRIPT.contains("/agent_status"));
        assert!(NOTIFY_SCRIPT.contains("$CCIE_PANE_ID"));
        assert!(NOTIFY_SCRIPT.contains("\\\"state\\\":\\\"waiting\\\""));
        assert!(NOTIFY_SCRIPT.contains("\\\"agentType\\\":\\\"codex\\\""));
        assert!(NOTIFY_SCRIPT.contains("browser-control.json"));
    }
}

