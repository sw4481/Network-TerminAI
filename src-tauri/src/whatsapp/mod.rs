//! WhatsApp linked-device bridge (personal transport via the sidecar's neonize
//! client). See `docs`/the design doc for rationale.
//!
//! Surgical by design:
//! - Outbound alerts hook the existing heartbeat sink in `lib.rs`.
//! - Inbound chat is **polled** (not pushed) via the `whatsapp.poll` RPC, so the
//!   shared `bridge.rs` NDJSON demux is never touched.
//! - Agent execution reuses the existing building blocks (`agents_loader`,
//!   `call_stream_ex`, `_retrieve_vault_secrets`) rather than duplicating them.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::commands::ai::ChatTurn;
use crate::commands::AppState;

/// Config mirrored from the `whatsapp_config` singleton row. `camelCase` for the
/// TS client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhatsAppConfig {
    pub enabled: bool,
    pub default_agent_id: String,
    /// E.164 numbers permitted to drive agents (the only full-trust guardrail).
    pub allowlist: Vec<String>,
    /// Heartbeat severities that push a WhatsApp alert.
    pub notify_severities: Vec<String>,
    /// neonize device-session directory (empty => sidecar default).
    pub session_dir: String,
    /// Trigger word an inbound message must start with (case-insensitive) for
    /// CCIE to act on it — lets CCIE coexist with another bot (e.g. Hermes) on
    /// the same number. Empty => respond to all allowlisted messages.
    pub trigger_keyword: String,
    /// Full JID (…@g.us group or …@s.whatsapp.net) CCIE is scoped to. Alerts go
    /// here and only messages in this chat are handled. Empty => any chat.
    pub bound_chat_jid: String,
}

impl Default for WhatsAppConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            default_agent_id: "network-architect".to_string(),
            allowlist: Vec::new(),
            notify_severities: vec!["critical".to_string(), "error".to_string()],
            session_dir: String::new(),
            trigger_keyword: "ccie".to_string(),
            bound_chat_jid: String::new(),
        }
    }
}

/// Read the singleton config row. Returns defaults when the row is unset.
pub fn get_config(db: &Arc<Mutex<rusqlite::Connection>>) -> WhatsAppConfig {
    let conn = db.lock();
    let row = conn
        .query_row(
            "SELECT enabled, default_agent_id, allowlist_json, notify_severities_json, session_dir, trigger_keyword, bound_chat_jid \
             FROM whatsapp_config WHERE id = 1",
            [],
            |r| {
                Ok((
                    r.get::<_, i64>(0)? == 1,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten();

    match row {
        Some((
            enabled,
            default_agent_id,
            allowlist_json,
            notify_json,
            session_dir,
            trigger_keyword,
            bound_chat_jid,
        )) => WhatsAppConfig {
            enabled,
            default_agent_id: if default_agent_id.is_empty() {
                "network-architect".to_string()
            } else {
                default_agent_id
            },
            allowlist: serde_json::from_str(&allowlist_json).unwrap_or_default(),
            notify_severities: serde_json::from_str(&notify_json)
                .unwrap_or_else(|_| vec!["critical".to_string(), "error".to_string()]),
            session_dir,
            trigger_keyword,
            bound_chat_jid,
        },
        None => WhatsAppConfig::default(),
    }
}

/// Persist the singleton config row.
pub fn save_config(
    db: &Arc<Mutex<rusqlite::Connection>>,
    cfg: &WhatsAppConfig,
) -> Result<(), String> {
    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO whatsapp_config \
         (id, enabled, default_agent_id, allowlist_json, notify_severities_json, session_dir, trigger_keyword, bound_chat_jid) \
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            if cfg.enabled { 1 } else { 0 },
            cfg.default_agent_id,
            serde_json::to_string(&cfg.allowlist).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&cfg.notify_severities)
                .unwrap_or_else(|_| "[\"critical\",\"error\"]".to_string()),
            cfg.session_dir,
            cfg.trigger_keyword,
            cfg.bound_chat_jid,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reduce a number/JID user-part to bare digits for comparison.
fn normalize(num: &str) -> String {
    num.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Allowlist check. Empty allowlist => deny all (fail-closed): the allowlist is
/// the only guardrail under full-trust.
pub fn is_allowed(sender: &str, allowlist: &[String]) -> bool {
    if allowlist.is_empty() {
        return false;
    }
    let s = normalize(sender);
    allowlist.iter().any(|e| normalize(e) == s)
}

/// Per-sender conversation history so multi-turn context works over WhatsApp.
/// Keyed by the sender's JID user-part. Bounded to the last N turns.
type HistoryMap = Arc<Mutex<HashMap<String, Vec<ChatTurn>>>>;

const HISTORY_MAX_TURNS: usize = 12;
const POLL_INTERVAL_SECS: u64 = 3;

/// Spawn the background poll loop. Every few seconds it drains inbound WhatsApp
/// messages from the sidecar and runs each through the configured agent.
pub fn spawn_poll_task(app_handle: tauri::AppHandle) {
    let history: HistoryMap = Arc::new(Mutex::new(HashMap::new()));

    tauri::async_runtime::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(POLL_INTERVAL_SECS));
        loop {
            interval.tick().await;

            // Cheap gate: skip everything (including the poll RPC) when disabled.
            let cfg = {
                let state = app_handle.state::<AppState>();
                get_config(&state.db)
            };
            if !cfg.enabled {
                continue;
            }

            let agent = {
                let state = app_handle.state::<AppState>();
                (*state.agent).clone()
            };

            let poll_result = agent.call("whatsapp.poll", serde_json::json!({})).await;

            let messages = match poll_result {
                Ok(crate::agent_bridge::AgentResponse::Done { result }) => result
                    .get("messages")
                    .and_then(|m| m.as_array())
                    .cloned()
                    .unwrap_or_default(),
                _ => continue,
            };

            for msg in messages {
                // `from` = the human sender (allowlist check); `chat` = where to
                // reply (a group JID, or the sender for a DM). Sidecar guarantees
                // both, but fall back to `from` if `chat` is absent.
                let from = msg
                    .get("from")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let chat = msg
                    .get("chat")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&from)
                    .to_string();
                let text = msg
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                // Sidecar sets `authorized` once its own allowlist/from_me gate
                // passes. Trust it — a group own-message `from` is a LID that
                // won't re-match the allowlist here.
                let authorized = msg
                    .get("authorized")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if from.is_empty() || text.is_empty() {
                    continue;
                }
                handle_inbound(&app_handle, &cfg, &history, chat, from, text, authorized).await;
            }
        }
    });
}

/// Run one inbound message through the agent and reply over WhatsApp.
/// `chat` is the reply target (group JID or DM); `from` is the human sender used
/// for the allowlist check.
async fn handle_inbound(
    app_handle: &tauri::AppHandle,
    cfg: &WhatsAppConfig,
    history: &HistoryMap,
    chat: String,
    from: String,
    text: String,
    authorized: bool,
) {
    // Defense-in-depth: the sidecar already gated (allowlist + from_me), which it
    // signals via `authorized`. Only re-check the allowlist when the sidecar did
    // NOT pre-authorize — a group's own-message sender is a LID that would never
    // match the allowlist here.
    if !authorized && !is_allowed(&from, &cfg.allowlist) {
        tracing::warn!(from = %from, "whatsapp: message from non-allowlisted sender ignored");
        return;
    }

    // Chat scoping (defense-in-depth; the sidecar also enforces it): when bound
    // to a specific chat/group, ignore everything else. This is how CCIE
    // coexists with another bot (e.g. Hermes) on one account.
    if !cfg.bound_chat_jid.is_empty() && chat != cfg.bound_chat_jid {
        return;
    }

    // Trigger keyword handling depends on whether we're in the bound group:
    //  - Bound group: this chat is CCIE-only, so the trigger is NOT required.
    //    Strip it if the user happens to type it, but act on every message.
    //  - Not bound (shared chat like the self-chat): require the trigger so CCIE
    //    only answers messages addressed to it (coexistence with e.g. Hermes).
    let in_bound_chat = !cfg.bound_chat_jid.is_empty() && chat == cfg.bound_chat_jid;
    let text = if in_bound_chat {
        // Strip the trigger if present; otherwise use the message as-is.
        strip_trigger(&text, &cfg.trigger_keyword).unwrap_or(text)
    } else {
        match strip_trigger(&text, &cfg.trigger_keyword) {
            Some(stripped) => stripped,
            None => return, // not addressed to CCIE — stay silent
        }
    };

    // Optional `/agent-id rest…` prefix selects a specific agent for this turn.
    let (agent_id, message) = parse_agent_prefix(&text, &cfg.default_agent_id);

    // History is keyed by chat so a group carries one shared conversation.
    let prior = {
        let map = history.lock();
        map.get(&chat).cloned().unwrap_or_default()
    };

    let reply = match run_agent(app_handle, &agent_id, &message, prior).await {
        Ok(r) if !r.trim().is_empty() => r,
        Ok(_) => "(agent produced no response)".to_string(),
        Err(e) => format!("⚠️ Error: {}", e),
    };

    // Append this turn to history (bounded).
    {
        let mut map = history.lock();
        let turns = map.entry(chat.clone()).or_default();
        turns.push(ChatTurn {
            role: "user".to_string(),
            content: message.clone(),
        });
        turns.push(ChatTurn {
            role: "assistant".to_string(),
            content: reply.clone(),
        });
        let len = turns.len();
        if len > HISTORY_MAX_TURNS {
            turns.drain(0..len - HISTORY_MAX_TURNS);
        }
    }

    // Send the reply back to the originating chat (group or DM).
    let agent = {
        let state = app_handle.state::<AppState>();
        (*state.agent).clone()
    };
    let _ = agent
        .call(
            "whatsapp.send",
            serde_json::json!({ "to": chat, "text": reply }),
        )
        .await;
}

/// Apply the trigger keyword. Returns:
/// - `Some(rest)` with the keyword stripped, when the message starts with it
///   (case-insensitive), or when no keyword is configured (respond to all).
/// - `None` when a keyword is configured and the message doesn't start with it
///   (the message is for another bot — ignore it).
fn strip_trigger(text: &str, trigger: &str) -> Option<String> {
    let trigger = trigger.trim();
    if trigger.is_empty() {
        return Some(text.to_string());
    }
    let trimmed = text.trim_start();
    let lower = trimmed.to_lowercase();
    let trig_lower = trigger.to_lowercase();
    if !lower.starts_with(&trig_lower) {
        return None;
    }
    // The keyword must be a whole token: followed by end-of-string or whitespace
    // (so "ccietest" doesn't trigger on "ccie").
    let rest = &trimmed[trigger.len()..];
    match rest.chars().next() {
        None => Some(String::new()),
        Some(c) if c.is_whitespace() => Some(rest.trim_start().to_string()),
        _ => None,
    }
}

/// Parse a leading `/agent-id` token. Returns (agent_id, remaining_message).
fn parse_agent_prefix(text: &str, default_agent: &str) -> (String, String) {
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix('/') {
        let mut parts = rest.splitn(2, char::is_whitespace);
        if let Some(token) = parts.next() {
            if !token.is_empty() {
                let msg = parts.next().unwrap_or("").trim().to_string();
                return (token.to_string(), msg);
            }
        }
    }
    (default_agent.to_string(), text.trim().to_string())
}

/// The sidecar reports transport failures as a successful JSON-RPC response
/// whose result contains `ok: false`; do not treat that envelope as delivered.
pub fn send_result_ok(result: &serde_json::Value) -> bool {
    result.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
}

/// Run an agent headlessly and collect its final text. Mirrors AgentPanel's
/// dispatch: it branches on the agent's `execution_mode` to pick the right
/// sidecar RPC (`react-code` → agent.react_code_loop, `code` →
/// agent.code_exec_loop, else → agent.react_loop). Full-trust: every path sets
/// `blast_radius_allowed: "critical"` so no HITL approval is emitted (there is
/// no UI to grant one over WhatsApp).
async fn run_agent(
    app_handle: &tauri::AppHandle,
    agent_id: &str,
    message: &str,
    history: Vec<ChatTurn>,
) -> Result<String, String> {
    let state = app_handle.state::<AppState>();

    let agent = state
        .agents_loader
        .get(agent_id)
        .ok_or_else(|| format!("Agent '{}' not found", agent_id))?;

    let mode = agent.execution_mode.as_deref().unwrap_or("react");

    // Attached-tool catalog + vault are only needed by the plain react path, and
    // optional for code paths (tool_id binds the sandbox client).
    let tool_id = agent
        .attached_tools
        .first()
        .map(|t| t.id.clone())
        .unwrap_or_default();
    let vault_entry = agent
        .attached_tools
        .first()
        .map(|t| t.vault_entry.clone())
        .unwrap_or_default();
    let vault_secrets = if !vault_entry.is_empty() {
        Some(crate::commands::ai::_retrieve_vault_secrets(&state, &vault_entry).await?)
    } else {
        None
    };

    let (rpc, params) = match mode {
        "react-code" => (
            "agent.react_code_loop",
            serde_json::json!({
                "agent_id": agent_id,
                "message": message,
                "history": history,
                "system_prompt": agent.system_prompt,
                "tool_id": tool_id,
                "vault_secrets": vault_secrets,
                "engine": agent.engine,
                "blast_radius_allowed": "critical",
            }),
        ),
        "code" => (
            "agent.code_exec_loop",
            serde_json::json!({
                "agent_id": agent_id,
                "message": message,
                "history": history,
                "system_prompt": agent.system_prompt,
                "tool_id": tool_id,
                "vault_entry": vault_entry,
                "vault_secrets": vault_secrets,
                "blast_radius_allowed": "critical",
            }),
        ),
        _ => {
            // Plain ReACT with a tool catalog — requires attached_tools.
            let tool_def = agent
                .attached_tools
                .first()
                .ok_or_else(|| "Agent has no attached tools configured".to_string())?;
            let catalog_json = std::fs::read_to_string(&tool_def.catalog)
                .map_err(|e| format!("Failed to read tool catalog {}: {}", tool_def.catalog, e))?;
            let catalog: serde_json::Value = serde_json::from_str(&catalog_json)
                .map_err(|e| format!("Failed to parse tool catalog: {}", e))?;
            (
                "agent.react_loop",
                serde_json::json!({
                    "agent_id": agent_id,
                    "message": message,
                    "history": history,
                    "system_prompt": agent.system_prompt,
                    "tools": catalog,
                    "vault_entry": vault_entry,
                    "vault_secrets": vault_secrets,
                    "engine": agent.engine,
                    "blast_radius_allowed": "critical",
                }),
            )
        }
    };

    let agent_bridge = (*state.agent).clone();
    let collected = Arc::new(Mutex::new(String::new()));
    let sink = collected.clone();

    agent_bridge
        .call_stream_ex(rpc, params, move |ev| {
            let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match ev_type {
                // All three loops emit "final" with the answer in "response".
                "final" => {
                    if let Some(response) = ev.get("response").and_then(|v| v.as_str()) {
                        *sink.lock() = response.to_string();
                    }
                }
                "error" => {
                    if let Some(m) = ev.get("message").and_then(|v| v.as_str()) {
                        let mut s = sink.lock();
                        if s.is_empty() {
                            *s = format!("⚠️ {}", m);
                        }
                    }
                }
                _ => {}
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?;

    let out = collected.lock().clone();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_db() -> Arc<Mutex<rusqlite::Connection>> {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/V0074__whatsapp_config.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../../migrations/V0075__whatsapp_trigger.sql"))
            .unwrap();
        conn.execute_batch(include_str!(
            "../../migrations/V0076__whatsapp_bound_chat.sql"
        ))
        .unwrap();
        Arc::new(Mutex::new(conn))
    }

    #[test]
    fn get_config_returns_defaults_when_unset() {
        let db = seed_db();
        let cfg = get_config(&db);
        assert!(!cfg.enabled);
        assert_eq!(cfg.default_agent_id, "network-architect");
        assert!(cfg.allowlist.is_empty());
        assert_eq!(cfg.notify_severities, vec!["critical", "error"]);
    }

    #[test]
    fn save_and_get_roundtrip() {
        let db = seed_db();
        let cfg = WhatsAppConfig {
            enabled: true,
            default_agent_id: "ise".to_string(),
            allowlist: vec!["15551234567".to_string(), "442071234567".to_string()],
            notify_severities: vec!["critical".to_string()],
            session_dir: "/tmp/wa".to_string(),
            trigger_keyword: "netbot".to_string(),
            bound_chat_jid: "120363001@g.us".to_string(),
        };
        save_config(&db, &cfg).unwrap();

        let got = get_config(&db);
        assert!(got.enabled);
        assert_eq!(got.default_agent_id, "ise");
        assert_eq!(got.allowlist, cfg.allowlist);
        assert_eq!(got.notify_severities, vec!["critical"]);
        assert_eq!(got.session_dir, "/tmp/wa");
        assert_eq!(got.trigger_keyword, "netbot");
        assert_eq!(got.bound_chat_jid, "120363001@g.us");
    }

    #[test]
    fn trigger_defaults_to_ccie_and_gates_messages() {
        let db = seed_db();
        // The V0075 column default is "ccie".
        assert_eq!(get_config(&db).trigger_keyword, "ccie");

        // Matches (case-insensitive), keyword stripped.
        assert_eq!(
            strip_trigger("ccie show version", "ccie"),
            Some("show version".to_string())
        );
        assert_eq!(
            strip_trigger("CCIE  show bgp", "ccie"),
            Some("show bgp".to_string())
        );
        assert_eq!(strip_trigger("ccie", "ccie"), Some(String::new()));

        // Not addressed to CCIE (e.g. a Hermes message) => ignored.
        assert_eq!(strip_trigger("hermes what's up", "ccie"), None);
        // Must be a whole token — no false match on a longer word.
        assert_eq!(strip_trigger("ccietest", "ccie"), None);

        // Empty trigger => respond to everything (single-bot mode).
        assert_eq!(strip_trigger("anything", ""), Some("anything".to_string()));
    }

    #[test]
    fn allowlist_is_fail_closed_and_digit_normalized() {
        // Empty allowlist denies everyone.
        assert!(!is_allowed("15551234567", &[]));
        // Formatting differences are ignored — compare on bare digits.
        let allow = vec!["+1 (555) 123-4567".to_string()];
        assert!(is_allowed("15551234567", &allow));
        assert!(!is_allowed("15559999999", &allow));
    }

    #[test]
    fn agent_prefix_parsing() {
        let (a, m) = parse_agent_prefix("/ise show me the endpoints", "network-architect");
        assert_eq!(a, "ise");
        assert_eq!(m, "show me the endpoints");

        let (a2, m2) = parse_agent_prefix("just a plain question", "network-architect");
        assert_eq!(a2, "network-architect");
        assert_eq!(m2, "just a plain question");

        // A slash followed by whitespace has no agent token, so it safely falls
        // through to the default agent (the whole text is kept as the message).
        let (a3, _m3) = parse_agent_prefix("/ what now", "network-architect");
        assert_eq!(a3, "network-architect");
    }

    #[test]
    fn send_result_requires_explicit_success() {
        assert!(send_result_ok(&serde_json::json!({"ok": true})));
        assert!(!send_result_ok(&serde_json::json!({"ok": false})));
        assert!(!send_result_ok(&serde_json::json!({
            "message": "not linked"
        })));
    }
}
