//! Milestone A — Topolograph persistence and command boundary.
//!
//! Commands retain the URL/file/audit boundary while calling the dedicated
//! Topolograph methods on the persistent Python sidecar bridge.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::File;
use std::io::Read;
use std::net::IpAddr;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use zeroize::Zeroizing;

use crate::commands::AppState;

pub(crate) mod pyats_import;
pub use pyats_import::{
    topolograph_import_lsdb_from_pyats, TopolographPyatsLsdbImportRequest,
};

pub const TOPOLOGRAPH_SINGLETON_ID: &str = "topolograph";
pub const MAX_UPLOAD_BYTES: u64 = 32 * 1024 * 1024;
const AUDIT_RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_AUDIT_ROWS: i64 = 500;
const MAX_AUDIT_LIST_LIMIT: u32 = 50;

fn default_singleton_id() -> String {
    TOPOLOGRAPH_SINGLETON_ID.to_string()
}

fn default_verify_tls() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct TopolographConfig {
    pub singleton_id: String,
    pub enabled: bool,
    pub base_url: String,
    pub secret_id: String,
    pub verify_tls: bool,
    pub updated_at: i64,
}

impl Default for TopolographConfig {
    fn default() -> Self {
        Self {
            singleton_id: default_singleton_id(),
            enabled: false,
            base_url: String::new(),
            secret_id: String::new(),
            verify_tls: default_verify_tls(),
            updated_at: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStage {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionReport {
    pub ok: bool,
    pub message: String,
    pub warnings: Vec<String>,
    pub server_name: String,
    pub server_version: String,
    pub latency_ms: Option<f64>,
    pub tools: Vec<String>,
    pub missing_tools: Vec<String>,
    pub unexpected_tools: Vec<String>,
    pub stages: Vec<ConnectionStage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub ok: bool,
    pub message: String,
    pub bytes: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TopolographLsdbUploadRequest {
    pub path: String,
    pub protocol: String,
}

pub type LsdbUploadRequest = TopolographLsdbUploadRequest;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TopolographUploadKind {
    Lsdb,
    Yaml,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TopolographAuditEvent {
    pub id: i64,
    pub occurred_at: i64,
    pub caller_kind: String,
    pub caller_id: String,
    pub action: String,
    pub target_label: String,
    pub outcome: String,
    pub duration_ms: i64,
    pub error_code: String,
}

pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Topolograph base URL is required".into());
    }
    let mut url =
        url::Url::parse(trimmed).map_err(|_| "invalid Topolograph base URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Topolograph base URL must use http or https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Topolograph base URL must not contain credentials".into());
    }
    if url.query().is_some() {
        return Err("Topolograph base URL must not contain a query".into());
    }
    if url.fragment().is_some() {
        return Err("Topolograph base URL must not contain a fragment".into());
    }
    if url.host_str().is_none() {
        return Err("Topolograph base URL must contain a host".into());
    }
    while url.path().len() > 1 && url.path().ends_with('/') {
        let path = url.path().trim_end_matches('/').to_string();
        url.set_path(&path);
    }
    Ok(url.to_string().trim_end_matches('/').to_string())
}

pub fn security_warnings(base_url: &str, verify_tls: bool) -> Vec<String> {
    let Ok(url) = url::Url::parse(base_url) else {
        return Vec::new();
    };
    let mut warnings = Vec::new();
    if url.scheme() == "http" {
        warnings.push("HTTP transport is not encrypted".into());
        if url.host_str().is_some_and(is_private_host) {
            warnings.push("private-network HTTP endpoint is not encrypted".into());
        }
    }
    if !verify_tls {
        warnings.push("TLS certificate verification is disabled".into());
    }
    warnings
}

fn is_private_host(host: &str) -> bool {
    if matches!(host, "localhost" | "localhost.localdomain") || host.ends_with(".local") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local(),
    })
}

pub fn validate_native_upload(path: &Path, kind: TopolographUploadKind) -> Result<Vec<u8>, String> {
    if !path.is_absolute() {
        return Err("Topolograph upload path must be an absolute native-picker path".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "Topolograph upload file must have a supported extension".to_string())?;
    let valid_extension = match kind {
        TopolographUploadKind::Lsdb => matches!(extension.as_str(), "txt" | "log"),
        TopolographUploadKind::Yaml => matches!(extension.as_str(), "yaml" | "yml"),
    };
    if !valid_extension {
        return Err("Topolograph upload file extension is not allowed".into());
    }

    let metadata =
        std::fs::metadata(path).map_err(|e| format!("cannot inspect upload file: {e}"))?;
    if !metadata.is_file() {
        return Err("Topolograph upload path is not a regular file".into());
    }
    if metadata.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "Topolograph upload exceeds {MAX_UPLOAD_BYTES} bytes"
        ));
    }

    let mut file = File::open(path).map_err(|e| format!("cannot open upload file: {e}"))?;
    let mut content = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(MAX_UPLOAD_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|e| format!("cannot read upload file: {e}"))?;
    if content.len() as u64 > MAX_UPLOAD_BYTES {
        return Err(format!(
            "Topolograph upload exceeds {MAX_UPLOAD_BYTES} bytes"
        ));
    }
    if content.iter().all(u8::is_ascii_whitespace) {
        return Err("Topolograph upload file must contain non-empty content".into());
    }
    Ok(content)
}

pub fn clamp_audit_limit(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(MAX_AUDIT_LIST_LIMIT)
        .clamp(1, MAX_AUDIT_LIST_LIMIT)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

pub fn prune_audit(connection: &Connection, now: i64) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM topolograph_audit WHERE occurred_at < ?1",
            params![now - AUDIT_RETENTION_SECONDS],
        )
        .map_err(|e| e.to_string())?;
    connection
        .execute(
            "DELETE FROM topolograph_audit
             WHERE id NOT IN (
                 SELECT id FROM topolograph_audit
                 ORDER BY occurred_at DESC, id DESC LIMIT ?1
             )",
            params![MAX_AUDIT_ROWS],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn insert_audit(
    connection: &Connection,
    action: &str,
    target_label: &str,
    outcome: &str,
    duration_ms: i64,
    error_code: &str,
) -> Result<(), String> {
    let occurred_at = now_secs();
    connection
        .execute(
            "INSERT INTO topolograph_audit
                (occurred_at, caller_kind, caller_id, action, target_label, outcome, duration_ms, error_code)
             VALUES (?1, 'tauri', 'topolograph', ?2, ?3, ?4, ?5, ?6)",
            params![occurred_at, action, target_label, outcome, duration_ms, error_code],
        )
        .map_err(|e| e.to_string())?;
    prune_audit(connection, occurred_at)
}

fn normalize_config(mut config: TopolographConfig) -> Result<TopolographConfig, String> {
    config.singleton_id = TOPOLOGRAPH_SINGLETON_ID.to_string();
    config.base_url = if config.base_url.trim().is_empty() {
        String::new()
    } else {
        normalize_base_url(&config.base_url)?
    };
    config.secret_id = config.secret_id.trim().to_string();
    config.updated_at = now_secs();
    Ok(config)
}

fn normalized_complete_config(config: TopolographConfig) -> Result<TopolographConfig, String> {
    let config = normalize_config(config)?;
    require_enabled_config(&config)?;
    if config.base_url.is_empty() {
        return Err("Topolograph base URL is required".into());
    }
    Ok(config)
}

fn normalized_persisted_config(config: TopolographConfig) -> Result<TopolographConfig, String> {
    let config = normalize_config(config)?;
    if config.enabled {
        require_enabled_config(&config)?;
        if config.base_url.is_empty() {
            return Err("Topolograph base URL is required".into());
        }
    }
    Ok(config)
}

fn read_config(connection: &Connection) -> Result<Option<TopolographConfig>, String> {
    connection
        .query_row(
            "SELECT singleton_id, enabled, base_url, secret_id, verify_tls, updated_at
             FROM topolograph_config WHERE singleton_id = ?1",
            params![TOPOLOGRAPH_SINGLETON_ID],
            |row| {
                Ok(TopolographConfig {
                    singleton_id: row.get(0)?,
                    enabled: row.get::<_, i64>(1)? != 0,
                    base_url: row.get(2)?,
                    secret_id: row.get(3)?,
                    verify_tls: row.get::<_, i64>(4)? != 0,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
}

fn read_selected_token(state: &AppState, secret_id: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    if secret_id.is_empty() {
        return Ok(Zeroizing::new(Vec::new()));
    }
    let connection = state.db.lock();
    state
        .vault
        .store
        .read_secret(&connection, &state.vault.lock, secret_id)
        .map_err(|error| format!("Topolograph Vault secret unavailable: {error}"))
}

fn selected_secret_is_unlocked(state: &AppState, secret_id: &str) -> Result<bool, String> {
    let connection = state.db.lock();
    let envelope_id: Option<String> = connection
        .query_row(
            "SELECT envelope_id FROM vault_secrets WHERE id = ?1",
            params![secret_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Topolograph Vault secret unavailable: {error}"))?;
    let envelope_id = envelope_id.ok_or_else(|| {
        "Topolograph Vault secret unavailable: selected secret not found".to_string()
    })?;
    Ok(state.vault.lock.is_unlocked(&envelope_id))
}

fn read_verified_selected_token(
    state: &AppState,
    secret_id: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    if !selected_secret_is_unlocked(state, secret_id)? {
        return Err("Topolograph Vault secret unavailable: vault is locked".into());
    }
    read_selected_token(state, secret_id)
}

fn selected_token_text(token: &Zeroizing<Vec<u8>>) -> Result<String, String> {
    String::from_utf8(token.to_vec())
        .map_err(|_| "Topolograph Vault token is not valid UTF-8".to_string())
}

fn build_architect_runtime_binding(
    config: &TopolographConfig,
    token: Zeroizing<Vec<u8>>,
) -> Option<Value> {
    let config = normalized_complete_config(config.clone()).ok()?;
    let token = selected_token_text(&token).ok()?;
    if token.trim().is_empty() {
        return None;
    }
    Some(json!({
        "base_url": config.base_url,
        "verify_tls": config.verify_tls,
        "token": token,
    }))
}

fn topolograph_architect_runtime_binding_with<F, G>(
    config: Result<TopolographConfig, String>,
    selected_secret_is_unlocked: F,
    read_token: G,
) -> Option<Value>
where
    F: FnOnce(&str) -> Result<bool, String>,
    G: FnOnce(&str) -> Result<Zeroizing<Vec<u8>>, String>,
{
    let config = normalized_complete_config(config.ok()?).ok()?;
    if !selected_secret_is_unlocked(&config.secret_id).ok()? {
        return None;
    }
    let token = read_token(&config.secret_id).ok()?;
    build_architect_runtime_binding(&config, token)
}

pub(crate) fn topolograph_architect_runtime_binding(state: &AppState) -> Option<Value> {
    topolograph_architect_runtime_binding_with(
        persisted_config(state),
        |secret_id| selected_secret_is_unlocked(state, secret_id),
        |secret_id| read_selected_token(state, secret_id),
    )
}

fn topolograph_direct_params(
    config: &TopolographConfig,
    token: Zeroizing<Vec<u8>>,
) -> Result<Value, String> {
    require_enabled_config(config)?;
    if config.base_url.trim().is_empty() {
        return Err("Topolograph base URL is required".into());
    }
    let token = selected_token_text(&token)?;
    if token.trim().is_empty() {
        return Err("Topolograph Vault token is required".into());
    }
    Ok(json!({
        "base_url": config.base_url,
        "verify_tls": config.verify_tls,
        "token": token,
        "enabled": true,
        "configured": true,
        "unlocked": true,
    }))
}

async fn call_topolograph(
    state: &AppState,
    method: &str,
    params: Value,
) -> Result<crate::agent_bridge::AgentResponse, String> {
    state
        .agent
        .call(method, params)
        .await
        .map_err(|_| "Topolograph sidecar bridge failed".to_string())
}

fn require_enabled_config(config: &TopolographConfig) -> Result<(), String> {
    if !config.enabled {
        return Err("Topolograph connector is disabled".into());
    }
    if config.secret_id.trim().is_empty() {
        return Err("Topolograph Vault secret is required".into());
    }
    Ok(())
}

fn sidecar_error_code(message: &str) -> String {
    message
        .split(':')
        .map(str::trim)
        .find(|code| {
            !code.is_empty()
                && code.chars().all(|character| {
                    character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
                })
        })
        .map(str::to_string)
        .unwrap_or_else(|| "SIDECAR_ERROR".to_string())
}

fn connection_report_from_agent_response(
    response: crate::agent_bridge::AgentResponse,
    mut warnings: Vec<String>,
) -> Result<ConnectionReport, String> {
    match response {
        crate::agent_bridge::AgentResponse::Done { result } => {
            let object = result
                .as_object()
                .ok_or_else(|| "Topolograph sidecar returned an invalid report".to_string())?;
            let ok = object.get("ok").and_then(Value::as_bool).unwrap_or(true);
            let message = object
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    let name = object
                        .get("server_name")
                        .and_then(Value::as_str)
                        .unwrap_or("Topolograph");
                    let version = object
                        .get("server_version")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if version.is_empty() {
                        format!("Connected to {name}")
                    } else {
                        format!("Connected to {name} {version}")
                    }
                });
            if let Some(extra) = object.get("warnings").and_then(Value::as_array) {
                warnings.extend(extra.iter().filter_map(Value::as_str).map(str::to_string));
            }
            let strings = |field: &str| object
                .get(field)
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            Ok(ConnectionReport {
                ok,
                message,
                warnings,
                server_name: object.get("server_name").and_then(Value::as_str).unwrap_or_default().to_string(),
                server_version: object.get("server_version").and_then(Value::as_str).unwrap_or_default().to_string(),
                latency_ms: object.get("latency_ms").and_then(Value::as_f64),
                tools: strings("tools"),
                missing_tools: strings("missing_tools"),
                unexpected_tools: strings("unexpected_tools"),
                stages: object
                    .get("stages")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| {
                                let object = item.as_object()?;
                                let name = object.get("name")?.as_str()?;
                                let status = object.get("status")?.as_str()?;
                                if !matches!(status, "passed" | "failed" | "skipped") {
                                    return None;
                                }
                                Some(ConnectionStage {
                                    name: name.to_string(),
                                    status: status.to_string(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        }
        crate::agent_bridge::AgentResponse::Error { message } => Ok(ConnectionReport {
            ok: false,
            message,
            warnings,
            server_name: String::new(),
            server_version: String::new(),
            latency_ms: None,
            tools: Vec::new(),
            missing_tools: Vec::new(),
            unexpected_tools: Vec::new(),
            stages: Vec::new(),
        }),
        crate::agent_bridge::AgentResponse::Token { .. } => {
            Err("Topolograph sidecar returned an unexpected stream response".to_string())
        }
    }
}

fn upload_result_from_agent_response(
    response: crate::agent_bridge::AgentResponse,
    bytes: u64,
    warnings: Vec<String>,
) -> Result<UploadResult, String> {
    match response {
        crate::agent_bridge::AgentResponse::Done { result } => {
            let object = result.as_object().ok_or_else(|| {
                "Topolograph sidecar returned an invalid upload result".to_string()
            })?;
            let ok = object.get("ok").and_then(Value::as_bool).unwrap_or(true);
            let message = object
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Topolograph upload completed")
                .to_string();
            Ok(UploadResult {
                ok,
                message,
                bytes,
                warnings,
            })
        }
        crate::agent_bridge::AgentResponse::Error { message } => Ok(UploadResult {
            ok: false,
            message,
            bytes,
            warnings,
        }),
        crate::agent_bridge::AgentResponse::Token { .. } => {
            Err("Topolograph sidecar returned an unexpected stream response".to_string())
        }
    }
}

#[tauri::command]
pub fn topolograph_config_get(
    state: State<'_, AppState>,
) -> Result<Option<TopolographConfig>, String> {
    let connection = state.db.lock();
    read_config(&connection)
}

#[tauri::command]
pub fn topolograph_config_save(
    state: State<'_, AppState>,
    config: TopolographConfig,
) -> Result<(), String> {
    let config = normalized_persisted_config(config)?;
    let warnings = security_warnings(&config.base_url, config.verify_tls);
    let connection = state.db.lock();
    connection
        .execute(
            "INSERT OR REPLACE INTO topolograph_config
                (singleton_id, enabled, base_url, secret_id, verify_tls, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                config.singleton_id,
                if config.enabled { 1 } else { 0 },
                config.base_url,
                config.secret_id,
                if config.verify_tls { 1 } else { 0 },
                config.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    insert_audit(
        &connection,
        "config.save",
        "topolograph",
        if warnings.is_empty() { "ok" } else { "warning" },
        0,
        if warnings.is_empty() {
            ""
        } else {
            "transport_warning"
        },
    )
}

#[tauri::command]
pub async fn topolograph_test_connection(
    state: State<'_, AppState>,
    config: TopolographConfig,
) -> Result<ConnectionReport, String> {
    let config = normalized_complete_config(config)?;
    let warnings = security_warnings(&config.base_url, config.verify_tls);
    let token = read_verified_selected_token(&state, &config.secret_id)?;
    let params = topolograph_direct_params(&config, token)?;
    let started = std::time::Instant::now();
    let response = call_topolograph(&state, "topolograph.test_connection", params).await?;
    let report = connection_report_from_agent_response(response, warnings)?;
    let error_code = if report.ok {
        String::new()
    } else {
        sidecar_error_code(&report.message)
    };
    let connection = state.db.lock();
    insert_audit(
        &connection,
        "connection.test",
        "topolograph",
        if report.ok { "ok" } else { "error" },
        started.elapsed().as_millis() as i64,
        &error_code,
    )?;
    Ok(report)
}

fn persisted_config(state: &AppState) -> Result<TopolographConfig, String> {
    let connection = state.db.lock();
    read_config(&connection)?.ok_or_else(|| "Topolograph configuration is not saved".into())
}

fn upload_config_and_token(
    state: &AppState,
) -> Result<(TopolographConfig, Zeroizing<Vec<u8>>), String> {
    let config = persisted_config(state)?;
    let config = normalized_complete_config(config)?;
    let token = read_verified_selected_token(state, &config.secret_id)?;
    Ok((config, token))
}

#[tauri::command]
pub async fn topolograph_upload_lsdb_file(
    state: State<'_, AppState>,
    request: TopolographLsdbUploadRequest,
) -> Result<UploadResult, String> {
    let protocol = request.protocol.trim().to_ascii_lowercase();
    if !matches!(protocol.as_str(), "ospf" | "ospfv3" | "isis") {
        return Err("Topolograph LSDB protocol must be ospf, ospfv3, or isis".into());
    }
    let mut request = request;
    request.protocol = protocol;
    let content = validate_native_upload(Path::new(&request.path), TopolographUploadKind::Lsdb)?;
    let (config, token) = upload_config_and_token(&state)?;
    let mut params = topolograph_direct_params(&config, token)?;
    params["content"] = json!(String::from_utf8(content.clone())
        .map_err(|_| "Topolograph LSDB upload file must be UTF-8 text".to_string())?);
    params["vendor"] = json!("Cisco");
    params["protocol"] = json!(request.protocol);
    let warnings = security_warnings(&config.base_url, config.verify_tls);
    let started = std::time::Instant::now();
    let response = call_topolograph(&state, "topolograph.upload_lsdb", params).await?;
    let result = upload_result_from_agent_response(response, content.len() as u64, warnings)?;
    let error_code = if result.ok {
        String::new()
    } else {
        sidecar_error_code(&result.message)
    };
    let connection = state.db.lock();
    insert_audit(
        &connection,
        "upload.lsdb",
        Path::new(&request.path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("upload"),
        if result.ok { "ok" } else { "error" },
        started.elapsed().as_millis() as i64,
        &error_code,
    )?;
    Ok(result)
}

#[tauri::command]
pub async fn topolograph_upload_yaml_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<UploadResult, String> {
    let content = validate_native_upload(Path::new(&path), TopolographUploadKind::Yaml)?;
    let (config, token) = upload_config_and_token(&state)?;
    let mut params = topolograph_direct_params(&config, token)?;
    params["content"] = json!(String::from_utf8(content.clone())
        .map_err(|_| "Topolograph YAML upload file must be UTF-8 text".to_string())?);
    let warnings = security_warnings(&config.base_url, config.verify_tls);
    let started = std::time::Instant::now();
    let response = call_topolograph(&state, "topolograph.upload_yaml", params).await?;
    let result = upload_result_from_agent_response(response, content.len() as u64, warnings)?;
    let error_code = if result.ok {
        String::new()
    } else {
        sidecar_error_code(&result.message)
    };
    let connection = state.db.lock();
    insert_audit(
        &connection,
        "upload.yaml",
        Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("upload"),
        if result.ok { "ok" } else { "error" },
        started.elapsed().as_millis() as i64,
        &error_code,
    )?;
    Ok(result)
}

#[tauri::command]
pub fn topolograph_audit_list(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<TopolographAuditEvent>, String> {
    let limit = clamp_audit_limit(limit);
    let connection = state.db.lock();
    prune_audit(&connection, now_secs())?;
    let mut statement = connection
        .prepare(
            "SELECT id, occurred_at, caller_kind, caller_id, action, target_label,
                    outcome, duration_ms, error_code
             FROM topolograph_audit
             ORDER BY occurred_at DESC, id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![limit], |row| {
            Ok(TopolographAuditEvent {
                id: row.get(0)?,
                occurred_at: row.get(1)?,
                caller_kind: row.get(2)?,
                caller_id: row.get(3)?,
                action: row.get(4)?,
                target_label: row.get(5)?,
                outcome: row.get(6)?,
                duration_ms: row.get(7)?,
                error_code: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::path::Path;

    #[test]
    fn normalizes_safe_base_urls_and_rejects_url_credential_components() {
        assert_eq!(
            normalize_base_url(" https://topolograph.example/// ").unwrap(),
            "https://topolograph.example"
        );
        for unsafe_url in [
            "https://user:password@topolograph.example",
            "https://topolograph.example?token=secret",
            "https://topolograph.example/#fragment",
            "ftp://topolograph.example",
        ] {
            assert!(normalize_base_url(unsafe_url).is_err(), "{unsafe_url}");
        }
    }

    #[test]
    fn security_warnings_identify_private_http_and_disabled_tls() {
        let warnings = security_warnings("http://10.0.0.20", false);
        assert!(warnings.iter().any(|warning| warning.contains("HTTP")));
        assert!(warnings.iter().any(|warning| warning.contains("TLS")));
    }

    #[test]
    fn validates_nonempty_native_files_by_kind_and_caps_them_at_32_mib() {
        let temp = tempfile::tempdir().unwrap();
        let lsdb = temp.path().join("capture.log");
        std::fs::write(&lsdb, "router ospf output").unwrap();
        assert!(validate_native_upload(&lsdb, TopolographUploadKind::Lsdb).is_ok());
        assert!(validate_native_upload(&lsdb, TopolographUploadKind::Yaml).is_err());

        let empty = temp.path().join("empty.txt");
        std::fs::write(&empty, b"").unwrap();
        assert!(validate_native_upload(&empty, TopolographUploadKind::Lsdb).is_err());

        let oversized = temp.path().join("large.yaml");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_UPLOAD_BYTES + 1).unwrap();
        assert!(validate_native_upload(&oversized, TopolographUploadKind::Yaml).is_err());
        assert!(
            validate_native_upload(Path::new("missing.yaml"), TopolographUploadKind::Yaml).is_err()
        );
    }

    #[test]
    fn rejects_relative_paths_directories_and_disallowed_extensions_at_the_native_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("directory.log");
        std::fs::create_dir(&directory).unwrap();
        let wrong_extension = temp.path().join("capture.csv");
        std::fs::write(&wrong_extension, "router ospf output").unwrap();

        assert!(validate_native_upload(Path::new("capture.log"), TopolographUploadKind::Lsdb).is_err());
        assert!(validate_native_upload(&directory, TopolographUploadKind::Lsdb).is_err());
        assert!(validate_native_upload(&wrong_extension, TopolographUploadKind::Lsdb).is_err());
    }

    #[test]
    fn clamps_audit_listing_to_newest_fifty() {
        assert_eq!(clamp_audit_limit(None), 50);
        assert_eq!(clamp_audit_limit(Some(0)), 1);
        assert_eq!(clamp_audit_limit(Some(500)), 50);
    }

    #[test]
    fn maps_agent_bridge_done_and_error_responses_without_exposing_sensitive_values() {
        let done = crate::agent_bridge::AgentResponse::Done {
            result: serde_json::json!({
                "server_name": "Topolograph MCP",
                "server_version": "1.3.1",
                "latency_ms": 4.2,
                "tools": ["get_all_graphs"],
                "missing_tools": [],
                "unexpected_tools": [],
                "stages": [
                    {"name": "initialize", "status": "passed"},
                    {"name": "tool_inventory", "status": "passed"},
                    {"name": "bounded_probe", "status": "skipped"}
                ]
            }),
        };
        let report = connection_report_from_agent_response(done, Vec::new()).unwrap();
        assert!(report.ok);
        assert!(report.message.contains("Topolograph MCP"));
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            json!({
                "ok": true,
                "message": "Connected to Topolograph MCP 1.3.1",
                "warnings": [],
                "serverName": "Topolograph MCP",
                "serverVersion": "1.3.1",
                "latencyMs": 4.2,
                "tools": ["get_all_graphs"],
                "missingTools": [],
                "unexpectedTools": [],
                "stages": [
                    {"name": "initialize", "status": "passed"},
                    {"name": "tool_inventory", "status": "passed"},
                    {"name": "bounded_probe", "status": "skipped"}
                ]
            })
        );

        let error = crate::agent_bridge::AgentResponse::Error {
            message: "UPSTREAM_RPC_ERROR: Topolograph rejected the MCP request.".into(),
        };
        let failed = connection_report_from_agent_response(error, Vec::new()).unwrap();
        assert!(!failed.ok);
        assert!(failed.message.contains("UPSTREAM_RPC_ERROR"));
        assert!(!failed.message.contains("selected-token"));
        assert!(!failed.message.contains("raw-body"));
    }

    #[test]
    fn allows_disabled_connector_state_to_be_normalized_for_persistence() {
        let saved = normalized_persisted_config(TopolographConfig {
            enabled: false,
            ..TopolographConfig::default()
        })
        .unwrap();

        assert!(!saved.enabled);
        assert!(saved.base_url.is_empty());
        assert!(saved.secret_id.is_empty());
    }

    #[test]
    fn architect_runtime_binding_reads_the_selected_secret_only_after_complete_unlocked_preflight()
    {
        let config = TopolographConfig {
            singleton_id: TOPOLOGRAPH_SINGLETON_ID.to_string(),
            enabled: true,
            base_url: "https://topolograph.example".to_string(),
            secret_id: "selected-secret".to_string(),
            verify_tls: false,
            updated_at: 0,
        };
        let secret_reads = Cell::new(0);

        let binding = topolograph_architect_runtime_binding_with(
            Ok(config),
            |secret_id| {
                assert_eq!(secret_id, "selected-secret");
                Ok(true)
            },
            |secret_id| {
                assert_eq!(secret_id, "selected-secret");
                secret_reads.set(secret_reads.get() + 1);
                Ok(Zeroizing::new(b"selected-token".to_vec()))
            },
        )
        .unwrap();

        assert_eq!(
            binding,
            json!({
                "base_url": "https://topolograph.example",
                "verify_tls": false,
                "token": "selected-token",
            })
        );
        assert_eq!(secret_reads.get(), 1);
    }

    #[test]
    fn architect_runtime_binding_omits_unusable_states_without_reading_a_secret() {
        let usable = TopolographConfig {
            singleton_id: TOPOLOGRAPH_SINGLETON_ID.to_string(),
            enabled: true,
            base_url: "https://topolograph.example".to_string(),
            secret_id: "selected-secret".to_string(),
            verify_tls: true,
            updated_at: 0,
        };
        let cases = [
            (
                "missing persisted configuration",
                Err("not saved".to_string()),
                Ok(true),
                0,
            ),
            (
                "disabled connector",
                Ok(TopolographConfig {
                    enabled: false,
                    ..usable.clone()
                }),
                Ok(true),
                0,
            ),
            (
                "empty base URL",
                Ok(TopolographConfig {
                    base_url: String::new(),
                    ..usable.clone()
                }),
                Ok(true),
                0,
            ),
            (
                "empty selected secret ID",
                Ok(TopolographConfig {
                    secret_id: String::new(),
                    ..usable.clone()
                }),
                Ok(true),
                0,
            ),
            (
                "missing selected secret",
                Ok(usable.clone()),
                Err("secret not found".to_string()),
                1,
            ),
            ("locked vault", Ok(usable), Ok(false), 1),
        ];

        for (state, config, vault_ready, expected_preflights) in cases {
            let preflight_calls = Cell::new(0);
            let secret_reads = Cell::new(0);
            let binding = topolograph_architect_runtime_binding_with(
                config,
                |_| {
                    preflight_calls.set(preflight_calls.get() + 1);
                    vault_ready
                },
                |_| {
                    secret_reads.set(secret_reads.get() + 1);
                    Ok(Zeroizing::new(b"selected-token".to_vec()))
                },
            );

            assert!(binding.is_none(), "{state}");
            assert_eq!(preflight_calls.get(), expected_preflights, "{state}");
            assert_eq!(secret_reads.get(), 0, "{state}");
        }
    }

    #[test]
    fn direct_tauri_params_mark_a_verified_connector_complete_and_unlocked() {
        let config = TopolographConfig {
            singleton_id: TOPOLOGRAPH_SINGLETON_ID.to_string(),
            enabled: true,
            base_url: "https://topolograph.example".to_string(),
            secret_id: "selected-secret".to_string(),
            verify_tls: false,
            updated_at: 0,
        };

        assert_eq!(
            topolograph_direct_params(&config, Zeroizing::new(b"selected-token".to_vec())).unwrap(),
            json!({
                "base_url": "https://topolograph.example",
                "verify_tls": false,
                "token": "selected-token",
                "enabled": true,
                "configured": true,
                "unlocked": true,
            })
        );
    }

    #[test]
    fn migration_defines_only_the_requested_topolograph_boundary_columns() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../migrations/V0089__topolograph.sql"))
            .unwrap();

        let columns = |table: &str| {
            connection
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap()
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            columns("topolograph_config"),
            vec![
                "singleton_id",
                "enabled",
                "base_url",
                "secret_id",
                "verify_tls",
                "updated_at"
            ]
        );
        assert_eq!(
            columns("topolograph_audit"),
            vec![
                "id",
                "occurred_at",
                "caller_kind",
                "caller_id",
                "action",
                "target_label",
                "outcome",
                "duration_ms",
                "error_code"
            ]
        );
    }

    #[test]
    fn audit_retention_prunes_old_rows_then_keeps_newest_five_hundred() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../migrations/V0089__topolograph.sql"))
            .unwrap();
        for id in 0..501_i64 {
            connection
                .execute(
                    "INSERT INTO topolograph_audit (id, occurred_at, caller_kind, caller_id, action, target_label, outcome, duration_ms, error_code)
                     VALUES (?1, ?2, 'test', 'test', 'test', 'test', 'ok', 0, '')",
                    rusqlite::params![id, 2_000 + id],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO topolograph_audit (occurred_at, caller_kind, caller_id, action, target_label, outcome, duration_ms, error_code)
                 VALUES (1, 'test', 'test', 'old', 'old', 'ok', 0, '')",
                [],
            )
            .unwrap();

        prune_audit(&connection, 10_000).unwrap();
        let (count, oldest): (i64, i64) = connection
            .query_row(
                "SELECT COUNT(*), MIN(occurred_at) FROM topolograph_audit",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 500);
        assert_eq!(oldest, 2_001);
    }
}
