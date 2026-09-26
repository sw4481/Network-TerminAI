pub mod ai;
pub mod appearance;
pub mod browser;
pub mod dap;
pub mod diagrams;
pub mod drift;
pub mod editor;
pub mod editor_windows;
pub mod fanout;
pub mod git;
pub mod guardrails;
pub mod logs;
pub mod lsp;
pub mod palette;
pub mod pane_activity;
pub mod parsers;
pub mod pcap;
pub mod pyats;
pub mod rag;
pub mod rag_seed;
pub mod recording;
pub mod serial;
pub mod sftp;
pub mod sidecar_status;
pub mod ssh;
pub mod ssh_import;
pub mod structured;
pub mod stp;
pub mod topology;
pub mod topolograph;
pub mod troubleshoot;
pub mod vault;

use crate::validation;
use rusqlite::OptionalExtension;
use std::fs;
use std::io::Write;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::path::BaseDirectory;

pub fn ping() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("pong @ {}", ts)
}

#[tauri::command]
pub fn ping_cmd() -> String {
    ping()
}

#[tauri::command]
pub fn dictation_start(state: State<AppState>) -> Result<(), String> {
    state.dictation.start()
}

#[tauri::command]
pub async fn dictation_stop(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let dictation = state.dictation.clone();
    let bundled_model = app
        .path()
        .resolve("models/ggml-base.en.bin", BaseDirectory::Resource)
        .ok();
    tauri::async_runtime::spawn_blocking(move || dictation.stop(bundled_model))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn dictation_cancel(state: State<AppState>) {
    state.dictation.cancel();
}

/// Register the browser-control MCP shim in `mcp_servers` so built-in agents
/// can drive browser windows. Mirrors `enable_stealthwatch_mcp_server`. The
/// shim reads the discovery file for the live port+token, so no creds in env.
pub fn enable_browser_mcp_server(
    db: &std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();
    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let shim_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/browser_mcp.py",
        repo_root
    );
    let command_json = serde_json::json!({ "cmd": python, "args": [shim_path] });

    // Use the shared DB handle (same as enable_stealthwatch_mcp_server) — do
    // NOT open a second connection (lock contention with the primary).
    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('browser-mcp', 'Browser Control', 'stdio', ?1, NULL, NULL, 1)",
        rusqlite::params![serde_json::to_string(&command_json).unwrap()],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Register the packaged Blender MCP server. It connects to the BlenderMCP
/// addon on localhost:9876 by default; the sandbox `blender` helper uses the
/// same addon socket directly so agents can work even before the MCP bridge is
/// fully wired for tool execution.
pub fn enable_blender_mcp_server(
    db: &std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();
    let command_json = serde_json::json!({
        "cmd": python,
        "args": ["-m", "blender_mcp.server"]
    });
    let env_json = serde_json::json!({
        "BLENDER_HOST": "localhost",
        "BLENDER_PORT": "9876"
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('blender-mcp', 'Blender MCP', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct BrowserMcpConfig {
    pub command: String,
    pub args: Vec<String>,
}

#[tauri::command]
pub async fn get_browser_mcp_config() -> Result<BrowserMcpConfig, String> {
    let (python, _) = sidecar_spawn_target();
    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let shim_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/browser_mcp.py",
        repo_root
    );
    Ok(BrowserMcpConfig {
        command: python,
        args: vec![shim_path],
    })
}

/// Resolve the command + args for spawning the Python sidecar.
///
/// Priority:
/// 1. Bundled app: `<resource_dir>/python/bin/python3` (or `python.exe` on
///    Windows) spawned with `-m ccie_sidecar`. Installed by
///    `sidecar/scripts/build_sidecar.sh` and packaged via
///    `tauri.conf.json` `bundle.resources`.
/// 2. Dev mode: `$CCIE_REPO_ROOT/sidecar/.venv/bin/python -m ccie_sidecar`.
pub fn sidecar_spawn_target() -> (String, Vec<String>) {
    if let Some(path) = bundled_python_path() {
        return (
            path.to_string_lossy().into_owned(),
            vec!["-m".to_string(), "ccie_sidecar".to_string()],
        );
    }
    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")))
            .to_string_lossy()
            .to_string()
    });
    let venv_python = if cfg!(windows) {
        format!("{}/sidecar/.venv/Scripts/python.exe", repo_root)
    } else {
        format!("{}/sidecar/.venv/bin/python", repo_root)
    };
    (
        venv_python,
        vec!["-m".to_string(), "ccie_sidecar".to_string()],
    )
}

/// Return the absolute path to the bundled python interpreter, if one is
/// packaged alongside the executable. None means "dev mode, fall back to
/// the repo's .venv". We probe the common Tauri resource layouts:
/// - `<exe_dir>/python/bin/python3` (Linux AppImage, Windows)
/// - `<exe_dir>/../Resources/python/bin/python3` (macOS .app bundle)
fn should_use_bundled_python() -> bool {
    !cfg!(debug_assertions) && std::env::var_os("CCIE_FORCE_VENV").is_none()
}

fn bundled_python_path() -> Option<std::path::PathBuf> {
    // Dev builds should always use sidecar/.venv. A stale target/debug/python
    // tree can otherwise shadow live sidecar edits until manually deleted.
    if !should_use_bundled_python() {
        return None;
    }

    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?.to_path_buf();
    let bin = if cfg!(windows) {
        "python/python.exe"
    } else {
        "python/bin/python3"
    };
    [
        exe_dir.join(bin),
        exe_dir.join("resources").join(bin),
        // macOS .app: Contents/MacOS/<app> → Contents/Resources/python/bin/python3
        exe_dir
            .parent()
            .map(|p| p.join("Resources").join(bin))
            .unwrap_or_default(),
    ]
    .into_iter()
    .find(|base| base.is_file())
}

#[tauri::command]
pub async fn ping_sidecar() -> Result<String, String> {
    use crate::bridge::SidecarHandle;

    let (python, args) = sidecar_spawn_target();
    let mut handle = SidecarHandle::spawn(&python, &args).map_err(|e| e.to_string())?;
    let resp = handle
        .call("ping", serde_json::json!({}))
        .map_err(|e| e.to_string())?;
    handle.shutdown();

    resp.get("result")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("malformed response: {resp}"))
}

use crate::agent_bridge::AgentBridge;
use crate::agents;
use crate::ftp;
use crate::netconf_runner;
use crate::pty::{spawn_pty, PtyEvent, PtyHandle, PtyOptions};
use crate::session;
use crate::shell_integration;
use crate::skills;
use crate::tftp;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc;

/// Side-channel holding oneshot::Receivers for pending agent-tool approvals,
/// keyed by tool_call_id. Populated inside the sync streaming callback (which
/// can't store a Receiver in a serde_json::Value), consumed by the async
/// agent_chat_stream loop.
fn pending_rx_map(
) -> &'static std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Receiver<ApprovalDecision>>> {
    static PENDING_RX_MAP: OnceLock<
        std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Receiver<ApprovalDecision>>>,
    > = OnceLock::new();
    PENDING_RX_MAP.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[allow(non_snake_case)]
fn PENDING_RX(
) -> &'static std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Receiver<ApprovalDecision>>> {
    pending_rx_map()
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyEventEnvelope {
    pub tab_id: String,
    pub event: PtyEvent,
}

pub struct AppState {
    pub ptys: Arc<Mutex<HashMap<String, PtyHandle>>>,
    /// Capability-scoped Network Architect access to explicitly attached PTYs.
    pub terminal_agent: Arc<crate::terminal_agent::TerminalAgentManager>,
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub agent: Arc<AgentBridge>,
    pub mcp_bridge: Arc<crate::mcp::McpBridge>,
    pub skills_loader: Arc<skills::SkillsLoader>,
    pub agents_loader: Arc<agents::AgentsLoader>,
    /// Pending tool-call approvals keyed by tool_call_id. The value is a oneshot sender
    /// that receives the user's decision: "run" / "reject" / edited payload JSON.
    pub pending_approvals:
        Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<ApprovalDecision>>>>,
    /// Map of tab_id -> latest observed block completion event receivers.
    /// When an approved shell command is injected we wait for the next matching CommandEnd.
    pub block_end_waiters:
        Arc<Mutex<HashMap<String, Vec<tokio::sync::oneshot::Sender<(String, Option<i32>)>>>>>,
    /// Per-tab cancellation flags. When set, the agent loop aborts after the
    /// current inflight step. Also used to short-circuit pending approvals.
    pub cancel_flags: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// FTP server lifecycle + event pipeline.
    pub ftp: Arc<ftp::FtpService>,
    /// TFTP server lifecycle + event pipeline.
    pub tftp: Arc<tftp::TftpService>,
    /// Focused USB serial consoles. These sessions never enter the PTY/tab registry.
    pub serial: Arc<crate::commands::serial::SerialService>,
    /// Focused dual-pane SFTP sessions and their single transfer slot.
    pub sftp: Arc<crate::commands::sftp::SftpService>,
    /// API Runner stateful auth orchestrator (token cache, cookie jars).
    pub api_auth: Arc<crate::api_runner::AuthStateStore>,
    /// Hook runner used for `ApiAuth::Hook`. Defaults to the sidecar-backed
    /// implementation; tests can swap in a deterministic runner.
    pub api_hooks: Arc<dyn crate::api_runner::HookRunner>,
    /// Live NETCONF sessions keyed by opaque session_id.
    pub netconf_registry: Arc<crate::netconf_runner::registry::SessionRegistry>,
    /// LSP server process manager for editor language intelligence.
    pub lsp_manager: Arc<crate::lsp::LspManager>,
    /// Zed Mode Phase 5 — Python debug adapter/session authority.
    pub dap_manager: Arc<crate::dap::DapManager>,
    /// SQLite-backed cache for parsed show-output results.
    pub parser_cache: crate::parsers::cache::ParseCache,
    /// Bridge to the Python sidecar's `parse.request` NDJSON method.
    pub parser_bridge: crate::parsers::bridge::ParserBridge,
    /// Live notebook runs — control-channel senders keyed by run_id.
    pub notebook_runs: Arc<crate::commands::notebooks_runnable::RunRegistry>,
    /// Multi-device fan-out executor (Plan 07). Lazily initialized on first
    /// `fanout_run_start` so test harnesses without a Tauri AppHandle can
    /// still construct an `AppState` for store-only assertions.
    pub fanout_executor: Arc<Mutex<Option<crate::fanout::executor::Executor>>>,
    /// Drift scheduler (Plan 08 Phase 5). Lazily initialized on first
    /// `drift_schedule_*` call so unit tests can construct an `AppState`
    /// without a tokio runtime.
    pub drift_scheduler: Arc<Mutex<Option<crate::drift::scheduler::DriftScheduler>>>,
    /// Compiled guardrail ruleset (Plan 09). Initialized from the embedded
    /// builtin set at boot, then merged with user-authored DB rules via
    /// `commands::guardrails::reload_ruleset`. The `RwLock` lets the
    /// classify hot path read concurrently while CRUD calls swap the set.
    pub guardrails_ruleset: Arc<parking_lot::RwLock<crate::guardrails::rules::RuleSet>>,
    /// RAG document store (Plan 12). Shares the same SQLite connection
    /// as `db` so writes stay coherent — opening a second on-disk
    /// connection would race refinery and break vec0 row ordering.
    pub rag_store: crate::rag::store::RagStore,
    /// Bridge to the sidecar's `rag.ingest` NDJSON stream.
    pub rag_bridge: Arc<dyn crate::rag::bridge::RagBridgeApi>,
    /// Plan 14 — Credential vault state (envelope CRUD + idle-lock).
    pub vault: Arc<VaultState>,
    /// Plan 14 — Session recording supervisor.
    pub recording: Arc<crate::recording::supervisor::RecordingSupervisor>,
    /// Plan 15 Phase 2 — In-flight troubleshoot run registry.
    /// Holds per-run cancel flags + prompt-resume oneshot
    /// senders. Lifetime is request-scoped: registered on
    /// `start_run`, removed on terminal status (or `cancel_run`).
    pub troubleshoot: Arc<crate::troubleshoot::state::TroubleshootState>,
    /// AI Assistant Integration Phase 1 — Per-pane activity tracking.
    /// Monitors command execution, output volume, and errors to surface
    /// smart notifications and provide rich context to AI agents.
    pub pane_manager: Arc<crate::pane_context::PaneContextManager>,
    /// Phase 3 — open popup browser windows registry.
    pub browser_manager: Arc<crate::browser::BrowserManager>,
    /// Zed Mode Phase 2 — authoritative cross-webview editor buffers.
    pub editor_buffer_manager: Arc<crate::editor::EditorBufferManager>,
    /// Zed Mode Phase 2 — detached internal editor window metadata.
    pub editor_window_manager: Arc<crate::editor::EditorWindowManager>,
    /// Zed Mode Phase 6 — shared repository discovery, mutation, history, diff,
    /// and watcher authority. Commands remain stateless adapters around it.
    pub git_repository_service: Arc<crate::git::GitRepositoryService>,
    /// Zed Mode Phase 6 — backend-only GitHub OAuth/token authority.
    pub github_auth_manager: Arc<crate::git::GitHubAuthManager>,
    /// Heartbeat Monitoring System — Lazily initialized scheduler for automated
    /// network health checks. Optional so unit tests can construct AppState without
    /// a Tauri AppHandle.
    pub heartbeat_scheduler:
        Arc<parking_lot::Mutex<Option<crate::heartbeat::scheduler::HeartbeatScheduler>>>,
    /// Native STP persistence and full-interval scheduler boundary.
    pub stp: Arc<crate::commands::stp::StpService>,
    pub dictation: Arc<crate::dictation::DictationService>,
}

/// Vault-related state bundle: keyring-backed CRUD store + idle-lock map.
pub struct VaultState {
    pub store: crate::vault::VaultStore,
    pub lock: crate::vault::VaultLock,
}

impl VaultState {
    pub fn new(keyring: Arc<dyn crate::vault::KeyringStore>, idle: std::time::Duration) -> Self {
        Self {
            store: crate::vault::VaultStore::new(keyring),
            lock: crate::vault::VaultLock::new(idle),
        }
    }
}

#[derive(Debug, Clone)]
pub enum ApprovalDecision {
    Run(serde_json::Value), // possibly-edited payload
    Reject,
}

impl AppState {
    pub fn new(db: rusqlite::Connection, db_path: std::path::PathBuf) -> Self {
        let (python, args) = sidecar_spawn_target();
        let agent = Arc::new(AgentBridge::new(python, args));

        let db_arc = Arc::new(Mutex::new(db));

        // Wire sidecar heartbeats into the DB-backed status row so the
        // frontend status chip has something to read. The worker thread owns
        // the DB UPDATE so the supervisor's reader thread doesn't block on a
        // contended `db_arc` lock.
        {
            let hb_tx = sidecar_status::spawn_heartbeat_worker(db_arc.clone());
            agent.supervisor().set_heartbeat_sink(move |hb| {
                // try_send: if the worker's queue is full (DB is stuck), drop
                // the beat rather than block the reader thread. Liveness will
                // recover on the next heartbeat once the queue drains.
                if let Err(e) = hb_tx.try_send(hb) {
                    tracing::warn!(error = %e, "heartbeat: worker queue full, dropping");
                }
            });
        }

        let parser_bridge = crate::parsers::bridge::ParserBridge::new(agent.clone());
        let mcp_bridge = Arc::new(crate::mcp::McpBridge::new());

        let skills_loader = skills::create_loader().expect("Failed to create skills loader");

        // Load all skills on startup
        let _ = skills_loader.load_all();

        let agents_loader = agents::create_loader().expect("Failed to create agents loader");
        // First-run copy of bundled agents is an explicit boot-time write;
        // load_all() itself is a pure read.
        let _ = agents_loader.initialize_bundled_agents();
        let _ = agents_loader.load_all();

        let parser_cache = crate::parsers::cache::ParseCache::from_connection(db_arc.clone());
        let ftp = Arc::new(ftp::FtpService::new(db_arc.clone()));
        let tftp = Arc::new(tftp::TftpService::new(db_arc.clone()));
        let serial = Arc::new(crate::commands::serial::SerialService::new());
        let sftp = Arc::new(crate::commands::sftp::SftpService::new());
        let api_auth = Arc::new(crate::api_runner::AuthStateStore::new());
        let api_hooks: Arc<dyn crate::api_runner::HookRunner> =
            Arc::new(crate::api_runner::SidecarHookRunner::new(agent.clone()));
        // Plan 12 Phase 3: share `db_arc` with the RAG store so RAG
        // writes participate in the same on-disk SQLite database that
        // already had V0039 applied. The bridge is the production
        // sidecar-backed implementation; tests construct AppState
        // through dedicated test helpers if/when needed.
        let rag_store = crate::rag::store::RagStore::new(db_arc.clone());
        let rag_bridge: Arc<dyn crate::rag::bridge::RagBridgeApi> =
            Arc::new(crate::rag::bridge::RagBridge::from_agent_bridge(&agent));

        // Plan 14 — vault + recording. Idle timeout: 4 hours default; the
        // env var `CCIE_VAULT_IDLE_SECS` overrides for dev/testing.
        let idle_secs = std::env::var("CCIE_VAULT_IDLE_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(14400); // 4 hours = 14400 seconds
                               // Use DbKeyringStore instead of OsKeyringStore due to Tauri Keychain access issues.
                               // Security is maintained: values are still encrypted with Argon2id-derived keys.
                               // Uses separate DB connection to avoid deadlocks.
        let keyring: Arc<dyn crate::vault::KeyringStore> = Arc::new(
            crate::vault::DbKeyringStore::new(&db_path).expect("Failed to create DbKeyringStore"),
        );
        let vault = Arc::new(VaultState::new(
            keyring,
            std::time::Duration::from_secs(idle_secs),
        ));
        let recording = Arc::new(crate::recording::supervisor::RecordingSupervisor::new(
            db_arc.clone(),
        ));
        let pane_manager = Arc::new(crate::pane_context::PaneContextManager::new());
        let browser_manager = Arc::new(crate::browser::BrowserManager::new());
        let editor_buffer_manager = Arc::new(crate::editor::EditorBufferManager::new());
        let editor_window_manager = Arc::new(crate::editor::EditorWindowManager::new());
        let git_repository_service = Arc::new(crate::git::GitRepositoryService::new());
        let github_auth_manager = Arc::new(crate::git::GitHubAuthManager::production());
        Self {
            ptys: Arc::new(Mutex::new(HashMap::new())),
            terminal_agent: Arc::new(crate::terminal_agent::TerminalAgentManager::default()),
            db: db_arc.clone(),
            agent,
            mcp_bridge,
            skills_loader,
            agents_loader,
            pending_approvals: Arc::new(Mutex::new(HashMap::new())),
            block_end_waiters: Arc::new(Mutex::new(HashMap::new())),
            cancel_flags: Arc::new(Mutex::new(HashMap::new())),
            ftp,
            tftp,
            serial,
            sftp,
            api_auth,
            api_hooks,
            netconf_registry: Arc::new(crate::netconf_runner::registry::SessionRegistry::new()),
            lsp_manager: Arc::new(crate::lsp::LspManager::new()),
            dap_manager: Arc::new(crate::dap::DapManager::new()),
            parser_cache,
            parser_bridge,
            notebook_runs: crate::commands::notebooks_runnable::RunRegistry::new(),
            fanout_executor: Arc::new(Mutex::new(None)),
            drift_scheduler: Arc::new(Mutex::new(None)),
            guardrails_ruleset: Arc::new(parking_lot::RwLock::new(
                crate::guardrails::rules::RuleSet::load_builtin()
                    .unwrap_or_else(|e| {
                        tracing::error!(error = %e, "guardrails: builtin ruleset failed to load; starting empty");
                        crate::guardrails::rules::RuleSet::empty()
                    }),
            )),
            rag_store,
            rag_bridge,
            vault,
            recording,
            troubleshoot: Arc::new(crate::troubleshoot::state::TroubleshootState::new()),
            pane_manager,
            browser_manager,
            editor_buffer_manager,
            editor_window_manager,
            git_repository_service,
            github_auth_manager,
            heartbeat_scheduler: Arc::new(parking_lot::Mutex::new(None)),
            stp: Arc::new(crate::commands::stp::StpService::new(
                db_arc.clone(),
                Arc::new(crate::commands::stp::SidecarStpCollector),
            )),
            dictation: Arc::new(crate::dictation::DictationService::new()),
        }
    }

    /// Auto-unlock vaults marked with auto_unlock=1 on app startup.
    /// Retrieves passphrases from keyring and unlocks silently.
    pub fn auto_unlock_vaults(&self) {
        let db = self.db.lock();

        // Query all envelopes with auto_unlock enabled
        let mut stmt =
            match db.prepare("SELECT id, name FROM vault_envelopes WHERE auto_unlock = 1") {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "Failed to prepare auto-unlock query");
                    return;
                }
            };

        let envelopes: Vec<(String, String)> = match stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        {
            Ok(e) => e,
            Err(e) => {
                tracing::error!(error = %e, "Failed to query auto-unlock envelopes");
                return;
            }
        };

        if envelopes.is_empty() {
            tracing::info!("[VAULT] No auto-unlock envelopes configured");
            return;
        }

        tracing::info!(
            "[VAULT] Auto-unlock: found {} envelope(s) to unlock",
            envelopes.len()
        );

        for (envelope_id, name) in envelopes {
            // Retrieve passphrase from keyring
            let passphrase = match self.vault.store.get_auto_unlock_passphrase(&envelope_id) {
                Ok(pp) => pp,
                Err(e) => {
                    tracing::error!(
                        envelope_id = %envelope_id,
                        envelope_name = %name,
                        error = %e,
                        "Failed to retrieve auto-unlock passphrase"
                    );
                    continue;
                }
            };

            // Unlock the envelope
            match self
                .vault
                .store
                .unlock_envelope(&db, &self.vault.lock, &name, passphrase)
            {
                Ok(session_id) => {
                    tracing::info!(
                        envelope_id = %envelope_id,
                        envelope_name = %name,
                        session_id = %session_id,
                        "Auto-unlock successful"
                    );
                }
                Err(e) => {
                    tracing::error!(
                        envelope_id = %envelope_id,
                        envelope_name = %name,
                        error = %e,
                        "Auto-unlock failed"
                    );
                }
            }
        }
    }
}

#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    shell: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
    preferred_tab_id: Option<String>,
) -> Result<String, String> {
    tracing::info!(
        shell = %shell,
        args = ?args,
        cwd = %cwd,
        cols = cols,
        rows = rows,
        "Spawning PTY"
    );

    let tab = {
        let db = state.db.lock();
        match preferred_tab_id.as_deref() {
            Some(id) => {
                session::create_tab_with_id(&db, id, &shell, &shell, &cwd).map_err(|e| {
                    tracing::error!(error = %e, "Failed to reuse tab id");
                    e.to_string()
                })?
            }
            None => session::create_tab(&db, &shell, &shell, &cwd).map_err(|e| {
                tracing::error!(error = %e, "Failed to create tab in database");
                e.to_string()
            })?,
        }
    };

    let (tx, mut rx) = mpsc::channel::<PtyEvent>(256);
    let tab_id = tab.id.clone();
    let db = state.db.clone();
    let block_end_waiters = state.block_end_waiters.clone();
    let terminal_agent = state.terminal_agent.clone();
    let pane_manager = state.pane_manager.clone();
    let cwd_for_register = cwd.clone();

    // Export the pane id + app-managed Claude config dir so in-pane agents
    // (claude/codex) report their lifecycle status to the right pane via hooks.
    let claude_config_dir = crate::claude_hooks::config_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());

    let handle = spawn_pty(
        PtyOptions {
            shell,
            args,
            cwd,
            cols,
            rows,
            pane_id: Some(tab.id.clone()),
            claude_config_dir,
        },
        tx,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, tab_id = %tab.id, "Failed to spawn PTY");
        e.to_string()
    })?;

    // Reusing a persisted tab id creates a new PTY generation. Never let a
    // saved-device identity survive across that boundary.
    state.terminal_agent.clear_saved_ssh_binding(&tab.id);
    state.ptys.lock().insert(tab.id.clone(), handle);
    tracing::info!(tab_id = %tab.id, "PTY spawned successfully");

    // Register pane with context manager (using tab_id as pane_id for now)
    state
        .pane_manager
        .register_pane(tab.id.clone(), tab.id.clone(), cwd_for_register);

    let emit_tab_id = tab_id.clone();
    let pane_ctx_tab_id = tab_id.clone();
    let pane_ctx_app = app.clone();
    tokio::spawn(async move {
        let mut current_block: Option<String> = None;
        tracing::info!(tab_id = %emit_tab_id, "Event loop started for tab");
        while let Some(ev) = rx.recv().await {
            terminal_agent.on_pty_event(&emit_tab_id, &ev);
            // Forward PTY events to PaneContextManager for Phase 2 tracking.
            // NOTE: Using tab_id as pane_id temporarily until pane mapping is added.
            // We only emit pane_activity_updated on lifecycle transitions
            // (CommandStart/End/Cwd) — NOT on every Output chunk, which would
            // flood the frontend with hundreds of events per command.
            if let Some((parse_ev, is_lifecycle)) = match &ev {
                PtyEvent::CommandStart { cmd, .. } => Some((
                    crate::command_parser::ParseEvent::CommandStart { cmd: cmd.clone() },
                    true,
                )),
                PtyEvent::CommandEnd { exit_code } => Some((
                    crate::command_parser::ParseEvent::CommandEnd {
                        exit_code: *exit_code,
                    },
                    true,
                )),
                PtyEvent::Cwd { path } => {
                    Some((crate::command_parser::ParseEvent::Cwd(path.clone()), true))
                }
                PtyEvent::EnterAltScreen => {
                    Some((crate::command_parser::ParseEvent::EnterAltScreen, true))
                }
                PtyEvent::ExitAltScreen => {
                    Some((crate::command_parser::ParseEvent::ExitAltScreen, true))
                }
                PtyEvent::Output { bytes } => Some((
                    crate::command_parser::ParseEvent::Output(bytes.clone()),
                    false,
                )),
                PtyEvent::Exit { .. } => None,
            } {
                pane_manager.handle_event(&pane_ctx_tab_id, &emit_tab_id, parse_ev);

                // Emit the updated activity to the frontend so the notification
                // bell and activity indicators react in real time.
                if is_lifecycle {
                    use tauri::Emitter;
                    if let Some(activity) = pane_manager.get_activity(&pane_ctx_tab_id) {
                        tracing::info!(
                            pane_id = %pane_ctx_tab_id,
                            notification_state = ?activity.notification_state,
                            "Emitting pane_activity_updated"
                        );
                        let _ = pane_ctx_app.emit("pane_activity_updated", &activity);
                    }
                }
            }

            {
                let db = db.lock();
                let mut ev_to_send = ev.clone();
                match &ev {
                    PtyEvent::Output { bytes } => {
                        tracing::debug!(tab_id = %emit_tab_id, bytes_len = bytes.len(), "Received output event");
                        // Bounded append: scrollback is a ring buffer for
                        // restore-on-reopen, not durable history. The unbounded
                        // variant let this table grow to ~2.5 GB / 7.8M rows and
                        // slowed every write under the shared DB lock.
                        let _ = session::append_scrollback_with_limit(
                            &db,
                            &emit_tab_id,
                            bytes,
                            session::MAX_SCROLLBACK_BYTES_PER_TAB,
                        );
                        // NOTE: command_blocks rows are owned by the FRONTEND
                        // (blocksStore.addBlock/completeBlock), which stores
                        // ANSI-stripped output + IaC enrichment. We must NOT
                        // also persist a row here or every command shows twice
                        // (with raw escape codes). We only track the current
                        // block id in memory to satisfy block-end waiters.
                    }
                    PtyEvent::CommandStart { cmd, .. } => {
                        // Generate an id for waiters (notebooks/change_verify
                        // resolve a run by this id) WITHOUT persisting a row.
                        let bid = uuid::Uuid::new_v4().to_string();
                        current_block = Some(bid.clone());
                        ev_to_send = PtyEvent::CommandStart {
                            cmd: cmd.clone(),
                            block_id: Some(bid),
                        };
                    }
                    PtyEvent::CommandEnd { exit_code } => {
                        if let Some(bid) = current_block.take() {
                            // Notify any waiters on this tab that a block completed.
                            // (No DB write — see CommandStart note above.)
                            if let Some(waiters) = block_end_waiters
                                .lock()
                                .get_mut(&emit_tab_id)
                                .map(std::mem::take)
                            {
                                for waiter in waiters {
                                    let _ = waiter.send((bid.clone(), *exit_code));
                                }
                            }
                        }
                    }
                    PtyEvent::Cwd { path } => {
                        // Persist the live cwd so it survives a tab reload, and
                        // forward the event so the frontend store tracks it.
                        let _ = db.execute(
                            "UPDATE tabs SET cwd = ?1 WHERE id = ?2",
                            rusqlite::params![path, &emit_tab_id],
                        );
                    }
                    // Alt-screen transitions carry no payload to persist; they
                    // are forwarded as-is so the frontend can react if needed.
                    PtyEvent::EnterAltScreen | PtyEvent::ExitAltScreen => {}
                    PtyEvent::Exit { .. } => {}
                }
                drop(db);
                let _ = pane_ctx_app.emit(
                    "pty-event",
                    PtyEventEnvelope {
                        tab_id: emit_tab_id.clone(),
                        event: ev_to_send.clone(),
                    },
                );
                if let Err(e) = on_event.send(ev_to_send) {
                    tracing::debug!(tab_id = %emit_tab_id, error = ?e, "PTY event subscriber disconnected");
                }
                tracing::trace!(tab_id = %emit_tab_id, "Event sent successfully to frontend");
            }
        }
        tracing::warn!(tab_id = %emit_tab_id, "Event loop exited");
    });

    Ok(tab_id)
}

/// Open a native window for an existing terminal PTY. The source tab is
/// removed by the renderer after this succeeds; the PTY remains owned here
/// until the detached window is closed.
#[tauri::command]
pub fn terminal_detach(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    title: String,
) -> Result<String, String> {
    let tab_id = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    if !state.ptys.lock().contains_key(&tab_id) {
        return Err("terminal PTY is no longer active".to_string());
    }
    let title: String = title
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect();
    let window_id = format!("terminal-{}", uuid::Uuid::new_v4());
    WebviewWindowBuilder::new(
        &app,
        &window_id,
        WebviewUrl::App(format!("index.html?view=terminal-detached&tab_id={tab_id}").into()),
    )
    .title(if title.is_empty() { "Terminal" } else { &title })
    .inner_size(900.0, 650.0)
    .min_inner_size(480.0, 320.0)
    .build()
    .map_err(|error| format!("failed to create detached terminal window: {error}"))?;
    Ok(window_id)
}

#[tauri::command]
pub fn terminal_detached_window_close(app: AppHandle, window_id: String) -> Result<(), String> {
    if !window_id.starts_with("terminal-") {
        return Err("invalid detached terminal window".to_string());
    }
    app.get_webview_window(&window_id)
        .ok_or_else(|| "detached terminal window not found".to_string())?
        .destroy()
        .map_err(|error| format!("failed to destroy detached terminal window: {error}"))
}

#[cfg(any(target_os = "macos", test))]
const SYSTEM_SSH_BINARY: &str = "/usr/bin/ssh";

#[cfg(any(target_os = "macos", test))]
fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "_@%+=:,./-".contains(character))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(any(target_os = "macos", test))]
fn build_saved_ssh_argv(
    host: &str,
    user: Option<&str>,
    port: Option<i64>,
    identity_file: Option<&str>,
) -> Vec<String> {
    let destination = user
        .filter(|value| !value.is_empty())
        .map(|value| format!("{value}@{host}"))
        .unwrap_or_else(|| host.to_string());
    let mut parts = vec![
        SYSTEM_SSH_BINARY.to_string(),
        "-p".to_string(),
        port.unwrap_or(22).to_string(),
        "-o".to_string(),
        format!("HostName={host}"),
    ];
    if let Some(identity_file) = identity_file.filter(|value| !value.is_empty()) {
        parts.push("-i".to_string());
        parts.push(identity_file.to_string());
    }
    // End option parsing before the destination. Saved fields are shell-quoted,
    // and `--` also prevents a leading dash in an imported user/host value from
    // being reinterpreted as another OpenSSH option.
    parts.push("--".to_string());
    parts.push(destination);
    parts
}

#[cfg(any(target_os = "macos", test))]
fn build_saved_ssh_command(argv: &[String]) -> String {
    argv.iter()
        .map(|argument| shell_quote(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(any(target_os = "macos", test))]
fn matches_saved_ssh_process(executable: &str, argv: &[String], expected_argv: &[String]) -> bool {
    executable == SYSTEM_SSH_BINARY && argv == expected_argv
}

/// Launch a saved SSH connection from backend-owned database fields, then bind
/// its kernel-observed process generation. The renderer never supplies or
/// writes the command and therefore cannot attest a different endpoint.
#[tauri::command]
pub async fn terminal_launch_saved_ssh(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, tab_id, connection_id);
        Err("saved SSH terminal verification is not supported on this OS".into())
    }

    #[cfg(target_os = "macos")]
    {
        let validated_tab_id = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
        let saved: Option<(String, Option<String>, Option<i64>, Option<String>)> = state
            .db
            .lock()
            .query_row(
                "SELECT host, user, port, identity_file FROM ssh_connections WHERE id = ?1",
                rusqlite::params![&connection_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let (host, user, port, identity_file) =
            saved.ok_or_else(|| "saved SSH connection no longer exists".to_string())?;
        let expected_argv =
            build_saved_ssh_argv(&host, user.as_deref(), port, identity_file.as_deref());
        let command = build_saved_ssh_command(&expected_argv);
        state
            .terminal_agent
            .revoke_for_pty(&validated_tab_id, "user takeover");
        let (launch_nonce, baseline_process_group_id) = state
            .terminal_agent
            .begin_saved_ssh_launch_and_write(&validated_tab_id, || {
                let ptys = state.ptys.lock();
                let handle = ptys
                    .get(&validated_tab_id)
                    .ok_or_else(|| "terminal PTY is no longer active".to_string())?;
                let (process_group_id, executable, _) =
                    handle.foreground_process_identity().ok_or_else(|| {
                        "could not verify the terminal foreground process".to_string()
                    })?;
                let executable = executable
                    .rsplit('/')
                    .next()
                    .unwrap_or("")
                    .trim_start_matches('-');
                if !matches!(executable, "zsh" | "bash" | "sh" | "fish" | "nu" | "pwsh") {
                    return Err("saved SSH launch requires a verified local shell prompt".into());
                }
                // Clear any partially typed prompt input, then submit the one
                // backend-owned command while competing PTY writes are locked out.
                handle
                    .write(format!("\u{3}{command}\r").as_bytes())
                    .map_err(|error| error.to_string())?;
                Ok(process_group_id)
            })?;
        for _ in 0..100 {
            let identity = {
                let ptys = state.ptys.lock();
                let handle = ptys
                    .get(&validated_tab_id)
                    .ok_or_else(|| "terminal PTY is no longer active".to_string())?;
                handle.foreground_process_identity()
            };
            if let Some((process_group_id, executable, argv)) = identity {
                if process_group_id != baseline_process_group_id
                    && matches_saved_ssh_process(&executable, &argv, &expected_argv)
                {
                    state.terminal_agent.complete_saved_ssh_launch(
                        &validated_tab_id,
                        &launch_nonce,
                        &connection_id,
                        process_group_id,
                    )?;
                    return Ok(());
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        state
            .terminal_agent
            .cancel_saved_ssh_launch(&validated_tab_id);
        Err("could not verify the saved SSH process in the focused PTY".into())
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, tab_id: String, data: Vec<u8>) -> Result<(), String> {
    // Validate tab_id to prevent injection
    let validated_tab_id = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;

    // Human input always wins. Revoke before writing, but never swallow the
    // operator's keystroke.
    state
        .terminal_agent
        .revoke_for_pty(&validated_tab_id, "user takeover");
    state
        .terminal_agent
        .cancel_saved_ssh_launch_and_write(&validated_tab_id, || {
            let ptys = state.ptys.lock();
            let h = ptys
                .get(&validated_tab_id)
                .ok_or_else(|| "tab not found".to_string())?;
            h.write(&data).map_err(|e| e.to_string())
        })
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    tab_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Validate tab_id
    let validated_tab_id = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;

    let ptys = state.ptys.lock();
    let h = ptys
        .get(&validated_tab_id)
        .ok_or_else(|| "tab not found".to_string())?;
    h.resize(cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    // Validate tab_id
    let validated_tab_id = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;

    state
        .terminal_agent
        .revoke_for_pty(&validated_tab_id, "PTY closed");
    state
        .terminal_agent
        .clear_saved_ssh_binding(&validated_tab_id);
    let h = state.ptys.lock().remove(&validated_tab_id);
    if let Some(h) = h {
        let _ = h.kill();
    }
    let db = state.db.lock();
    session::close_tab(&db, &validated_tab_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_tabs(state: State<'_, AppState>) -> Result<Vec<session::Tab>, String> {
    let db = state.db.lock();
    session::list_open_tabs(&db).map_err(|e| e.to_string())
}

/// Tabs that are valid **pipe targets** right now — terminal tabs in the
/// DB whose PTY is still live in the `AppState::ptys` map.
///
/// `list_tabs` returns every row with `closed_at IS NULL`, which includes
/// stale rows from app restarts where the PTY died without a clean close.
/// The API Runner's PipeMenu uses this command instead so users only see
/// terminals they can actually pipe into.
#[tauri::command]
pub fn list_pipe_targets(state: State<'_, AppState>) -> Result<Vec<session::Tab>, String> {
    let live: std::collections::HashSet<String> = {
        let ptys = state.ptys.lock();
        ptys.keys().cloned().collect()
    };
    let db = state.db.lock();
    let all = session::list_open_tabs(&db).map_err(|e| e.to_string())?;
    Ok(all
        .into_iter()
        .filter(|t| t.tab_type == "terminal" && live.contains(&t.id))
        .collect())
}

/// Create an API Runner tab. Unlike `pty_spawn`, this does NOT start a shell process;
/// it only inserts a row with `tab_type='api'` plus a companion `api_tab_state` row.
#[tauri::command]
pub fn tab_new_api(
    state: State<'_, AppState>,
    title: String,
    target_id: Option<String>,
    environment: Option<String>,
) -> Result<session::Tab, String> {
    tracing::info!(
        title = %title,
        target = ?target_id,
        env = ?environment,
        "Creating API tab"
    );
    let db = state.db.lock();
    session::create_api_tab(&db, &title, target_id.as_deref(), environment.as_deref()).map_err(
        |e| {
            tracing::error!(error = %e, "Failed to create API tab");
            e.to_string()
        },
    )
}

/// Close an API Runner tab (no PTY, just a DB close). Safe to call even if
/// the tab has already been closed.
#[tauri::command]
pub fn tab_close_api(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let validated = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    let db = state.db.lock();
    session::close_tab(&db, &validated).map_err(|e| e.to_string())
}

/// Create a NETCONF tab. Like `tab_new_api`, this does NOT spawn a PTY —
/// it inserts a row with `tab_type='netconf'` plus a companion
/// `netconf_tab_state` row. Sessions open lazily via `netconf_connect`.
#[tauri::command]
pub fn tab_new_netconf(state: State<'_, AppState>, title: String) -> Result<session::Tab, String> {
    tracing::info!(title = %title, "Creating NETCONF tab");
    let db = state.db.lock();
    netconf_runner::session_store::create_netconf_tab(&db, &title).map_err(|e| {
        tracing::error!(error = %e, "Failed to create NETCONF tab");
        e.to_string()
    })
}

/// Close a NETCONF tab (no PTY, just a DB close). Safe to call repeatedly.
/// Does NOT tear down an active sidecar session — that is the caller's
/// responsibility via `netconf_disconnect`.
#[tauri::command]
pub fn tab_close_netconf(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let validated = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    let db = state.db.lock();
    session::close_tab(&db, &validated).map_err(|e| e.to_string())
}

/// Create a Subnet Calculator tab. Like API/NETCONF tabs, this does NOT
/// spawn a PTY — it only inserts a row with `tab_type='subnet'`.
#[tauri::command]
pub fn tab_new_subnet(state: State<'_, AppState>, title: String) -> Result<session::Tab, String> {
    tracing::info!(title = %title, "Creating Subnet Calculator tab");
    let db = state.db.lock();
    session::create_subnet_tab(&db, &title).map_err(|e| {
        tracing::error!(error = %e, "Failed to create subnet tab");
        e.to_string()
    })
}

/// Close a Subnet Calculator tab (no PTY, just a DB close).
#[tauri::command]
pub fn tab_close_subnet(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let validated = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    let db = state.db.lock();
    session::close_tab(&db, &validated).map_err(|e| e.to_string())
}

/// Create an Editor tab. Like API/NETCONF tabs, this does NOT spawn a PTY.
#[tauri::command]
pub fn tab_new_editor(
    state: State<'_, AppState>,
    title: String,
    file_path: Option<String>,
) -> Result<session::Tab, String> {
    tracing::info!(
        title = %title,
        file_path = ?file_path,
        "Creating Editor tab"
    );
    let db = state.db.lock();
    session::create_editor_tab(&db, &title, file_path.as_deref()).map_err(|e| {
        tracing::error!(error = %e, "Failed to create Editor tab");
        e.to_string()
    })
}

/// Close an Editor tab (no PTY, just a DB close). Safe to call repeatedly.
#[tauri::command]
pub async fn tab_close_editor(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let validated = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    crate::commands::editor_windows::close_detached_editor_windows_for_tab(
        &app,
        &state.editor_window_manager,
        &validated,
    )?;
    state.dap_manager.remove_tab(&validated).await;
    let db = state.db.lock();
    session::close_tab(&db, &validated).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct NetconfConnectResult {
    pub session_id: String,
    pub server_session_id: u64,
    pub capabilities: Vec<String>,
    pub framing: String,
}

/// Open a NETCONF session over SSH, do the hello exchange, return an opaque
/// session_id the frontend can use for subsequent `netconf_send_rpc` calls
/// plus the device's advertised capabilities.
#[tauri::command]
pub async fn netconf_connect(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<NetconfConnectResult, String> {
    use crate::netconf_runner::{session::Session, transport::ConnectArgs};
    use std::time::Duration;

    let registry = state.netconf_registry.clone();
    let session = Session::open(ConnectArgs {
        host: host.clone(),
        port,
        username,
        password,
        connect_timeout: Duration::from_secs(15),
    })
    .await
    .map_err(|e| e.to_string())?;

    let server_session_id = session.server_session_id;
    let capabilities = session.capabilities.clone();
    let framing = match session.framing {
        crate::netconf_runner::hello::Framing::EndOfMessage => "1.0".to_string(),
        crate::netconf_runner::hello::Framing::Chunked => "1.1".to_string(),
    };
    let session_id = registry.insert(session);

    tracing::info!(host = %host, port = port, session_id = %session_id, "NETCONF session opened");

    Ok(NetconfConnectResult {
        session_id,
        server_session_id,
        capabilities,
        framing,
    })
}

/// Send one `<rpc>` over an existing session, return the raw `<rpc-reply>` XML.
/// Records the RPC in history with timing and error information.
#[tauri::command]
pub async fn netconf_send_rpc(
    state: State<'_, AppState>,
    tab_id: Option<String>,
    session_id: String,
    host: String,
    rpc_xml: String,
) -> Result<String, String> {
    let session = state
        .netconf_registry
        .get(&session_id)
        .map_err(|e| e.to_string())?;

    let start = std::time::Instant::now();
    let result = session.send_rpc(&rpc_xml).await;
    let duration_ms = start.elapsed().as_millis() as i64;

    // Extract operation from RPC (simple heuristic)
    let operation = if rpc_xml.contains("<get-config") {
        "get-config"
    } else if rpc_xml.contains("<get>") {
        "get"
    } else if rpc_xml.contains("<edit-config") {
        "edit-config"
    } else if rpc_xml.contains("<action") {
        "action"
    } else {
        "rpc"
    };

    // Record history
    let db = state.db.lock();
    match &result {
        Ok(response) => {
            let _ = crate::netconf_runner::history::insert(
                &db,
                tab_id.as_deref(),
                None, // device_id - TODO: track in session
                &host,
                operation,
                None, // target_datastore - TODO: parse from request
                &rpc_xml,
                Some(response),
                "success",
                None,
                Some(duration_ms),
            );
        }
        Err(e) => {
            let _ = crate::netconf_runner::history::insert(
                &db,
                tab_id.as_deref(),
                None,
                &host,
                operation,
                None,
                &rpc_xml,
                None,
                "error",
                Some(&e.to_string()),
                Some(duration_ms),
            );
        }
    }
    drop(db);

    result.map_err(|e| e.to_string())
}

/// List all saved NETCONF devices (passwords excluded).
#[tauri::command]
pub fn netconf_device_list(
    state: State<'_, AppState>,
) -> Result<Vec<crate::netconf_runner::devices::SavedDevice>, String> {
    let db = state.db.lock();
    crate::netconf_runner::devices::list_devices(&db).map_err(|e| e.to_string())
}

/// Create a new saved NETCONF device. Password stored in OS keychain.
#[tauri::command]
pub fn netconf_device_create(
    state: State<'_, AppState>,
    name: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    verify_host_key: bool,
) -> Result<crate::netconf_runner::devices::SavedDevice, String> {
    let db = state.db.lock();
    crate::netconf_runner::devices::create_device(
        &db,
        &name,
        &host,
        port,
        &username,
        &password,
        verify_host_key,
    )
    .map_err(|e| e.to_string())
}

/// Delete a saved NETCONF device (also removes password from keychain).
#[tauri::command]
pub fn netconf_device_delete(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let db = state.db.lock();
    crate::netconf_runner::devices::delete_device(&db, id).map_err(|e| e.to_string())
}

/// Retrieve a device's password from the OS keychain.
#[tauri::command]
pub fn netconf_device_get_password(id: i64) -> Result<String, String> {
    crate::netconf_runner::devices::get_password(id).map_err(|e| e.to_string())
}

/// Wrap CLI text into a NETCONF `<rpc>` for the given platform.
/// Returns XML ready to send via `netconf_send_rpc`.
#[tauri::command]
pub fn netconf_wrap_cli(platform: String, cli_text: String) -> Result<String, String> {
    let plat = match platform.to_lowercase().as_str() {
        "iosxe" | "ios-xe" | "ios_xe" => crate::netconf_runner::cli_wrapper::Platform::IosXe,
        "nxos" | "nx-os" | "nx_os" => crate::netconf_runner::cli_wrapper::Platform::NxOs,
        _ => return Err(format!("unknown platform: {platform}")),
    };
    crate::netconf_runner::cli_wrapper::wrap(plat, &cli_text).map_err(|e| e.to_string())
}

/// List NETCONF history for a tab.
#[tauri::command]
pub fn netconf_history_list(
    state: State<'_, AppState>,
    tab_id: String,
    limit: i64,
    offset: i64,
) -> Result<Vec<crate::netconf_runner::history::HistoryItem>, String> {
    let db = state.db.lock();
    crate::netconf_runner::history::list_for_tab(&db, &tab_id, limit, offset)
        .map_err(|e| e.to_string())
}

/// Get full NETCONF history detail by ID.
#[tauri::command]
pub fn netconf_history_detail(
    state: State<'_, AppState>,
    id: String,
) -> Result<crate::netconf_runner::history::HistoryDetail, String> {
    let db = state.db.lock();
    crate::netconf_runner::history::get_detail(&db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn netconf_saved_rpc_list(
    state: State<'_, AppState>,
) -> Result<Vec<crate::netconf_runner::saved_rpcs::SavedNetconfRpc>, String> {
    let db = state.db.lock();
    crate::netconf_runner::saved_rpcs::list(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn netconf_saved_rpc_upsert(
    state: State<'_, AppState>,
    id: Option<i64>,
    name: String,
    rpc_xml: String,
) -> Result<crate::netconf_runner::saved_rpcs::SavedNetconfRpc, String> {
    let db = state.db.lock();
    crate::netconf_runner::saved_rpcs::upsert(&db, id, &name, &rpc_xml).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn netconf_saved_rpc_delete(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let db = state.db.lock();
    crate::netconf_runner::saved_rpcs::delete(&db, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn yang_release_list(
    state: State<'_, AppState>,
) -> Result<Vec<crate::netconf_runner::yang_cache::YangRelease>, String> {
    let db = state.db.lock();
    crate::netconf_runner::yang_cache::list_releases(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn yang_release_delete(state: State<'_, AppState>, release_id: i64) -> Result<(), String> {
    let db = state.db.lock();
    let release = crate::netconf_runner::yang_cache::get_release(&db, release_id)
        .map_err(|e| e.to_string())?;

    // Delete from database
    crate::netconf_runner::yang_cache::delete_release(&db, release_id)
        .map_err(|e| e.to_string())?;

    // Delete cache directory
    let cache_path = std::path::Path::new(&release.cache_dir);
    if cache_path.exists() {
        std::fs::remove_dir_all(cache_path)
            .map_err(|e| format!("Failed to delete cache directory: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn yang_module_list(
    state: State<'_, AppState>,
    release_id: i64,
    query: Option<String>,
) -> Result<Vec<crate::netconf_runner::yang_cache::YangModule>, String> {
    let db = state.db.lock();
    crate::netconf_runner::yang_cache::list_modules(&db, release_id, query.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn yang_release_download(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    vendor: String,
    os: String,
    release: String,
) -> Result<i64, String> {
    let cache_base = crate::netconf_runner::yang_cache::cache_base().map_err(|e| e.to_string())?;

    let params = serde_json::json!({
        "vendor": vendor,
        "os": os,
        "release": release,
        "cache_base": cache_base.to_string_lossy(),
    });

    let app_handle = app.clone();
    let modules = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let modules_clone = modules.clone();

    // Call sidecar with streaming to get progress events
    eprintln!(
        "=== Starting YANG download stream for {}/{}/{} ===",
        vendor, os, release
    );
    tracing::info!(
        "Starting YANG download stream for {}/{}/{}",
        vendor,
        os,
        release
    );
    let result = state
        .agent
        .call_stream_ex("yang_download", params, move |event| {
            let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

            eprintln!("=== YANG event: {} ===", event_type);
            tracing::info!("YANG download event: {} - {:?}", event_type, event);

            match event_type {
                "progress" => {
                    if let Some(data) = event.get("data") {
                        // Check if this is a module batch
                        if data.get("type").and_then(|v| v.as_str()) == Some("module_batch") {
                            if let Some(batch) = data.get("modules").and_then(|v| v.as_array()) {
                                let mut mods = modules_clone.lock().unwrap();
                                mods.extend(batch.iter().cloned());
                            }
                        } else {
                            // Regular progress - emit to frontend
                            use tauri::Emitter;
                            let _ = app_handle.emit("yang-download-progress", data);
                        }
                    }
                }
                "done" => {
                    tracing::info!("YANG download complete - received done event in callback");
                }
                "error" => {
                    if let Some(msg) = event.get("message").and_then(|v| v.as_str()) {
                        tracing::error!("YANG download error: {}", msg);
                    }
                }
                _ => {}
            }
            Ok(())
        })
        .await
        .map_err(|e| {
            eprintln!("=== call_stream_ex FAILED: {} ===", e);
            tracing::error!("call_stream_ex failed: {}", e);
            e.to_string()
        })?;

    eprintln!("=== call_stream_ex returned successfully ===");
    tracing::info!("call_stream_ex returned successfully");

    let modules = std::sync::Arc::try_unwrap(modules)
        .map(|mutex| mutex.into_inner().unwrap())
        .unwrap_or_else(|arc| arc.lock().unwrap().clone());

    // Extract cache_dir from final result (modules already collected in callback)
    eprintln!(
        "=== Extracting result, modules collected: {} ===",
        modules.len()
    );
    tracing::info!("YANG download result: {:?}", result);
    let cache_dir = result
        .get("cache_dir")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| "No cache_dir in response".to_string())?;

    tracing::info!(
        "Extracted cache_dir: {:?}, modules count: {}",
        cache_dir,
        modules.len()
    );

    // Insert into database
    let db = state.db.lock();
    let source_path = format!("github.com/YangModels/yang/{}/{}/{}", vendor, os, release);
    let release_id = crate::netconf_runner::yang_cache::insert_release(
        &db,
        &vendor,
        &os,
        &release,
        &source_path,
        &cache_dir,
    )
    .map_err(|e| e.to_string())?;

    // Insert modules
    for module in modules {
        let name = module.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let namespace = module.get("namespace").and_then(|v| v.as_str());
        let revision = module.get("revision").and_then(|v| v.as_str());
        let file_path = module
            .get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        crate::netconf_runner::yang_cache::insert_module(
            &db, release_id, name, namespace, revision, file_path,
        )
        .map_err(|e| e.to_string())?;
    }

    // Update module count
    crate::netconf_runner::yang_cache::update_module_count(&db, release_id)
        .map_err(|e| e.to_string())?;

    Ok(release_id)
}

#[tauri::command]
pub async fn yang_module_content(file_path: String) -> Result<String, String> {
    std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read YANG file: {}", e))
}

#[tauri::command]
pub async fn yang_explain_module(
    state: State<'_, AppState>,
    module_name: String,
    yang_content: String,
) -> Result<String, String> {
    let params = serde_json::json!({
        "module_name": module_name,
        "yang_content": yang_content,
        "profile": "default",
    });

    let response = state
        .agent
        .call("explain_yang_module", params)
        .await
        .map_err(|e| e.to_string())?;

    match response {
        crate::agent_bridge::AgentResponse::Done { result } => result
            .get("summary")
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| "No summary in response".to_string()),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("Unexpected response type".to_string()),
    }
}

/// Execute one API request and return the response. Also logs the attempt
/// (success or failure) to `api_history` for later recall.
///
/// If `environment` is supplied, we load that env's variables and run the
/// resolver over URL/headers/query/body/auth before dispatching. Unresolved
/// placeholders produce an error response (not a silent empty-string expansion).
#[tauri::command]
pub async fn api_send_request(
    state: State<'_, AppState>,
    tab_id: Option<String>,
    target_id: Option<String>,
    environment: Option<String>,
    request: crate::api_runner::ApiRequest,
) -> Result<crate::api_runner::ApiResponse, String> {
    let validated_tab = match tab_id.as_deref() {
        Some(t) => Some(validation::validate_tab_id(t).map_err(|e| e.to_string())?),
        None => None,
    };
    tracing::info!(
        tab_id = ?validated_tab,
        target = ?target_id,
        env = ?environment,
        method = request.method.as_str(),
        url = %request.url,
        "api_send_request"
    );

    // Build the resolver context for the requested environment, if any.
    let mut ctx = match environment.as_deref() {
        Some(env) => build_resolver_context(env).map_err(|e| e.to_string())?,
        None => crate::api_runner::resolver::ResolverContext::default(),
    };
    // Step 7: pre-load any `${response.NAME...}` references from history.
    preload_response_refs(&state.db, &mut ctx, &request);

    let mut resolved_request = request;
    if let Err(err) = crate::api_runner::resolver::resolve_request(&mut resolved_request, &ctx) {
        // Log the failure AS a history row so the user sees it in history.
        let db = state.db.clone();
        let err_msg = format!("resolve failed: {err}");
        let fake = crate::api_runner::ApiResponse {
            status_code: 0,
            status_text: String::new(),
            headers: std::collections::BTreeMap::new(),
            body: Vec::new(),
            body_truncated: false,
            duration_ms: 0,
            final_url: resolved_request.url.clone(),
            error: Some(err_msg.clone()),
        };
        let _ = write_history_row(&db, validated_tab.as_deref(), &resolved_request, &fake);
        return Ok(fake);
    }

    // Do NOT hold the DB lock across await — the request can take seconds,
    // and parking_lot::Mutex + tokio is a deadlock footgun.
    let request_for_log = resolved_request.clone();
    let db = state.db.clone();

    // Route through the auth orchestrator. Stateless auth types pass
    // straight through to `execute_request`; stateful ones (token_login,
    // session_cookie, hook) run their flows against the cached state keyed
    // by (target_id, environment).
    let cache_key = crate::api_runner::AuthCacheKey::new(
        target_id.unwrap_or_default(),
        environment.unwrap_or_default(),
    );
    let response = state
        .api_auth
        .send(cache_key, resolved_request, state.api_hooks.clone())
        .await;

    if let Err(err) = write_history_row(&db, validated_tab.as_deref(), &request_for_log, &response)
    {
        tracing::warn!(error = %err, "failed to write api_history row");
    }

    Ok(response)
}

/// Load one environment's vars from disk into a ResolverContext.
fn build_resolver_context(
    env: &str,
) -> anyhow::Result<crate::api_runner::resolver::ResolverContext> {
    let dir = crate::config::api_environments_dir()?;
    let mut ctx = crate::api_runner::resolver::ResolverContext::default();
    for v in crate::api_runner::env_store::load_env(&dir, env)? {
        ctx.insert(v.key, v.value);
    }
    Ok(ctx)
}

/// Scan the request for `${response.NAME...}` placeholders and pre-load
/// the corresponding saved-request bodies into the resolver context so
/// the resolver can substitute them. Any referenced saved request that
/// has never been successfully sent stays absent — the resolver will
/// then return an Unresolved error naming it, which is the behavior we
/// want (user sees "oh, I need to run `list-orgs` first").
fn preload_response_refs(
    db: &std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
    ctx: &mut crate::api_runner::resolver::ResolverContext,
    request: &crate::api_runner::ApiRequest,
) {
    let mut names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    fn scan(target: &mut std::collections::BTreeSet<String>, s: &str) {
        // Walk for `${response.NAME.` and `${response.NAME}` patterns.
        let bytes = s.as_bytes();
        let mut i = 0;
        while i + 10 < bytes.len() {
            if &bytes[i..i + 11] == b"${response." {
                let start = i + 11;
                let mut j = start;
                while j < bytes.len() && bytes[j] != b'.' && bytes[j] != b'}' {
                    j += 1;
                }
                if let Ok(name) = std::str::from_utf8(&bytes[start..j]) {
                    if !name.is_empty() {
                        target.insert(name.to_string());
                    }
                }
                i = j;
            } else {
                i += 1;
            }
        }
    }
    scan(&mut names, &request.url);
    for (k, v) in &request.headers {
        scan(&mut names, k);
        scan(&mut names, v);
    }
    for (k, v) in &request.query {
        scan(&mut names, k);
        scan(&mut names, v);
    }
    if let Some(b) = &request.body_text {
        scan(&mut names, b);
    }
    if names.is_empty() {
        return;
    }
    let db = db.lock();
    for name in names {
        if let Ok(Some(body)) = crate::api_runner::history::lookup_latest_response_body(&db, &name)
        {
            ctx.insert_response(name, &body);
        }
    }
}

fn write_history_row(
    db: &Arc<Mutex<rusqlite::Connection>>,
    tab_id: Option<&str>,
    request: &crate::api_runner::ApiRequest,
    response: &crate::api_runner::ApiResponse,
) -> anyhow::Result<()> {
    use rusqlite::params;
    let db = db.lock();
    let id = uuid::Uuid::new_v4().to_string();

    let request_headers_json = serde_json::to_string(&request.headers)?;
    let response_headers_json = serde_json::to_string(&response.headers)?;

    let body_bytes: Option<&[u8]> = if response.body.is_empty() {
        None
    } else {
        Some(response.body.as_slice())
    };
    let req_body: Option<&[u8]> = request.body_bytes.as_deref();

    db.execute(
        r#"INSERT INTO api_history
           (id, tab_id, target_id, environment, method, url,
            request_headers_json, request_body,
            status_code, response_headers_json, response_body,
            response_body_truncated, duration_ms, error)
           VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        params![
            id,
            tab_id,
            request.method.as_str(),
            request.url,
            request_headers_json,
            req_body,
            if response.status_code == 0 {
                None
            } else {
                Some(response.status_code as i64)
            },
            response_headers_json,
            body_bytes,
            response.body_truncated as i64,
            response.duration_ms as i64,
            response.error.clone(),
        ],
    )?;
    Ok(())
}

// ---- Step 3: target manifests + OpenAPI ---------------------------------

/// Summary response for `api_list_targets`. Includes resolved endpoint
/// catalog size for the UI's loading indicator.
#[derive(serde::Serialize)]
pub struct ApiTargetListResponse {
    pub targets: Vec<crate::api_runner::TargetSummary>,
}

/// Detail response for `api_get_target`. Returns the parsed manifest plus
/// the resolved endpoint catalog (inline from manifest for Step 3;
/// OpenAPI-imported endpoints are served via `api_import_openapi`).
#[derive(serde::Serialize)]
pub struct ApiTargetDetailResponse {
    pub manifest: crate::api_runner::TargetManifest,
    pub endpoints: Vec<crate::api_runner::Endpoint>,
    pub builtin: bool,
}

fn load_all_targets() -> anyhow::Result<crate::api_runner::catalog::LoadedTargets> {
    let builtin_dir = crate::config::api_targets_builtin_dir()?;
    let user_dir = crate::config::api_targets_dir()?;
    // Seed builtin manifests (idempotent; skips existing files).
    crate::api_runner::catalog::seed_builtin_manifests(&builtin_dir)?;
    crate::api_runner::catalog::load_all(&builtin_dir, &user_dir)
}

#[tauri::command]
pub fn api_list_targets() -> Result<ApiTargetListResponse, String> {
    let loaded = load_all_targets().map_err(|e| e.to_string())?;
    Ok(ApiTargetListResponse {
        targets: loaded.summaries(),
    })
}

#[tauri::command]
pub fn api_get_target(id: String) -> Result<ApiTargetDetailResponse, String> {
    let loaded = load_all_targets().map_err(|e| e.to_string())?;
    let manifest = loaded
        .find(&id)
        .ok_or_else(|| format!("target not found: {id}"))?
        .clone();
    let builtin = loaded.builtin.iter().any(|(m, _)| m.id == id);
    let endpoints = crate::api_runner::catalog::catalog_for_manifest(&manifest);
    Ok(ApiTargetDetailResponse {
        manifest,
        endpoints,
        builtin,
    })
}

// ---- Environments + credentials (Step 4) --------------------------------

#[tauri::command]
pub fn api_list_environments() -> Result<Vec<String>, String> {
    let dir = crate::config::api_environments_dir().map_err(|e| e.to_string())?;
    crate::api_runner::env_store::list_environments(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_create_environment(name: String) -> Result<bool, String> {
    let dir = crate::config::api_environments_dir().map_err(|e| e.to_string())?;
    crate::api_runner::env_store::create_environment(&dir, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_delete_environment(name: String) -> Result<(), String> {
    let dir = crate::config::api_environments_dir().map_err(|e| e.to_string())?;
    crate::api_runner::env_store::delete_environment(&dir, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_get_env_vars(
    environment: String,
) -> Result<Vec<crate::api_runner::env_store::EnvVar>, String> {
    let dir = crate::config::api_environments_dir().map_err(|e| e.to_string())?;
    crate::api_runner::env_store::load_env(&dir, &environment).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_set_env_var(
    environment: String,
    key: String,
    value: String,
    is_secret: bool,
) -> Result<(), String> {
    let dir = crate::config::api_environments_dir().map_err(|e| e.to_string())?;
    // Ensure the env exists before setting — a set on a missing env creates it.
    let _ = crate::api_runner::env_store::create_environment(&dir, &environment)
        .map_err(|e| e.to_string())?;
    crate::api_runner::env_store::set_var(&dir, &environment, &key, &value, is_secret)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_delete_env_var(environment: String, key: String) -> Result<(), String> {
    let dir = crate::config::api_environments_dir().map_err(|e| e.to_string())?;
    crate::api_runner::env_store::delete_var(&dir, &environment, &key).map_err(|e| e.to_string())
}

// ---- Step 7: history + saved requests ----------------------------------

/// Tab-scoped history listing for the history drawer.
#[tauri::command]
pub fn api_list_history(
    state: State<'_, AppState>,
    tab_id: Option<String>,
    saved_request_id: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<crate::api_runner::history::HistoryRow>, String> {
    let validated_tab = match tab_id.as_deref() {
        Some(t) => Some(validation::validate_tab_id(t).map_err(|e| e.to_string())?),
        None => None,
    };
    let filter = crate::api_runner::history::HistoryFilter {
        tab_id: validated_tab,
        saved_request_id,
        limit: limit.unwrap_or(100).min(1000),
        offset: offset.unwrap_or(0),
    };
    let db = state.db.lock();
    crate::api_runner::history::list_history(&db, &filter).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_get_history_detail(
    state: State<'_, AppState>,
    id: String,
) -> Result<crate::api_runner::history::HistoryDetail, String> {
    let db = state.db.lock();
    crate::api_runner::history::get_history_detail(&db, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("history row not found: {id}"))
}

#[derive(Debug, serde::Deserialize)]
pub struct SaveRequestInput {
    pub name: String,
    pub target_id: Option<String>,
    pub environment: Option<String>,
    pub method: String,
    pub url: String,
    /// Serialized map (JSON object). The frontend already carries headers
    /// as a record; we serialize to text here so the DB column stays the
    /// same whether the user is on an API or Custom tab.
    pub headers_json: String,
    pub query_json: String,
    pub body_kind: String,
    pub body_text: Option<String>,
}

#[tauri::command]
pub fn api_save_request(
    state: State<'_, AppState>,
    input: SaveRequestInput,
) -> Result<crate::api_runner::history::SavedRequestRow, String> {
    let db = state.db.lock();
    crate::api_runner::history::save_request(
        &db,
        crate::api_runner::history::NewSavedRequest {
            name: &input.name,
            target_id: input.target_id.as_deref(),
            environment: input.environment.as_deref(),
            method: &input.method,
            url: &input.url,
            headers_json: &input.headers_json,
            query_json: &input.query_json,
            body_kind: &input.body_kind,
            body_text: input.body_text.as_deref(),
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_list_saved_requests(
    state: State<'_, AppState>,
) -> Result<Vec<crate::api_runner::history::SavedRequestRow>, String> {
    let db = state.db.lock();
    crate::api_runner::history::list_saved_requests(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_delete_saved_request(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock();
    crate::api_runner::history::delete_saved_request(&db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_preview_postman_import(
    source_path: String,
) -> Result<crate::api_runner::postman::PostmanImportPreview, String> {
    crate::api_runner::postman::preview_file(std::path::Path::new(&source_path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn api_commit_postman_import(
    state: State<'_, AppState>,
    source_path: String,
    fingerprint: String,
) -> Result<crate::api_runner::postman::PostmanImportResult, String> {
    let environments_dir =
        crate::config::api_environments_dir().map_err(|error| error.to_string())?;
    let mut database = state.db.lock();
    crate::api_runner::postman::commit_file(
        &mut database,
        &environments_dir,
        std::path::Path::new(&source_path),
        &fingerprint,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn api_list_postman_collections(
    state: State<'_, AppState>,
) -> Result<Vec<crate::api_runner::postman::PostmanCollectionSummary>, String> {
    let database = state.db.lock();
    crate::api_runner::postman::list_collections(&database).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn api_get_postman_collection(
    state: State<'_, AppState>,
    id: String,
) -> Result<crate::api_runner::postman::PostmanCollectionDetail, String> {
    let database = state.db.lock();
    crate::api_runner::postman::get_collection(&database, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Postman collection not found: {id}"))
}

#[tauri::command]
pub fn api_delete_postman_collection(
    state: State<'_, AppState>,
    id: String,
) -> Result<crate::api_runner::postman::PostmanCollectionSummary, String> {
    let environments_dir =
        crate::config::api_environments_dir().map_err(|error| error.to_string())?;
    let mut database = state.db.lock();
    crate::api_runner::postman::delete_collection(&mut database, &environments_dir, &id)
        .map_err(|error| error.to_string())
}

// ---- Step 6: pipe-to-terminal + pipe-to-AI ------------------------------

/// Send bytes to a terminal tab's PTY stdin.
///
/// Validates:
///   * `tab_id` is well-formed (via `validation::validate_tab_id`),
///   * the tab exists AND has `tab_type='terminal'` (piping into an API tab
///     would be a silent no-op — fail loudly instead),
///   * the PTY is still spawned.
///
/// The frontend uses this to pipe JSON values from response viewer into the
/// user's active shell. Typical flow: right-click value in API tab →
/// "Send to terminal [tab-X]" → `api_pipe_to_terminal(tab_id=X, text="...")`.
/// Appends a trailing newline so shells actually execute the line.
#[tauri::command]
pub fn api_pipe_to_terminal(
    state: State<'_, AppState>,
    tab_id: String,
    text: String,
) -> Result<(), String> {
    let validated = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;

    // Verify target tab is a terminal, not an API tab. We peek at the tabs
    // table instead of relying on a runtime map, so that a tab that's
    // listed but has an absent PTY (edge case) still produces a specific
    // error instead of generic "tab not found".
    let tab_type: String = {
        let db = state.db.lock();
        db.query_row(
            "SELECT tab_type FROM tabs WHERE id = ? AND closed_at IS NULL",
            rusqlite::params![validated],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| "terminal tab not found".to_string())?
    };
    if tab_type != "terminal" {
        return Err(format!(
            "cannot pipe to tab of type {tab_type:?}; target must be a terminal"
        ));
    }

    // API Runner injection is operator-originated input and must take over the
    // PTY exactly like keyboard input before any bytes are written.
    state
        .terminal_agent
        .revoke_for_pty(&validated, "user takeover");
    // Ensure a trailing newline so the shell actually runs it. If the user
    // already included one, don't add a second.
    let mut bytes = text.into_bytes();
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    state
        .terminal_agent
        .cancel_saved_ssh_launch_and_write(&validated, || {
            let ptys = state.ptys.lock();
            let handle = ptys
                .get(&validated)
                .ok_or_else(|| "terminal pty not running".to_string())?;
            handle.write(&bytes).map_err(|e| e.to_string())
        })
}

/// Queue a user message into the AI chat for a target tab. The AI chat is
/// stream-consumed via `agent_chat_stream`; this command just persists the
/// message so the AgentPanel picks it up on its next render. The frontend
/// is then free to trigger `agent_chat_stream` separately (or just show it
/// in the chat transcript).
///
/// `context_snippet` is a short JSON excerpt that the user picked from the
/// response viewer; it's prefixed into the message so the LLM sees the
/// content along with the user's prompt.
#[tauri::command]
pub fn api_pipe_to_ai(
    state: State<'_, AppState>,
    tab_id: String,
    prompt: String,
    context_snippet: String,
    agent_id: Option<String>,
) -> Result<String, String> {
    let validated = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Assemble one message. Markdown fences so the chat renderer knows
    // it's a code/data block.
    let body = if context_snippet.trim().is_empty() {
        prompt
    } else {
        format!("{prompt}\n\nContext from API response:\n```json\n{context_snippet}\n```")
    };
    let db = state.db.lock();
    // agent_id = None → general chat bucket; Some("foo") → that agent's
    // conversation for this tab. Matches how AgentPanel persists messages.
    let id = session::save_ai_message_with_agent(
        &db,
        &validated,
        "user",
        &body,
        now,
        agent_id.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Ask the LLM to summarize an HTTP response in plain English. Used by
/// the API tab's "Explain" button so non-devops users don't have to read
/// raw JSON. Returns the model's summary as a single string; the frontend
/// is responsible for rendering it (light markdown is expected).
#[tauri::command]
pub async fn api_explain_response(
    state: State<'_, AppState>,
    method: String,
    url: String,
    status_code: u16,
    body: String,
) -> Result<String, String> {
    let params = serde_json::json!({
        "method": method,
        "url": url,
        "status_code": status_code,
        "body": body,
        "profile": "default",
    });
    let resp = state
        .agent
        .call("explain_api_response", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => result
            .get("summary")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "no summary in response".to_string()),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

#[tauri::command]
pub async fn netconf_explain_response(
    state: State<'_, AppState>,
    operation: String,
    response_xml: String,
) -> Result<String, String> {
    let params = serde_json::json!({
        "operation": operation,
        "response_xml": response_xml,
        "profile": "default",
    });
    let resp = state
        .agent
        .call("explain_netconf_response", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => result
            .get("summary")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "no summary in response".to_string()),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

/// Import an OpenAPI spec from either a filesystem path or an https URL.
/// Returns the parsed endpoint catalog. Results are cached on disk keyed by
/// SHA-256 of the source identifier.
#[tauri::command]
pub async fn api_import_openapi(
    source: String,
) -> Result<Vec<crate::api_runner::Endpoint>, String> {
    let raw = if source.starts_with("http://") || source.starts_with("https://") {
        let resp = reqwest::get(&source)
            .await
            .map_err(|e| format!("fetch OpenAPI spec: {e}"))?;
        resp.text()
            .await
            .map_err(|e| format!("read OpenAPI body: {e}"))?
    } else {
        std::fs::read_to_string(&source).map_err(|e| format!("read OpenAPI file {source}: {e}"))?
    };
    crate::api_runner::openapi::parse_spec(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tab_scrollback(state: State<'_, AppState>, tab_id: String) -> Result<Vec<u8>, String> {
    // Validate tab_id
    let validated_tab_id = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;

    let db = state.db.lock();
    session::read_scrollback(&db, &validated_tab_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_export_scrollback(
    state: State<'_, AppState>,
    tab_id: String,
    target_path: String,
) -> Result<(), String> {
    let validated_tab_id = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    let scrollback = {
        let db = state.db.lock();
        session::read_scrollback(&db, &validated_tab_id).map_err(|e| e.to_string())?
    };
    crate::transcript_export::write_redacted_scrollback(
        &scrollback,
        std::path::Path::new(&target_path),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn block_output(state: State<'_, AppState>, block_id: String) -> Result<Vec<u8>, String> {
    // Validate block_id (same format as tab_id)
    let validated_block_id = validation::validate_tab_id(&block_id).map_err(|e| e.to_string())?;

    let db = state.db.lock();
    session::get_block_output(&db, &validated_block_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn install_shell_integration() -> Result<String, String> {
    let p = shell_integration::install().map_err(|e| e.to_string())?;
    Ok(p.zsh.to_string_lossy().into_owned())
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentChatEvent {
    Token {
        text: String,
    },
    /// Agent proposed a tool call. Frontend shows an approval card.
    ToolProposed {
        tool_call_id: String,
        /// "shell" | "mcp"
        kind: String,
        /// Raw JSON payload from the agent
        payload: serde_json::Value,
        /// For shell: whether the command matched the agent's allowed_commands list
        allowed: bool,
    },
    /// Result of a tool execution flowing back to the UI
    ToolResult {
        tool_call_id: String,
        exit_code: Option<i32>,
        /// First N lines of output for UI preview
        output_preview: String,
    },
    /// Plan 12 Phase 5 — RAG-retrieved chunks the assistant is being
    /// shown for this turn. Emitted BEFORE the first `Token` so the
    /// frontend can attach the citations to the assistant message
    /// before any text streams in.
    Sources {
        chunks: Vec<crate::rag::retrieve::RetrievedChunk>,
    },
    Done,
    Error {
        message: String,
    },
}

/// Plan 12 Phase 5 — best-effort RAG retrieval for the active turn.
///
/// Returns `Some(system_prefix_text)` if at least one chunk was
/// retrieved, `None` otherwise. Side-effects:
/// - Emits an `AgentChatEvent::Sources` with the raw chunks BEFORE
///   the first token streams in (the frontend uses this to attach
///   citations to the assistant message it just appended).
/// - Logs (but never propagates) any retrieval error so a broken
///   sidecar embedder cannot block the user's chat.
///
/// When both `vendor` and `platform` are `None`, RAG is skipped
/// entirely (no embed call, no Sources event). This is the default
/// for tabs whose vendor / platform isn't tracked yet — Phase 13 wires
/// the `useTabs` store into AgentPanel and starts passing real values.
async fn build_rag_system_prefix(
    state: &State<'_, AppState>,
    vendor: Option<&str>,
    platform: Option<&str>,
    user_tags: &[String],
    query: &str,
    on_event: &Channel<AgentChatEvent>,
) -> Option<String> {
    if vendor.is_none() && platform.is_none() && user_tags.is_empty() {
        return None;
    }
    let mut tags = crate::rag::session_tags::derive_tags(vendor, platform, None);
    for t in user_tags {
        tags.push(t.clone());
    }
    let args = crate::rag::retrieve::RetrieveArgs {
        query: query.to_string(),
        tags,
        k: 5,
    };
    let store = state.rag_store.clone();
    let bridge = state.rag_bridge.clone();
    let chunks = match crate::rag::retrieve::retrieve(&store, bridge.as_ref(), args).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, "rag retrieve failed; chat continues without sources");
            return None;
        }
    };
    if chunks.is_empty() {
        return None;
    }
    // Emit the Sources event FIRST so the frontend attaches the
    // citations to the assistant bubble it already appended; the
    // first Token typically arrives within tens of ms after this.
    let _ = on_event.send(AgentChatEvent::Sources {
        chunks: chunks.clone(),
    });
    Some(format_rag_prefix(&chunks))
}

/// Build the `# Retrieved Documentation` system message body. Each
/// chunk is rendered as a `[doc=N chunk=M tags=A,B] <text>` line so the
/// model can cite by `doc#chunk` references.
fn format_rag_prefix(chunks: &[crate::rag::retrieve::RetrievedChunk]) -> String {
    let mut out = String::new();
    out.push_str("# Retrieved Documentation (use these as authoritative; cite by [doc#chunk])\n");
    for c in chunks {
        let tags = c.tags.join(",");
        out.push_str(&format!(
            "[doc={} chunk={} tags={}] {}\n",
            c.document_id, c.chunk_idx, tags, c.text
        ));
    }
    out
}

/// Strip a leading `@agent-name ` from the message and return (agent_id, stripped_msg).
/// Only the first word after `@` is consumed; `@` followed by a non-identifier char is ignored.
fn extract_mention_override(message: &str) -> (Option<String>, String) {
    let trimmed = message.trim_start();
    if !trimmed.starts_with('@') {
        return (None, message.to_string());
    }
    // Consume identifier: alphanumeric, hyphen, underscore
    let after = &trimmed[1..];
    let end = after
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .unwrap_or(after.len());
    if end == 0 {
        return (None, message.to_string());
    }
    let name = after[..end].to_string();
    let rest = after[end..].trim_start().to_string();
    (Some(name), rest)
}

/// Stream a chat turn for the given tab.
///
/// Plan 12 Phase 5 — `vendor` and `platform` are the active tab's
/// vendor / platform (e.g. `("cisco", "iosxe")`). When BOTH are set,
/// the RAG retrieval pipeline runs against the embedded sidecar and
/// the top-K chunks are (a) emitted as an `AgentChatEvent::Sources`
/// before the first token and (b) prepended as a `system` message
/// to the array sent to the sidecar. When either is `None` the RAG
/// path is skipped entirely (no retrieval, no Sources event) — RAG
/// is best-effort and must never block the user's chat.
#[tauri::command]
pub async fn agent_chat_stream(
    state: State<'_, AppState>,
    tab_id: String,
    message: String,
    on_event: Channel<AgentChatEvent>,
    vendor: Option<String>,
    platform: Option<String>,
    user_tags: Option<Vec<String>>,
) -> Result<(), String> {
    // 1. Check for @agent-name mention override (single-message routing).
    let (mention_override, cleaned_msg) = extract_mention_override(&message);

    // 2. Resolve active agent for the tab (if any).
    let bound_agent_id = {
        let validated = validation::validate_tab_id(&tab_id).ok();
        match validated {
            Some(v) => {
                let db = state.db.lock();
                db.query_row(
                    "SELECT agent_id FROM agent_sessions WHERE tab_id = ?1",
                    rusqlite::params![&v],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .unwrap_or(None)
            }
            None => None,
        }
    };

    // Resolved agent: mention takes precedence, then tab default, else None (general chat).
    let resolved_agent = mention_override.or(bound_agent_id);

    // Validate resolved agent exists if set
    let resolved_agent = match resolved_agent {
        Some(id) if id != "general" => {
            if state.agents_loader.get(&id).is_some() {
                Some(id)
            } else {
                // Fall back silently; emit a soft notice
                let _ = on_event.send(AgentChatEvent::Token {
                    text: format!("[agent '{}' not found, using general chat]\n", id),
                });
                None
            }
        }
        _ => None,
    };

    // Plan 12 Phase 5 — RAG retrieval + sources injection. Best-effort:
    // any failure (sidecar embed dies, vec0 errors, etc.) is logged and
    // we fall through with NO sources injected — RAG must never block
    // the user's chat. Skipped entirely when both vendor and platform
    // are absent (most existing call sites until tab vendor inference
    // ships in a later plan).
    let user_tags_vec = user_tags.unwrap_or_default();
    let rag_prefix = build_rag_system_prefix(
        &state,
        vendor.as_deref(),
        platform.as_deref(),
        &user_tags_vec,
        &cleaned_msg,
        &on_event,
    )
    .await;

    // For "general" (no agent), keep the simple token-only streaming path.
    // For agent-routed chat, use the full event stream so we can surface tool calls.
    if resolved_agent.is_none() {
        // Prepend the system-prefix message (if any) so the sidecar's
        // chat.stream sees the retrieved context as authoritative
        // grounding for the answer it streams back.
        let mut messages = Vec::new();
        if let Some(ref sys) = rag_prefix {
            messages.push(serde_json::json!({"role": "system", "content": sys}));
        }
        messages.push(serde_json::json!({"role": "user", "content": cleaned_msg}));
        let params = serde_json::json!({
            "session_id": tab_id,
            "messages": messages,
            "profile": "default",
        });
        let on_event_clone = on_event.clone();
        let result = state
            .agent
            .call_stream("chat.stream", params, move |data| {
                on_event_clone
                    .send(AgentChatEvent::Token { text: data })
                    .map_err(|e| anyhow::anyhow!("send token: {e}"))
            })
            .await;
        return match result {
            Ok(_) => {
                let _ = on_event.send(AgentChatEvent::Done);
                Ok(())
            }
            Err(e) => {
                let _ = on_event.send(AgentChatEvent::Error {
                    message: e.to_string(),
                });
                Err(e.to_string())
            }
        };
    }

    // Agent-routed path. We loop: send messages to the agent, relay tokens, intercept
    // tool_call events (pause sidecar by letting the stream finish), await approval,
    // execute, and re-invoke with the updated conversation.
    let agent_id = resolved_agent.unwrap();
    let agent_def = state
        .agents_loader
        .get(&agent_id)
        .ok_or_else(|| format!("Agent '{}' not found", agent_id))?;
    let allowed_regexes = compile_allowed_regexes(&agent_def.allowed_commands);

    // Conversation history: starts with the (optional) RAG system
    // prefix followed by the user message. The same prefix lives at
    // index 0 across every tool-iteration of the agent loop so the
    // model never loses sight of its citations.
    let mut history: Vec<serde_json::Value> = Vec::new();
    if let Some(ref sys) = rag_prefix {
        history.push(serde_json::json!({"role": "system", "content": sys}));
    }
    history.push(serde_json::json!({
        "role": "user",
        "content": cleaned_msg,
    }));

    // Register (or refresh) the cancel flag for this tab. Anyone with the Arc can
    // set it to true; the loop polls it between steps.
    let cancel_flag: Arc<std::sync::atomic::AtomicBool> = {
        let mut map = state.cancel_flags.lock();
        // Reset any stale flag from a previous turn on this tab.
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        map.insert(tab_id.clone(), flag.clone());
        flag
    };
    let check_cancel = |where_: &str, on_event: &Channel<AgentChatEvent>| -> bool {
        if cancel_flag.load(std::sync::atomic::Ordering::Acquire) {
            tracing::info!(where_ = %where_, "agent turn cancelled");
            let _ = on_event.send(AgentChatEvent::Token {
                text: "\n\n[stopped by user]\n".to_string(),
            });
            let _ = on_event.send(AgentChatEvent::Done);
            true
        } else {
            false
        }
    };

    // Cap the agentic loop to avoid runaway token use.
    const MAX_TURNS: usize = 8;

    for _turn in 0..MAX_TURNS {
        if check_cancel("turn-start", &on_event) {
            return Ok(());
        }
        let params = serde_json::json!({
            "session_id": tab_id,
            "messages": history.clone(),
            "agent_id": agent_id,
        });

        // Accumulator for both the assistant's textual response (what we save to history)
        // and detected tool calls (we stop after the first one per turn).
        let accumulated = Arc::new(std::sync::Mutex::new(String::new()));
        let detected_tool: Arc<std::sync::Mutex<Option<(String, String, serde_json::Value)>>> =
            Arc::new(std::sync::Mutex::new(None));

        let on_event_clone = on_event.clone();
        let accumulated_cb = accumulated.clone();
        let detected_cb = detected_tool.clone();
        let allowed_cb = allowed_regexes.clone();
        // Share the pending_approvals map into the streaming callback so we can register
        // the oneshot AT EMIT TIME (users can click "Run" while the sidecar is still
        // producing its tail tokens).
        let pending_approvals_cb = state.pending_approvals.clone();

        let result = state
            .agent
            .call_stream_ex("chat.stream_agent", params, move |ev| {
                let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match ev_type {
                    "token" => {
                        if let Some(data) = ev.get("data").and_then(|v| v.as_str()) {
                            accumulated_cb.lock().unwrap().push_str(data);
                            let _ = on_event_clone.send(AgentChatEvent::Token {
                                text: data.to_string(),
                            });
                        }
                    }
                    "tool_call" => {
                        let kind = ev
                            .get("kind")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let payload = ev
                            .get("payload")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        let tool_call_id = format!("tc-{}", uuid_like());

                        // Only register the FIRST tool call per turn — if the LLM emitted more,
                        // we ignore them so we don't collide on approvals.
                        let mut slot = detected_cb.lock().unwrap();
                        if slot.is_some() {
                            return Ok(());
                        }

                        // Register the approval receiver BEFORE telling the frontend,
                        // so the frontend's approve_tool call can find it immediately.
                        let (tx, rx) = tokio::sync::oneshot::channel::<ApprovalDecision>();
                        pending_approvals_cb.lock().insert(tool_call_id.clone(), tx);

                        let allowed = if kind == "shell" {
                            let cmd = payload.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                            matches_any(&allowed_cb, cmd)
                        } else {
                            true
                        };
                        let _ = on_event_clone.send(AgentChatEvent::ToolProposed {
                            tool_call_id: tool_call_id.clone(),
                            kind: kind.clone(),
                            payload: payload.clone(),
                            allowed,
                        });
                        // Store the rx along with the proposal so the outer loop awaits it.
                        // We wrap it in a type-erased holder because serde_json::Value
                        // can't hold a Receiver — so we stash it via a side-channel mutex.
                        *slot = Some((tool_call_id.clone(), kind, payload));
                        // We need to hand off the `rx` to the outer loop. Put it into a
                        // thread-local-free approach: store in the shared detected_cb's slot
                        // via a sibling Arc<Mutex<Option<Receiver<...>>>>.
                        PENDING_RX().lock().unwrap().insert(tool_call_id, rx);
                    }
                    _ => {}
                }
                Ok(())
            })
            .await;

        if let Err(e) = result {
            let _ = on_event.send(AgentChatEvent::Error {
                message: e.to_string(),
            });
            return Err(e.to_string());
        }

        let text_so_far = accumulated.lock().unwrap().clone();
        let pending_tool = detected_tool.lock().unwrap().take();

        // Always save the assistant's text turn to history (even partial if a tool call was emitted).
        history.push(serde_json::json!({
            "role": "assistant",
            "content": text_so_far,
        }));

        // If no tool call was proposed, we're done.
        let (tool_call_id, kind, _payload) = match pending_tool {
            Some(t) => t,
            None => {
                let _ = on_event.send(AgentChatEvent::Done);
                return Ok(());
            }
        };

        // Pick up the receiver we registered during the stream callback.
        let rx = match PENDING_RX().lock().unwrap().remove(&tool_call_id) {
            Some(r) => r,
            None => {
                let _ = on_event.send(AgentChatEvent::Error {
                    message: "internal: approval receiver missing".to_string(),
                });
                return Err("approval receiver missing".to_string());
            }
        };

        // Race approval arrival vs a user-initiated cancel.
        let cancel_watch_flag = cancel_flag.clone();
        let cancel_watch = async move {
            loop {
                if cancel_watch_flag.load(std::sync::atomic::Ordering::Acquire) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
        };

        let decision = tokio::select! {
            res = rx => match res {
                Ok(d) => d,
                Err(e) => {
                    let _ = on_event.send(AgentChatEvent::Error {
                        message: format!("approval channel dropped: {e}"),
                    });
                    return Err(e.to_string());
                }
            },
            _ = cancel_watch => {
                // User stopped while the approval card was up. Clear any pending
                // entry for this tool_call_id so approve_tool calls won't dangle.
                state.pending_approvals.lock().remove(&tool_call_id);
                PENDING_RX().lock().unwrap().remove(&tool_call_id);
                let _ = on_event.send(AgentChatEvent::ToolResult {
                    tool_call_id: tool_call_id.clone(),
                    exit_code: None,
                    output_preview: "[cancelled by user]".to_string(),
                });
                let _ = on_event.send(AgentChatEvent::Token {
                    text: "\n\n[stopped by user]\n".to_string(),
                });
                let _ = on_event.send(AgentChatEvent::Done);
                return Ok(());
            }
        };

        let (exit_code, output_preview) = match decision {
            ApprovalDecision::Reject => {
                let _ = on_event.send(AgentChatEvent::ToolResult {
                    tool_call_id: tool_call_id.clone(),
                    exit_code: None,
                    output_preview: "[rejected by user]".to_string(),
                });
                // Feed rejection back to the agent as a tool-result user message
                history.push(serde_json::json!({
                    "role": "user",
                    "content": format!(
                        "TOOL_RESULT for {tool_call_id}: REJECTED by user. Please adjust your plan."
                    ),
                }));
                continue;
            }
            ApprovalDecision::Run(edited_payload) => match kind.as_str() {
                "shell" => execute_shell_tool(&state, &tab_id, &edited_payload).await,
                "mcp" => execute_mcp_tool(&state, &edited_payload).await,
                _ => (None, format!("[unknown tool kind: {}]", kind)),
            },
        };

        let _ = on_event.send(AgentChatEvent::ToolResult {
            tool_call_id: tool_call_id.clone(),
            exit_code,
            output_preview: output_preview.clone(),
        });

        history.push(serde_json::json!({
            "role": "user",
            "content": format!(
                "TOOL_RESULT for {tool_call_id} (exit_code={}):\n```\n{}\n```",
                exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "n/a".to_string()),
                truncate_for_prompt(&output_preview, 4000)
            ),
        }));
    }

    // Hit max turns without natural termination
    let _ = on_event.send(AgentChatEvent::Error {
        message: format!("agent loop exceeded {} turns", MAX_TURNS),
    });
    let _ = on_event.send(AgentChatEvent::Done);
    Ok(())
}

/// Approve, edit, or reject a pending tool call.
#[tauri::command]
pub fn agent_approve_tool(
    state: State<'_, AppState>,
    tool_call_id: String,
    action: String,
    edited_payload: Option<serde_json::Value>,
) -> Result<(), String> {
    tracing::info!(
        tool_call_id = %tool_call_id,
        action = %action,
        has_payload = edited_payload.is_some(),
        "agent_approve_tool received"
    );
    let tx = {
        let mut map = state.pending_approvals.lock();
        map.remove(&tool_call_id)
            .ok_or_else(|| format!("No pending approval for '{}'", tool_call_id))?
    };
    let decision = match action.as_str() {
        "run" => ApprovalDecision::Run(edited_payload.unwrap_or(serde_json::Value::Null)),
        "reject" => ApprovalDecision::Reject,
        _ => return Err(format!("Unknown action '{}'", action)),
    };
    tx.send(decision)
        .map_err(|_| "Approval receiver gone".to_string())?;
    Ok(())
}

/// Cancel any in-flight agent turn on the given tab. Sets the per-tab cancel flag
/// (which the agent loop polls between turns + during approval waits).
#[tauri::command]
pub fn agent_chat_cancel(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let validated = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    tracing::info!(tab_id = %validated, "agent_chat_cancel requested");
    if let Some(flag) = state.cancel_flags.lock().get(&validated) {
        flag.store(true, std::sync::atomic::Ordering::Release);
    }
    Ok(())
}

// --- Helpers for Phase C ---

fn compile_allowed_regexes(patterns: &[String]) -> Vec<regex::Regex> {
    patterns
        .iter()
        .filter_map(|p| regex::Regex::new(p).ok())
        .collect()
}

fn matches_any(regexes: &[regex::Regex], text: &str) -> bool {
    if regexes.is_empty() {
        return false; // empty allowlist => nothing matches, UI shows warning
    }
    regexes.iter().any(|r| r.is_match(text))
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

fn truncate_for_prompt(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…[truncated]", &s[..max])
    }
}

/// Execute a shell tool call by writing to the tab's PTY.
///
/// Works for two cases:
/// 1. Local shell-integrated zsh: OSC 133 emits CommandEnd → we pick that up and
///    use `get_block_output` (clean, exact boundaries).
/// 2. Non-integrated sessions (SSH into Cisco, Docker exec, etc.): OSC 133 won't
///    fire inside the remote shell. We fall back to "quiet period" detection:
///    watch `read_scrollback` length; once no new bytes arrive for a short window,
///    consider the command done and return the scrollback delta as the output.
async fn execute_shell_tool(
    state: &AppState,
    tab_id: &str,
    payload: &serde_json::Value,
) -> (Option<i32>, String) {
    let cmd = match payload.get("cmd").and_then(|v| v.as_str()) {
        Some(c) if !c.is_empty() => c,
        _ => return (None, "[no command in payload]".to_string()),
    };

    state.terminal_agent.revoke_for_pty(tab_id, "user takeover");

    // Capture scrollback length BEFORE writing, so we can diff after.
    let scrollback_start = {
        let db = state.db.lock();
        session::read_scrollback(&db, tab_id)
            .map(|v| v.len())
            .unwrap_or(0)
    };

    // Register a CommandEnd waiter (used if OSC 133 fires).
    let (tx, rx) = tokio::sync::oneshot::channel::<(String, Option<i32>)>();
    state
        .block_end_waiters
        .lock()
        .entry(tab_id.to_string())
        .or_default()
        .push(tx);

    // Write `cmd + \r` to the PTY
    let write_result = state
        .terminal_agent
        .cancel_saved_ssh_launch_and_write(tab_id, || {
            let ptys = state.ptys.lock();
            let h = ptys
                .get(tab_id)
                .ok_or_else(|| "tab not found — agent cannot execute".to_string())?;
            let mut bytes = cmd.as_bytes().to_vec();
            bytes.push(b'\r');
            h.write(&bytes)
                .map_err(|error| format!("pty write failed: {error}"))
        });
    if let Err(error) = write_result {
        return (None, format!("[{error}]"));
    }

    // Quiet-period detector: polls scrollback length until we see the scrollback
    // grow past the starting point AND then stop growing for QUIET_WINDOW.
    const QUIET_WINDOW: std::time::Duration = std::time::Duration::from_millis(2000);
    const POLL: std::time::Duration = std::time::Duration::from_millis(200);
    const OVERALL: std::time::Duration = std::time::Duration::from_secs(90);
    const MIN_GROWTH_BEFORE_QUIET: usize = 16; // ignore just the echoed newline

    let db_arc = state.db.clone();
    let tab_id_owned = tab_id.to_string();
    let quiet_fut = async move {
        let mut last_len = scrollback_start;
        let mut last_change = std::time::Instant::now();
        let start = std::time::Instant::now();
        loop {
            tokio::time::sleep(POLL).await;
            let now = std::time::Instant::now();
            let cur_len = {
                let db = db_arc.lock();
                session::read_scrollback(&db, &tab_id_owned)
                    .map(|v| v.len())
                    .unwrap_or(last_len)
            };
            if cur_len != last_len {
                last_len = cur_len;
                last_change = now;
            }
            let grew = last_len.saturating_sub(scrollback_start);
            if grew >= MIN_GROWTH_BEFORE_QUIET && now.duration_since(last_change) >= QUIET_WINDOW {
                return last_len;
            }
            if now.duration_since(start) >= OVERALL {
                return last_len;
            }
        }
    };

    // Race: OSC 133 CommandEnd vs quiet-period completion.
    let outcome = tokio::select! {
        res = rx => Outcome::Osc(res),
        final_len = quiet_fut => Outcome::Quiet(final_len),
    };

    match outcome {
        Outcome::Osc(Ok((block_id, exit_code))) => {
            let output_bytes = {
                let db = state.db.lock();
                session::get_block_output(&db, &block_id).unwrap_or_default()
            };
            let text = strip_ansi(&String::from_utf8_lossy(&output_bytes));
            (exit_code, text)
        }
        Outcome::Osc(Err(_)) => (None, "[approval channel dropped]".to_string()),
        Outcome::Quiet(final_len) => {
            // Pull the scrollback delta and return it as the output.
            let output_bytes = {
                let db = state.db.lock();
                session::read_scrollback(&db, tab_id).unwrap_or_default()
            };
            let slice = if final_len <= scrollback_start {
                Vec::new()
            } else {
                let end = final_len.min(output_bytes.len());
                output_bytes[scrollback_start.min(output_bytes.len())..end].to_vec()
            };
            let raw = String::from_utf8_lossy(&slice).to_string();
            let cleaned = strip_ansi(&raw);
            // Trim any trailing remote prompt line to avoid confusing the LLM
            let trimmed = trim_trailing_prompt(&cleaned);
            // No OSC exit code available for remote shells; return None
            (None, trimmed)
        }
    }
}

enum Outcome {
    Osc(Result<(String, Option<i32>), tokio::sync::oneshot::error::RecvError>),
    Quiet(usize),
}

/// Strip ANSI escape sequences + common control chars from captured output.
fn strip_ansi(s: &str) -> String {
    // CSI escape: ESC[ ... final letter
    let re_csi = regex::Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").unwrap();
    let re_osc = regex::Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").unwrap();
    let re_ctrl = regex::Regex::new(r"[\x00-\x08\x0b-\x1f\x7f]").unwrap();
    let step1 = re_osc.replace_all(s, "");
    let step2 = re_csi.replace_all(&step1, "");
    re_ctrl.replace_all(&step2, "").to_string()
}

/// Heuristic: drop the last line if it looks like a shell/device prompt (e.g. "Router#", "zsh% ").
fn trim_trailing_prompt(s: &str) -> String {
    let mut lines: Vec<&str> = s.lines().collect();
    while let Some(last) = lines.last() {
        let l = last.trim_end();
        let looks_like_prompt =
            l.ends_with('#') || l.ends_with('$') || l.ends_with('%') || l.ends_with('>');
        if looks_like_prompt && l.len() < 80 {
            lines.pop();
        } else {
            break;
        }
    }
    lines.join("\n")
}

async fn execute_mcp_tool(_state: &AppState, payload: &serde_json::Value) -> (Option<i32>, String) {
    // MCP integration placeholder — we hook into mcp_bridge when the MVP wiring
    // for per-agent MCP tool invocation lands. For now, return a stub so the
    // frontend event flow can be tested.
    let server = payload
        .get("server")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let tool = payload.get("tool").and_then(|v| v.as_str()).unwrap_or("?");
    (
        None,
        format!(
            "[mcp {}:{} — MCP invocation not yet wired; pretend this returned your result]",
            server, tool
        ),
    )
}

#[tauri::command]
pub async fn agent_nl_to_command(
    state: State<'_, AppState>,
    nl_query: String,
    shell: String,
    cwd: String,
) -> Result<String, String> {
    let params = serde_json::json!({
        "nl_query": nl_query,
        "shell": shell,
        "cwd": cwd,
    });

    let resp = state
        .agent
        .call("nl_to_command", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => result
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "no command in response".to_string()),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct ExplainErrorResult {
    pub explanation: String,
    pub suggested_command: String,
}

#[tauri::command]
pub async fn agent_explain_error(
    state: State<'_, AppState>,
    cmd: String,
    output: String,
    exit_code: i32,
    cwd: String,
) -> Result<ExplainErrorResult, String> {
    let params = serde_json::json!({
        "cmd": cmd,
        "output": output,
        "exit_code": exit_code,
        "cwd": cwd,
    });

    let resp = state
        .agent
        .call("explain_error", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => {
            let explanation = result
                .get("explanation")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let suggested_command = result
                .get("suggested_command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Ok(ExplainErrorResult {
                explanation,
                suggested_command,
            })
        }
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

#[tauri::command]
pub async fn agent_explain_command(
    state: State<'_, AppState>,
    command: String,
    cwd: String,
) -> Result<String, String> {
    let params = serde_json::json!({
        "command": command,
        "cwd": cwd,
    });

    let resp = state
        .agent
        .call("explain_command", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => {
            let explanation = result
                .get("explanation")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Ok(explanation)
        }
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

// MCP Server Management

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command_json: Option<String>,
    pub url: Option<String>,
    pub env_json: Option<String>,
    pub enabled: bool,
    pub created_at: i64,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct McpPolicy {
    pub server_name: String,
    pub tool_name: String,
    pub policy: String,
    pub scope: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub fn mcp_list_servers(state: State<'_, AppState>) -> Result<Vec<McpServer>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare("SELECT id, name, transport, command_json, url, env_json, enabled, created_at FROM mcp_servers ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let servers = stmt
        .query_map([], |row| {
            Ok(McpServer {
                id: row.get(0)?,
                name: row.get(1)?,
                transport: row.get(2)?,
                command_json: row.get(3)?,
                url: row.get(4)?,
                env_json: row.get(5)?,
                enabled: row.get::<_, i64>(6)? != 0,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(servers)
}

#[tauri::command]
pub fn mcp_add_server(
    state: State<'_, AppState>,
    name: String,
    transport: String,
    command_json: Option<String>,
    url: Option<String>,
    env_json: Option<String>,
) -> Result<String, String> {
    if transport != "stdio" && transport != "sse" {
        return Err("transport must be 'stdio' or 'sse'".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let db = state.db.lock();

    db.execute(
        "INSERT INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
        rusqlite::params![id, name, transport, command_json, url, env_json],
    )
    .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
pub fn mcp_remove_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "DELETE FROM mcp_servers WHERE id = ?",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn mcp_update_server_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "UPDATE mcp_servers SET enabled = ? WHERE id = ?",
        rusqlite::params![if enabled { 1 } else { 0 }, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mcp_test_connection(
    _state: State<'_, AppState>,
    _id: String,
) -> Result<Vec<McpTool>, String> {
    // Placeholder: In Phase 4, this would actually connect to the MCP server
    // and call the list_tools method
    Ok(vec![McpTool {
        name: "example_tool".to_string(),
        description: Some("Example tool from MCP server".to_string()),
    }])
}

#[tauri::command]
pub fn mcp_list_policies(
    state: State<'_, AppState>,
    server_name: String,
) -> Result<Vec<McpPolicy>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare("SELECT server_name, tool_name, policy, scope, created_at, updated_at FROM approval_policies WHERE server_name = ?")
        .map_err(|e| e.to_string())?;

    let policies = stmt
        .query_map([server_name], |row| {
            Ok(McpPolicy {
                server_name: row.get(0)?,
                tool_name: row.get(1)?,
                policy: row.get(2)?,
                scope: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(policies)
}

#[tauri::command]
pub fn mcp_set_policy(
    state: State<'_, AppState>,
    server_name: String,
    tool_name: String,
    policy: String,
) -> Result<(), String> {
    let valid_policies = ["auto_allow", "confirm", "confirm_once", "deny"];
    if !valid_policies.contains(&policy.as_str()) {
        return Err("invalid policy".to_string());
    }

    let db = state.db.lock();

    db.execute(
        "INSERT INTO approval_policies (server_name, tool_name, policy) VALUES (?, ?, ?)
         ON CONFLICT(server_name, tool_name) DO UPDATE SET policy = excluded.policy, updated_at = strftime('%s','now')",
        rusqlite::params![server_name, tool_name, policy],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

// MCP Tool Approval

#[tauri::command]
pub fn approve_tool_call(
    state: State<'_, AppState>,
    request_id: String,
    approved: bool,
    remember: bool,
) -> Result<(), String> {
    state
        .mcp_bridge
        .handle_approval(&request_id, approved, remember)
        .map_err(|e| e.to_string())
}

// Skills System

#[tauri::command]
pub fn skills_list(state: State<'_, AppState>) -> Result<Vec<skills::Skill>, String> {
    state.skills_loader.load_all().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn skills_get(state: State<'_, AppState>, id: String) -> Result<skills::Skill, String> {
    state
        .skills_loader
        .get(&id)
        .ok_or_else(|| format!("Skill '{}' not found", id))
}

#[tauri::command]
pub fn skills_reload(state: State<'_, AppState>) -> Result<(), String> {
    state.skills_loader.load_all().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct SkillScript {
    pub name: String,
    pub content: String,
}

#[tauri::command]
pub fn skills_create(
    state: State<'_, AppState>,
    name: String,
    skill_md_content: String,
    scripts: Vec<SkillScript>,
) -> Result<String, String> {
    // Validate skill name
    validation::validate_session_name(&name).map_err(|e| e.to_string())?;

    let skills_dir = skills::default_skills_dir().map_err(|e| e.to_string())?;

    // Create skills directory if it doesn't exist
    if !skills_dir.exists() {
        std::fs::create_dir_all(&skills_dir).map_err(|e| e.to_string())?;
    }

    // Sanitize skill name
    let safe_name = name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-");

    let skill_path = skills_dir.join(&safe_name);

    // Check if skill already exists
    if skill_path.exists() {
        return Err(format!("Skill '{}' already exists", safe_name));
    }

    // Create skill directory
    std::fs::create_dir_all(&skill_path)
        .map_err(|e| format!("Failed to create skill directory: {}", e))?;

    // Write SKILL.md
    let skill_md_path = skill_path.join("SKILL.md");
    std::fs::write(&skill_md_path, &skill_md_content)
        .map_err(|e| format!("Failed to write SKILL.md: {}", e))?;

    // Write scripts
    for script in scripts {
        let script_path = skill_path.join(&script.name);

        // Create parent directory if script is in a subdirectory
        if let Some(parent) = script_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create script directory: {}", e))?;
        }

        std::fs::write(&script_path, &script.content)
            .map_err(|e| format!("Failed to write script {}: {}", script.name, e))?;

        // Make scripts executable on Unix systems
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if script.name.ends_with(".sh") || script.name.ends_with(".py") {
                if let Ok(metadata) = std::fs::metadata(&script_path) {
                    let mut perms = metadata.permissions();
                    perms.set_mode(0o755);
                    let _ = std::fs::set_permissions(&script_path, perms);
                }
            }
        }
    }

    // Reload skills
    state.skills_loader.load_all().map_err(|e| e.to_string())?;

    Ok(skill_path.to_string_lossy().to_string())
}

// ============================================================================
// Agents - Warp-style specialized personas that compose skills + MCP tools
// ============================================================================

#[tauri::command]
pub fn agents_list(state: State<'_, AppState>) -> Result<Vec<agents::Agent>, String> {
    state.agents_loader.load_all().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_get(state: State<'_, AppState>, id: String) -> Result<agents::Agent, String> {
    state
        .agents_loader
        .get(&id)
        .ok_or_else(|| format!("Agent '{}' not found", id))
}

#[tauri::command]
pub fn agents_reload(state: State<'_, AppState>) -> Result<(), String> {
    state.agents_loader.load_all().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentInput {
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    #[serde(default)]
    pub model_override: Option<agents::ModelOverride>,
    #[serde(default)]
    pub execution_mode: Option<String>,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub attached_skills: Vec<String>,
    #[serde(default)]
    pub attached_mcp_servers: Vec<String>,
    #[serde(default)]
    pub attached_tools: Vec<agents::AttachedTool>,
    #[serde(default)]
    pub allowed_commands: Vec<String>,
    #[serde(default)]
    pub body: String,
}

#[tauri::command]
pub fn agents_create(
    state: State<'_, AppState>,
    input: CreateAgentInput,
) -> Result<agents::Agent, String> {
    validation::validate_session_name(&input.name).map_err(|e| e.to_string())?;
    // Sanitize into directory-safe id
    let id = input
        .name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-");

    let model_override = input.model_override.map(|m| (m.provider, m.model));

    state
        .agents_loader
        .create(
            &id,
            &input.name,
            &input.description,
            &input.system_prompt,
            model_override,
            input.execution_mode,
            input.engine,
            input.attached_skills,
            input.attached_mcp_servers,
            input.attached_tools,
            input.allowed_commands,
            &input.body,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_update(
    state: State<'_, AppState>,
    id: String,
    input: CreateAgentInput,
) -> Result<agents::Agent, String> {
    // Validate agent exists (and grab the current definition so we can
    // preserve fields the editor UI doesn't round-trip).
    let existing = state
        .agents_loader
        .get(&id)
        .ok_or_else(|| format!("Agent '{}' not found", id))?;

    let model_override = input.model_override.map(|m| (m.provider, m.model));

    // The Settings agent editor (CreateAgentInput from the frontend) does not
    // carry attached_tools, so it serializes as an empty Vec. Overwriting with
    // an empty list would silently wipe an agent's tool config (e.g. the Meraki
    // catalog + vault-entry) on any edit — including a no-op engine toggle.
    // Preserve the existing tools whenever the update doesn't supply any.
    let attached_tools = if input.attached_tools.is_empty() {
        existing.attached_tools.clone()
    } else {
        input.attached_tools
    };

    state
        .agents_loader
        .update(
            &id,
            &input.name,
            &input.description,
            &input.system_prompt,
            model_override,
            input.execution_mode,
            input.engine,
            input.attached_skills,
            input.attached_mcp_servers,
            attached_tools,
            input.allowed_commands,
            &input.body,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.agents_loader.delete(&id).map_err(|e| e.to_string())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkArchitectSoulFile {
    pub file_name: String,
    pub content: String,
}

fn is_network_architect_soul_file_name(file_name: &str) -> bool {
    file_name.starts_with("SOUL")
        && file_name.ends_with(".md")
        && !file_name.contains('/')
        && !file_name.contains('\\')
}

fn network_architect_soul_path(
    state: &AppState,
    file_name: &str,
) -> Result<std::path::PathBuf, String> {
    if !is_network_architect_soul_file_name(file_name) {
        return Err("Only Network Architect SOUL*.md files can be edited".to_string());
    }

    let agent = state
        .agents_loader
        .get("network-architect")
        .ok_or_else(|| "Network Architect agent not found".to_string())?;
    Ok(agent.path.join(file_name))
}

#[tauri::command]
pub fn network_architect_soul_list(
    state: State<'_, AppState>,
) -> Result<Vec<NetworkArchitectSoulFile>, String> {
    let agent = state
        .agents_loader
        .get("network-architect")
        .ok_or_else(|| "Network Architect agent not found".to_string())?;

    let mut files = fs::read_dir(&agent.path)
        .map_err(|e| format!("Failed to read Network Architect directory: {e}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            is_network_architect_soul_file_name(&file_name).then_some((file_name, entry.path()))
        })
        .map(|(file_name, path)| {
            fs::read_to_string(&path)
                .map(|content| NetworkArchitectSoulFile { file_name, content })
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    files.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(files)
}

fn save_network_architect_soul_file(path: &std::path::Path, content: &str) -> Result<(), String> {
    let tmp_path = path.with_extension(format!("md.{}.tmp", uuid::Uuid::new_v4()));
    let mut tmp_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|e| format!("Failed to create temporary SOUL file: {e}"))?;
    if let Err(error) = tmp_file.write_all(content.as_bytes()) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to write temporary SOUL file: {error}"));
    }
    if let Err(error) = tmp_file.sync_all() {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to flush temporary SOUL file: {error}"));
    }
    drop(tmp_file);
    if let Err(error) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to save SOUL file: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub fn network_architect_soul_save(
    state: State<'_, AppState>,
    file_name: String,
    content: String,
) -> Result<NetworkArchitectSoulFile, String> {
    let path = network_architect_soul_path(&state, &file_name)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| format!("Network Architect SOUL file not found: {file_name}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!("Network Architect SOUL file is not editable: {file_name}"));
    }

    save_network_architect_soul_file(&path, &content)?;
    Ok(NetworkArchitectSoulFile { file_name, content })
}

// --- Per-tab active agent session (agent_sessions table) ---

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRow {
    pub tab_id: String,
    pub agent_id: String,
    pub updated_at: i64,
}

#[tauri::command]
pub fn agent_session_get(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Option<AgentSessionRow>, String> {
    let validated = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    let db = state.db.lock();
    let row = db
        .query_row(
            "SELECT tab_id, agent_id, updated_at FROM agent_sessions WHERE tab_id = ?1",
            rusqlite::params![&validated],
            |r| {
                Ok(AgentSessionRow {
                    tab_id: r.get(0)?,
                    agent_id: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command]
pub fn agent_session_set(
    state: State<'_, AppState>,
    tab_id: String,
    agent_id: String,
) -> Result<(), String> {
    let validated = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    // Allow special "general" sentinel to clear the binding
    if agent_id == "general" {
        let db = state.db.lock();
        db.execute(
            "DELETE FROM agent_sessions WHERE tab_id = ?1",
            rusqlite::params![&validated],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    // Validate agent exists
    if state.agents_loader.get(&agent_id).is_none() {
        return Err(format!("Agent '{}' not found", agent_id));
    }
    let db = state.db.lock();
    db.execute(
        "INSERT INTO agent_sessions (tab_id, agent_id) VALUES (?1, ?2)
         ON CONFLICT(tab_id) DO UPDATE SET agent_id = excluded.agent_id,
                                            updated_at = strftime('%s','now')",
        rusqlite::params![&validated, &agent_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn agent_session_list_all(state: State<'_, AppState>) -> Result<Vec<AgentSessionRow>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare("SELECT tab_id, agent_id, updated_at FROM agent_sessions")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AgentSessionRow {
                tab_id: r.get(0)?,
                agent_id: r.get(1)?,
                updated_at: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct GenerateSkillResult {
    pub skill_md: String,
    pub scripts: Vec<SkillScript>,
}

#[tauri::command]
pub async fn agent_generate_skill(
    state: State<'_, AppState>,
    description: String,
    examples: Option<String>,
    profile: Option<String>,
) -> Result<GenerateSkillResult, String> {
    let params = serde_json::json!({
        "description": description,
        "examples": examples.unwrap_or_default(),
        "profile": profile.unwrap_or_else(|| "default".to_string()),
    });

    let resp = state
        .agent
        .call("generate_skill", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => {
            let skill_md = result
                .get("skill_md")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let scripts = result
                .get("scripts")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            let name = item.get("name")?.as_str()?.to_string();
                            let content = item.get("content")?.as_str()?.to_string();
                            Some(SkillScript { name, content })
                        })
                        .collect()
                })
                .unwrap_or_default();

            Ok(GenerateSkillResult { skill_md, scripts })
        }
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

// Phase 6 Search API (FTS5-based)

use crate::search::{AiMessageResult, CommandBlockResult, SearchResults, SkillResult};

#[tauri::command]
pub fn search_commands(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<CommandBlockResult>, String> {
    // Validate search query
    let validated_query = validation::validate_search_query(&query).map_err(|e| e.to_string())?;

    let db = state.db.lock();
    let limit = limit.unwrap_or(50).min(500); // Cap at 500 results
    crate::search::search_commands(&db, &validated_query, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_ai_messages(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<AiMessageResult>, String> {
    // Validate search query
    let validated_query = validation::validate_search_query(&query).map_err(|e| e.to_string())?;

    let db = state.db.lock();
    let limit = limit.unwrap_or(50).min(500); // Cap at 500 results
    crate::search::search_ai_messages(&db, &validated_query, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_skills_cmd(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SkillResult>, String> {
    // Validate search query
    let validated_query = validation::validate_search_query(&query).map_err(|e| e.to_string())?;

    let db = state.db.lock();
    let limit = limit.unwrap_or(50).min(500); // Cap at 500 results
    crate::search::search_skills(&db, &validated_query, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_all(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<SearchResults, String> {
    // Validate search query
    let validated_query = validation::validate_search_query(&query).map_err(|e| e.to_string())?;

    let db = state.db.lock();
    let limit = limit.unwrap_or(50).min(500); // Cap at 500 results
    crate::search::search_all(&db, &validated_query, limit).map_err(|e| e.to_string())
}

// Session Restoration

#[tauri::command]
pub fn restore_last_session(
    state: State<'_, AppState>,
) -> Result<Option<session::SessionSnapshot>, String> {
    let db = state.db.lock();
    session::load_session_snapshot(&db, "__last__").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_current_session(
    state: State<'_, AppState>,
    active_tab_id: Option<String>,
    tab_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let db = state.db.lock();
    session::save_session_snapshot(
        &db,
        "__last__",
        active_tab_id.as_deref(),
        tab_ids.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_messages_by_tab(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Vec<session::AiMessage>, String> {
    let db = state.db.lock();
    session::get_ai_messages_by_tab(&db, &tab_id).map_err(|e| e.to_string())
}

/// Get messages for a specific (tab, agent). Pass `agent_id: null` for general chat.
#[tauri::command]
pub fn ai_messages_by_tab_agent(
    state: State<'_, AppState>,
    tab_id: String,
    agent_id: Option<String>,
) -> Result<Vec<session::AiMessage>, String> {
    let db = state.db.lock();
    session::get_ai_messages_by_tab_agent(&db, &tab_id, agent_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_ai_message(
    state: State<'_, AppState>,
    tab_id: String,
    role: String,
    content: String,
    timestamp: i64,
    agent_id: Option<String>,
) -> Result<String, String> {
    let db = state.db.lock();
    session::save_ai_message_with_agent(
        &db,
        &tab_id,
        &role,
        &content,
        timestamp,
        agent_id.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/// Delete all messages for a (tab, agent) pair. Returns number of rows removed.
#[tauri::command]
pub fn ai_clear_messages(
    state: State<'_, AppState>,
    tab_id: String,
    agent_id: Option<String>,
) -> Result<usize, String> {
    let db = state.db.lock();
    session::clear_ai_messages(&db, &tab_id, agent_id.as_deref()).map_err(|e| e.to_string())
}

/// List every conversation (distinct tab × agent) for the global history browser.
#[tauri::command]
pub fn ai_conversations_list(
    state: State<'_, AppState>,
) -> Result<Vec<session::ConversationSummary>, String> {
    let db = state.db.lock();
    session::list_conversations(&db).map_err(|e| e.to_string())
}

// Named Session Management (Phase 6)

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct SavedSessionInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub tab_count: usize,
    pub created_at: i64,
}

#[tauri::command]
pub fn session_save_named(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
) -> Result<String, String> {
    // Validate session name
    let validated_name = validation::validate_session_name(&name).map_err(|e| e.to_string())?;

    // Validate description if provided
    let validated_description = description.map(|desc| validation::sanitize_for_display(&desc));

    let db = state.db.lock();

    // Get current open tabs
    let tabs = session::list_open_tabs(&db).map_err(|e| e.to_string())?;

    // Collect scrollback for each tab
    let mut scrollback = std::collections::HashMap::new();
    for tab in &tabs {
        let scrollback_data = session::read_scrollback(&db, &tab.id).map_err(|e| e.to_string())?;
        scrollback.insert(tab.id.clone(), scrollback_data);
    }

    // Collect AI history for each tab
    let mut ai_history = std::collections::HashMap::new();
    for tab in &tabs {
        let messages = session::get_ai_messages_by_tab(&db, &tab.id).map_err(|e| e.to_string())?;
        if !messages.is_empty() {
            let messages_json = serde_json::to_string(&messages).map_err(|e| e.to_string())?;
            ai_history.insert(tab.id.clone(), messages_json);
        }
    }

    session::save_session(
        &db,
        &validated_name,
        validated_description.as_deref(),
        &tabs,
        &scrollback,
        &ai_history,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_list_saved(state: State<'_, AppState>) -> Result<Vec<SavedSessionInfo>, String> {
    let db = state.db.lock();
    let sessions = session::list_saved_sessions(&db).map_err(|e| e.to_string())?;

    Ok(sessions
        .into_iter()
        .map(|s| SavedSessionInfo {
            id: s.id,
            name: s.name,
            description: s.description,
            tab_count: s.tab_count,
            created_at: s.created_at,
        })
        .collect())
}

#[tauri::command]
pub fn session_load_saved(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<session::SessionSnapshotLegacy, String> {
    let db = state.db.lock();
    session::load_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_delete_saved(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let db = state.db.lock();
    session::delete_saved_session(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_export_json(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let db = state.db.lock();
    session::export_session_json(&db, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_import_json(
    state: State<'_, AppState>,
    json_data: String,
) -> Result<String, String> {
    let db = state.db.lock();
    session::import_session_json(&db, &json_data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_list_models(
    provider: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    match provider.as_str() {
        "anthropic" => {
            let key = api_key.ok_or("API key required for Anthropic")?;
            fetch_anthropic_models(&key).await
        }
        "openai" => {
            let key = api_key.ok_or("API key required for OpenAI")?;
            fetch_openai_models(&key).await
        }
        "google" => {
            // Google doesn't have a public models list API, return known models
            Ok(vec![
                "gemini-2.0-flash-exp".to_string(),
                "gemini-1.5-pro".to_string(),
                "gemini-1.5-flash".to_string(),
                "gemini-1.0-pro".to_string(),
            ])
        }
        "nvidia" => {
            let key = api_key.ok_or("API key required for NVIDIA")?;
            fetch_nvidia_models(&key).await
        }
        "ollama" => {
            let url = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
            fetch_ollama_models(&url).await
        }
        "vllm" => {
            let url = base_url.ok_or("Base URL required for vLLM")?;
            fetch_vllm_models(&url).await
        }
        _ => Err(format!("Unknown provider: {}", provider)),
    }
}

async fn fetch_anthropic_models(api_key: &str) -> Result<Vec<String>, String> {
    fetch_anthropic_models_from_url("https://api.anthropic.com", api_key).await
}

/// Fetches the live Anthropic Models API. Kept separately from the production
/// URL so the request contract can be tested without reaching an external API.
async fn fetch_anthropic_models_from_url(
    api_base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/v1/models?limit=1000",
        api_base_url.trim_end_matches('/')
    );
    let response = client
        .get(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Anthropic models: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Anthropic models API returned an error: {e}"))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Anthropic models response: {e}"))?;

    let models = json["data"]
        .as_array()
        .ok_or_else(|| "Invalid Anthropic models response format".to_string())?
        .iter()
        .filter_map(|model| model["id"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    Ok(models)
}

async fn fetch_openai_models(api_key: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://api.openai.com/v1/models")
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch OpenAI models: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse OpenAI response: {}", e))?;

    let models: Vec<String> = json["data"]
        .as_array()
        .ok_or("Invalid response format")?
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .filter(|id| id.starts_with("gpt-"))
        .collect();

    Ok(models)
}

async fn fetch_nvidia_models(api_key: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://integrate.api.nvidia.com/v1/models")
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch NVIDIA models: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse NVIDIA response: {}", e))?;

    let models: Vec<String> = json["data"]
        .as_array()
        .ok_or("Invalid response format")?
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .collect();

    Ok(models)
}

async fn fetch_ollama_models(base_url: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/tags", base_url);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Ollama models: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;

    let models: Vec<String> = json["models"]
        .as_array()
        .ok_or("Invalid response format")?
        .iter()
        .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
        .collect();

    Ok(models)
}

async fn fetch_vllm_models(base_url: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/models", base_url);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch vLLM models: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse vLLM response: {}", e))?;

    let models: Vec<String> = json["data"]
        .as_array()
        .ok_or("Invalid response format")?
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .collect();

    Ok(models)
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIProviderConfig {
    provider: String,
    model: String,
    api_key: Option<String>,
    base_url: Option<String>,
}

#[tauri::command]
pub fn ai_save_config(state: State<'_, AppState>, config: AIProviderConfig) -> Result<(), String> {
    let db = state.db.lock();

    // Save to database
    db.execute(
        "INSERT OR REPLACE INTO ai_config (id, provider, model, api_key, base_url) VALUES (1, ?1, ?2, ?3, ?4)",
        rusqlite::params![&config.provider, &config.model, &config.api_key, &config.base_url],
    )
    .map_err(|e| format!("Failed to save AI config: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn ai_get_config(state: State<'_, AppState>) -> Result<Option<AIProviderConfig>, String> {
    let db = state.db.lock();

    let mut stmt = db
        .prepare("SELECT provider, model, api_key, base_url FROM ai_config WHERE id = 1")
        .map_err(|e| format!("Failed to query AI config: {}", e))?;

    let config = stmt
        .query_row([], |row| {
            Ok(AIProviderConfig {
                provider: row.get(0)?,
                model: row.get(1)?,
                api_key: row.get(2)?,
                base_url: row.get(3)?,
            })
        })
        .optional()
        .map_err(|e| format!("Failed to read AI config: {}", e))?;

    Ok(config)
}

/// Master feature flag for the context-graph work (agent graph helper,
/// temporal memory, graph-compact serialization). Persisted in the generic
/// `app_flags` key/value table under `ccie_context_graph` so the sidecar
/// (`feature_flags.context_graph_enabled`) reads the same source. Default OFF —
/// the instant, no-rebuild rollback lever. An env var of the same name still
/// overrides this in the sidecar for launch-time control.
const CONTEXT_GRAPH_FLAG_KEY: &str = "ccie_context_graph";

#[tauri::command]
pub fn context_graph_get_enabled(state: State<'_, AppState>) -> Result<bool, String> {
    let db = state.db.lock();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (\
            key TEXT PRIMARY KEY,\
            value TEXT NOT NULL,\
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\
        );",
    )
    .map_err(|e| format!("Failed to ensure app_flags: {}", e))?;

    let value: Option<String> = db
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            rusqlite::params![CONTEXT_GRAPH_FLAG_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read context-graph flag: {}", e))?;

    Ok(matches!(
        value
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    ))
}

#[tauri::command]
pub fn context_graph_set_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let db = state.db.lock();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (\
            key TEXT PRIMARY KEY,\
            value TEXT NOT NULL,\
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\
        );",
    )
    .map_err(|e| format!("Failed to ensure app_flags: {}", e))?;

    db.execute(
        "INSERT OR REPLACE INTO app_flags(key, value) VALUES (?1, ?2)",
        rusqlite::params![CONTEXT_GRAPH_FLAG_KEY, if enabled { "1" } else { "0" }],
    )
    .map_err(|e| format!("Failed to save context-graph flag: {}", e))?;

    Ok(())
}

/// Staleness window (seconds) for remembered context-graph facts. A cached
/// fact older than this is flagged stale so the agent re-pulls it live. Stored
/// in `app_flags` under `ccie_context_graph_staleness_secs`; the sidecar reads
/// the same key. Default 7200 (2 hours).
const CONTEXT_GRAPH_STALENESS_KEY: &str = "ccie_context_graph_staleness_secs";
const CONTEXT_GRAPH_STALENESS_DEFAULT: i64 = 7200;

#[tauri::command]
pub fn context_graph_get_staleness(state: State<'_, AppState>) -> Result<i64, String> {
    let db = state.db.lock();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (\
            key TEXT PRIMARY KEY,\
            value TEXT NOT NULL,\
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\
        );",
    )
    .map_err(|e| format!("Failed to ensure app_flags: {}", e))?;

    let value: Option<String> = db
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            rusqlite::params![CONTEXT_GRAPH_STALENESS_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read staleness: {}", e))?;

    let secs = value
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(CONTEXT_GRAPH_STALENESS_DEFAULT);
    Ok(secs)
}

#[tauri::command]
pub fn context_graph_set_staleness(state: State<'_, AppState>, seconds: i64) -> Result<(), String> {
    if seconds <= 0 {
        return Err("staleness must be a positive number of seconds".into());
    }
    let db = state.db.lock();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (\
            key TEXT PRIMARY KEY,\
            value TEXT NOT NULL,\
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\
        );",
    )
    .map_err(|e| format!("Failed to ensure app_flags: {}", e))?;

    db.execute(
        "INSERT OR REPLACE INTO app_flags(key, value) VALUES (?1, ?2)",
        rusqlite::params![CONTEXT_GRAPH_STALENESS_KEY, seconds.to_string()],
    )
    .map_err(|e| format!("Failed to save staleness: {}", e))?;

    Ok(())
}

/// Per-vendor routing keyword overrides for the Network Architect. Stored as one
/// JSON blob in app_flags under `ccie_vendor_keywords`; the sidecar
/// (`architect_subagents.load_keyword_overrides`) reads the same key and REPLACES
/// a vendor's built-in keyword list with the stored one. Edits take effect on the
/// next agent turn — no restart.
const VENDOR_KEYWORDS_FLAG_KEY: &str = "ccie_vendor_keywords";

#[tauri::command]
pub fn vendor_keywords_get(state: State<'_, AppState>) -> Result<String, String> {
    let db = state.db.lock();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (\
            key TEXT PRIMARY KEY,\
            value TEXT NOT NULL,\
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\
        );",
    )
    .map_err(|e| format!("Failed to ensure app_flags: {}", e))?;

    let value: Option<String> = db
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            rusqlite::params![VENDOR_KEYWORDS_FLAG_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read vendor keywords: {}", e))?;

    Ok(value.unwrap_or_else(|| "{}".to_string()))
}

#[tauri::command]
pub fn vendor_keywords_set(state: State<'_, AppState>, keywords: String) -> Result<(), String> {
    // Validate it parses as a JSON object before persisting (defense in depth;
    // the sidecar also degrades gracefully on bad JSON).
    let parsed: serde_json::Value =
        serde_json::from_str(&keywords).map_err(|e| format!("Invalid JSON: {}", e))?;
    if !parsed.is_object() {
        return Err("Vendor keywords must be a JSON object".to_string());
    }

    let db = state.db.lock();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (\
            key TEXT PRIMARY KEY,\
            value TEXT NOT NULL,\
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\
        );",
    )
    .map_err(|e| format!("Failed to ensure app_flags: {}", e))?;

    db.execute(
        "INSERT OR REPLACE INTO app_flags(key, value) VALUES (?1, ?2)",
        rusqlite::params![VENDOR_KEYWORDS_FLAG_KEY, keywords],
    )
    .map_err(|e| format!("Failed to save vendor keywords: {}", e))?;

    Ok(())
}

/// Git / CI defaults for the IaC Studio push flow. Stored as one JSON blob in
/// app_flags under `ccie_git_config` (shape: `{remote, branch, authorName,
/// authorEmail}`). The Push-to-Git modal prefills from here; a per-repo remote
/// read via `git_get_remote` still takes precedence when one is configured.
const GIT_CONFIG_FLAG_KEY: &str = "ccie_git_config";

#[tauri::command]
pub fn git_config_get(state: State<'_, AppState>) -> Result<String, String> {
    let value = {
        let db = state.db.lock();
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_flags (\
                key TEXT PRIMARY KEY,\
                value TEXT NOT NULL,\
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\
            );",
        )
        .map_err(|e| format!("Failed to ensure app_flags: {}", e))?;

        db.query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            rusqlite::params![GIT_CONFIG_FLAG_KEY],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read git config: {}", e))?
        .unwrap_or_else(|| "{}".to_string())
    };

    let mut stored: serde_json::Value =
        serde_json::from_str(&value).unwrap_or_else(|_| serde_json::json!({}));
    let Some(object) = stored.as_object_mut() else {
        return Ok("{}".to_string());
    };
    let legacy_token = object
        .get("token")
        .and_then(|token| token.as_str())
        .filter(|token| !token.trim().is_empty())
        .map(str::to_string);

    let mut needs_reconnect = false;
    let mut migrated = false;
    if let Some(token) = legacy_token.as_deref() {
        match state.github_auth_manager.migrate_legacy_token(token) {
            Ok(true) => {
                object.remove("token");
                migrated = true;
            }
            Ok(false) | Err(_) => {
                // Preserve the legacy value in SQLite until secure storage
                // succeeds, but never return or use it through the frontend.
                needs_reconnect = true;
            }
        }
    }

    let mut safe = stored.clone();
    if let Some(safe_object) = safe.as_object_mut() {
        safe_object.remove("token");
        if needs_reconnect {
            safe_object.insert(
                "legacyTokenNeedsReconnect".to_string(),
                serde_json::Value::Bool(true),
            );
        }
    }

    if migrated {
        let db = state.db.lock();
        db.execute(
            "INSERT OR REPLACE INTO app_flags(key, value) VALUES (?1, ?2)",
            rusqlite::params![GIT_CONFIG_FLAG_KEY, stored.to_string()],
        )
        .map_err(|e| format!("Failed to finish secure GitHub token migration: {}", e))?;
    }

    serde_json::to_string(&safe).map_err(|e| format!("Failed to encode git config: {e}"))
}

#[tauri::command]
pub fn git_config_set(state: State<'_, AppState>, config: String) -> Result<(), String> {
    // Validate it parses as a JSON object before persisting (defense in depth).
    let parsed: serde_json::Value =
        serde_json::from_str(&config).map_err(|e| format!("Invalid JSON: {}", e))?;
    if !parsed.is_object() {
        return Err("Git config must be a JSON object".to_string());
    }
    if parsed.get("token").is_some() {
        return Err(
            "GitHub tokens cannot be saved in Git defaults. Connect GitHub from the Git panel."
                .to_string(),
        );
    }

    let mut stored = parsed;

    let db = state.db.lock();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (\
            key TEXT PRIMARY KEY,\
            value TEXT NOT NULL,\
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\
        );",
    )
    .map_err(|e| format!("Failed to ensure app_flags: {}", e))?;

    // An older build may still have a plaintext token awaiting secure
    // migration. Preserve it in-place when keyring migration failed; never
    // expose it to React and never accept a new plaintext replacement.
    if !state
        .github_auth_manager
        .has_secure_token()
        .unwrap_or(false)
    {
        let existing: Option<String> = db
            .query_row(
                "SELECT value FROM app_flags WHERE key = ?1",
                rusqlite::params![GIT_CONFIG_FLAG_KEY],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to read existing git config: {e}"))?;
        if let Some(token) = existing
            .as_deref()
            .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
            .and_then(|value| value.get("token").cloned())
        {
            if let Some(object) = stored.as_object_mut() {
                object.insert("token".to_string(), token);
            }
        }
    }

    db.execute(
        "INSERT OR REPLACE INTO app_flags(key, value) VALUES (?1, ?2)",
        rusqlite::params![GIT_CONFIG_FLAG_KEY, stored.to_string()],
    )
    .map_err(|e| format!("Failed to save git config: {}", e))?;

    Ok(())
}

/// Built-in keyword defaults (display name + keyword list per vendor). Python is
/// the single source of truth: at startup the sidecar exports the static
/// defaults to `<config_dir>/vendor_keyword_defaults.json`. We read that file
/// directly — NOT an RPC — because the sidecar request loop is single-threaded,
/// so a mid-agent-turn RPC would hang behind the running turn (the Settings tab
/// then shows an empty panel). The RPC is kept only as a fallback for the narrow
/// window before the file is written on a fresh start; that window has no agent
/// turn in flight, so the RPC responds promptly there.
#[tauri::command]
pub async fn vendor_keyword_defaults(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Primary path: read the file the sidecar exported at startup (no RPC).
    if let Ok(dir) = crate::db::default_db_path() {
        let path = dir
            .parent()
            .map(|p| p.join("vendor_keyword_defaults.json"))
            .unwrap_or_default();
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                return Ok(value);
            }
        }
    }

    // Fallback: ask the sidecar directly (fresh-start race before the file lands).
    let resp = state
        .agent
        .call("architect.keyword_defaults", serde_json::json!({}))
        .await
        .map_err(|e| format!("Sidecar call failed: {}", e))?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        other => Err(format!("Unexpected sidecar response: {:?}", other)),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxmoxConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub token_name: String,
    #[serde(default)]
    pub token_value: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub verify_ssl: bool,
}

#[tauri::command]
pub fn proxmox_save_config(
    state: State<'_, AppState>,
    config: ProxmoxConfig,
) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "INSERT OR REPLACE INTO proxmox_config \
         (id, host, port, user, token_name, token_value, password, verify_ssl) \
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            &config.host,
            config.port as i64,
            &config.user,
            &config.token_name,
            &config.token_value,
            &config.password,
            if config.verify_ssl { 1_i64 } else { 0_i64 },
        ],
    )
    .map_err(|e| format!("Failed to save Proxmox config: {}", e))?;
    Ok(())
}

fn read_proxmox_config_from_db(db: &rusqlite::Connection) -> Result<Option<ProxmoxConfig>, String> {
    let mut stmt = db
        .prepare(
            "SELECT host, port, user, token_name, token_value, password, verify_ssl \
             FROM proxmox_config WHERE id = 1",
        )
        .map_err(|e| format!("Failed to query Proxmox config: {}", e))?;
    stmt.query_row([], |row| {
        Ok(ProxmoxConfig {
            host: row.get(0)?,
            port: row.get::<_, i64>(1)? as u16,
            user: row.get(2)?,
            token_name: row.get(3)?,
            token_value: row.get(4)?,
            password: row.get(5)?,
            verify_ssl: row.get::<_, i64>(6)? != 0,
        })
    })
    .optional()
    .map_err(|e| format!("Failed to read Proxmox config: {}", e))
}

#[tauri::command]
pub fn proxmox_get_config(state: State<'_, AppState>) -> Result<Option<ProxmoxConfig>, String> {
    let db = state.db.lock();
    read_proxmox_config_from_db(&db)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProxmoxTestResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProxmoxInventoryNode {
    pub node: String,
    pub status: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProxmoxTemplate {
    pub node: String,
    pub vmid: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProxmoxInventory {
    pub nodes: Vec<ProxmoxInventoryNode>,
    pub templates: Vec<ProxmoxTemplate>,
}

const PROXMOX_LXC_ACTION_TIMEOUT: Duration = Duration::from_secs(120);
const PROXMOX_LXC_CLONE_TIMEOUT: Duration = Duration::from_secs(600);

fn proxmox_accept_invalid_certs(config: &ProxmoxConfig) -> bool {
    !config.verify_ssl
}

fn proxmox_token_header_value(config: &ProxmoxConfig) -> Option<String> {
    if config.token_name.is_empty() || config.token_value.is_empty() {
        return None;
    }
    let token_id = if config.token_name.contains('!') {
        config.token_name.clone()
    } else {
        format!("{}!{}", config.user, config.token_name)
    };
    Some(format!("PVEAPIToken={}={}", token_id, config.token_value))
}

fn proxmox_base_url(config: &ProxmoxConfig) -> Result<String, String> {
    let host = config.host.trim();
    if host.is_empty()
        || host.contains(':')
        || host
            .chars()
            .any(|c| c.is_ascii_whitespace() || matches!(c, '@' | '/' | '?' | '#' | '\\'))
    {
        return Err("Proxmox host must be a bare hostname or IP; put the port in the Port field.".into());
    }
    Ok(format!("https://{}:{}/api2/json", host, config.port))
}

fn proxmox_node_segment(node: &str) -> Result<&str, String> {
    if !node.is_empty()
        && node
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        Ok(node)
    } else {
        Err("Invalid Proxmox node name.".into())
    }
}

fn proxmox_vmid_segment(vmid: &str) -> Result<&str, String> {
    if !vmid.is_empty() && vmid.chars().all(|c| c.is_ascii_digit()) {
        Ok(vmid)
    } else {
        Err("Invalid Proxmox VMID.".into())
    }
}

fn proxmox_lxc_status_path(node: &str, vmid: &str, action: &str) -> Result<String, String> {
    if !matches!(action, "start" | "stop") {
        return Err("Invalid Proxmox LXC action.".into());
    }
    Ok(format!(
        "/nodes/{}/lxc/{}/status/{}",
        proxmox_node_segment(node)?,
        proxmox_vmid_segment(vmid)?,
        action
    ))
}

fn proxmox_lxc_clone_path(node: &str, template_vmid: &str) -> Result<String, String> {
    Ok(format!(
        "/nodes/{}/lxc/{}/clone",
        proxmox_node_segment(node)?,
        proxmox_vmid_segment(template_vmid)?
    ))
}

fn proxmox_task_status_path(node: &str, upid: &str) -> Result<String, String> {
    if upid.contains('/') || upid.contains('?') || upid.contains('#') {
        return Err("Invalid Proxmox task id.".into());
    }
    Ok(format!("/nodes/{}/tasks/{}/status", proxmox_node_segment(node)?, upid))
}

fn proxmox_password_headers_from_ticket(ticket: &serde_json::Value) -> Result<reqwest::header::HeaderMap, String> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, COOKIE};

    let Some(cookie) = ticket
        .get("data")
        .and_then(|data| data.get("ticket"))
        .and_then(|value| value.as_str()) else {
        return Err("Proxmox did not return an auth ticket.".into());
    };
    let Some(csrf) = ticket
        .get("data")
        .and_then(|data| data.get("CSRFPreventionToken"))
        .and_then(|value| value.as_str()) else {
        return Err("Proxmox did not return a CSRF token.".into());
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        COOKIE,
        HeaderValue::from_str(&format!("PVEAuthCookie={}", cookie))
            .map_err(|_| "Invalid Proxmox auth ticket.".to_string())?,
    );
    headers.insert(
        HeaderName::from_static("csrfpreventiontoken"),
        HeaderValue::from_str(csrf).map_err(|_| "Invalid Proxmox CSRF token.".to_string())?,
    );
    Ok(headers)
}

async fn proxmox_client(config: &ProxmoxConfig) -> Result<(reqwest::Client, String, reqwest::header::HeaderMap), String> {
    use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};

    let base_url = proxmox_base_url(config)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(proxmox_accept_invalid_certs(config))
        .build()
        .map_err(|e| e.to_string())?;
    let mut headers = HeaderMap::new();

    if let Some(token) = proxmox_token_header_value(config) {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&token).map_err(|_| "Invalid Proxmox API token.".to_string())?,
        );
    } else {
        let ticket: serde_json::Value = client
            .post(format!("{}/access/ticket", base_url))
            .form(&[("username", config.user.as_str()), ("password", config.password.as_str())])
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        headers = proxmox_password_headers_from_ticket(&ticket)?;
    }
    Ok((client, base_url, headers))
}

async fn proxmox_request_data(
    client: &reqwest::Client,
    base_url: &str,
    headers: &reqwest::header::HeaderMap,
    method: reqwest::Method,
    path: &str,
    form: Option<Vec<(&'static str, String)>>,
) -> Result<serde_json::Value, String> {
    let mut request = client
        .request(method, format!("{}{}", base_url, path))
        .headers(headers.clone());
    if let Some(form) = &form {
        request = request.form(form);
    }
    let body: serde_json::Value = request
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(body.get("data").cloned().unwrap_or(serde_json::Value::Null))
}

async fn proxmox_get_data(client: &reqwest::Client, base_url: &str, headers: &reqwest::header::HeaderMap, path: &str) -> Result<Vec<serde_json::Value>, String> {
    Ok(proxmox_request_data(client, base_url, headers, reqwest::Method::GET, path, None)
        .await?
        .as_array()
        .cloned()
        .unwrap_or_default())
}

async fn proxmox_nodes(config: &ProxmoxConfig) -> Result<Vec<serde_json::Value>, String> {
    let (client, base_url, headers) = proxmox_client(config).await?;
    proxmox_get_data(&client, &base_url, &headers, "/nodes").await
}

async fn proxmox_wait_task(
    client: &reqwest::Client,
    base_url: &str,
    headers: &reqwest::header::HeaderMap,
    node: &str,
    upid: &str,
    timeout: Duration,
) -> Result<(), String> {
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        let path = proxmox_task_status_path(node, upid)?;
        let status = proxmox_request_data(client, base_url, headers, reqwest::Method::GET, &path, None).await?;
        if status.get("status").and_then(|value| value.as_str()) == Some("stopped") {
            return if status.get("exitstatus").and_then(|value| value.as_str()) == Some("OK") {
                Ok(())
            } else {
                Err(status.get("exitstatus").and_then(|value| value.as_str()).unwrap_or("task failed").to_string())
            };
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err("task timed out".into())
}

async fn proxmox_lxc_action(config: &ProxmoxConfig, node: &str, vmid: &str, action: &str) -> Result<(), String> {
    let (client, base_url, headers) = proxmox_client(config).await?;
    let path = proxmox_lxc_status_path(node, vmid, action)?;
    let upid = proxmox_request_data(&client, &base_url, &headers, reqwest::Method::POST, &path, None)
        .await?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("Proxmox did not return a {} task.", action))?;
    proxmox_wait_task(&client, &base_url, &headers, node, &upid, PROXMOX_LXC_ACTION_TIMEOUT).await
}

async fn proxmox_clone_lxc(config: &ProxmoxConfig, computer: &AgentComputerEntry) -> Result<AgentComputerEntry, String> {
    let (client, base_url, headers) = proxmox_client(config).await?;
    let template_vmid = computer.template_vmid.trim();
    if template_vmid.is_empty() {
        return Err("Agent computer needs template VMID.".into());
    }
    let path = proxmox_lxc_clone_path(&computer.node, template_vmid)?;
    let upid = proxmox_request_data(
        &client,
        &base_url,
        &headers,
        reqwest::Method::POST,
        &path,
        Some(vec![("newid", computer.vmid.clone()), ("full", "1".into())]),
    )
    .await?
    .as_str()
    .map(str::to_string)
    .ok_or_else(|| "Proxmox did not return a clone task.".to_string())?;
    proxmox_wait_task(&client, &base_url, &headers, &computer.node, &upid, PROXMOX_LXC_CLONE_TIMEOUT).await?;
    proxmox_lxc_action(config, &computer.node, &computer.vmid, "start").await?;
    Ok(AgentComputerEntry {
        name: if computer.name.is_empty() { format!("agent-{}", computer.vmid) } else { computer.name.clone() },
        node: computer.node.clone(),
        vmid: computer.vmid.clone(),
        template_vmid: template_vmid.to_string(),
        base_url: format!("pct://{}/{}", computer.node, computer.vmid),
        token: if computer.token.is_empty() { "pct".into() } else { computer.token.clone() },
    })
}

async fn proxmox_list_inventory_from_config(config: &ProxmoxConfig) -> Result<ProxmoxInventory, String> {
    let (client, base_url, headers) = proxmox_client(config).await?;
    let nodes_raw = proxmox_get_data(&client, &base_url, &headers, "/nodes").await?;
    let nodes: Vec<ProxmoxInventoryNode> = nodes_raw
        .iter()
        .filter_map(|node| {
            Some(ProxmoxInventoryNode {
                node: node.get("node")?.as_str()?.to_string(),
                status: node.get("status").and_then(|value| value.as_str()).map(str::to_string),
            })
        })
        .collect();
    let mut templates = Vec::new();
    for node in &nodes {
        if node.status.as_deref() != Some("online") {
            continue;
        }
        let Ok(containers) = proxmox_get_data(&client, &base_url, &headers, &format!("/nodes/{}/lxc", node.node)).await else {
            continue;
        };
        for ct in containers {
            if ct.get("template").and_then(|value| value.as_i64()).unwrap_or(0) != 1 {
                continue;
            }
            let Some(vmid) = ct.get("vmid") else { continue };
            templates.push(ProxmoxTemplate {
                node: node.node.clone(),
                vmid: vmid.as_str().map(str::to_string).unwrap_or_else(|| vmid.to_string()),
                name: ct.get("name").and_then(|value| value.as_str()).map(str::to_string),
            });
        }
    }
    Ok(ProxmoxInventory { nodes, templates })
}

#[tauri::command]
pub async fn proxmox_list_inventory(state: State<'_, AppState>) -> Result<ProxmoxInventory, String> {
    let config = {
        let db = state.db.lock();
        read_proxmox_config_from_db(&db)?
    }
    .ok_or_else(|| "Proxmox is not configured. Set host/credentials in Settings → Proxmox.".to_string())?;
    proxmox_list_inventory_from_config(&config).await
}

async fn proxmox_test_connection_direct(config: &ProxmoxConfig) -> ProxmoxTestResult {
    if config.host.trim().is_empty() {
        return ProxmoxTestResult {
            ok: false,
            message: "No host set. Enter a Proxmox host first.".into(),
        };
    }
    let nodes = match proxmox_nodes(config).await {
        Ok(nodes) => nodes,
        Err(e) => {
            return ProxmoxTestResult {
                ok: false,
                message: format!("Connection failed: {}", e),
            }
        }
    };
    let names: Vec<String> = nodes
        .iter()
        .filter_map(|node| node.get("node").and_then(|value| value.as_str()).map(str::to_string))
        .collect();
    let online = nodes
        .iter()
        .filter(|node| node.get("status").and_then(|value| value.as_str()) == Some("online"))
        .count();
    let mut message = format!("Connected. {} node(s): {}.", names.len(), if names.is_empty() { "none".into() } else { names.join(", ") });
    if online > 0 {
        message.push_str(&format!(" {} online.", online));
    }
    ProxmoxTestResult { ok: true, message }
}

const AGENT_COMPUTERS_FLAG_KEY: &str = "ccie_agent_computers";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentComputerEntry {
    pub name: String,
    pub node: String,
    pub vmid: String,
    #[serde(default)]
    pub template_vmid: String,
    pub base_url: String,
    pub token: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct AgentComputerConfig {
    pub computers: Vec<AgentComputerEntry>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentComputerResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub computer: Option<AgentComputerEntry>,
}

#[tauri::command]
pub fn agent_computers_get_config(
    state: State<'_, AppState>,
) -> Result<AgentComputerConfig, String> {
    let db = state.db.lock();
    db.execute(
        "CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )
    .map_err(|e| e.to_string())?;
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            rusqlite::params![AGENT_COMPUTERS_FLAG_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match value {
        Some(raw) => serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid Agent Computers config: {}", e)),
        None => Ok(AgentComputerConfig::default()),
    }
}

#[tauri::command]
pub fn agent_computers_save_config(
    state: State<'_, AppState>,
    config: AgentComputerConfig,
) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )
    .map_err(|e| e.to_string())?;
    let raw = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO app_flags(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![AGENT_COMPUTERS_FLAG_KEY, raw],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn agent_computer_allows_plain_http(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .filter(|url| url.scheme() == "http")
        .and_then(|url| {
            url.host_str()
                .map(|host| host == "localhost" || host == "127.0.0.1" || host == "::1")
        })
        .unwrap_or(false)
}

fn agent_computer_requires_tls(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .map(|url| url.scheme() != "https" && !agent_computer_allows_plain_http(base_url))
        .unwrap_or(true)
}

fn agent_computer_saved_entry(
    state: &State<'_, AppState>,
    computer: &AgentComputerEntry,
) -> Result<Option<AgentComputerEntry>, String> {
    let db = state.db.lock();
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            rusqlite::params![AGENT_COMPUTERS_FLAG_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(raw) = value else { return Ok(None) };
    let config: AgentComputerConfig = serde_json::from_str(&raw)
        .map_err(|e| format!("Invalid Agent Computers config: {}", e))?;
    Ok(config.computers.into_iter().find(|saved| {
        saved.name == computer.name && saved.node == computer.node && saved.vmid == computer.vmid
    }))
}

#[tauri::command]
pub async fn agent_computer_test(
    state: State<'_, AppState>,
    computer: AgentComputerEntry,
) -> Result<AgentComputerResult, String> {
    if computer.base_url.starts_with("pct://") {
        return agent_computer_lxc(state, computer, "agent_computer.health").await;
    }
    if agent_computer_requires_tls(&computer.base_url) {
        return Ok(AgentComputerResult {
            ok: false,
            message: "Agent computer Base URL must use HTTPS unless it is loopback HTTP.".into(),
            computer: None,
        });
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!("{}/health", computer.base_url.trim_end_matches('/')))
        .bearer_auth(computer.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(AgentComputerResult {
        ok: res.status().is_success(),
        message: if res.status().is_success() {
            "Connected".into()
        } else {
            format!("HTTP {}", res.status())
        },
        computer: None,
    })
}

async fn agent_computer_lxc(
    state: State<'_, AppState>,
    computer: AgentComputerEntry,
    method: &str,
) -> Result<AgentComputerResult, String> {
    let proxmox_config = {
        let db = state.db.lock();
        read_proxmox_config_from_db(&db)?
    };

    if matches!(method, "agent_computer.provision" | "agent_computer.start_lxc" | "agent_computer.stop_lxc") {
        let Some(config) = proxmox_config else {
            return Ok(AgentComputerResult {
                ok: false,
                message: "Proxmox is not configured. Set host/credentials in Settings → Proxmox.".into(),
                computer: None,
            });
        };
        if computer.node.is_empty() || computer.vmid.is_empty() {
            return Ok(AgentComputerResult {
                ok: false,
                message: "Agent computer needs node and vmid.".into(),
                computer: None,
            });
        }

        return match method {
            "agent_computer.provision" => match proxmox_clone_lxc(&config, &computer).await {
                Ok(generated) => Ok(AgentComputerResult { ok: true, message: "Provisioned".into(), computer: Some(generated) }),
                Err(message) => Ok(AgentComputerResult { ok: false, message, computer: None }),
            },
            "agent_computer.start_lxc" => match proxmox_lxc_action(&config, &computer.node, &computer.vmid, "start").await {
                Ok(()) => Ok(AgentComputerResult { ok: true, message: "Started".into(), computer: None }),
                Err(message) => Ok(AgentComputerResult { ok: false, message, computer: None }),
            },
            "agent_computer.stop_lxc" => match proxmox_lxc_action(&config, &computer.node, &computer.vmid, "stop").await {
                Ok(()) => Ok(AgentComputerResult { ok: true, message: "Stopped".into(), computer: None }),
                Err(message) => Ok(AgentComputerResult { ok: false, message, computer: None }),
            },
            _ => unreachable!(),
        };
    }

    let resp = state
        .agent
        .call_with_idle_timeout(
            method,
            serde_json::json!({ "computer": computer, "proxmoxConfig": proxmox_config }),
            Duration::from_secs(30),
        )
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(AgentComputerResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("No response from sidecar")
                .to_string(),
            computer: result
                .get("computer")
                .cloned()
                .and_then(|value| serde_json::from_value(value).ok()),
        }),
        crate::agent_bridge::AgentResponse::Error { message } => Ok(AgentComputerResult {
            ok: false,
            message,
            computer: None,
        }),
        _ => Err("unexpected response type".to_string()),
    }
}

#[tauri::command]
pub async fn agent_computer_provision(
    state: State<'_, AppState>,
    computer: AgentComputerEntry,
) -> Result<AgentComputerResult, String> {
    agent_computer_lxc(state, computer, "agent_computer.provision").await
}

#[tauri::command]
pub async fn agent_computer_start(
    state: State<'_, AppState>,
    computer: AgentComputerEntry,
) -> Result<AgentComputerResult, String> {
    match agent_computer_saved_entry(&state, &computer)? {
        Some(saved) => agent_computer_lxc(state, saved, "agent_computer.start_lxc").await,
        None => Ok(AgentComputerResult { ok: false, message: "Save this Agent Computer before starting it.".into(), computer: None }),
    }
}

#[tauri::command]
pub async fn agent_computer_stop(
    state: State<'_, AppState>,
    computer: AgentComputerEntry,
) -> Result<AgentComputerResult, String> {
    match agent_computer_saved_entry(&state, &computer)? {
        Some(saved) => agent_computer_lxc(state, saved, "agent_computer.stop_lxc").await,
        None => Ok(AgentComputerResult { ok: false, message: "Save this Agent Computer before stopping it.".into(), computer: None }),
    }
}

#[tauri::command]
pub async fn proxmox_test_connection(
    _state: State<'_, AppState>,
    config: ProxmoxConfig,
) -> Result<ProxmoxTestResult, String> {
    Ok(proxmox_test_connection_direct(&config).await)
}

#[tauri::command]
pub async fn ai_test_connection(config: AIProviderConfig) -> Result<String, String> {
    match config.provider.as_str() {
        "anthropic" => {
            let key = config.api_key.ok_or("API key required for Anthropic")?;
            test_anthropic(&key, &config.model).await
        }
        "openai" => {
            let key = config.api_key.ok_or("API key required for OpenAI")?;
            test_openai(&key, &config.model).await
        }
        "google" => {
            let key = config.api_key.ok_or("API key required for Google")?;
            test_google(&key, &config.model).await
        }
        "nvidia" => {
            let key = config.api_key.ok_or("API key required for NVIDIA")?;
            test_nvidia(&key, &config.model).await
        }
        "ollama" => {
            let url = config
                .base_url
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            test_ollama(&url, &config.model).await
        }
        "vllm" => {
            let url = config.base_url.ok_or("Base URL required for vLLM")?;
            test_vllm(&url, &config.model).await
        }
        _ => Err(format!("Unknown provider: {}", config.provider)),
    }
}

async fn test_anthropic(api_key: &str, model: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "max_tokens": 10,
            "messages": [{"role": "user", "content": "test"}]
        }))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if response.status().is_success() {
        Ok(format!(
            "✓ Successfully connected to Anthropic with {}",
            model
        ))
    } else {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error ({}): {}", status, text))
    }
}

async fn test_openai(api_key: &str, model: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "test"}],
            "max_tokens": 5
        }))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if response.status().is_success() {
        Ok(format!("✓ Successfully connected to OpenAI with {}", model))
    } else {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error ({}): {}", status, text))
    }
}

async fn test_google(api_key: &str, model: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, api_key
    );
    let response = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "contents": [{"parts": [{"text": "test"}]}]
        }))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if response.status().is_success() {
        Ok(format!("✓ Successfully connected to Google with {}", model))
    } else {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error ({}): {}", status, text))
    }
}

async fn test_ollama(base_url: &str, model: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/generate", base_url);
    let response = client
        .post(&url)
        .json(&serde_json::json!({
            "model": model,
            "prompt": "test",
            "stream": false
        }))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if response.status().is_success() {
        Ok(format!("✓ Successfully connected to Ollama with {}", model))
    } else {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(format!("Connection error ({}): {}", status, text))
    }
}

async fn test_vllm(base_url: &str, model: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/chat/completions", base_url);
    let response = client
        .post(&url)
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "test"}],
            "max_tokens": 5
        }))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if response.status().is_success() {
        Ok(format!("✓ Successfully connected to vLLM with {}", model))
    } else {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(format!("Connection error ({}): {}", status, text))
    }
}

async fn test_nvidia(api_key: &str, model: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .post("https://integrate.api.nvidia.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 10
        }))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if response.status().is_success() {
        Ok("✓ Connection successful! NVIDIA API is working.".to_string())
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(format!("Connection failed: HTTP {} - {}", status, body))
    }
}

// ============================================================================
// FTP server — config, users, lifecycle, events
// ============================================================================

#[tauri::command]
pub fn ftp_config_get(state: State<'_, AppState>) -> Result<ftp::FtpConfig, String> {
    let db = state.db.lock();
    db.query_row(
        "SELECT bind_host, bind_port, passive_min, passive_max, greeting, auto_start
           FROM ftp_config WHERE id = 1",
        [],
        |row| {
            Ok(ftp::FtpConfig {
                bind_host: row.get(0)?,
                bind_port: row.get::<_, i64>(1)? as u16,
                passive_min: row.get::<_, i64>(2)? as u16,
                passive_max: row.get::<_, i64>(3)? as u16,
                greeting: row.get(4)?,
                auto_start: row.get::<_, i64>(5)? != 0,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ftp_config_set(state: State<'_, AppState>, config: ftp::FtpConfig) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "UPDATE ftp_config SET
           bind_host = ?1, bind_port = ?2, passive_min = ?3,
           passive_max = ?4, greeting = ?5, auto_start = ?6,
           updated_at = strftime('%s','now')
         WHERE id = 1",
        rusqlite::params![
            &config.bind_host,
            config.bind_port as i64,
            config.passive_min as i64,
            config.passive_max as i64,
            &config.greeting,
            if config.auto_start { 1i64 } else { 0 },
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn ftp_status(state: State<'_, AppState>) -> Result<ftp::FtpStatus, String> {
    Ok(state.ftp.status())
}

#[tauri::command]
pub async fn ftp_start(state: State<'_, AppState>) -> Result<ftp::FtpStatus, String> {
    // Read config inline (State isn't Clone, so we can't reuse ftp_config_get).
    let config = {
        let db = state.db.lock();
        db.query_row(
            "SELECT bind_host, bind_port, passive_min, passive_max, greeting, auto_start
               FROM ftp_config WHERE id = 1",
            [],
            |row| {
                Ok(ftp::FtpConfig {
                    bind_host: row.get(0)?,
                    bind_port: row.get::<_, i64>(1)? as u16,
                    passive_min: row.get::<_, i64>(2)? as u16,
                    passive_max: row.get::<_, i64>(3)? as u16,
                    greeting: row.get(4)?,
                    auto_start: row.get::<_, i64>(5)? != 0,
                })
            },
        )
        .map_err(|e| e.to_string())?
    };
    state.ftp.start(config).await.map_err(|e| e.to_string())?;
    Ok(state.ftp.status())
}

#[tauri::command]
pub fn ftp_stop(state: State<'_, AppState>) -> Result<ftp::FtpStatus, String> {
    state.ftp.stop().map_err(|e| e.to_string())?;
    Ok(state.ftp.status())
}

// ---- Users CRUD ----

#[tauri::command]
pub fn ftp_users_list(state: State<'_, AppState>) -> Result<Vec<ftp::FtpUser>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT id, username, password, home_dir, read_only, enabled, created_at, updated_at
               FROM ftp_users ORDER BY username",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ftp::FtpUser {
                id: r.get(0)?,
                username: r.get(1)?,
                password: r.get(2)?,
                home_dir: r.get(3)?,
                read_only: r.get::<_, i64>(4)? != 0,
                enabled: r.get::<_, i64>(5)? != 0,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn ftp_users_create(
    state: State<'_, AppState>,
    input: ftp::CreateFtpUserInput,
) -> Result<ftp::FtpUser, String> {
    if input.username.trim().is_empty() {
        return Err("username required".into());
    }
    let safe_name: String = input
        .username
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    if safe_name.is_empty() {
        return Err("username must contain alphanumerics".into());
    }
    let home = match input.home_dir.as_ref().filter(|s| !s.is_empty()) {
        Some(p) => std::path::PathBuf::from(p),
        None => ftp::default_user_home(&safe_name).map_err(|e| e.to_string())?,
    };
    std::fs::create_dir_all(&home).map_err(|e| format!("create home dir: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let home_str = home.to_string_lossy().to_string();
    let db = state.db.lock();
    db.execute(
        "INSERT INTO ftp_users (id, username, password, home_dir, read_only, enabled)
           VALUES (?1, ?2, ?3, ?4, ?5, 1)",
        rusqlite::params![
            &id,
            &safe_name,
            &input.password,
            &home_str,
            if input.read_only { 1i64 } else { 0 },
        ],
    )
    .map_err(|e| e.to_string())?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok(ftp::FtpUser {
        id,
        username: safe_name,
        password: input.password,
        home_dir: home_str,
        read_only: input.read_only,
        enabled: true,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
pub fn ftp_users_update(
    state: State<'_, AppState>,
    input: ftp::UpdateFtpUserInput,
) -> Result<(), String> {
    let db = state.db.lock();
    if let Some(u) = input.username.as_ref() {
        db.execute(
            "UPDATE ftp_users SET username = ?1, updated_at = strftime('%s','now') WHERE id = ?2",
            rusqlite::params![u, &input.id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(p) = input.password.as_ref() {
        db.execute(
            "UPDATE ftp_users SET password = ?1, updated_at = strftime('%s','now') WHERE id = ?2",
            rusqlite::params![p, &input.id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(h) = input.home_dir.as_ref() {
        std::fs::create_dir_all(h).ok();
        db.execute(
            "UPDATE ftp_users SET home_dir = ?1, updated_at = strftime('%s','now') WHERE id = ?2",
            rusqlite::params![h, &input.id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(ro) = input.read_only {
        db.execute(
            "UPDATE ftp_users SET read_only = ?1, updated_at = strftime('%s','now') WHERE id = ?2",
            rusqlite::params![if ro { 1i64 } else { 0 }, &input.id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(en) = input.enabled {
        db.execute(
            "UPDATE ftp_users SET enabled = ?1, updated_at = strftime('%s','now') WHERE id = ?2",
            rusqlite::params![if en { 1i64 } else { 0 }, &input.id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn ftp_users_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock();
    db.execute("DELETE FROM ftp_users WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Events ----

#[tauri::command]
pub fn ftp_events_tail(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<ftp::FtpEvent>, String> {
    let lim = limit.unwrap_or(200).min(5000);
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT id, ts, kind, username, client_ip, path, detail
               FROM ftp_events ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([lim as i64], |r| {
            Ok(ftp::FtpEvent {
                id: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                username: r.get(3)?,
                client_ip: r.get(4)?,
                path: r.get(5)?,
                detail: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    // Return oldest-first so the UI can append as-is.
    out.reverse();
    Ok(out)
}

#[tauri::command]
pub async fn ftp_events_stream(
    state: State<'_, AppState>,
    on_event: Channel<ftp::FtpEvent>,
) -> Result<(), String> {
    let mut rx = state.ftp.events.subscribe();
    tokio::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            if on_event.send(ev).is_err() {
                break;
            }
        }
    });
    Ok(())
}

// ============================================================================
// TFTP server — config, lifecycle, events (no users; TFTP is anonymous)
// ============================================================================

fn read_tftp_config(db: &rusqlite::Connection) -> Result<tftp::TftpConfig, String> {
    db.query_row(
        "SELECT bind_host, bind_port, root_dir, read_only, auto_start
           FROM tftp_config WHERE id = 1",
        [],
        |row| {
            Ok(tftp::TftpConfig {
                bind_host: row.get(0)?,
                bind_port: row.get::<_, i64>(1)? as u16,
                root_dir: row.get(2)?,
                read_only: row.get::<_, i64>(3)? != 0,
                auto_start: row.get::<_, i64>(4)? != 0,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tftp_config_get(state: State<'_, AppState>) -> Result<tftp::TftpConfig, String> {
    let db = state.db.lock();
    read_tftp_config(&db)
}

#[tauri::command]
pub fn tftp_config_set(state: State<'_, AppState>, config: tftp::TftpConfig) -> Result<(), String> {
    // Make sure the chosen root exists (empty root = default, created on start).
    if !config.root_dir.trim().is_empty() {
        std::fs::create_dir_all(&config.root_dir).ok();
    }
    let db = state.db.lock();
    db.execute(
        "UPDATE tftp_config SET
           bind_host = ?1, bind_port = ?2, root_dir = ?3,
           read_only = ?4, auto_start = ?5,
           updated_at = strftime('%s','now')
         WHERE id = 1",
        rusqlite::params![
            &config.bind_host,
            config.bind_port as i64,
            &config.root_dir,
            if config.read_only { 1i64 } else { 0 },
            if config.auto_start { 1i64 } else { 0 },
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn tftp_status(state: State<'_, AppState>) -> Result<tftp::TftpStatus, String> {
    Ok(state.tftp.status())
}

#[tauri::command]
pub async fn tftp_start(state: State<'_, AppState>) -> Result<tftp::TftpStatus, String> {
    let config = {
        let db = state.db.lock();
        read_tftp_config(&db)?
    };
    state.tftp.start(config).await.map_err(|e| e.to_string())?;
    Ok(state.tftp.status())
}

#[tauri::command]
pub fn tftp_stop(state: State<'_, AppState>) -> Result<tftp::TftpStatus, String> {
    state.tftp.stop().map_err(|e| e.to_string())?;
    Ok(state.tftp.status())
}

#[tauri::command]
pub fn tftp_events_tail(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<tftp::TftpEvent>, String> {
    let lim = limit.unwrap_or(200).min(5000);
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT id, ts, kind, client_ip, path, detail
               FROM tftp_events ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([lim as i64], |r| {
            Ok(tftp::TftpEvent {
                id: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                client_ip: r.get(3)?,
                path: r.get(4)?,
                detail: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    out.reverse(); // oldest-first for the feed
    Ok(out)
}

// Plan 16 Phase 1 — IaC integration: query IaC execution metadata for enriched block rendering
#[tauri::command]
pub fn get_iac_execution(
    state: State<'_, AppState>,
    execution_id: String,
) -> Result<Option<crate::database::IaCExecution>, String> {
    use rusqlite::params;
    let db = state.db.lock();

    let mut stmt = db
        .prepare(
            "SELECT id, command_block_id, tool, subcommand, project_path,
                git_commit, git_branch, had_uncommitted_changes,
                blast_radius, resources_changed, resources_failed,
                metadata_json, created_at
         FROM iac_executions WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let result = stmt.query_row(params![execution_id], |row| {
        Ok(crate::database::IaCExecution {
            id: row.get(0)?,
            command_block_id: row.get(1)?,
            tool: row.get(2)?,
            subcommand: row.get(3)?,
            project_path: row.get(4)?,
            git_commit: row.get(5)?,
            git_branch: row.get(6)?,
            had_uncommitted_changes: row.get::<_, i32>(7)? != 0,
            blast_radius: row.get(8)?,
            resources_changed: row.get::<_, Option<i64>>(9)?.map(|v| v as u32),
            resources_failed: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
            metadata_json: row.get(11)?,
            created_at: row.get::<_, i64>(12)? as u64,
        })
    });

    match result {
        Ok(exec) => Ok(Some(exec)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// Plan 16 Phase 1 — IaC integration: process completed block and store IaC execution
#[tauri::command]
pub async fn iac_process_block(
    state: State<'_, AppState>,
    block_id: String,
) -> Result<Option<String>, String> {
    use crate::iac::detector::detect_iac_command;
    use crate::iac::parser::{parse_ansible_output, parse_terraform_output};
    use rusqlite::params;

    let db = state.db.lock();

    // Read block from database
    let mut stmt = db
        .prepare("SELECT cmd, output, cwd FROM command_blocks WHERE id = ?1")
        .map_err(|e| e.to_string())?;

    let (cmd, output_raw, cwd): (String, rusqlite::types::Value, String) = stmt
        .query_row(params![&block_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?;

    // Handle both BLOB and TEXT output types (column changed from BLOB to TEXT in newer schema)
    let output = match output_raw {
        rusqlite::types::Value::Blob(bytes) => bytes,
        rusqlite::types::Value::Text(text) => text.into_bytes(),
        _ => return Err("Invalid output column type".to_string()),
    };

    drop(stmt);
    drop(db);

    // Detect IaC command
    let working_dir = std::path::PathBuf::from(&cwd);
    let iac_cmd = match detect_iac_command(&cmd, &working_dir) {
        Some(cmd) if cmd.is_mutating => cmd,
        _ => return Ok(None), // Not an IaC command or not mutating
    };

    // Parse output
    let output_str = String::from_utf8_lossy(&output);
    let metadata = match iac_cmd.tool {
        crate::iac::types::IaCTool::Terraform => {
            parse_terraform_output(&output_str, &iac_cmd.subcommand)
        }
        crate::iac::types::IaCTool::Ansible => parse_ansible_output(&output_str),
    }
    .map_err(|e| format!("Parse error: {}", e))?;

    // Get git info
    let git_branch = get_git_branch(&working_dir).ok();
    let git_commit = get_git_commit(&working_dir).ok();

    // Store execution using database.rs wrapper
    let exec_id = crate::database::Database::insert_iac_execution_direct(
        &state.db,
        &block_id,
        iac_cmd.tool,
        &iac_cmd.subcommand,
        iac_cmd.working_dir.to_str().unwrap_or(""),
        git_commit.as_deref(),
        git_branch.as_deref(),
        false,
        Some("low"), // TODO: blast radius calculation in Phase 2
        &metadata,
    )
    .map_err(|e| e.to_string())?;

    // Update command_blocks with iac_execution_id for frontend lookup
    let db = state.db.lock();
    db.execute(
        "UPDATE command_blocks SET iac_execution_id = ?1 WHERE id = ?2",
        params![&exec_id, &block_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(Some(exec_id))
}

fn get_git_branch(working_dir: &std::path::Path) -> Result<String, std::io::Error> {
    let output = std::process::Command::new("git")
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("HEAD")
        .current_dir(working_dir)
        .output()?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn get_git_commit(working_dir: &std::path::Path) -> Result<String, std::io::Error> {
    let output = std::process::Command::new("git")
        .arg("rev-parse")
        .arg("HEAD")
        .current_dir(working_dir)
        .output()?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// IaC Phase 2 — classify the blast radius of a mutating IaC operation.
///
/// The thresholds + `terraform plan -json` execution live in the Python sidecar
/// (single source of truth — see iac_blast_radius.py). This command forwards to
/// the `iac.classify_blast_radius` RPC so any terminal-side UI reuses the same
/// classifier the agent uses. Returns the classifier result JSON
/// ({tier, create, update, destroy, source, note?}).
#[tauri::command]
pub async fn iac_classify_blast_radius(
    state: State<'_, AppState>,
    tool: String,
    working_dir: String,
    git_branch: Option<String>,
    plan_output: Option<String>,
    has_destructive_tag: Option<bool>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "tool": tool,
        "working_dir": working_dir,
        "git_branch": git_branch.unwrap_or_default(),
        "plan_output": plan_output,
        "has_destructive_tag": has_destructive_tag.unwrap_or(false),
    });
    let resp = state
        .agent
        .call("iac.classify_blast_radius", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

/// IaC Studio Phase B — lint a single buffer via the sidecar's `iac.lint_file`
/// RPC. Forwards the file path, content, and language; returns the structured
/// `{ diagnostics, linters }` payload verbatim. Editing never depends on this —
/// if the sidecar is down the caller simply gets an Err and shows no diagnostics.
#[tauri::command]
pub async fn iac_lint_file(
    state: State<'_, AppState>,
    file_path: String,
    content: String,
    language: String,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "file_path": file_path,
        "content": content,
        "language": language,
    });
    let resp = state
        .agent
        .call("iac.lint_file", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

/// IaC Studio Phase C — generate Terraform HCL from natural language via the
/// sidecar's `iac.generate_terraform_code` RPC (Settings-page LLM). Returns the
/// codegen dict verbatim; `unavailable: true` is a valid (honest) result, not
/// an error.
#[tauri::command]
pub async fn iac_generate_terraform(
    state: State<'_, AppState>,
    intent: String,
    working_dir: String,
    git_branch: Option<String>,
    existing_code: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "intent": intent,
        "working_dir": working_dir,
        "git_branch": git_branch.unwrap_or_default(),
        "existing_code": existing_code.unwrap_or_default(),
    });
    let resp = state
        .agent
        .call("iac.generate_terraform_code", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

/// IaC Studio Phase C — generate an Ansible playbook from natural language via
/// the sidecar's `iac.generate_ansible_playbook` RPC (Settings-page LLM).
#[tauri::command]
pub async fn iac_generate_ansible(
    state: State<'_, AppState>,
    intent: String,
    working_dir: String,
    git_branch: Option<String>,
    existing_code: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "intent": intent,
        "working_dir": working_dir,
        "git_branch": git_branch.unwrap_or_default(),
        "existing_code": existing_code.unwrap_or_default(),
    });
    let resp = state
        .agent
        .call("iac.generate_ansible_playbook", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

/// IaC Studio Phase D — generate a CI/CD pipeline (GitHub Actions / GitLab CI)
/// from structured inputs via the sidecar's `iac.generate_pipeline` RPC. Output
/// is validated as plain YAML, never as HCL/playbook. `unavailable: true` is a
/// valid (honest) result, not an error.
#[tauri::command]
pub async fn iac_generate_pipeline(
    state: State<'_, AppState>,
    platform: String,
    tool: String,
    flow: String,
    auth: Option<String>,
    intent: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "platform": platform,
        "tool": tool,
        "flow": flow,
        "auth": auth.unwrap_or_default(),
        "intent": intent.unwrap_or_default(),
    });
    let resp = state
        .agent
        .call("iac.generate_pipeline", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

/// IaC Phase 3 — load a project's terraform state, using the V0050 cache when
/// the .tfstate mtime is unchanged. Tries `terraform.tfstate` then
/// `.terraform/terraform.tfstate`. Returns None when no state file exists
/// (not an error — the drawer shows an empty state).
#[tauri::command]
pub fn iac_load_state(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<Option<crate::iac::state_manager::TerraformState>, String> {
    use rusqlite::params;
    use std::time::UNIX_EPOCH;

    let base = std::path::PathBuf::from(&project_path);
    let candidates = [
        base.join("terraform.tfstate"),
        base.join(".terraform").join("terraform.tfstate"),
    ];
    let state_file = match candidates.iter().find(|p| p.exists()) {
        Some(p) => p.clone(),
        None => return Ok(None),
    };

    let mtime = std::fs::metadata(&state_file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let db = state.db.lock();

    // Serve from cache if mtime matches.
    let cached: Option<String> = db
        .query_row(
            "SELECT state_json FROM terraform_state_cache
             WHERE project_path = ?1 AND last_updated = ?2",
            params![&project_path, mtime],
            |row| row.get(0),
        )
        .ok();
    if let Some(json) = cached {
        let parsed =
            crate::iac::state_manager::parse_terraform_state(&json).map_err(|e| e.to_string())?;
        return Ok(Some(parsed));
    }

    // Cache miss / stale — read fresh, parse, upsert.
    let raw = std::fs::read_to_string(&state_file).map_err(|e| e.to_string())?;
    let parsed =
        crate::iac::state_manager::parse_terraform_state(&raw).map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO terraform_state_cache
           (id, project_path, state_json, serial, resource_count, last_updated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(project_path) DO UPDATE SET
           state_json = excluded.state_json,
           serial = excluded.serial,
           resource_count = excluded.resource_count,
           last_updated = excluded.last_updated",
        params![
            uuid::Uuid::new_v4().to_string(),
            &project_path,
            &raw,
            parsed.serial as i64,
            parsed.resources.len() as i64,
            mtime
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(Some(parsed))
}

/// IaC Phase 3 — filtered resource query for the state drawer search box.
#[tauri::command]
pub fn iac_query_state(
    state: State<'_, AppState>,
    project_path: String,
    query: Option<String>,
) -> Result<Vec<crate::iac::state_manager::StateResource>, String> {
    let loaded = iac_load_state(state, project_path)?;
    let st = match loaded {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let filtered = crate::iac::state_manager::query_state_resources(&st, query.as_deref());
    Ok(filtered.into_iter().cloned().collect())
}

/// IaC Phase 3 — add a drift exception (local ignore list).
#[tauri::command]
pub fn iac_add_drift_exception(
    state: State<'_, AppState>,
    project_path: String,
    resource_address: String,
) -> Result<(), String> {
    use rusqlite::params;
    let db = state.db.lock();
    db.execute(
        "INSERT OR IGNORE INTO drift_exceptions
           (id, project_path, resource_address, created_at)
         VALUES (?1, ?2, ?3, strftime('%s','now'))",
        params![
            uuid::Uuid::new_v4().to_string(),
            project_path,
            resource_address
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// IaC Phase 3 — list drift-exception resource addresses for a project.
#[tauri::command]
pub fn iac_list_drift_exceptions(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<Vec<String>, String> {
    use rusqlite::params;
    let db = state.db.lock();
    let mut stmt = db
        .prepare("SELECT resource_address FROM drift_exceptions WHERE project_path = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_path], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// IaC Phase 3 — run an on-demand, read-only drift check.
///
/// 1. `terraform plan -detailed-exitcode -json` (read-only) via drift_checker.
/// 2. Best-effort AI explanation over the `iac.analyze_drift` sidecar RPC; a
///    failure here NEVER fails the check (analysis is omitted).
/// 3. Persist a drift_checks row ONLY when the check actually ran. On terraform
///    absence / plan error we return Err and write nothing (report, not guess).
#[tauri::command]
pub async fn iac_check_drift(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<serde_json::Value, String> {
    use rusqlite::params;

    let path = std::path::PathBuf::from(&project_path);
    let drift = crate::iac::drift_checker::run_drift_plan(&path).map_err(|e| e.to_string())?;

    // Best-effort AI analysis (only when there's drift to explain).
    let mut analysis = serde_json::json!({"analyses": []});
    if drift.has_drift {
        let rpc_params = serde_json::json!({
            "drifted": drift.drifted,
            "plan_output": "",
        });
        if let Ok(crate::agent_bridge::AgentResponse::Done { result }) =
            state.agent.call("iac.analyze_drift", rpc_params).await
        {
            analysis = result;
        }
    }

    let summary = serde_json::json!({
        "drifted": drift.drifted,
        "analysis": analysis,
    });

    // Persist (the check ran successfully, so record it).
    {
        let db = state.db.lock();
        db.execute(
            "INSERT INTO drift_checks
               (id, project_path, checked_at, has_drift, drifted_count,
                drift_summary_json, created_at)
             VALUES (?1, ?2, strftime('%s','now'), ?3, ?4, ?5, strftime('%s','now'))",
            params![
                uuid::Uuid::new_v4().to_string(),
                &project_path,
                drift.has_drift as i32,
                drift.drifted.len() as i64,
                summary.to_string(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(serde_json::json!({
        "hasDrift": drift.has_drift,
        "drifted": drift.drifted,
        "analysis": analysis,
    }))
}

// ---- Stealthwatch Configuration --------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StealthwatchConfig {
    pub host: String,
    pub username: String,
    pub password: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn stealthwatch_get_config(
    state: State<'_, AppState>,
) -> Result<Option<StealthwatchConfig>, String> {
    let conn = state.db.lock();

    let result: Option<StealthwatchConfig> = conn
        .query_row(
            "SELECT host, username, password, verify_ssl FROM stealthwatch_config WHERE id = 1",
            [],
            |row| {
                Ok(StealthwatchConfig {
                    host: row.get(0)?,
                    username: row.get(1)?,
                    password: row.get(2)?,
                    verify_ssl: row.get::<_, i64>(3)? == 1,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Register the Stealthwatch MCP server in the `mcp_servers` table.
/// Credentials are passed via environment variables so the Python script
/// can access them without storing them in the command JSON.
fn enable_stealthwatch_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &StealthwatchConfig,
) -> Result<(), String> {
    // Get Python interpreter path (bundled or dev .venv)
    let (python, _) = sidecar_spawn_target();

    // Construct path to MCP script relative to repo root
    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/stealthwatch_mcp.py",
        repo_root
    );

    // Prepare command JSON for stdio transport
    let command_json = serde_json::json!({
        "cmd": python,
        "args": [mcp_script_path]
    });

    // Prepare environment JSON with credentials
    let env_json = serde_json::json!({
        "STEALTHWATCH_HOST": config.host,
        "STEALTHWATCH_USERNAME": config.username,
        "STEALTHWATCH_PASSWORD": config.password,
        "STEALTHWATCH_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    // Upsert MCP server configuration
    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('stealthwatch-mcp', 'Cisco Stealthwatch Enterprise', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn stealthwatch_save_config(
    state: State<'_, AppState>,
    config: StealthwatchConfig,
) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO stealthwatch_config (id, host, username, password, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4)",
            rusqlite::params![
                config.host,
                config.username,
                config.password,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // Auto-enable MCP server after saving config
    enable_stealthwatch_mcp_server(&state.db, &config)?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StealthwatchTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn stealthwatch_test_connection(
    state: State<'_, AppState>,
    config: StealthwatchConfig,
) -> Result<StealthwatchTestResult, String> {
    // Prepare config as JSON params for Python sidecar RPC
    let params = serde_json::json!({
        "config": {
            "host": config.host,
            "username": config.username,
            "password": config.password,
            "verify_ssl": config.verify_ssl,
        }
    });

    // Call Python sidecar via agent bridge
    let resp = state
        .agent
        .call("stealthwatch.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;

    // Extract ok + message from response
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(StealthwatchTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Cisco ISE Configuration -----------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IseConfig {
    pub host: String,
    pub username: String,
    pub password: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn ise_get_config(state: State<'_, AppState>) -> Result<Option<IseConfig>, String> {
    let conn = state.db.lock();

    let result: Option<IseConfig> = conn
        .query_row(
            "SELECT host, username, password, verify_ssl FROM ise_config WHERE id = 1",
            [],
            |row| {
                Ok(IseConfig {
                    host: row.get(0)?,
                    username: row.get(1)?,
                    password: row.get(2)?,
                    verify_ssl: row.get::<_, i64>(3)? == 1,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Register the ISE MCP server in the `mcp_servers` table.
/// Credentials are passed via environment variables so the Python script
/// can access them without storing them in the command JSON.
fn enable_ise_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &IseConfig,
) -> Result<(), String> {
    // Get Python interpreter path (bundled or dev .venv)
    let (python, _) = sidecar_spawn_target();

    // Construct path to MCP script relative to repo root
    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/ise_mcp.py",
        repo_root
    );

    // Prepare command JSON for stdio transport
    let command_json = serde_json::json!({
        "cmd": python,
        "args": [mcp_script_path]
    });

    // Prepare environment JSON with credentials
    let env_json = serde_json::json!({
        "ISE_HOST": config.host,
        "ISE_USERNAME": config.username,
        "ISE_PASSWORD": config.password,
        "ISE_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    // Upsert MCP server configuration
    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('ise-mcp', 'Cisco ISE', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn ise_save_config(state: State<'_, AppState>, config: IseConfig) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO ise_config (id, host, username, password, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4)",
            rusqlite::params![
                config.host,
                config.username,
                config.password,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // Auto-enable MCP server after saving config
    enable_ise_mcp_server(&state.db, &config)?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IseTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn ise_test_connection(
    state: State<'_, AppState>,
    config: IseConfig,
) -> Result<IseTestResult, String> {
    // Prepare config as JSON params for Python sidecar RPC
    let params = serde_json::json!({
        "config": {
            "host": config.host,
            "username": config.username,
            "password": config.password,
            "verify_ssl": config.verify_ssl,
        }
    });

    // Call Python sidecar via agent bridge
    let resp = state
        .agent
        .call("ise.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;

    // Extract ok + message from response
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(IseTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Netclaw-inspired integrations (Grafana / Prometheus / NetBox / Sketchfab)
// These mirror the ISE config pattern (singleton table + get/save/test) but do
// NOT register an MCP-server twin — the in-sandbox helper is the only transport.
// A shared VendorTestResult keeps the test payload uniform across all four.

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VendorTestResult {
    pub ok: bool,
    pub message: String,
}

fn unwrap_test_result(
    resp: crate::agent_bridge::AgentResponse,
) -> Result<VendorTestResult, String> {
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(VendorTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Grafana ---------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrafanaConfig {
    pub url: String,
    pub token: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn grafana_get_config(
    state: State<'_, AppState>,
) -> Result<Option<GrafanaConfig>, String> {
    let conn = state.db.lock();
    let result: Option<GrafanaConfig> = conn
        .query_row(
            "SELECT url, token, verify_ssl FROM grafana_config WHERE id = 1",
            [],
            |row| {
                Ok(GrafanaConfig {
                    url: row.get(0)?,
                    token: row.get(1)?,
                    verify_ssl: row.get::<_, i64>(2)? == 1,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn grafana_save_config(
    state: State<'_, AppState>,
    config: GrafanaConfig,
) -> Result<(), String> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO grafana_config (id, url, token, verify_ssl)
         VALUES (1, ?1, ?2, ?3)",
        rusqlite::params![
            config.url,
            config.token,
            if config.verify_ssl { 1 } else { 0 },
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn grafana_test_connection(
    state: State<'_, AppState>,
    config: GrafanaConfig,
) -> Result<VendorTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "url": config.url,
            "token": config.token,
            "verify_ssl": config.verify_ssl,
        }
    });
    let resp = state
        .agent
        .call("grafana.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;
    unwrap_test_result(resp)
}

// ---- Prometheus ------------------------------------------------------------

// ---- Zabbix ----------------------------------------------------------------
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZabbixConfig {
    pub url: String,
    pub auth_mode: String,
    pub token: String,
    pub username: String,
    pub password: String,
    pub verify_ssl: bool,
}
#[tauri::command]
pub async fn zabbix_get_config(state: State<'_, AppState>) -> Result<Option<ZabbixConfig>, String> {
    let conn = state.db.lock();
    conn.query_row("SELECT url, auth_mode, token, username, password, verify_ssl FROM zabbix_config WHERE id=1", [], |r| Ok(ZabbixConfig { url:r.get(0)?, auth_mode:r.get(1)?, token:r.get(2)?, username:r.get(3)?, password:r.get(4)?, verify_ssl:r.get::<_,i64>(5)? == 1 })).optional().map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn zabbix_save_config(
    state: State<'_, AppState>,
    mut config: ZabbixConfig,
) -> Result<(), String> {
    if config.auth_mode == "token" {
        config.username.clear();
        config.password.clear();
    } else {
        config.token.clear();
    }
    state.db.lock().execute("INSERT OR REPLACE INTO zabbix_config (id,url,auth_mode,token,username,password,verify_ssl) VALUES (1,?1,?2,?3,?4,?5,?6)", rusqlite::params![config.url,config.auth_mode,config.token,config.username,config.password,if config.verify_ssl {1}else{0}]).map_err(|e|e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn zabbix_test_connection(
    state: State<'_, AppState>,
    config: ZabbixConfig,
) -> Result<VendorTestResult, String> {
    let resp=state.agent.call("zabbix.test_connection", serde_json::json!({"config":{"url":config.url,"auth_mode":config.auth_mode,"token":config.token,"username":config.username,"password":config.password,"verify_ssl":config.verify_ssl}})).await.map_err(|e|e.to_string())?;
    unwrap_test_result(resp)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrometheusConfig {
    pub url: String,
    pub username: String,
    pub password: String,
    pub token: String,
    pub org_id: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn prometheus_get_config(
    state: State<'_, AppState>,
) -> Result<Option<PrometheusConfig>, String> {
    let conn = state.db.lock();
    let result: Option<PrometheusConfig> = conn
        .query_row(
            "SELECT url, username, password, token, org_id, verify_ssl FROM prometheus_config WHERE id = 1",
            [],
            |row| Ok(PrometheusConfig {
                url: row.get(0)?,
                username: row.get(1)?,
                password: row.get(2)?,
                token: row.get(3)?,
                org_id: row.get(4)?,
                verify_ssl: row.get::<_, i64>(5)? == 1,
            }),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn prometheus_save_config(
    state: State<'_, AppState>,
    config: PrometheusConfig,
) -> Result<(), String> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO prometheus_config (id, url, username, password, token, org_id, verify_ssl)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            config.url,
            config.username,
            config.password,
            config.token,
            config.org_id,
            if config.verify_ssl { 1 } else { 0 },
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn prometheus_test_connection(
    state: State<'_, AppState>,
    config: PrometheusConfig,
) -> Result<VendorTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "url": config.url,
            "username": config.username,
            "password": config.password,
            "token": config.token,
            "org_id": config.org_id,
            "verify_ssl": config.verify_ssl,
        }
    });
    let resp = state
        .agent
        .call("prometheus.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;
    unwrap_test_result(resp)
}

// ---- NetBox ----------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetboxConfig {
    pub url: String,
    pub token: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn netbox_get_config(state: State<'_, AppState>) -> Result<Option<NetboxConfig>, String> {
    let conn = state.db.lock();
    let result: Option<NetboxConfig> = conn
        .query_row(
            "SELECT url, token, verify_ssl FROM netbox_config WHERE id = 1",
            [],
            |row| {
                Ok(NetboxConfig {
                    url: row.get(0)?,
                    token: row.get(1)?,
                    verify_ssl: row.get::<_, i64>(2)? == 1,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn netbox_save_config(
    state: State<'_, AppState>,
    config: NetboxConfig,
) -> Result<(), String> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO netbox_config (id, url, token, verify_ssl)
         VALUES (1, ?1, ?2, ?3)",
        rusqlite::params![
            config.url,
            config.token,
            if config.verify_ssl { 1 } else { 0 },
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn netbox_test_connection(
    state: State<'_, AppState>,
    config: NetboxConfig,
) -> Result<VendorTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "url": config.url,
            "token": config.token,
            "verify_ssl": config.verify_ssl,
        }
    });
    let resp = state
        .agent
        .call("netbox.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;
    unwrap_test_result(resp)
}

// ---- Sketchfab (API key is optional) ---------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchfabConfig {
    pub api_key: String,
}

#[tauri::command]
pub async fn sketchfab_get_config(
    state: State<'_, AppState>,
) -> Result<Option<SketchfabConfig>, String> {
    let conn = state.db.lock();
    let result: Option<SketchfabConfig> = conn
        .query_row(
            "SELECT api_key FROM sketchfab_config WHERE id = 1",
            [],
            |row| {
                Ok(SketchfabConfig {
                    api_key: row.get(0)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn sketchfab_save_config(
    state: State<'_, AppState>,
    config: SketchfabConfig,
) -> Result<(), String> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO sketchfab_config (id, api_key) VALUES (1, ?1)",
        rusqlite::params![config.api_key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn sketchfab_test_connection(
    state: State<'_, AppState>,
    config: SketchfabConfig,
) -> Result<VendorTestResult, String> {
    let params = serde_json::json!({
        "config": { "api_key": config.api_key }
    });
    let resp = state
        .agent
        .call("sketchfab.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;
    unwrap_test_result(resp)
}

// ---- Cisco Secure Endpoint Configuration --------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureEndpointConfig {
    pub region: String,
    pub auth_mode: String,
    pub client_id: String,
    pub api_key: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn secure_endpoint_get_config(
    state: State<'_, AppState>,
) -> Result<Option<SecureEndpointConfig>, String> {
    let conn = state.db.lock();
    let result: Option<SecureEndpointConfig> = conn
        .query_row(
            "SELECT region, auth_mode, client_id, api_key, verify_ssl FROM secure_endpoint_config WHERE id = 1",
            [],
            |row| Ok(SecureEndpointConfig {
                region: row.get(0)?,
                auth_mode: row.get(1)?,
                client_id: row.get(2)?,
                api_key: row.get(3)?,
                verify_ssl: row.get::<_, i64>(4)? == 1,
            }),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

/// Register the Secure Endpoint MCP server in the `mcp_servers` table.
/// Credentials are passed via environment variables so the Python script can
/// access them without storing them in the command JSON.
fn enable_secure_endpoint_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &SecureEndpointConfig,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();
    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/secure_endpoint_mcp.py",
        repo_root
    );

    let command_json = serde_json::json!({ "cmd": python, "args": [mcp_script_path] });
    let env_json = serde_json::json!({
        "SECURE_ENDPOINT_REGION": config.region,
        "SECURE_ENDPOINT_AUTH_MODE": config.auth_mode,
        "SECURE_ENDPOINT_CLIENT_ID": config.client_id,
        "SECURE_ENDPOINT_API_KEY": config.api_key,
        "SECURE_ENDPOINT_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('secure-endpoint-mcp', 'Cisco Secure Endpoint', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn secure_endpoint_save_config(
    state: State<'_, AppState>,
    config: SecureEndpointConfig,
) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO secure_endpoint_config (id, region, auth_mode, client_id, api_key, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                config.region,
                config.auth_mode,
                config.client_id,
                config.api_key,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    enable_secure_endpoint_mcp_server(&state.db, &config)?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SecureEndpointTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn secure_endpoint_test_connection(
    state: State<'_, AppState>,
    config: SecureEndpointConfig,
) -> Result<SecureEndpointTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "region": config.region,
            "auth_mode": config.auth_mode,
            "client_id": config.client_id,
            "api_key": config.api_key,
            "verify_ssl": config.verify_ssl,
        }
    });
    let resp = state
        .agent
        .call("secure_endpoint.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(SecureEndpointTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Cisco XDR Configuration --------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiscoXdrConfig {
    pub region: String,
    pub client_id: String,
    pub client_password: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn cisco_xdr_get_config(
    state: State<'_, AppState>,
) -> Result<Option<CiscoXdrConfig>, String> {
    let conn = state.db.lock();
    let result: Option<CiscoXdrConfig> = conn
        .query_row(
            "SELECT region, client_id, client_password, verify_ssl FROM cisco_xdr_config WHERE id = 1",
            [],
            |row| Ok(CiscoXdrConfig {
                region: row.get(0)?,
                client_id: row.get(1)?,
                client_password: row.get(2)?,
                verify_ssl: row.get::<_, i64>(3)? == 1,
            }),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

/// Register the Cisco XDR MCP server in the `mcp_servers` table.
/// Credentials are passed via environment variables so the Python script can
/// access them without storing them in the command JSON.
fn enable_cisco_xdr_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &CiscoXdrConfig,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();
    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/cisco_xdr_mcp.py",
        repo_root
    );

    let command_json = serde_json::json!({ "cmd": python, "args": [mcp_script_path] });
    let env_json = serde_json::json!({
        "CISCO_XDR_REGION": config.region,
        "CISCO_XDR_CLIENT_ID": config.client_id,
        "CISCO_XDR_CLIENT_PASSWORD": config.client_password,
        "CISCO_XDR_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('cisco-xdr-mcp', 'Cisco XDR', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cisco_xdr_save_config(
    state: State<'_, AppState>,
    config: CiscoXdrConfig,
) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO cisco_xdr_config (id, region, client_id, client_password, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4)",
            rusqlite::params![
                config.region,
                config.client_id,
                config.client_password,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    enable_cisco_xdr_mcp_server(&state.db, &config)?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CiscoXdrTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn cisco_xdr_test_connection(
    state: State<'_, AppState>,
    config: CiscoXdrConfig,
) -> Result<CiscoXdrTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "region": config.region,
            "client_id": config.client_id,
            "client_password": config.client_password,
            "verify_ssl": config.verify_ssl,
        }
    });
    let resp = state
        .agent
        .call("cisco_xdr.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(CiscoXdrTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Juniper Mist Configuration --------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MistConfig {
    pub region: String,
    pub api_token: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn mist_get_config(state: State<'_, AppState>) -> Result<Option<MistConfig>, String> {
    let conn = state.db.lock();
    let result: Option<MistConfig> = conn
        .query_row(
            "SELECT region, api_token, verify_ssl FROM mist_config WHERE id = 1",
            [],
            |row| {
                Ok(MistConfig {
                    region: row.get(0)?,
                    api_token: row.get(1)?,
                    verify_ssl: row.get::<_, i64>(2)? == 1,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

/// Register the Juniper Mist MCP server in the `mcp_servers` table.
/// Credentials are passed via environment variables so the Python script can
/// access them without storing them in the command JSON.
fn enable_mist_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &MistConfig,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();
    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/mist_mcp.py",
        repo_root
    );

    let command_json = serde_json::json!({ "cmd": python, "args": [mcp_script_path] });
    let env_json = serde_json::json!({
        "MIST_REGION": config.region,
        "MIST_API_TOKEN": config.api_token,
        "MIST_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('mist-mcp', 'Juniper Mist', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mist_save_config(
    state: State<'_, AppState>,
    config: MistConfig,
) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO mist_config (id, region, api_token, verify_ssl)
             VALUES (1, ?1, ?2, ?3)",
            rusqlite::params![
                config.region,
                config.api_token,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    enable_mist_mcp_server(&state.db, &config)?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MistTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn mist_test_connection(
    state: State<'_, AppState>,
    config: MistConfig,
) -> Result<MistTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "region": config.region,
            "api_token": config.api_token,
            "verify_ssl": config.verify_ssl,
        }
    });
    let resp = state
        .agent
        .call("mist.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(MistTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- WhatsApp Bridge Configuration -----------------------------------------
// Personal linked-device transport via the sidecar's neonize client. Unlike the
// vendor integrations there is no MCP server (WhatsApp is a transport, not an
// agent tool) and no credential column (the linked-device session authenticates).

#[tauri::command]
pub async fn whatsapp_get_config(
    state: State<'_, AppState>,
) -> Result<crate::whatsapp::WhatsAppConfig, String> {
    Ok(crate::whatsapp::get_config(&state.db))
}

#[tauri::command]
pub async fn whatsapp_save_config(
    state: State<'_, AppState>,
    config: crate::whatsapp::WhatsAppConfig,
) -> Result<(), String> {
    crate::whatsapp::save_config(&state.db, &config)?;
    // Push the new allowlist/session to the sidecar. If enabled, (re)start the
    // client so a freshly-linked allowlist takes effect immediately; if
    // disabled, leave any running client alone (unlink is explicit).
    if config.enabled {
        let params = serde_json::json!({
            "session_dir": config.session_dir,
            "allowlist": config.allowlist,
            "bound_chat": config.bound_chat_jid,
        });
        let _ = state.agent.call("whatsapp.link", params).await;
    }
    Ok(())
}

/// Start pairing (or reconnect). QR + link state are read back via `whatsapp_status`.
#[tauri::command]
pub async fn whatsapp_link(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = crate::whatsapp::get_config(&state.db);
    let params = serde_json::json!({
        "session_dir": cfg.session_dir,
        "allowlist": cfg.allowlist,
        "bound_chat": cfg.bound_chat_jid,
    });
    match state
        .agent
        .call("whatsapp.link", params)
        .await
        .map_err(|e| e.to_string())?
    {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

/// List joined WhatsApp groups so the Settings UI can offer a chat-scope picker.
#[tauri::command]
pub async fn whatsapp_list_groups(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    match state
        .agent
        .call("whatsapp.list_groups", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())?
    {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

#[tauri::command]
pub async fn whatsapp_unlink(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    match state
        .agent
        .call("whatsapp.unlink", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())?
    {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

#[tauri::command]
pub async fn whatsapp_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    match state
        .agent
        .call("whatsapp.status", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())?
    {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Cisco Modeling Labs (CML) Configuration -------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CmlConfig {
    pub host: String,
    pub username: String,
    pub password: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn cml_get_config(state: State<'_, AppState>) -> Result<Option<CmlConfig>, String> {
    let conn = state.db.lock();

    let result: Option<CmlConfig> = conn
        .query_row(
            "SELECT host, username, password, verify_ssl FROM cml_config WHERE id = 1",
            [],
            |row| {
                Ok(CmlConfig {
                    host: row.get(0)?,
                    username: row.get(1)?,
                    password: row.get(2)?,
                    verify_ssl: row.get::<_, i64>(3)? == 1,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Register the CML MCP server in the `mcp_servers` table.
/// Credentials are passed via environment variables so the Python script
/// can access them without storing them in the command JSON.
fn enable_cml_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &CmlConfig,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();

    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/cml_mcp.py",
        repo_root
    );

    let command_json = serde_json::json!({
        "cmd": python,
        "args": [mcp_script_path]
    });

    let env_json = serde_json::json!({
        "CML_HOST": config.host,
        "CML_USERNAME": config.username,
        "CML_PASSWORD": config.password,
        "CML_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('cml-mcp', 'Cisco Modeling Labs', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn cml_save_config(state: State<'_, AppState>, config: CmlConfig) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO cml_config (id, host, username, password, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4)",
            rusqlite::params![
                config.host,
                config.username,
                config.password,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    enable_cml_mcp_server(&state.db, &config)?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CmlTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn cml_test_connection(
    state: State<'_, AppState>,
    config: CmlConfig,
) -> Result<CmlTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "host": config.host,
            "username": config.username,
            "password": config.password,
            "verify_ssl": config.verify_ssl,
        }
    });

    let resp = state
        .agent
        .call("cml.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(CmlTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Cisco Catalyst Center (DNA Center) Configuration ----------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalystCenterConfig {
    pub host: String,
    pub username: String,
    pub password: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn catalyst_center_get_config(
    state: State<'_, AppState>,
) -> Result<Option<CatalystCenterConfig>, String> {
    let conn = state.db.lock();

    let result: Option<CatalystCenterConfig> = conn
        .query_row(
            "SELECT host, username, password, verify_ssl FROM catalyst_center_config WHERE id = 1",
            [],
            |row| {
                Ok(CatalystCenterConfig {
                    host: row.get(0)?,
                    username: row.get(1)?,
                    password: row.get(2)?,
                    verify_ssl: row.get::<_, i64>(3)? == 1,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Register the Catalyst Center MCP server in the `mcp_servers` table.
/// Credentials are passed via environment variables so the Python script
/// can access them without storing them in the command JSON.
fn enable_catalyst_center_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &CatalystCenterConfig,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();

    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/catalyst_center_mcp.py",
        repo_root
    );

    let command_json = serde_json::json!({
        "cmd": python,
        "args": [mcp_script_path]
    });

    let env_json = serde_json::json!({
        "CATALYST_CENTER_HOST": config.host,
        "CATALYST_CENTER_USERNAME": config.username,
        "CATALYST_CENTER_PASSWORD": config.password,
        "CATALYST_CENTER_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('catalyst-center-mcp', 'Cisco Catalyst Center', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn catalyst_center_save_config(
    state: State<'_, AppState>,
    config: CatalystCenterConfig,
) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO catalyst_center_config (id, host, username, password, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4)",
            rusqlite::params![
                config.host,
                config.username,
                config.password,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    enable_catalyst_center_mcp_server(&state.db, &config)?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CatalystCenterTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn catalyst_center_test_connection(
    state: State<'_, AppState>,
    config: CatalystCenterConfig,
) -> Result<CatalystCenterTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "host": config.host,
            "username": config.username,
            "password": config.password,
            "verify_ssl": config.verify_ssl,
        }
    });

    let resp = state
        .agent
        .call("catalyst_center.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(CatalystCenterTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Cisco Splunk Configuration --------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplunkConfig {
    pub host: String,
    pub port: i64,
    pub token: String,
    pub username: String,
    pub password: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn splunk_get_config(state: State<'_, AppState>) -> Result<Option<SplunkConfig>, String> {
    let conn = state.db.lock();

    let result: Option<SplunkConfig> = conn
        .query_row(
            "SELECT host, port, token, username, password, verify_ssl FROM splunk_config WHERE id = 1",
            [],
            |row| Ok(SplunkConfig {
                host: row.get(0)?,
                port: row.get(1)?,
                token: row.get(2)?,
                username: row.get(3)?,
                password: row.get(4)?,
                verify_ssl: row.get::<_, i64>(5)? == 1,
            })
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Register the Splunk MCP server in the `mcp_servers` table.
/// Credentials are passed via environment variables so the Python script
/// can access them without storing them in the command JSON.
fn enable_splunk_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &SplunkConfig,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();

    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/splunk_mcp.py",
        repo_root
    );

    let command_json = serde_json::json!({
        "cmd": python,
        "args": [mcp_script_path]
    });

    let env_json = serde_json::json!({
        "SPLUNK_HOST": config.host,
        "SPLUNK_PORT": config.port.to_string(),
        "SPLUNK_TOKEN": config.token,
        "SPLUNK_USERNAME": config.username,
        "SPLUNK_PASSWORD": config.password,
        "SPLUNK_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('splunk-mcp', 'Cisco Splunk', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn splunk_save_config(
    state: State<'_, AppState>,
    config: SplunkConfig,
) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO splunk_config (id, host, port, token, username, password, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                config.host,
                config.port,
                config.token,
                config.username,
                config.password,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    enable_splunk_mcp_server(&state.db, &config)?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SplunkTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn splunk_test_connection(
    state: State<'_, AppState>,
    config: SplunkConfig,
) -> Result<SplunkTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "host": config.host,
            "port": config.port,
            "token": config.token,
            "username": config.username,
            "password": config.password,
            "verify_ssl": config.verify_ssl,
        }
    });

    let resp = state
        .agent
        .call("splunk.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(SplunkTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Cisco ACI (APIC) Configuration ----------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AciConfig {
    pub host: String,
    pub username: String,
    pub password: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn aci_get_config(state: State<'_, AppState>) -> Result<Option<AciConfig>, String> {
    let conn = state.db.lock();

    let result: Option<AciConfig> = conn
        .query_row(
            "SELECT host, username, password, verify_ssl FROM aci_config WHERE id = 1",
            [],
            |row| {
                Ok(AciConfig {
                    host: row.get(0)?,
                    username: row.get(1)?,
                    password: row.get(2)?,
                    verify_ssl: row.get::<_, i64>(3)? == 1,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Register the ACI MCP server in the `mcp_servers` table. Credentials are
/// passed via environment variables so the Python script can access them
/// without storing them in the command JSON.
fn enable_aci_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &AciConfig,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();

    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/aci_mcp.py",
        repo_root
    );

    let command_json = serde_json::json!({
        "cmd": python,
        "args": [mcp_script_path]
    });

    let env_json = serde_json::json!({
        "ACI_HOST": config.host,
        "ACI_USERNAME": config.username,
        "ACI_PASSWORD": config.password,
        "ACI_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('aci-mcp', 'Cisco ACI (APIC)', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn aci_save_config(state: State<'_, AppState>, config: AciConfig) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO aci_config (id, host, username, password, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4)",
            rusqlite::params![
                config.host,
                config.username,
                config.password,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    enable_aci_mcp_server(&state.db, &config)?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AciTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn aci_test_connection(
    state: State<'_, AppState>,
    config: AciConfig,
) -> Result<AciTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "host": config.host,
            "username": config.username,
            "password": config.password,
            "verify_ssl": config.verify_ssl,
        }
    });

    let resp = state
        .agent
        .call("aci.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(AciTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- gNMI Configuration (multi-target) -------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GnmiTarget {
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u32>,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub skip_verify: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GnmiConfig {
    pub targets: Vec<GnmiTarget>,
}

#[tauri::command]
pub async fn gnmi_get_config(state: State<'_, AppState>) -> Result<GnmiConfig, String> {
    let conn = state.db.lock();

    let raw: Option<String> = conn
        .query_row(
            "SELECT targets_json FROM gnmi_config WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let targets: Vec<GnmiTarget> = match raw {
        Some(s) => serde_json::from_str(&s).unwrap_or_default(),
        None => Vec::new(),
    };

    Ok(GnmiConfig { targets })
}

/// Register the gNMI MCP server in the `mcp_servers` table. The whole target
/// list is passed via the GNMI_TARGETS env var (a JSON array) so the Python
/// script can address devices by name.
fn enable_gnmi_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    targets_json: &str,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();

    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/gnmi_mcp.py",
        repo_root
    );

    let command_json = serde_json::json!({
        "cmd": python,
        "args": [mcp_script_path]
    });

    let env_json = serde_json::json!({
        "GNMI_TARGETS": targets_json,
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('gnmi-mcp', 'gNMI', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn gnmi_save_config(
    state: State<'_, AppState>,
    config: GnmiConfig,
) -> Result<(), String> {
    let targets_json = serde_json::to_string(&config.targets).map_err(|e| e.to_string())?;
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO gnmi_config (id, targets_json) VALUES (1, ?1)",
            rusqlite::params![targets_json],
        )
        .map_err(|e| e.to_string())?;
    }

    enable_gnmi_mcp_server(&state.db, &targets_json)?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GnmiTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn gnmi_test_connection(
    state: State<'_, AppState>,
    config: GnmiConfig,
) -> Result<GnmiTestResult, String> {
    // Forward the full target list; the sidecar tests the first target with a
    // read-only capabilities request.
    let targets: Vec<serde_json::Value> = config
        .targets
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "host": t.host,
                "port": t.port,
                "username": t.username,
                "password": t.password,
                "vendor": t.vendor,
                "skip_verify": t.skip_verify,
            })
        })
        .collect();

    let params = serde_json::json!({ "config": { "targets": targets } });

    let resp = state
        .agent
        .call("gnmi.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(GnmiTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Cisco FMC (Secure Firewall Management Center) Configuration -----------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FmcConfig {
    pub host: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub domain_uuid: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn fmc_get_config(state: State<'_, AppState>) -> Result<Option<FmcConfig>, String> {
    let conn = state.db.lock();

    let result: Option<FmcConfig> = conn
        .query_row(
            "SELECT host, username, password, domain_uuid, verify_ssl FROM fmc_config WHERE id = 1",
            [],
            |row| {
                Ok(FmcConfig {
                    host: row.get(0)?,
                    username: row.get(1)?,
                    password: row.get(2)?,
                    domain_uuid: row.get(3)?,
                    verify_ssl: row.get::<_, i64>(4)? == 1,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Register the FMC MCP server in the `mcp_servers` table. Credentials are
/// passed via environment variables so the Python script can access them
/// without storing them in the command JSON.
fn enable_fmc_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &FmcConfig,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();

    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/fmc_mcp.py",
        repo_root
    );

    let command_json = serde_json::json!({
        "cmd": python,
        "args": [mcp_script_path]
    });

    let env_json = serde_json::json!({
        "FMC_HOST": config.host,
        "FMC_USERNAME": config.username,
        "FMC_PASSWORD": config.password,
        "FMC_DOMAIN_UUID": config.domain_uuid,
        "FMC_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('fmc-mcp', 'Cisco Secure Firewall (FMC)', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn fmc_save_config(state: State<'_, AppState>, config: FmcConfig) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO fmc_config (id, host, username, password, domain_uuid, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                config.host,
                config.username,
                config.password,
                config.domain_uuid,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    enable_fmc_mcp_server(&state.db, &config)?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FmcTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn fmc_test_connection(
    state: State<'_, AppState>,
    config: FmcConfig,
) -> Result<FmcTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "host": config.host,
            "username": config.username,
            "password": config.password,
            "domain_uuid": config.domain_uuid,
            "verify_ssl": config.verify_ssl,
        }
    });

    let resp = state
        .agent
        .call("fmc.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(FmcTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Cisco ThousandEyes Configuration (token-only) -------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThousandEyesConfig {
    pub token: String,
    #[serde(default)]
    pub account_group_id: String,
}

#[tauri::command]
pub async fn thousandeyes_get_config(
    state: State<'_, AppState>,
) -> Result<Option<ThousandEyesConfig>, String> {
    let conn = state.db.lock();

    let result: Option<ThousandEyesConfig> = conn
        .query_row(
            "SELECT token, account_group_id FROM thousandeyes_config WHERE id = 1",
            [],
            |row| {
                Ok(ThousandEyesConfig {
                    token: row.get(0)?,
                    account_group_id: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Register the ThousandEyes MCP server in the `mcp_servers` table. The token is
/// passed via environment variables so the Python script can access it without
/// storing it in the command JSON.
fn enable_thousandeyes_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &ThousandEyesConfig,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();

    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/thousandeyes_mcp.py",
        repo_root
    );

    let command_json = serde_json::json!({
        "cmd": python,
        "args": [mcp_script_path]
    });

    let env_json = serde_json::json!({
        "THOUSANDEYES_TOKEN": config.token,
        "THOUSANDEYES_ACCOUNT_GROUP_ID": config.account_group_id,
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('thousandeyes-mcp', 'Cisco ThousandEyes', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn thousandeyes_save_config(
    state: State<'_, AppState>,
    config: ThousandEyesConfig,
) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO thousandeyes_config (id, token, account_group_id)
             VALUES (1, ?1, ?2)",
            rusqlite::params![config.token, config.account_group_id],
        )
        .map_err(|e| e.to_string())?;
    }

    enable_thousandeyes_mcp_server(&state.db, &config)?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ThousandEyesTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn thousandeyes_test_connection(
    state: State<'_, AppState>,
    config: ThousandEyesConfig,
) -> Result<ThousandEyesTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "token": config.token,
            "account_group_id": config.account_group_id,
        }
    });

    let resp = state
        .agent
        .call("thousandeyes.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(ThousandEyesTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

// ---- Cisco Meraki Dashboard Configuration (API-key only) -------------------
//
// Unlike the other vendors, Meraki has no MCP server (it uses the meraki SDK in
// the sandbox), so there is no enable_*_mcp_server step — just persist the key
// to sessions.db where the sandbox (meraki_config.get_meraki_config) reads it.

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MerakiConfig {
    pub api_key: String,
    #[serde(default)]
    pub org_id: String,
}

#[tauri::command]
pub async fn meraki_get_config(state: State<'_, AppState>) -> Result<Option<MerakiConfig>, String> {
    let conn = state.db.lock();

    let result: Option<MerakiConfig> = conn
        .query_row(
            "SELECT api_key, org_id FROM meraki_config WHERE id = 1",
            [],
            |row| {
                Ok(MerakiConfig {
                    api_key: row.get(0)?,
                    org_id: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
pub async fn meraki_save_config(
    state: State<'_, AppState>,
    config: MerakiConfig,
) -> Result<(), String> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO meraki_config (id, api_key, org_id) VALUES (1, ?1, ?2)",
        rusqlite::params![config.api_key, config.org_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MerakiTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn meraki_test_connection(
    state: State<'_, AppState>,
    config: MerakiConfig,
) -> Result<MerakiTestResult, String> {
    let params = serde_json::json!({
        "config": { "api_key": config.api_key, "org_id": config.org_id }
    });

    let resp = state
        .agent
        .call("meraki.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(MerakiTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}

pub mod blocks;
pub mod change_verify;
pub mod notebooks;
pub mod notebooks_runnable;
pub mod panes;
pub mod workflows;
pub mod workflows_seed;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn anthropic_model_refresh_uses_live_models_api() {
        use wiremock::matchers::{header, method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .and(query_param("limit", "1000"))
            .and(header("x-api-key", "test-key"))
            .and(header("anthropic-version", "2023-06-01"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"data":[{"id":"claude-live-new"},{"id":"claude-live-other"}]}"#,
            ))
            .mount(&server)
            .await;

        let models = fetch_anthropic_models_from_url(&server.uri(), "test-key")
            .await
            .expect("live Anthropic model list");
        assert_eq!(models, vec!["claude-live-new", "claude-live-other"]);
    }

    #[test]
    #[cfg(debug_assertions)]
    fn debug_builds_use_live_sidecar_venv() {
        assert!(!should_use_bundled_python());
        let (python, _) = sidecar_spawn_target();
        assert!(python.ends_with("sidecar/.venv/bin/python") || python.ends_with("sidecar/.venv/Scripts/python.exe"));
        assert!(!python.contains("src-tauri/sidecar/.venv"));
    }

    #[test]
    fn network_architect_soul_file_name_allows_only_bare_soul_markdown() {
        assert!(is_network_architect_soul_file_name("SOUL.md"));
        assert!(is_network_architect_soul_file_name("SOUL-SKILLS.md"));
        assert!(!is_network_architect_soul_file_name("AGENT.md"));
        assert!(!is_network_architect_soul_file_name("../SOUL.md"));
        assert!(!is_network_architect_soul_file_name("SOUL.txt"));
    }

    #[test]
    #[cfg(unix)]
    fn network_architect_soul_save_ignores_preexisting_tmp_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let soul_path = dir.path().join("SOUL.md");
        let outside_path = dir.path().join("outside.txt");
        std::fs::write(&soul_path, "old").unwrap();
        std::fs::write(&outside_path, "outside").unwrap();
        std::os::unix::fs::symlink(&outside_path, dir.path().join("SOUL.md.tmp")).unwrap();

        save_network_architect_soul_file(&soul_path, "new").unwrap();

        assert_eq!(std::fs::read_to_string(&soul_path).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&outside_path).unwrap(), "outside");
    }

    #[test]
    fn proxmox_tls_off_accepts_invalid_certs() {
        let config = ProxmoxConfig {
            host: "pve.local".into(),
            port: 8006,
            user: "root@pam".into(),
            token_name: String::new(),
            token_value: String::new(),
            password: "pw".into(),
            verify_ssl: false,
        };
        assert!(proxmox_accept_invalid_certs(&config));
    }

    #[test]
    fn proxmox_token_header_prefixes_user_when_needed() {
        let config = ProxmoxConfig {
            host: "pve.local".into(),
            port: 8006,
            user: "root@pam".into(),
            token_name: "automation".into(),
            token_value: "secret".into(),
            password: String::new(),
            verify_ssl: false,
        };
        assert_eq!(
            proxmox_token_header_value(&config).as_deref(),
            Some("PVEAPIToken=root@pam!automation=secret")
        );
    }

    #[test]
    fn proxmox_config_accepts_frontend_camelcase_fields() {
        let config: ProxmoxConfig = serde_json::from_value(serde_json::json!({
            "host": "pve.local",
            "port": 8006,
            "user": "root@pam",
            "tokenName": "automation",
            "tokenValue": "secret",
            "password": "pw",
            "verifySsl": true,
        }))
        .unwrap();
        assert_eq!(config.token_name, "automation");
        assert_eq!(config.token_value, "secret");
        assert!(config.verify_ssl);
    }

    #[test]
    fn proxmox_password_auth_includes_csrf_header_from_ticket() {
        let headers = proxmox_password_headers_from_ticket(&serde_json::json!({
            "data": {
                "ticket": "PVE:ticket",
                "CSRFPreventionToken": "csrf-token"
            }
        }))
        .unwrap();

        assert_eq!(headers.get("cookie").unwrap(), "PVEAuthCookie=PVE:ticket");
        assert_eq!(headers.get("csrfpreventiontoken").unwrap(), "csrf-token");
    }

    #[test]
    fn proxmox_base_url_rejects_authority_injection() {
        let config = ProxmoxConfig {
            host: "pve.local:8006@evil.example".into(),
            port: 8006,
            user: "root@pam".into(),
            token_name: String::new(),
            token_value: String::new(),
            password: "pw".into(),
            verify_ssl: false,
        };

        assert!(proxmox_base_url(&config).is_err());
    }

    #[test]
    fn proxmox_lxc_paths_reject_route_escapes() {
        assert!(proxmox_lxc_status_path("pve/qemu/100", "300", "stop").is_err());
        assert!(proxmox_lxc_status_path("pve", "300/../../100", "stop").is_err());
        assert!(proxmox_lxc_clone_path("pve", "110/../../100").is_err());
        assert!(proxmox_lxc_status_path("pve", "300", "stop").is_ok());
        assert!(proxmox_lxc_clone_path("pve", "110").is_ok());
    }

    #[test]
    fn proxmox_clone_timeout_allows_slow_full_clones() {
        assert!(PROXMOX_LXC_CLONE_TIMEOUT > PROXMOX_LXC_ACTION_TIMEOUT);
        assert!(PROXMOX_LXC_CLONE_TIMEOUT >= Duration::from_secs(600));
    }

    #[test]
    fn blender_mcp_registration_uses_packaged_python_module() {
        let conn = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        conn.lock()
            .execute(
                "CREATE TABLE mcp_servers (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    transport TEXT NOT NULL,
                    command_json TEXT,
                    url TEXT,
                    env_json TEXT,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
                )",
                [],
            )
            .unwrap();

        enable_blender_mcp_server(&conn).unwrap();

        let row = conn
            .lock()
            .query_row(
                "SELECT name, transport, command_json, env_json, enabled FROM mcp_servers WHERE id = 'blender-mcp'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .unwrap();
        let command: serde_json::Value = serde_json::from_str(&row.2).unwrap();
        let env: serde_json::Value = serde_json::from_str(&row.3).unwrap();
        assert_eq!(row.0, "Blender MCP");
        assert_eq!(row.1, "stdio");
        assert_eq!(command["args"], serde_json::json!(["-m", "blender_mcp.server"]));
        assert_eq!(env["BLENDER_HOST"], "localhost");
        assert_eq!(env["BLENDER_PORT"], "9876");
        assert_eq!(row.4, 1);
    }

    #[test]
    fn saved_ssh_launch_is_built_only_from_inventory_fields() {
        let argv = build_saved_ssh_argv(
            "switch.example",
            Some("admin"),
            Some(2222),
            Some("/keys/lab key"),
        );
        assert_eq!(
            argv,
            vec![
                "/usr/bin/ssh",
                "-p",
                "2222",
                "-o",
                "HostName=switch.example",
                "-i",
                "/keys/lab key",
                "--",
                "admin@switch.example",
            ]
        );
        assert_eq!(build_saved_ssh_command(&argv), "/usr/bin/ssh -p 2222 -o HostName=switch.example -i '/keys/lab key' -- admin@switch.example");
        assert!(matches_saved_ssh_process(SYSTEM_SSH_BINARY, &argv, &argv));
        assert!(!matches_saved_ssh_process("/tmp/ssh", &argv, &argv));
        let mut redirected = argv.clone();
        redirected[4] = "HostName=other.example".into();
        assert!(!matches_saved_ssh_process(
            SYSTEM_SSH_BINARY,
            &redirected,
            &argv,
        ));
    }

    #[test]
    fn test_stealthwatch_get_config_returns_none_when_empty() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();

        // Apply migration
        conn.execute_batch(include_str!(
            "../../migrations/V0052__stealthwatch_config.sql"
        ))
        .unwrap();

        let result: Option<StealthwatchConfig> = conn
            .query_row(
                "SELECT host, username, password, verify_ssl FROM stealthwatch_config WHERE id = 1",
                [],
                |row| {
                    Ok(StealthwatchConfig {
                        host: row.get(0)?,
                        username: row.get(1)?,
                        password: row.get(2)?,
                        verify_ssl: row.get::<_, i64>(3)? == 1,
                    })
                },
            )
            .optional()
            .unwrap();

        assert!(result.is_none());
    }

    #[test]
    fn test_stealthwatch_save_config_inserts_row() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();

        conn.execute_batch(include_str!(
            "../../migrations/V0052__stealthwatch_config.sql"
        ))
        .unwrap();

        let config = StealthwatchConfig {
            host: "smc.example.com".to_string(),
            username: "admin".to_string(),
            password: "secret".to_string(),
            verify_ssl: true,
        };

        conn.execute(
            "INSERT OR REPLACE INTO stealthwatch_config (id, host, username, password, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4)",
            rusqlite::params![
                &config.host,
                &config.username,
                &config.password,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .unwrap();

        let saved: StealthwatchConfig = conn
            .query_row(
                "SELECT host, username, password, verify_ssl FROM stealthwatch_config WHERE id = 1",
                [],
                |row| {
                    Ok(StealthwatchConfig {
                        host: row.get(0)?,
                        username: row.get(1)?,
                        password: row.get(2)?,
                        verify_ssl: row.get::<_, i64>(3)? == 1,
                    })
                },
            )
            .unwrap();

        assert_eq!(saved.host, "smc.example.com");
        assert_eq!(saved.username, "admin");
        assert_eq!(saved.password, "secret");
        assert!(saved.verify_ssl);
    }

    #[test]
    fn test_ise_save_and_get_config_roundtrip() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/V0056__ise_config.sql"))
            .unwrap();

        conn.execute(
            "INSERT OR REPLACE INTO ise_config (id, host, username, password, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4)",
            rusqlite::params!["ise.example.com", "admin", "secret", 0],
        )
        .unwrap();

        let saved: IseConfig = conn
            .query_row(
                "SELECT host, username, password, verify_ssl FROM ise_config WHERE id = 1",
                [],
                |row| {
                    Ok(IseConfig {
                        host: row.get(0)?,
                        username: row.get(1)?,
                        password: row.get(2)?,
                        verify_ssl: row.get::<_, i64>(3)? == 1,
                    })
                },
            )
            .unwrap();

        assert_eq!(saved.host, "ise.example.com");
        assert_eq!(saved.username, "admin");
        assert!(!saved.verify_ssl);
    }
}

// ============================================================================
// Heartbeat Monitoring
// ============================================================================

#[tauri::command]
pub async fn heartbeat_plan(
    nl_input: String,
    context: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use crate::bridge::SidecarHandle;

    let (python, args) = sidecar_spawn_target();
    let mut handle = SidecarHandle::spawn(&python, &args).map_err(|e| e.to_string())?;

    let params = serde_json::json!({
        "nl_input": nl_input,
        "context": context,
    });

    let resp = handle.call("heartbeat.plan", params).map_err(|e| {
        eprintln!("Sidecar heartbeat.plan call failed: {}", e);
        e.to_string()
    })?;

    eprintln!("Sidecar response: {:?}", resp);

    handle.shutdown();

    // The sidecar returns the plan directly in result
    // Wrap it in the expected {status, plan, error} structure
    if let Some(plan) = resp.get("result").cloned() {
        Ok(serde_json::json!({
            "status": "success",
            "plan": plan,
            "error": null
        }))
    } else {
        eprintln!(
            "No 'result' field in sidecar response. Full response: {:?}",
            resp
        );
        Ok(serde_json::json!({
            "status": "error",
            "plan": null,
            "error": format!("No result in sidecar response. Got: {:?}", resp)
        }))
    }
}

pub mod metadata;
