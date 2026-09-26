//! CCIE Terminal - A Warp-inspired AI-powered terminal for network engineers.
//!
//! This crate provides the core Rust/Tauri backend for CCIE Terminal, including:
//! - PTY management for terminal sessions
//! - SQLite database for persistence
//! - AI agent bridge to Python sidecar
//! - MCP (Model Context Protocol) client
//! - Skills system loader
//! - Full-text search via FTS5
//!
//! # Architecture
//!
//! The application uses a three-layer architecture:
//! - Frontend: React + xterm.js
//! - Core: Rust + Tauri (this crate)
//! - Sidecar: Python + LLM SDKs

pub mod agent_bridge;
pub mod agents;
pub mod api_runner;
mod app_lifecycle;
pub mod bridge;
pub mod browser;
pub mod change_verify;
pub mod claude_hooks;
pub mod codex_hooks;
pub mod command_parser;
pub mod commands;
pub mod config;
pub mod dap;
pub mod database;
pub mod db;
pub mod dictation;
pub mod drift;
pub mod editor;
pub mod fanout;
pub mod ftp;
pub mod git;
pub mod guardrails;
pub mod heartbeat;
pub mod iac;
pub mod logging;
pub mod lsp;
pub mod macos_icon;
pub mod mcp;
pub mod metadata;
pub mod netconf_runner;
pub mod notebooks;
pub mod palette;
pub mod pane_context;
pub mod parsers;
pub mod pcap;
pub mod pty;
pub mod pty_runner;
pub mod pyats;
pub mod rag;
pub mod recording;
pub mod search;
pub mod session;
pub mod sftp;
pub mod shell_integration;
pub mod skills;
pub mod ssh_exec;
pub mod structured;
pub mod terminal_agent;
pub mod tftp;
pub mod topology;
pub mod transcript_export;
pub mod troubleshoot;
pub mod validation;
pub mod vault;
pub mod whatsapp;

use commands::AppState;

/// Return at most `maximum` Unicode scalar values without slicing through a
/// multi-byte UTF-8 character.
fn truncate_chars(value: &str, maximum: usize) -> &str {
    value
        .char_indices()
        .nth(maximum)
        .map_or(value, |(boundary, _)| &value[..boundary])
}

/// Main entry point for the CCIE Terminal application.
///
/// Initializes:
/// - Logging system
/// - SQLite database with migrations
/// - Application state (PTY manager, agent bridge, MCP bridge, skills loader)
/// - Configuration manager
/// - Tauri window and IPC handlers
///
/// # Panics
///
/// Panics if database initialization or Tauri builder fails.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Privileged TFTP helper mode: bind port < 1024 as root, run listener, exit.
    if crate::tftp::helper::run_helper_if_requested() {
        return;
    }

    // Initialize logging first
    if let Err(e) = logging::init_default_logging() {
        eprintln!("Failed to initialize logging: {}", e);
    }

    tracing::info!("TerminAI starting up");

    let (db, db_path) = {
        let path = db::default_db_path().expect("default_db_path");
        tracing::info!(?path, "Opening database");
        let db = db::open_and_migrate(&path).expect("open_and_migrate");
        (db, path)
    };
    let state = AppState::new(db, db_path);
    tracing::info!("Application state initialized");
    if let Err(error) = state.stp.start() {
        tracing::warn!(error = %error, "stp: scheduler failed to start");
    }

    // Auto-unlock vaults marked with auto_unlock=1
    state.auto_unlock_vaults();

    // Plan 07 Phase 4 — clean up any fan-out runs left in `running` from a
    // previous crash. Their pending/running result rows get marked failed
    // with `interrupted: app restart`; the run itself becomes `failed`.
    {
        let conn = state.db.lock();
        match crate::fanout::store::FanoutStore::cleanup_orphan_runs(&conn) {
            Ok(0) => {}
            Ok(n) => tracing::info!(n, "fanout: cleaned up orphan runs"),
            Err(e) => tracing::warn!(error = %e, "fanout: orphan cleanup failed"),
        }
    }

    // One-time scrollback prune: older builds appended scrollback unbounded,
    // growing the table to ~2.5 GB / 7.8M rows (the bulk of sessions.db) and
    // slowing every PTY write. Trim each tab to the per-tab cap, then VACUUM to
    // reclaim the freed pages. Cheap on an already-trimmed DB (prune returns 0
    // and we skip the VACUUM), so it's safe to run on every boot.
    {
        let conn = state.db.lock();
        match crate::session::prune_all_scrollback(
            &conn,
            crate::session::MAX_SCROLLBACK_BYTES_PER_TAB,
        ) {
            Ok(0) => {}
            Ok(n) => {
                tracing::info!(tabs = n, "scrollback: pruned over-cap tabs; vacuuming");
                if let Err(e) = conn.execute_batch("VACUUM") {
                    tracing::warn!(error = %e, "scrollback: VACUUM after prune failed");
                }
            }
            Err(e) => tracing::warn!(error = %e, "scrollback: prune failed"),
        }
    }

    // Plan 14 — reconcile session recordings left "LIVE" (ended_at NULL) by a
    // previous run that exited mid-recording; otherwise they show LIVE forever.
    match state.recording.cleanup_orphan_recordings() {
        Ok(0) => {}
        Ok(n) => tracing::info!(n, "recording: reconciled orphan recordings"),
        Err(e) => tracing::warn!(error = %e, "recording: orphan cleanup failed"),
    }

    // Eagerly engage the sidecar so its heartbeat thread starts feeding
    // `sidecar_status` and the footer chip flips to green at boot. Without
    // this, the supervisor stays dormant until the user invokes an
    // AI/parser feature; the chip would read "down" the entire time.
    {
        let agent = state.agent.clone();
        std::thread::spawn(move || {
            // Run a short-lived tokio runtime just for this ping so we
            // don't block boot on supervisor IO.
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    tracing::warn!(error = %e, "sidecar warmup: failed to build runtime");
                    return;
                }
            };
            rt.block_on(async move {
                match agent.call("ping", serde_json::json!({})).await {
                    Ok(_) => tracing::info!("sidecar warmup: ping succeeded"),
                    Err(e) => tracing::warn!(error = %e, "sidecar warmup: ping failed"),
                }
            });
        });
    }

    // First-run-only: seed the bundled workflow pack. Idempotent thanks to
    // the `workflows.seeded.v1` flag in app_flags. Errors are non-fatal so
    // a malformed seed file never blocks the app from booting.
    {
        let conn = state.db.lock();
        match commands::workflows_seed::seed_builtin_from_yaml(
            &conn,
            commands::workflows_seed::SEED_YAML,
        ) {
            Ok(0) => tracing::debug!("workflows: seed already applied"),
            Ok(n) => tracing::info!(seeded = n, "workflows: bundled seed applied"),
            Err(e) => tracing::warn!(error = %e, "workflows: seed error (non-fatal)"),
        }
    }

    // First-run-only: seed the bundled runnable-notebook pack.
    {
        let conn = state.db.lock();
        match notebooks::seeds::seed_builtin_runnable_notebooks(&conn) {
            Ok(0) => tracing::debug!("notebooks: seed already applied"),
            Ok(n) => tracing::info!(seeded = n, "notebooks: bundled seed applied"),
            Err(e) => tracing::warn!(error = %e, "notebooks: seed error (non-fatal)"),
        }
    }

    // First-run-only: seed the canonical change-verification bundles.
    {
        let mut conn = state.db.lock();
        match change_verify::seeds::seed_if_first_run(&mut conn) {
            Ok(0) => tracing::debug!("change_verify: seed already applied"),
            Ok(n) => tracing::info!(seeded = n, "change_verify: bundled seed applied"),
            Err(e) => tracing::warn!(error = %e, "change_verify: seed error (non-fatal)"),
        }
    }

    // Plan 15 — seed the bundled AI-Driven Troubleshooting playbook
    // catalogue. Idempotent: re-runs UPSERT every boot so updated
    // bundled YAML lands without a manual reset, while WHERE builtin=1
    // protects user-forked rows. Errors are non-fatal so a malformed
    // seed never blocks app startup.
    {
        let conn = state.db.lock();
        match troubleshoot::seed::ensure_builtins(&conn) {
            Ok(()) => tracing::info!(
                builtins = troubleshoot::seed::BUILTIN_COUNT,
                "troubleshoot: bundled playbooks seeded"
            ),
            Err(e) => tracing::warn!(error = %e, "troubleshoot: seed error (non-fatal)"),
        }
    }

    // Boot-time maintenance: cap palette_usage at 5000 rows per target_type
    // so the table can't grow unbounded across years of picks. Errors are
    // non-fatal — the picker still works on an over-sized usage table.
    {
        let conn = state.db.lock();
        match palette::usage::trim(&conn, 5000) {
            Ok(0) => tracing::debug!("palette_usage: nothing to trim"),
            Ok(n) => tracing::info!(deleted = n, "palette_usage: trimmed"),
            Err(e) => tracing::warn!(error = %e, "palette_usage: trim failed"),
        }
    }

    // Plan 09 — overlay any user-authored guardrail rules on top of the
    // builtin set so the runtime classifier reflects the latest DB state.
    if let Err(e) = commands::guardrails::reload_ruleset(&state) {
        tracing::warn!(error = %e, "guardrails: ruleset reload at boot failed");
    } else {
        tracing::info!(
            rules = state.guardrails_ruleset.read().len(),
            "guardrails: ruleset loaded"
        );
    }

    let config_manager = config::ConfigManager::new().expect("initialize config manager");
    tracing::info!("Config manager initialized");

    let shutdown = app_lifecycle::ShutdownCoordinator::default();
    let shutdown_for_window_events = shutdown.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if app_lifecycle::close_disposition(window.label())
                    != app_lifecycle::WindowCloseDisposition::ExitApplication
                {
                    return;
                }
                use tauri::Manager;

                api.prevent_close();
                let _ = window.state::<AppState>().stp.shutdown();
                window
                    .state::<AppState>()
                    .terminal_agent
                    .revoke_all("application shutdown");
                app_lifecycle::request_shutdown(
                    window.app_handle(),
                    &shutdown_for_window_events,
                    "main-window-close",
                );
            }
        })
        .manage(state)
        .manage(config_manager)
        .manage(shutdown)
        .invoke_handler(tauri::generate_handler![
            commands::ping_cmd,
            commands::dictation_start,
            commands::dictation_stop,
            commands::dictation_cancel,
            commands::ping_sidecar,
            commands::parsers::parse_show,
            commands::sidecar_status::get_sidecar_status,
            commands::logs::get_log_locations,
            commands::logs::open_log_location,
            commands::logs::reveal_log_location,
            commands::pty_spawn,
            commands::terminal_detach,
            commands::terminal_detached_window_close,
            commands::terminal_launch_saved_ssh,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::list_tabs,
            commands::list_pipe_targets,
            commands::tab_new_api,
            commands::tab_close_api,
            commands::tab_new_netconf,
            commands::tab_close_netconf,
            commands::tab_new_subnet,
            commands::tab_close_subnet,
            commands::netconf_connect,
            commands::netconf_send_rpc,
            commands::netconf_device_list,
            commands::netconf_device_create,
            commands::netconf_device_delete,
            commands::netconf_device_get_password,
            commands::netconf_wrap_cli,
            commands::netconf_history_list,
            commands::netconf_history_detail,
            commands::netconf_saved_rpc_list,
            commands::netconf_saved_rpc_upsert,
            commands::netconf_saved_rpc_delete,
            commands::netconf_explain_response,
            commands::tab_new_editor,
            commands::tab_close_editor,
            commands::editor::editor_open_file,
            commands::editor::editor_save_file,
            commands::editor::editor_get_state,
            commands::editor::editor_list_recent,
            commands::editor::editor_list_directory,
            commands::editor::editor_find_in_files,
            commands::editor::editor_get_home_directory,
            commands::editor::editor_mode_get,
            commands::editor::editor_mode_set,
            commands::appearance::appearance_settings_get,
            commands::appearance::appearance_settings_set,
            commands::appearance::appearance_settings_patch,
            app_lifecycle::app_shutdown_acknowledge,
            commands::editor::editor_buffer_register,
            commands::editor::editor_buffer_get,
            commands::editor::editor_buffer_update,
            commands::editor::editor_buffer_mark_saved,
            commands::editor_windows::editor_detach_pane,
            commands::editor_windows::editor_detached_window_get_current,
            commands::editor_windows::editor_detached_window_list,
            commands::editor_windows::editor_detached_window_focus,
            commands::editor_windows::editor_detached_window_close,
            commands::editor_windows::editor_source_window_focus,
            commands::editor::editor_create_file,
            commands::editor::editor_delete_file,
            commands::editor::editor_rename_file,
            commands::editor::iac_studio_read_file,
            commands::editor::iac_studio_write_file,
            commands::editor::editor_file_exists,
            commands::editor::editor_create_directory,
            commands::lsp::lsp_start,
            commands::lsp::lsp_stop,
            commands::lsp::lsp_request,
            commands::lsp::lsp_document_open,
            commands::lsp::lsp_document_change,
            commands::lsp::lsp_document_close,
            commands::lsp::lsp_is_running,
            commands::lsp::lsp_check_available,
            commands::dap::dap_check_available,
            commands::dap::dap_resolve_interpreter,
            commands::dap::dap_start,
            commands::dap::dap_restart,
            commands::dap::dap_stop,
            commands::dap::dap_clear_tab,
            commands::dap::dap_session_for_tab,
            commands::dap::dap_breakpoints_get,
            commands::dap::dap_breakpoints_set,
            commands::dap::dap_threads,
            commands::dap::dap_stack_trace,
            commands::dap::dap_scopes,
            commands::dap::dap_variables,
            commands::dap::dap_evaluate,
            commands::dap::dap_continue,
            commands::dap::dap_pause,
            commands::dap::dap_next,
            commands::dap::dap_step_in,
            commands::dap::dap_step_out,
            commands::git::git_get_status,
            commands::git::git_get_diff,
            commands::git::git_get_file_changes,
            commands::git::git_get_line_blame,
            commands::git::git_get_repository_summary,
            commands::git::git_is_repo,
            commands::git::git_discover_repositories,
            commands::git::git_get_repository_state,
            commands::git::git_watch_repositories,
            commands::git::git_stage_paths,
            commands::git::git_unstage_paths,
            commands::git::git_repository_commit,
            commands::git::git_initialize_repository,
            commands::git::git_clone_repository,
            commands::git::git_list_branches,
            commands::git::git_switch_branch,
            commands::git::git_repository_fetch,
            commands::git::git_repository_pull,
            commands::git::git_repository_push,
            commands::git::git_add_remote,
            commands::git::git_update_remote,
            commands::git::git_remove_remote,
            commands::git::git_repository_history,
            commands::git::git_commit_detail,
            commands::git::git_staged_diff,
            commands::git::git_unstaged_diff,
            commands::git::git_historical_diff,
            commands::git::git_init,
            commands::git::git_commit_paths,
            commands::git::git_get_remote,
            commands::git::git_set_remote,
            commands::git::git_push,
            commands::git::git_current_branch,
            commands::git::github_auth_start,
            commands::git::github_auth_poll,
            commands::git::github_auth_cancel,
            commands::git::github_account_status,
            commands::git::github_disconnect,
            commands::git::github_list_repositories,
            commands::git::github_list_runs,
            commands::yang_release_list,
            commands::yang_release_download,
            commands::yang_release_delete,
            commands::yang_module_list,
            commands::yang_module_content,
            commands::yang_explain_module,
            commands::api_send_request,
            commands::api_list_targets,
            commands::api_get_target,
            commands::api_import_openapi,
            commands::api_pipe_to_terminal,
            commands::api_pipe_to_ai,
            commands::api_explain_response,
            commands::api_list_history,
            commands::api_get_history_detail,
            commands::api_save_request,
            commands::api_list_saved_requests,
            commands::api_delete_saved_request,
            commands::api_preview_postman_import,
            commands::api_commit_postman_import,
            commands::api_list_postman_collections,
            commands::api_get_postman_collection,
            commands::api_delete_postman_collection,
            commands::api_list_environments,
            commands::api_create_environment,
            commands::api_delete_environment,
            commands::api_get_env_vars,
            commands::api_set_env_var,
            commands::api_delete_env_var,
            commands::tab_scrollback,
            commands::terminal_export_scrollback,
            commands::block_output,
            commands::install_shell_integration,
            commands::agent_chat_stream,
            commands::agent_nl_to_command,
            commands::ai::get_history_suggestions,
            commands::ai::ai_suggest_command,
            commands::ai::ai_natural_to_command,
            commands::ai::ai_analyze_error,
            commands::ai::agent_react_run,
            commands::ai::agent_code_exec_run,
            commands::ai::agent_react_code_run,
            commands::ai::agent_react_resume,
            commands::ai::agent_terminal_preview_fix_edit,
            commands::ai::agent_terminal_approve_fix,
            commands::ai::agent_terminal_cancel,
            commands::ssh::ssh_save_connection,
            commands::ssh::ssh_update_connection,
            commands::ssh::ssh_list_connections,
            commands::ssh::ssh_get_connection,
            commands::ssh::ssh_delete_connection,
            commands::ssh::ssh_mark_used,
            commands::ssh::ssh_list_folders,
            commands::ssh::ssh_create_folder,
            commands::ssh::ssh_update_folder,
            commands::ssh::ssh_delete_folder,
            commands::ssh::ssh_decrypt_password,
            commands::ssh_import::ssh_import_preview,
            commands::ssh_import::ssh_import_commit,
            commands::serial::serial_list_ports,
            commands::serial::serial_open,
            commands::serial::serial_write,
            commands::serial::serial_send_break,
            commands::serial::serial_close,
            commands::sftp::sftp_connect,
            commands::sftp::sftp_list,
            commands::sftp::sftp_mutate,
            commands::sftp::sftp_transfer,
            commands::sftp::sftp_cancel_transfer,
            commands::sftp::sftp_disconnect,
            commands::agent_explain_error,
            commands::agent_explain_command,
            commands::approve_tool_call,
            commands::mcp_list_servers,
            commands::mcp_add_server,
            commands::mcp_remove_server,
            commands::mcp_update_server_enabled,
            commands::mcp_test_connection,
            commands::mcp_list_policies,
            commands::mcp_set_policy,
            commands::skills_list,
            commands::skills_get,
            commands::skills_reload,
            commands::skills_create,
            commands::agent_generate_skill,
            commands::search_commands,
            commands::search_ai_messages,
            commands::search_skills_cmd,
            commands::search_all,
            commands::restore_last_session,
            commands::save_current_session,
            commands::ai_messages_by_tab,
            commands::ai_messages_by_tab_agent,
            commands::ai_clear_messages,
            commands::ai_conversations_list,
            commands::save_ai_message,
            commands::session_save_named,
            commands::session_list_saved,
            commands::session_load_saved,
            commands::session_delete_saved,
            commands::session_export_json,
            commands::session_import_json,
            commands::ai_list_models,
            commands::ai_save_config,
            commands::ai_get_config,
            commands::context_graph_get_enabled,
            commands::context_graph_set_enabled,
            commands::context_graph_get_staleness,
            commands::context_graph_set_staleness,
            commands::vendor_keywords_get,
            commands::vendor_keywords_set,
            commands::vendor_keyword_defaults,
            commands::git_config_get,
            commands::git_config_set,
            commands::proxmox_save_config,
            commands::proxmox_get_config,
            commands::proxmox_test_connection,
            commands::proxmox_list_inventory,
            commands::agent_computers_get_config,
            commands::agent_computers_save_config,
            commands::agent_computer_test,
            commands::agent_computer_provision,
            commands::agent_computer_start,
            commands::agent_computer_stop,
            commands::stealthwatch_get_config,
            commands::stealthwatch_save_config,
            commands::stealthwatch_test_connection,
            commands::ise_get_config,
            commands::ise_save_config,
            commands::ise_test_connection,
            commands::secure_endpoint_get_config,
            commands::secure_endpoint_save_config,
            commands::secure_endpoint_test_connection,
            commands::cisco_xdr_get_config,
            commands::cisco_xdr_save_config,
            commands::cisco_xdr_test_connection,
            commands::mist_get_config,
            commands::mist_save_config,
            commands::mist_test_connection,
            commands::whatsapp_get_config,
            commands::whatsapp_save_config,
            commands::whatsapp_link,
            commands::whatsapp_unlink,
            commands::whatsapp_status,
            commands::whatsapp_list_groups,
            commands::cml_get_config,
            commands::cml_save_config,
            commands::cml_test_connection,
            commands::catalyst_center_get_config,
            commands::catalyst_center_save_config,
            commands::catalyst_center_test_connection,
            commands::splunk_get_config,
            commands::splunk_save_config,
            commands::splunk_test_connection,
            commands::aci_get_config,
            commands::aci_save_config,
            commands::aci_test_connection,
            commands::gnmi_get_config,
            commands::gnmi_save_config,
            commands::gnmi_test_connection,
            commands::fmc_get_config,
            commands::fmc_save_config,
            commands::fmc_test_connection,
            commands::thousandeyes_get_config,
            commands::thousandeyes_save_config,
            commands::thousandeyes_test_connection,
            commands::meraki_get_config,
            commands::meraki_save_config,
            commands::meraki_test_connection,
            commands::grafana_get_config,
            commands::grafana_save_config,
            commands::grafana_test_connection,
            commands::zabbix_get_config,
            commands::zabbix_save_config,
            commands::zabbix_test_connection,
            commands::topolograph::topolograph_config_get,
            commands::topolograph::topolograph_config_save,
            commands::topolograph::topolograph_test_connection,
            commands::topolograph::topolograph_upload_lsdb_file,
            commands::topolograph::pyats_import::pyats_list_supported_devices,
            commands::topolograph::pyats_import::topolograph_import_lsdb_from_pyats,
            commands::topolograph::topolograph_upload_yaml_file,
            commands::topolograph::topolograph_audit_list,
            commands::stp::stp_settings_get,
            commands::stp::stp_settings_save,
            commands::stp::stp_collect_now,
            commands::stp::stp_snapshot_list,
            commands::stp::stp_snapshot_get,
            commands::prometheus_get_config,
            commands::prometheus_save_config,
            commands::prometheus_test_connection,
            commands::netbox_get_config,
            commands::netbox_save_config,
            commands::netbox_test_connection,
            commands::sketchfab_get_config,
            commands::sketchfab_save_config,
            commands::sketchfab_test_connection,
            commands::ai_test_connection,
            commands::agents_list,
            commands::agents_get,
            commands::agents_create,
            commands::agents_update,
            commands::agents_delete,
            commands::agents_reload,
            commands::network_architect_soul_list,
            commands::network_architect_soul_save,
            commands::agent_session_get,
            commands::agent_session_set,
            commands::agent_session_list_all,
            commands::agent_approve_tool,
            commands::agent_chat_cancel,
            commands::ftp_config_get,
            commands::ftp_config_set,
            commands::ftp_status,
            commands::ftp_start,
            commands::ftp_stop,
            commands::ftp_users_list,
            commands::ftp_users_create,
            commands::ftp_users_update,
            commands::ftp_users_delete,
            commands::ftp_events_tail,
            commands::ftp_events_stream,
            commands::tftp_config_get,
            commands::tftp_config_set,
            commands::tftp_status,
            commands::tftp_start,
            commands::tftp_stop,
            commands::tftp_events_tail,
            config::get_profiles,
            config::get_profile,
            config::save_profile,
            config::get_env_var,
            config::set_env_var,
            commands::blocks::blocks_list,
            commands::blocks::blocks_upsert,
            commands::blocks::blocks_delete,
            commands::blocks::blocks_get_recent,
            commands::blocks::blocks_get_bookmarked,
            commands::blocks::block_tag_add,
            commands::blocks::block_tag_remove,
            commands::blocks::block_tags_list,
            commands::blocks::blocks_by_tag,
            commands::blocks::block_pin,
            commands::blocks::block_unpin,
            commands::blocks::blocks_list_pinned,
            commands::blocks::block_set_collapsed,
            commands::blocks::block_share_create,
            commands::blocks::block_share_fetch,
            commands::blocks::block_share_revoke,
            commands::notebooks::notebooks_save,
            commands::notebooks::notebooks_list,
            commands::notebooks::notebooks_get,
            commands::notebooks::notebooks_delete,
            commands::notebooks_runnable::notebook_import_markdown,
            commands::notebooks_runnable::notebook_import_url,
            commands::notebooks_runnable::notebook_list_runnable,
            commands::notebooks_runnable::notebook_get_runnable,
            commands::notebooks_runnable::notebook_delete_runnable,
            commands::notebooks_runnable::notebook_export_markdown,
            commands::notebooks_runnable::notebook_run_start,
            commands::notebooks_runnable::notebook_run_approve,
            commands::notebooks_runnable::notebook_run_cancel,
            commands::notebooks_runnable::notebook_run_pause,
            commands::notebooks_runnable::notebook_run_resume,
            commands::notebooks_runnable::notebook_run_status,
            commands::panes::panes_get_layout,
            commands::panes::panes_save_layout,
            commands::panes::panes_delete_layout,
            commands::workflows::workflow_upsert,
            commands::workflows::workflow_get,
            commands::workflows::workflow_list,
            commands::workflows::workflow_delete,
            commands::workflows::workflow_run,
            commands::workflows::workflow_run_complete,
            commands::workflows::global_command_bar_get,
            commands::workflows::global_command_bar_set,
            commands::workflows_seed::workflows_seed_builtin,
            // Change Verification (Pre/Post Check Bundles)
            commands::change_verify::bundle_create,
            commands::change_verify::bundle_get,
            commands::change_verify::bundle_list,
            commands::change_verify::bundle_update_commands,
            commands::change_verify::bundle_rename,
            commands::change_verify::bundle_delete,
            commands::change_verify::change_run_pre,
            commands::change_verify::change_run_post,
            commands::change_verify::change_run_pre_ssh,
            commands::change_verify::change_run_post_ssh,
            commands::change_verify::change_snapshot_get,
            commands::change_verify::change_latest_pre_for_tab,
            commands::change_verify::change_run_post_and_report,
            commands::change_verify::change_run_post_and_report_ssh,
            commands::change_verify::change_report_get,
            commands::change_verify::change_report_list,
            commands::change_verify::change_report_append_approval,
            commands::palette::palette_search,
            commands::palette::palette_record_use,
            commands::structured::structured_auto_parse,
            commands::structured::structured_run_and_parse,
            commands::structured::structured_get,
            commands::structured::structured_snapshot_create,
            commands::structured::structured_list_snapshots,
            commands::structured::structured_snapshot_rename,
            commands::structured::structured_snapshot_delete,
            commands::structured::structured_snapshot_diff,
            // Multi-Device Fan-Out (Plan 07)
            commands::fanout::fanout_group_create,
            commands::fanout::fanout_group_get,
            commands::fanout::fanout_group_update,
            commands::fanout::fanout_group_delete,
            commands::fanout::fanout_group_list,
            commands::fanout::fanout_member_add,
            commands::fanout::fanout_member_add_bulk,
            commands::fanout::fanout_member_remove,
            commands::fanout::fanout_member_list,
            commands::fanout::fanout_group_import_csv,
            commands::fanout::fanout_run_list,
            commands::fanout::fanout_run_get,
            commands::fanout::fanout_run_start,
            commands::fanout::fanout_run_cancel,
            commands::fanout::fanout_device_cancel,
            commands::fanout::fanout_device_retry,
            commands::fanout::fanout_block_output_text,
            commands::fanout::fanout_run_export_zip,
            // Config intent + drift (Plan 08)
            commands::drift::intent_create,
            commands::drift::intent_get,
            commands::drift::intent_list,
            commands::drift::intent_update_body,
            commands::drift::intent_update_vars,
            commands::drift::intent_update_selector,
            commands::drift::intent_update_match_mode,
            commands::drift::intent_rename,
            commands::drift::intent_delete,
            commands::drift::intent_render,
            commands::drift::config_normalize,
            commands::drift::drift_diff,
            commands::drift::drift_run_on_demand,
            commands::drift::drift_reports_list,
            commands::drift::drift_report_get,
            commands::drift::drift_reports_by_device,
            commands::drift::drift_schedule_create,
            commands::drift::drift_schedule_pause,
            commands::drift::drift_schedule_resume,
            commands::drift::drift_schedule_delete,
            commands::drift::drift_schedule_list,
            commands::drift::drift_snapshot_device,
            commands::drift::config_snapshots_list,
            commands::drift::config_snapshot_get,
            commands::drift::config_snapshot_set_label,
            commands::drift::config_snapshots_diff,
            commands::drift::drift_exception_add,
            commands::drift::drift_exceptions_list,
            commands::drift::drift_exception_delete,
            // AI Guardrails / Blast-Radius (Plan 09)
            commands::guardrails::guardrail_classify,
            commands::guardrails::guardrail_record_decision,
            commands::guardrails::guardrail_decisions_list,
            commands::guardrails::guardrail_rules_list,
            commands::guardrails::guardrail_rule_upsert,
            commands::guardrails::guardrail_rule_delete,
            commands::guardrails::guardrail_rule_set_enabled,
            commands::guardrails::guardrail_ruleset_reload,
            commands::guardrails::guardrail_test_regex,
            commands::guardrails::guardrail_rules_export,
            commands::guardrails::guardrail_rules_import,
            commands::guardrails::guardrail_impact_summary,
            commands::guardrails::guardrail_second_opinion,
            // Session chains (Plan 10)
            // Packet capture (Plan 11)
            commands::pcap::pcap_list_templates,
            commands::pcap::pcap_create_template,
            commands::pcap::pcap_update_template,
            commands::pcap::pcap_delete_template,
            commands::pcap::pcap_capture_create,
            commands::pcap::pcap_capture_update_status,
            commands::pcap::pcap_capture_finalize,
            commands::pcap::pcap_capture_get,
            commands::pcap::pcap_capture_list,
            commands::pcap::pcap_capture_delete,
            commands::pcap::pcap_start_capture,
            commands::pcap::pcap_list_local_interfaces,
            commands::pcap::pcap_start_local_capture,
            commands::pcap::pcap_cancel,
            commands::pcap::pcap_summarize,
            commands::pcap::pcap_packet_bytes,
            commands::pcap::pcap_finding_rules,
            commands::pcap::pcap_findings,
            commands::pcap::pcap_follow_stream,
            commands::pcap::pcap_export,
            // RAG vendor-aware completion (Plan 12)
            commands::rag::rag_upload,
            commands::rag::rag_list_documents,
            commands::rag::rag_delete_document,
            commands::rag::rag_tag_taxonomy,
            commands::rag::rag_retrieve,
            commands::rag_seed::rag_run_seed_script,
            commands::rag_seed::rag_list_seed_files,
            // Inline topology awareness (Plan 13)
            commands::topology::topology_ingest_from_block,
            commands::topology::topology_ingest_from_text,
            commands::topology::topology_discover_device,
            commands::topology::topology_list_graphs,
            commands::topology::topology_get_graph,
            commands::topology::topology_create_graph,
            commands::topology::topology_delete_graph,
            commands::topology::topology_clear_graph,
            commands::topology::topology_neighbor_cache_list,
            commands::topology::device_lookup_by_ref,
            // Saved diagrams (agent-generated draw.io/mermaid, persisted).
            commands::diagrams::diagram_save,
            commands::diagrams::diagram_list,
            commands::diagrams::diagram_delete,
            // Plan 14 — Credential vault.
            commands::vault::vault_list_envelopes,
            commands::vault::vault_create_envelope,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::vault::vault_delete_envelope,
            commands::vault::vault_add_secret,
            commands::vault::vault_list_secrets,
            commands::vault::vault_reveal_secret,
            commands::vault::vault_delete_secret,
            commands::vault::vault_rotate_secret,
            commands::vault::vault_unlocked_ids,
            commands::vault::vault_set_auto_unlock,
            commands::vault::vault_idle_sweep,
            commands::vault::vault_audit_list,
            commands::vault::vault_import_csv,
            // Plan 14 — Session recording.
            commands::recording::recording_start,
            commands::recording::recording_stop,
            commands::recording::recording_status,
            commands::recording::recording_list,
            commands::recording::recording_get,
            commands::recording::recording_delete,
            commands::recording::recording_export,
            commands::recording::recording_export_text,
            commands::recording::recording_redaction_summary,
            commands::recording::recording_read_cast,
            // Plan 15 — AI-Driven Troubleshooting Tree (Phase 1: catalogue CRUD).
            commands::troubleshoot::list_playbooks,
            commands::troubleshoot::get_playbook,
            commands::troubleshoot::upsert_playbook,
            commands::troubleshoot::delete_playbook,
            // Plan 15 Phase 2 — run lifecycle.
            commands::troubleshoot::start_run,
            commands::troubleshoot::pause_run,
            commands::troubleshoot::resume_run,
            commands::troubleshoot::cancel_run,
            commands::troubleshoot::answer_prompt,
            commands::troubleshoot::mark_root_cause,
            commands::troubleshoot::get_run,
            // Plan 15 Phase 5 — symptom-to-playbook matcher.
            commands::troubleshoot::match_symptom,
            // Playbook editor — AI playbook generation.
            commands::troubleshoot::generate_playbook,
            // Plan 16 Phase 1 — IaC integration.
            commands::get_iac_execution,
            commands::iac_process_block,
            commands::iac_classify_blast_radius,
            commands::iac_lint_file,
            commands::iac_generate_terraform,
            commands::iac_generate_ansible,
            commands::iac_generate_pipeline,
            commands::iac_load_state,
            commands::iac_query_state,
            commands::iac_add_drift_exception,
            commands::iac_list_drift_exceptions,
            commands::iac_check_drift,
            // pyATS device inventory (Settings → pyATS).
            commands::pyats::pyats_save_testbed,
            commands::pyats::pyats_test_connection,
            commands::pyats::pyats_import_from_topology,
            // AI Assistant Integration Phase 1 — Pane activity tracking.
            commands::pane_activity::get_pane_activity,
            commands::pane_activity::get_all_pane_activities,
            commands::pane_activity::clear_pane_notification,
            commands::pane_activity::set_pane_focus,
            commands::pane_activity::register_agent_session,
            commands::pane_activity::unregister_agent_session,
            commands::pane_activity::get_active_agent_sessions,
            commands::pane_activity::update_notification_preferences,
            commands::pane_activity::get_notification_preferences,
            commands::pane_activity::get_pane_foreground_agent,
            commands::browser::create_browser_window,
            commands::browser::close_browser_window,
            commands::browser::list_browser_windows,
            commands::browser::browser_navigate,
            commands::browser::browser_back,
            commands::browser::browser_forward,
            commands::browser::browser_reload,
            commands::browser::browser_get_url,
            commands::browser::browser_eval,
            commands::browser::browser_import_cookies,
            commands::get_browser_mcp_config,
            // Phase 3E — Pane metadata sidebar.
            commands::metadata::get_pane_metadata,
            // Heartbeat Monitoring System — 18 commands for automated health checks.
            commands::heartbeat_plan,
            heartbeat::commands::heartbeat_create,
            heartbeat::commands::heartbeat_list,
            heartbeat::commands::heartbeat_get,
            heartbeat::commands::heartbeat_update,
            heartbeat::commands::heartbeat_update_checks,
            heartbeat::commands::heartbeat_pause,
            heartbeat::commands::heartbeat_resume,
            heartbeat::commands::heartbeat_delete,
            heartbeat::commands::heartbeat_trigger_now,
            heartbeat::commands::heartbeat_executions,
            heartbeat::commands::heartbeat_execution_detail,
            heartbeat::commands::heartbeat_suggestions_get,
            heartbeat::commands::heartbeat_suggestion_apply,
            heartbeat::commands::heartbeat_suggestion_dismiss,
            heartbeat::commands::heartbeat_export,
            heartbeat::commands::heartbeat_import,
        ])
        .setup(|app| {
            // Set the Dock icon at runtime so the TerminAI icon shows in dev too
            // (bundle.icon only applies to a built .app). No-op off macOS.
            crate::macos_icon::set_dock_icon();

            let terminal_agent = app.state::<AppState>().terminal_agent.clone();
            let gateway_url = crate::terminal_agent::gateway::start(
                app.handle().clone(),
                terminal_agent,
            )
            .map_err(std::io::Error::other)?;
            tracing::info!(url = %gateway_url, "terminal-agent gateway listening");

            // Build and set menu for the main window
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
            use tauri::Manager;

            let app_name = &app.package_info().name;

            // SSH menu with saved connections item
            let ssh_saved = MenuItem::with_id(app, "ssh_saved", "Saved Connections...", true, None::<&str>)?;
            let ssh_serial = MenuItem::with_id(app, "ssh_serial", "Serial Console...", true, None::<&str>)?;
            let ssh_sftp = MenuItem::with_id(app, "ssh_sftp", "SFTP...", true, None::<&str>)?;
            let ssh_menu = Submenu::with_items(app, "SSH", true, &[&ssh_saved, &ssh_serial, &ssh_sftp])?;

            // View menu — block view modes (raw/structured/diff), restored 2026-07-02.
            // Pin Snapshot / Export CSV/JSON / Copy as Markdown intentionally stay
            // removed — still available as in-block buttons inside StructuredTab.
            let view_raw = MenuItem::with_id(app, "view_raw", "Show Raw Output", true, Some("CmdOrCtrl+1"))?;
            let view_structured = MenuItem::with_id(app, "view_structured", "Show Structured", true, Some("CmdOrCtrl+2"))?;
            let view_diff = MenuItem::with_id(app, "view_diff", "Show Diff", true, Some("CmdOrCtrl+3"))?;
            let reopen_closed_tab = MenuItem::with_id(app, "reopen_closed_tab", "Reopen Closed Tab", true, Some("CmdOrCtrl+Shift+O"))?;
            let reopen_closed_pick = MenuItem::with_id(app, "reopen_closed_pick", "Recently Closed…", true, None::<&str>)?;
            let view_menu = Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &view_raw,
                    &view_structured,
                    &view_diff,
                    &PredefinedMenuItem::separator(app)?,
                    &reopen_closed_tab,
                    &reopen_closed_pick,
                ],
            )?;

            // Change menu — change verification workflow (Plan 06).
            let change_open = MenuItem::with_id(app, "change_open", "Open Change Window", true, Some("CmdOrCtrl+Shift+C"))?;
            let change_run_pre = MenuItem::with_id(app, "change_run_pre", "Run Pre-Check", true, Some("CmdOrCtrl+Shift+1"))?;
            let change_run_post = MenuItem::with_id(app, "change_run_post", "Run Post-Check", true, Some("CmdOrCtrl+Shift+2"))?;
            let change_new_bundle = MenuItem::with_id(app, "change_new_bundle", "New Bundle...", true, None::<&str>)?;
            let change_manage_bundles = MenuItem::with_id(app, "change_manage_bundles", "Manage Bundles...", true, None::<&str>)?;
            let change_export_md = MenuItem::with_id(app, "change_export_md", "Export Report as Markdown", true, None::<&str>)?;
            let change_menu = Submenu::with_items(
                app,
                "Change",
                true,
                &[
                    &change_open,
                    &change_run_pre,
                    &change_run_post,
                    &PredefinedMenuItem::separator(app)?,
                    &change_new_bundle,
                    &change_manage_bundles,
                    &PredefinedMenuItem::separator(app)?,
                    &change_export_md,
                ],
            )?;

            // Fan-out menu (Plan 07).
            let fanout_open = MenuItem::with_id(app, "fanout_open", "Open Fan-Out Panel", true, Some("CmdOrCtrl+Shift+F"))?;
            let fanout_groups = MenuItem::with_id(app, "fanout_groups", "Manage Device Groups...", true, None::<&str>)?;
            let fanout_menu = Submenu::with_items(
                app,
                "Fan-Out",
                true,
                &[&fanout_open, &fanout_groups],
            )?;

            // Drift menu (Plan 08).
            let drift_open = MenuItem::with_id(app, "drift_open", "Open Drift Sidebar", true, Some("CmdOrCtrl+Shift+D"))?;
            let drift_intents = MenuItem::with_id(app, "drift_intents", "Manage Intent Templates...", true, None::<&str>)?;
            let drift_menu = Submenu::with_items(
                app,
                "Drift",
                true,
                &[&drift_open, &drift_intents],
            )?;

            // Guardrails menu (Plan 09).
            let guardrails_rules = MenuItem::with_id(app, "guardrails_rules", "Rule Editor...", true, Some("CmdOrCtrl+Shift+G"))?;
            let guardrails_log = MenuItem::with_id(app, "guardrails_log", "Decision Log...", true, None::<&str>)?;
            let guardrails_menu = Submenu::with_items(
                app,
                "Guardrails",
                true,
                &[&guardrails_rules, &guardrails_log],
            )?;


            // Captures menu (Plan 11) — packet capture panel.
            // Browser — Phase 3 popup browser windows.
            let browser_new = MenuItem::with_id(app, "browser_new", "New Browser Window…", true, Some("CmdOrCtrl+Shift+B"))?;
            let browser_menu = Submenu::with_items(app, "Browser", true, &[&browser_new])?;

            let captures_open = MenuItem::with_id(app, "captures_open", "Open Captures Panel", true, Some("CmdOrCtrl+Shift+K"))?;
            let captures_menu = Submenu::with_items(
                app,
                "Captures",
                true,
                &[&captures_open],
            )?;

            // Diagrams menu — draw.io diagram viewer (agent-produced topology).
            let diagram_open = MenuItem::with_id(app, "diagram_open", "Open Diagram Viewer", true, Some("CmdOrCtrl+Shift+I"))?;
            let diagram_menu = Submenu::with_items(
                app,
                "Diagrams",
                true,
                &[&diagram_open],
            )?;

            // Pane menu (Phase 3E) — floating metadata HUD for the focused pane.
            let pane_metadata_toggle = MenuItem::with_id(app, "pane_metadata_toggle", "Toggle Metadata Card", true, Some("CmdOrCtrl+Shift+L"))?;
            let rich_input = MenuItem::with_id(app, "rich_input", "Compose Input…", true, Some("CmdOrCtrl+Shift+Enter"))?;
            let pane_menu = Submenu::with_items(app, "Pane", true, &[&pane_metadata_toggle, &rich_input])?;

            // IaC menu — Terraform state browser (Phase 3) + IaC Studio (Phase A).
            let iac_state_open = MenuItem::with_id(app, "iac_state_open", "Open Terraform State", true, Some("CmdOrCtrl+Shift+S"))?;
            let iac_studio_open = MenuItem::with_id(app, "iac_studio_open", "Open IaC Studio", true, Some("CmdOrCtrl+Shift+E"))?;
            let iac_new_resource = MenuItem::with_id(app, "iac_new_resource", "New Resource…", true, None::<&str>)?;
            let iac_new_pipeline = MenuItem::with_id(app, "iac_new_pipeline", "New Pipeline…", true, None::<&str>)?;
            let iac_get_started_pipelines = MenuItem::with_id(app, "iac_get_started_pipelines", "Get Started with Pipelines…", true, None::<&str>)?;
            let iac_menu = Submenu::with_items(app, "IaC", true, &[&iac_studio_open, &iac_state_open, &iac_new_resource, &iac_new_pipeline, &iac_get_started_pipelines])?;

            // Vault menu (Plan 14) — credential vault.
            let vault_open = MenuItem::with_id(app, "vault_open", "Open Vault Tab", true, Some("CmdOrCtrl+Shift+V"))?;
            let vault_lock_active = MenuItem::with_id(app, "vault_lock_active", "Lock Active Envelope", true, Some("CmdOrCtrl+L"))?;
            let vault_lock_all = MenuItem::with_id(app, "vault_lock_all", "Lock All Envelopes", true, None::<&str>)?;
            let vault_new_envelope = MenuItem::with_id(app, "vault_new_envelope", "New Envelope...", true, None::<&str>)?;
            let vault_import_csv = MenuItem::with_id(app, "vault_import_csv", "Import from 1Password/Bitwarden CSV...", true, None::<&str>)?;
            let vault_audit = MenuItem::with_id(app, "vault_audit", "Audit Log...", true, None::<&str>)?;
            let vault_menu = Submenu::with_items(
                app,
                "Vault",
                true,
                &[
                    &vault_open,
                    &PredefinedMenuItem::separator(app)?,
                    &vault_lock_active,
                    &vault_lock_all,
                    &PredefinedMenuItem::separator(app)?,
                    &vault_new_envelope,
                    &vault_import_csv,
                    &PredefinedMenuItem::separator(app)?,
                    &vault_audit,
                ],
            )?;

            // Recording menu (Plan 14) — session recording.
            let recording_toggle = MenuItem::with_id(app, "recording_toggle", "Start/Stop Recording (Active Tab)", true, Some("CmdOrCtrl+Shift+R"))?;
            let recording_open_list = MenuItem::with_id(app, "recording_open_list", "Open Recordings", true, None::<&str>)?;
            let recording_menu = Submenu::with_items(
                app,
                "Recording",
                true,
                &[&recording_toggle, &recording_open_list],
            )?;

            // Tools menu — palette, workflows, notebooks (entry points to existing features).
            let tool_palette = MenuItem::with_id(app, "open_palette", "Command Palette", true, Some("CmdOrCtrl+K"))?;
            let tool_workflows = MenuItem::with_id(app, "open_workflows", "Workflows", true, Some("CmdOrCtrl+Shift+W"))?;
            let tool_notebooks = MenuItem::with_id(app, "open_notebooks", "Notebooks", true, Some("CmdOrCtrl+Shift+N"))?;
            let tool_subnet = MenuItem::with_id(app, "subnet_new", "Subnet Calculator", true, Some("CmdOrCtrl+Shift+U"))?;
            let tools_menu = Submenu::with_items(
                app,
                "Tools",
                true,
                &[&tool_palette, &tool_workflows, &tool_notebooks, &tool_subnet],
            )?;

            // Troubleshoot menu (Plan 15) — AI-driven troubleshooting tree.
            let troubleshoot_open = MenuItem::with_id(app, "troubleshoot_open", "Open Troubleshoot Tab", true, Some("CmdOrCtrl+Shift+T"))?;
            let troubleshoot_editor = MenuItem::with_id(app, "troubleshoot_editor", "Playbook Editor...", true, Some("CmdOrCtrl+Alt+T"))?;
            let troubleshoot_templates = MenuItem::with_id(app, "troubleshoot_templates", "Browse Builtin Playbooks", true, None::<&str>)?;
            let troubleshoot_menu = Submenu::with_items(
                app,
                "Troubleshoot",
                true,
                &[
                    &troubleshoot_open,
                    &PredefinedMenuItem::separator(app)?,
                    &troubleshoot_editor,
                    &troubleshoot_templates,
                ],
            )?;

            // Heartbeat menu — automated health checks and monitoring (Task 12).
            let heartbeat_open = MenuItem::with_id(app, "heartbeat_open", "Heartbeats...", true, Some("CmdOrCtrl+Shift+H"))?;
            let heartbeat_menu = Submenu::with_items(
                app,
                "Heartbeat",
                true,
                &[&heartbeat_open],
            )?;

            // Help menu — in-app help surface (User Guide, Quick Start, About).
            let help_user_guide = MenuItem::with_id(app, "help_user_guide", "User Guide", true, Some("F1"))?;
            let help_quick_start = MenuItem::with_id(app, "help_quick_start", "Quick Start & Shortcuts", true, Some("CmdOrCtrl+/"))?;
            let help_keyboard = MenuItem::with_id(app, "help_keyboard", "Keyboard Shortcuts Reference", true, None::<&str>)?;
            let help_about = MenuItem::with_id(app, "help_about", "About TerminAI", true, None::<&str>)?;
            let help_menu = Submenu::with_items(
                app,
                "Help",
                true,
                &[
                    &help_user_guide,
                    &help_quick_start,
                    &help_keyboard,
                    &PredefinedMenuItem::separator(app)?,
                    &help_about,
                ],
            )?;

            // App menu (macOS style)
            let app_menu = Submenu::with_items(
                app,
                app_name,
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;

            // Edit menu (macOS style) — REQUIRED for clipboard shortcuts to work
            // in web content (inputs, textareas, selectable panels). WKWebView
            // only enables Cmd+C/V/X/A for the webview when these predefined
            // items (which carry the standard key equivalents) are present in
            // the app menu. Without an Edit menu, copy/paste works nowhere
            // except surfaces that hand-wire it (e.g. the xterm terminal).
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;

            // Operate — day-to-day workflow surfaces. Wraps the existing
            // Tools / Fan-Out / Captures / SSH / Vault / Recording
            // submenus; their MenuItem IDs and shortcuts remain unchanged so
            // the JS-side `app.on_menu_event` dispatcher and frontend
            // `listen('menu:...')` calls keep working.
            let operate_menu = Submenu::with_items(
                app,
                "Operate",
                true,
                &[
                    &tools_menu,
                    &fanout_menu,
                    &captures_menu,
                    &diagram_menu,
                    &iac_menu,
                    &browser_menu,
                    &pane_menu,
                    &heartbeat_menu,
                    &PredefinedMenuItem::separator(app)?,
                    &ssh_menu,
                    &vault_menu,
                    &recording_menu,
                ],
            )?;

            // Audit — verification surfaces (pre/post change, drift, guardrails,
            // troubleshooting playbooks).
            let audit_menu = Submenu::with_items(
                app,
                "Audit",
                true,
                &[
                    &change_menu,
                    &drift_menu,
                    &guardrails_menu,
                    &troubleshoot_menu,
                ],
            )?;

            // Build the full menu
            let menu = Menu::with_items(
                app,
                &[
                    &app_menu,
                    &edit_menu,
                    &view_menu,
                    &operate_menu,
                    &audit_menu,
                    &help_menu,
                ],
            )?;

            // Set menu on window
            app.set_menu(menu)?;

            // Handle menu events
            app.on_menu_event(|app_handle, event| {
                use tauri::Emitter;
                let window = match app_handle.webview_windows().values().next() {
                    Some(w) => w.clone(),
                    None => return,
                };
                match event.id().as_ref() {
                    "ssh_saved" => {
                        window.emit("menu:ssh_saved_connections", ()).ok();
                    }
                    "ssh_serial" => {
                        window.emit("menu:ssh_serial_console", ()).ok();
                    }
                    "ssh_sftp" => {
                        window.emit("menu:ssh_sftp", ()).ok();
                    }
                    "view_raw" => { window.emit("menu:view_mode", "raw").ok(); }
                    "view_structured" => { window.emit("menu:view_mode", "structured").ok(); }
                    "view_diff" => { window.emit("menu:view_mode", "diff").ok(); }
                    "reopen_closed_tab" => { window.emit("menu:reopen_closed_tab", ()).ok(); }
                    "reopen_closed_pick" => { window.emit("menu:reopen_closed_pick", ()).ok(); }
                    "change_open" => { window.emit("menu:change_open", ()).ok(); }
                    "change_run_pre" => { window.emit("menu:change_run_pre", ()).ok(); }
                    "change_run_post" => { window.emit("menu:change_run_post", ()).ok(); }
                    "change_new_bundle" => { window.emit("menu:change_new_bundle", ()).ok(); }
                    "change_manage_bundles" => { window.emit("menu:change_manage_bundles", ()).ok(); }
                    "change_export_md" => { window.emit("menu:change_export_md", ()).ok(); }
                    "fanout_open" => { window.emit("menu:fanout_open", ()).ok(); }
                    "fanout_groups" => { window.emit("menu:fanout_groups", ()).ok(); }
                    "open_palette" => { window.emit("menu:open_palette", ()).ok(); }
                    "open_workflows" => { window.emit("menu:open_workflows", ()).ok(); }
                    "open_notebooks" => { window.emit("menu:open_notebooks", ()).ok(); }
                    "subnet_new" => { window.emit("menu:subnet_new", ()).ok(); }
                    "drift_open" => { window.emit("menu:drift_open", ()).ok(); }
                    "drift_intents" => { window.emit("menu:drift_intents", ()).ok(); }
                    "iac_state_open" => { window.emit("menu:iac_state_open", ()).ok(); }
                    "iac_studio_open" => { window.emit("menu:iac_studio_open", ()).ok(); }
                    "iac_new_resource" => { window.emit("menu:iac_new_resource", ()).ok(); }
                    "iac_new_pipeline" => { window.emit("menu:iac_new_pipeline", ()).ok(); }
                    "iac_get_started_pipelines" => { window.emit("menu:iac_get_started_pipelines", ()).ok(); }
                    "guardrails_rules" => { window.emit("menu:guardrails_rules", ()).ok(); }
                    "guardrails_log" => { window.emit("menu:guardrails_log", ()).ok(); }
                    "browser_new" => { window.emit("menu:browser_new", ()).ok(); }
                    "captures_open" => { window.emit("menu:captures_open", ()).ok(); }
                    "diagram_open" => { window.emit("menu:diagram_open", ()).ok(); }
                    "pane_metadata_toggle" => { window.emit("menu:pane_metadata_toggle", ()).ok(); }
                    "rich_input" => { window.emit("menu:rich_input", ()).ok(); }
                    "vault_open" => { window.emit("menu:vault_open", ()).ok(); }
                    "vault_lock_active" => { window.emit("menu:vault_lock_active", ()).ok(); }
                    "vault_lock_all" => { window.emit("menu:vault_lock_all", ()).ok(); }
                    "vault_new_envelope" => { window.emit("menu:vault_new_envelope", ()).ok(); }
                    "vault_import_csv" => { window.emit("menu:vault_import_csv", ()).ok(); }
                    "vault_audit" => { window.emit("menu:vault_audit", ()).ok(); }
                    "recording_toggle" => { window.emit("menu:recording_toggle", ()).ok(); }
                    "recording_open_list" => { window.emit("menu:recording_open_list", ()).ok(); }
                    "troubleshoot_open" => { window.emit("menu:troubleshoot_open", ()).ok(); }
                    "troubleshoot_editor" => { window.emit("menu:troubleshoot_editor", ()).ok(); }
                    "troubleshoot_templates" => { window.emit("menu:troubleshoot_templates", ()).ok(); }
                    "heartbeat_open" => { window.emit("menu:heartbeat_open", ()).ok(); }
                    "help_user_guide" => { window.emit("menu:help_open", "user-guide").ok(); }
                    "help_quick_start" => { window.emit("menu:help_open", "quick-start").ok(); }
                    "help_keyboard" => { window.emit("menu:help_open", "shortcuts").ok(); }
                    "help_about" => { window.emit("menu:help_open", "about").ok(); }
                    _ => {}
                }
            });

            // Deep-link handler: route `ccie-terminal://block/<share_id>` URLs
            // to the frontend by emitting `deep-link:block-share` with the
            // share id. Multiple URLs may be delivered in a single batch on
            // cold start, so iterate through every entry.
            {
                use tauri::Emitter;
                use tauri_plugin_deep_link::DeepLinkExt;

                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let raw = url.as_str();
                        tracing::info!(target: "deep_link", url = %raw, "received deep-link URL");
                        if let Some(share_id) =
                            commands::blocks::parse_share_url(raw)
                        {
                            tracing::info!(
                                target: "deep_link",
                                %share_id,
                                "routing block share to frontend"
                            );
                            if let Some(window) =
                                app_handle.webview_windows().values().next()
                            {
                                let payload =
                                    serde_json::json!({ "shareId": share_id });
                                if let Err(e) =
                                    window.emit("deep-link:block-share", payload)
                                {
                                    tracing::warn!(
                                        target: "deep_link",
                                        error = %e,
                                        "failed to emit deep-link:block-share"
                                    );
                                }
                            } else {
                                tracing::warn!(
                                    target: "deep_link",
                                    "no webview window available to receive deep link"
                                );
                            }
                        } else {
                            tracing::debug!(
                                target: "deep_link",
                                url = %raw,
                                "ignoring deep-link URL (not a block share)"
                            );
                        }
                    }
                });
            }

            // Phase 3C — start the in-process browser control server so the
            // browser_mcp.py shim (and thus all agents) can drive windows.
            {
                use tauri::Manager;
                let app_handle = app.handle().clone();
                let state = app_handle.state::<commands::AppState>();
                let mgr = state.browser_manager.clone();
                let db = state.db.clone();
                if let Err(e) = commands::enable_blender_mcp_server(&db) {
                    tracing::error!(error = %e, "failed to register Blender MCP server");
                }
                tauri::async_runtime::spawn(async move {
                    match crate::browser::start_control_server(app_handle.clone(), mgr).await {
                        Ok(info) => {
                            if let Err(e) = crate::browser::write_control_discovery(&info) {
                                tracing::error!(error = %e, "failed to write browser-control.json");
                            }
                            // Register the browser MCP shim using the shared DB handle.
                            if let Err(e) = commands::enable_browser_mcp_server(&db) {
                                tracing::error!(error = %e, "failed to register browser MCP server");
                            }
                            // Part B — write the app-managed Claude Code hooks
                            // pointed at this control server, so in-pane
                            // `claude` reports its working/waiting state. The
                            // config dir is a deterministic path
                            // (claude_hooks::config_dir) that pty_spawn exports
                            // as CLAUDE_CONFIG_DIR; port+token are baked into
                            // the written settings.json here.
                            if let Err(e) = crate::claude_hooks::install(info.port, &info.token) {
                                tracing::error!(error = %e, "failed to install Claude Code hooks");
                            }
                            // Codex: additively wire a `notify` hook into the
                            // user's real ~/.codex/config.toml (its config can't
                            // be cleanly isolated; notify is the only working
                            // signal). The script reads the control discovery
                            // file at runtime, so it's independent of this port.
                            match crate::codex_hooks::install() {
                                Ok(outcome) => tracing::info!(?outcome, "codex notify hook"),
                                Err(e) => tracing::error!(error = %e, "failed to wire codex notify hook"),
                            }
                        }
                        Err(e) => tracing::error!(error = %e, "failed to start browser control server"),
                    }
                });
            }

            // Warp-style agent toolbelt: poll each live PTY's foreground process
            // every ~1.5s and emit `pane_foreground_agent` when a pane starts or
            // stops running claude/codex. Cheap: one process_group_leader syscall
            // per open PTY; only emits on change.
            {
                use tauri::{Emitter, Manager};
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use std::collections::HashMap;
                    let mut last: HashMap<String, Option<String>> = HashMap::new();
                    let mut ticker =
                        tokio::time::interval(std::time::Duration::from_millis(1500));
                    loop {
                        ticker.tick().await;
                        let state = handle.state::<commands::AppState>();
                        // Snapshot (pane_id, agent) under the lock, then release
                        // it before emitting so we never hold it across await.
                        let current: Vec<(String, Option<String>)> = {
                            let ptys = state.ptys.lock();
                            ptys.iter()
                                .map(|(id, h)| {
                                    let agent = h
                                        .foreground_process_name()
                                        .and_then(|n| {
                                            crate::pane_context::foreground::foreground_agent_for(&n)
                                        });
                                    (id.clone(), agent)
                                })
                                .collect()
                        };

                        let mut seen = std::collections::HashSet::new();
                        for (pane_id, agent) in current {
                            seen.insert(pane_id.clone());
                            if last.get(&pane_id) != Some(&agent) {
                                last.insert(pane_id.clone(), agent.clone());
                                let _ = handle.emit(
                                    "pane_foreground_agent",
                                    serde_json::json!({ "paneId": pane_id, "agent": agent }),
                                );
                            }
                        }
                        // Forget panes whose PTY is gone so a reused id re-emits.
                        last.retain(|id, _| seen.contains(id));
                    }
                });
            }

            // Plan 14 — Idle-lock background sweep. Every 30s, sweep
            // envelopes whose last activity exceeded the idle timeout,
            // mark their `vault_sessions` rows as locked, and emit
            // `vault://auto-locked`. Also resolve the per-platform
            // recording directory.
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                let state = handle.state::<commands::AppState>();
                if let Some(dir) = handle
                    .path()
                    .app_local_data_dir()
                    .ok()
                    .map(|d| d.join("recordings"))
                {
                    let _ = std::fs::create_dir_all(&dir);
                    state.recording.set_base_dir(dir);
                }
                let vault = state.vault.clone();
                let db = state.db.clone();
                let app_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    use tauri::Emitter;
                    let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
                    tick.tick().await;
                    loop {
                        tick.tick().await;
                        let swept = vault.lock.sweep_idle();
                        if swept.is_empty() {
                            continue;
                        }
                        let mut envelope_ids = Vec::with_capacity(swept.len());
                        {
                            let conn = db.lock();
                            for (eid, sid) in &swept {
                                let _ = conn.execute(
                                    "UPDATE vault_sessions
                                     SET locked_at = unixepoch(), reason = 'idle'
                                     WHERE id = ?1 AND locked_at IS NULL",
                                    rusqlite::params![sid],
                                );
                                envelope_ids.push(eid.clone());
                            }
                        }
                        let _ = app_handle.emit("vault://auto-locked", &envelope_ids);
                    }
                });
            }

            // Heartbeat Monitoring System — Initialize and start the scheduler.
            // The TauriHeartbeatSink emits `heartbeat://execution_completed` events
            // on every check execution so the frontend can update the dashboard.
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                let state = handle.state::<commands::AppState>();

                struct TauriHeartbeatSink {
                    app_handle: tauri::AppHandle,
                    agent: crate::agent_bridge::AgentBridge,
                    db: std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
                    /// Per-heartbeat-id last-sent time; throttles WhatsApp alerts
                    /// (the monitoring side has no debounce of its own).
                    wa_cooldown: std::sync::Arc<parking_lot::Mutex<std::collections::HashMap<String, std::time::Instant>>>,
                }

                impl crate::heartbeat::scheduler::HeartbeatSink for TauriHeartbeatSink {
                    fn emit_execution_completed(
                        &self,
                        heartbeat_id: &str,
                        execution_id: &str,
                        status: &str,
                        severity: &str,
                        summary: &str,
                        heartbeat_name: &str,
                    ) {
                        use tauri::Emitter;
                        let payload = serde_json::json!({
                            "heartbeatId": heartbeat_id,
                            "executionId": execution_id,
                            "status": status,
                            "severity": severity,
                            "summary": summary,
                            "heartbeatName": heartbeat_name,
                        });
                        let _ = self.app_handle.emit("heartbeat://execution_completed", payload.clone());

                        // Emit system notification for critical or error severity
                        if severity == "critical" || severity == "error" {
                            let notification_title = format!("Heartbeat Alert: {}", heartbeat_name);
                            let notification_body = format!("{}: Critical issues found", summary);
                            let event_payload = serde_json::json!({
                                "heartbeatId": heartbeat_id,
                                "executionId": execution_id,
                                "title": notification_title,
                                "body": notification_body,
                            });
                            let _ = self.app_handle.emit("heartbeat://critical_notification", event_payload);

                            self.maybe_notify_whatsapp(heartbeat_id, execution_id, status, severity, summary, heartbeat_name);
                        }
                    }
                }

                impl TauriHeartbeatSink {
                    /// Pull the notable findings for an execution and format them
                    /// as bullet lines for the alert body. Returns "" on error.
                    fn finding_details(&self, execution_id: &str) -> String {
                        let conn = self.db.lock();
                        let mut stmt = match conn.prepare(
                            "SELECT severity, title, message FROM heartbeat_findings \
                             WHERE execution_id = ?1 \
                             ORDER BY CASE severity \
                               WHEN 'critical' THEN 0 WHEN 'error' THEN 1 \
                               WHEN 'warning' THEN 2 WHEN 'info' THEN 3 ELSE 4 END",
                        ) {
                            Ok(s) => s,
                            Err(_) => return String::new(),
                        };
                        let rows = stmt.query_map(rusqlite::params![execution_id], |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                            ))
                        });
                        let mut lines = Vec::new();
                        if let Ok(rows) = rows {
                            for row in rows.flatten() {
                                let (sev, title, message) = row;
                                let icon = match sev.as_str() {
                                    "critical" => "🔴",
                                    "error" => "🟠",
                                    "warning" => "🟡",
                                    "info" => "🔵",
                                    _ => "⚪",
                                };
                                let mut line = format!("{} {}", icon, title);
                                if !message.trim().is_empty() {
                                    // Keep each finding readable but bounded.
                                    let msg = message.trim();
                                    let msg = truncate_chars(msg, 300);
                                    line.push_str(&format!("\n   {}", msg.replace('\n', "\n   ")));
                                }
                                lines.push(line);
                                if lines.len() >= 10 {
                                    lines.push("…(more findings — open the app for the full report)".to_string());
                                    break;
                                }
                            }
                        }
                        lines.join("\n")
                    }

                    /// Push a WhatsApp alert if enabled, the severity is in the
                    /// configured set, and this heartbeat isn't in cooldown.
                    fn maybe_notify_whatsapp(
                        &self,
                        heartbeat_id: &str,
                        execution_id: &str,
                        status: &str,
                        severity: &str,
                        summary: &str,
                        heartbeat_name: &str,
                    ) {
                        const COOLDOWN: std::time::Duration = std::time::Duration::from_secs(300);

                        let cfg = crate::whatsapp::get_config(&self.db);
                        if !cfg.enabled || !cfg.notify_severities.iter().any(|s| s == severity) {
                            return;
                        }

                        // Route to the bound chat/group when set (one send);
                        // otherwise fan out to the allowlisted numbers.
                        let recipients: Vec<String> = if !cfg.bound_chat_jid.is_empty() {
                            vec![cfg.bound_chat_jid.clone()]
                        } else {
                            cfg.allowlist.clone()
                        };
                        if recipients.is_empty() {
                            return;
                        }

                        // Cooldown check (per heartbeat id).
                        {
                            let mut map = self.wa_cooldown.lock();
                            if let Some(last) = map.get(heartbeat_id) {
                                if last.elapsed() < COOLDOWN {
                                    return;
                                }
                            }
                            map.insert(heartbeat_id.to_string(), std::time::Instant::now());
                        }

                        // Build a detailed alert: header + summary + per-finding lines.
                        let sev_icon = match severity {
                            "critical" => "🔴",
                            "error" => "🟠",
                            _ => "⚠️",
                        };
                        let details = self.finding_details(execution_id);
                        let mut text = format!(
                            "{} *{}*\nSeverity: {} | Status: {}\n{}",
                            sev_icon, heartbeat_name, severity, status, summary
                        );
                        if !details.is_empty() {
                            text.push_str(&format!("\n\n{}", details));
                        }
                        let agent = self.agent.clone();
                        let heartbeat_id = heartbeat_id.to_string();
                        let cooldown = self.wa_cooldown.clone();
                        tauri::async_runtime::spawn(async move {
                            let mut delivered = false;
                            for to in recipients {
                                match agent
                                    .call(
                                        "whatsapp.send",
                                        serde_json::json!({ "to": to, "text": text }),
                                    )
                                    .await
                                {
                                    Ok(crate::agent_bridge::AgentResponse::Done { result })
                                        if crate::whatsapp::send_result_ok(&result) =>
                                    {
                                        delivered = true;
                                    }
                                    Ok(crate::agent_bridge::AgentResponse::Done { .. }) => {
                                        tracing::warn!(
                                            heartbeat_id = %heartbeat_id,
                                            "WhatsApp heartbeat delivery was rejected"
                                        );
                                    }
                                    Ok(crate::agent_bridge::AgentResponse::Error { .. })
                                    | Ok(crate::agent_bridge::AgentResponse::Token { .. })
                                    | Err(_) => {
                                        tracing::warn!(
                                            heartbeat_id = %heartbeat_id,
                                            "WhatsApp heartbeat delivery failed"
                                        );
                                    }
                                }
                            }
                            // A failed send must not consume the cooldown; the
                            // next eligible heartbeat should get another chance.
                            if !delivered {
                                cooldown.lock().remove(&heartbeat_id);
                            }
                        });
                    }
                }

                let db = state.db.clone();
                let agent = (*state.agent).clone();
                let sink = std::sync::Arc::new(TauriHeartbeatSink {
                    app_handle: handle.clone(),
                    agent: (*state.agent).clone(),
                    db: state.db.clone(),
                    wa_cooldown: std::sync::Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new())),
                });

                let scheduler = crate::heartbeat::scheduler::HeartbeatScheduler::new(
                    db,
                    agent,
                    sink,
                );

                tauri::async_runtime::spawn(async move {
                    match scheduler.start().await {
                        Ok(_) => {
                            tracing::info!("heartbeat: scheduler started");
                            // Store the running scheduler in AppState so commands can use it
                            let state = handle.state::<commands::AppState>();
                            *state.heartbeat_scheduler.lock() = Some(scheduler);
                        }
                        Err(e) => tracing::error!(error = %e, "heartbeat: scheduler failed to start"),
                    }
                });
            }

            // WhatsApp bridge — inbound message poll loop. Polls the sidecar's
            // `whatsapp.poll` RPC every few seconds and runs each message through
            // the configured agent. Self-gates when WhatsApp is disabled.
            crate::whatsapp::spawn_poll_task(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        use tauri::Manager;

        match event {
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                let _ = app_handle.state::<commands::AppState>().stp.shutdown();
                let shutdown = app_handle.state::<app_lifecycle::ShutdownCoordinator>();
                if app_lifecycle::exit_request_disposition(&shutdown, code)
                    == app_lifecycle::ExitRequestDisposition::Intercept
                {
                    api.prevent_exit();
                    app_lifecycle::request_shutdown(app_handle, &shutdown, "application-quit");
                }
            }
            tauri::RunEvent::Exit => {
                app_lifecycle::cleanup_before_process_exit(app_handle);
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod unicode_truncation_tests {
    use super::truncate_chars;

    #[test]
    fn truncates_ascii_at_the_requested_character_count() {
        assert_eq!(truncate_chars("abcdef", 3), "abc");
    }

    #[test]
    fn does_not_split_multi_byte_characters() {
        let message = format!("{}tail", "🔴".repeat(300));
        let truncated = truncate_chars(&message, 300);

        assert_eq!(truncated.chars().count(), 300);
        assert_eq!(truncated, "🔴".repeat(300));
    }

    #[test]
    fn leaves_short_messages_unchanged() {
        assert_eq!(truncate_chars("Meraki ✅", 300), "Meraki ✅");
    }
}
