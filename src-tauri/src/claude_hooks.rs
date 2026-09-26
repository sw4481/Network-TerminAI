//! App-managed Claude Code config dir + lifecycle hooks.
//!
//! Part B of the agent-activity work. `claude` and `codex` are inline TUIs
//! (no alternate screen, no OSC 133), so the terminal cannot tell from the PTY
//! byte stream whether the agent is busy or idle. Instead, we have the agent
//! report its own lifecycle state via hooks that `curl` the in-process control
//! server (the same axum server the browser bridge uses).
//!
//! To install these hooks automatically on any machine WITHOUT polluting the
//! user's global `~/.claude` config, we point in-pane `claude` at our own
//! `CLAUDE_CONFIG_DIR` (exported per-PTY in `pty.rs`). Verified 2026-06-23:
//! setting `CLAUDE_CONFIG_DIR` keeps the user's auth working, fires the hooks,
//! and propagates `CCIE_PANE_ID` into the hook command — all with no admin
//! rights and no writes into the user's repos.

use anyhow::{Context, Result};
use std::path::PathBuf;

/// The app-managed Claude Code config dir, e.g.
/// `~/Library/Application Support/ccie-terminal/claude-config` on macOS.
/// Mirrors `shell_integration::install`'s use of `dirs::config_dir()`.
pub fn config_dir() -> Result<PathBuf> {
    let dir = dirs::config_dir()
        .context("config_dir")?
        .join("ccie-terminal")
        .join("claude-config");
    Ok(dir)
}

/// The `statusLine` script installed into the app-managed Claude config dir.
/// Claude Code pipes a JSON status object on stdin; we print
/// `[model] 📁 dir | Branch: x` (adapted from Warp's example) and append the
/// pane id so multi-pane sessions are distinguishable. `jq` ships on macOS via
/// Xcode CLT / Homebrew; if absent the model falls back to "Claude".
pub fn statusline_script() -> &'static str {
    r#"#!/bin/bash
input=$(cat)
if command -v jq >/dev/null 2>&1; then
  MODEL=$(echo "$input" | jq -r '.model.display_name // "Claude"')
  CURRENT_DIR=$(echo "$input" | jq -r '.workspace.current_dir // "~"')
else
  MODEL="Claude"
  CURRENT_DIR="$PWD"
fi
DIR_NAME="${CURRENT_DIR##*/}"
GIT_BRANCH=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null)
  [ -n "$BRANCH" ] && GIT_BRANCH=" | Branch: $BRANCH"
fi
PANE=""
[ -n "$CCIE_PANE_ID" ] && PANE=" | pane ${CCIE_PANE_ID:0:8}"
echo "[$MODEL] 📁 $DIR_NAME$GIT_BRANCH$PANE"
"#
}

/// Build the `settings.json` contents for the app-managed Claude config dir.
///
/// The hooks read `$CCIE_PANE_ID` (exported into the PTY) and post the agent's
/// lifecycle state to the control server on `127.0.0.1:<port>` with the bearer
/// `token`. A non-zero pane id is required; if the var is unset the curl still
/// fires but the server ignores an empty pane.
///
/// Signal mapping:
///   - `UserPromptSubmit`, `PreToolUse` -> `working`
///   - `Stop` -> `idle`
///   - `Notification` -> `waiting` (Claude needs the user: idle_prompt / permission)
pub fn build_hooks_settings(port: u16, token: &str) -> serde_json::Value {
    let cmd = |state: &str| -> serde_json::Value {
        // Single-line shell command. `-s` keeps curl quiet; `--max-time` keeps a
        // stalled server from blocking the agent. Body carries pane id + state.
        let shell = format!(
            "curl -s --max-time 2 -X POST http://127.0.0.1:{port}/agent_status \
             -H 'Authorization: Bearer {token}' -H 'Content-Type: application/json' \
             -d \"{{\\\"paneId\\\":\\\"$CCIE_PANE_ID\\\",\\\"agentType\\\":\\\"claude-code\\\",\\\"state\\\":\\\"{state}\\\"}}\" \
             >/dev/null 2>&1 || true"
        );
        serde_json::json!({
            "hooks": [ { "type": "command", "command": shell } ]
        })
    };

    let script_path = config_dir()
        .map(|d| d.join("statusline.sh").to_string_lossy().into_owned())
        .unwrap_or_else(|_| "statusline.sh".to_string());

    serde_json::json!({
        "hooks": {
            "UserPromptSubmit": [ cmd("working") ],
            "PreToolUse":       [ cmd("working") ],
            "Stop":             [ cmd("idle") ],
            "Notification":     [ cmd("waiting") ],
        },
        "statusLine": {
            "type": "command",
            "command": script_path,
        }
    })
}

/// Write the app-managed Claude config dir + `settings.json` with the status
/// hooks. Idempotent: overwrites our own settings.json each boot so the port
/// (which is ephemeral) and token stay current. Returns the dir to export as
/// `CLAUDE_CONFIG_DIR`.
pub fn install(port: u16, token: &str) -> Result<PathBuf> {
    let dir = config_dir()?;
    std::fs::create_dir_all(&dir).context("create claude-config dir")?;
    let settings = build_hooks_settings(port, token);
    let path = dir.join("settings.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&settings)?)
        .context("write claude settings.json")?;
    // Also write the statusLine script the settings.json points at, and make
    // it executable so Claude Code can run it.
    let script_path = dir.join("statusline.sh");
    std::fs::write(&script_path, statusline_script()).context("write statusline.sh")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)
            .context("stat statusline.sh")?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).context("chmod statusline.sh")?;
    }
    tracing::info!(path = %path.display(), "wrote app-managed Claude Code hooks");
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_have_all_lifecycle_hooks() {
        let v = build_hooks_settings(54321, "tok");
        let hooks = v.get("hooks").unwrap();
        for evt in ["UserPromptSubmit", "PreToolUse", "Stop", "Notification"] {
            assert!(hooks.get(evt).is_some(), "missing hook event {evt}");
        }
    }

    #[test]
    fn working_and_idle_states_map_to_right_events() {
        let v = build_hooks_settings(54321, "tok");
        let cmd_for = |evt: &str| -> String {
            v["hooks"][evt][0]["hooks"][0]["command"].as_str().unwrap().to_string()
        };
        assert!(cmd_for("UserPromptSubmit").contains("\\\"state\\\":\\\"working\\\""));
        assert!(cmd_for("Stop").contains("\\\"state\\\":\\\"idle\\\""));
        assert!(cmd_for("Notification").contains("\\\"state\\\":\\\"waiting\\\""));
    }

    #[test]
    fn command_targets_control_server_with_auth_and_pane() {
        let v = build_hooks_settings(54321, "secret-token");
        let cmd = v["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("127.0.0.1:54321/agent_status"), "must hit the control route");
        assert!(cmd.contains("Bearer secret-token"), "must carry the bearer token");
        assert!(cmd.contains("$CCIE_PANE_ID"), "must reference the injected pane id");
    }

    #[test]
    fn settings_include_statusline_command() {
        let v = build_hooks_settings(54321, "tok");
        let sl = v.get("statusLine").expect("statusLine present");
        assert_eq!(sl["type"].as_str().unwrap(), "command");
        let cmd = sl["command"].as_str().unwrap();
        assert!(cmd.ends_with("statusline.sh"), "points at the script: {cmd}");
        assert!(cmd.contains("claude-config"), "lives in the app config dir: {cmd}");
    }

    #[test]
    fn statusline_script_reads_model_and_pane() {
        let s = statusline_script();
        assert!(s.starts_with("#!/bin/bash"), "is a bash script");
        assert!(s.contains(".model.display_name"), "extracts the model name");
        assert!(s.contains("CCIE_PANE_ID"), "surfaces the pane id");
    }
}
