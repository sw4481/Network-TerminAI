//! Milestone A — Topolograph persistence and command boundary.
//!
//! Commands retain the URL/file/audit boundary while calling the dedicated
//! Topolograph methods on the persistent Python sidecar bridge.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::net::IpAddr;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

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
const REDACTED_API_KEY: &str = "[REDACTED]";

fn default_singleton_id() -> String {
    TOPOLOGRAPH_SINGLETON_ID.to_string()
}

fn default_verify_tls() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct TopolographConfig {
    pub singleton_id: String,
    pub enabled: bool,
    pub base_url: String,
    pub api_key: String,
    pub verify_tls: bool,
    pub updated_at: i64,
}

impl fmt::Debug for TopolographConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TopolographConfig")
            .field("singleton_id", &self.singleton_id)
            .field("enabled", &self.enabled)
            .field("base_url", &self.base_url)
            .field("api_key", &REDACTED_API_KEY)
            .field("verify_tls", &self.verify_tls)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

impl Default for TopolographConfig {
    fn default() -> Self {
        Self {
            singleton_id: default_singleton_id(),
            enabled: false,
            base_url: String::new(),
            api_key: String::new(),
            verify_tls: default_verify_tls(),
            updated_at: 0,
        }
    }
}

impl TopolographConfig {
    pub(crate) fn direct_params(&self) -> Result<Value, String> {
        require_enabled_config(self)?;
        let base_url = normalize_base_url(&self.base_url)?;
        Ok(json!({
            "base_url": base_url,
            "verify_tls": self.verify_tls,
            "token": self.api_key.trim(),
            "enabled": true,
            "configured": true,
            "unlocked": true,
        }))
    }

    fn runtime_binding(&self) -> Result<Value, String> {
        let params = self.direct_params()?;
        Ok(json!({
            "base_url": params["base_url"],
            "verify_tls": params["verify_tls"],
            "token": params["token"],
        }))
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
    config.api_key = config.api_key.trim().to_string();
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
            "SELECT singleton_id, enabled, base_url, api_key, verify_tls, updated_at
             FROM topolograph_config WHERE singleton_id = ?1",
            params![TOPOLOGRAPH_SINGLETON_ID],
            |row| {
                Ok(TopolographConfig {
                    singleton_id: row.get(0)?,
                    enabled: row.get::<_, i64>(1)? != 0,
                    base_url: row.get(2)?,
                    api_key: row.get(3)?,
                    verify_tls: row.get::<_, i64>(4)? != 0,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
}

fn topolograph_architect_runtime_binding_with(
    config: Result<TopolographConfig, String>,
) -> Option<Value> {
    config.ok()?.runtime_binding().ok()
}

fn topolograph_dedicated_runtime_binding_with(
    config: Result<TopolographConfig, String>,
) -> Result<Value, String> {
    config?.runtime_binding()
}

pub(crate) fn topolograph_architect_runtime_binding(state: &AppState) -> Option<Value> {
    topolograph_architect_runtime_binding_with(persisted_config(state))
}

pub(crate) fn topolograph_dedicated_runtime_binding(state: &AppState) -> Result<Value, String> {
    topolograph_dedicated_runtime_binding_with(persisted_config(state))
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
    if config.api_key.trim().is_empty() {
        return Err("Topolograph API key is required".into());
    }
    Ok(())
}

fn sanitize_api_key(value: &str, api_key: &str) -> String {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        value.to_string()
    } else {
        value.replace(api_key, REDACTED_API_KEY)
    }
}

fn sanitize_sidecar_value(value: Value, api_key: &str) -> Value {
    match value {
        Value::String(value) => Value::String(sanitize_api_key(&value, api_key)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| sanitize_sidecar_value(value, api_key))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, sanitize_sidecar_value(value, api_key)))
                .collect(),
        ),
        value => value,
    }
}

fn sanitize_warnings(warnings: Vec<String>, api_key: &str) -> Vec<String> {
    warnings
        .into_iter()
        .map(|warning| sanitize_api_key(&warning, api_key))
        .collect()
}

fn sidecar_error_code(message: &str, api_key: &str) -> String {
    let api_key = api_key.trim();
    if !api_key.is_empty() && message.contains(api_key) {
        return "SIDECAR_ERROR".to_string();
    }
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
    warnings: Vec<String>,
    api_key: &str,
) -> Result<ConnectionReport, String> {
    let mut warnings = sanitize_warnings(warnings, api_key);
    match response {
        crate::agent_bridge::AgentResponse::Done { result } => {
            let result = sanitize_sidecar_value(result, api_key);
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
            message: sanitize_api_key(&message, api_key),
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
    api_key: &str,
) -> Result<UploadResult, String> {
    let warnings = sanitize_warnings(warnings, api_key);
    match response {
        crate::agent_bridge::AgentResponse::Done { result } => {
            let result = sanitize_sidecar_value(result, api_key);
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
            message: sanitize_api_key(&message, api_key),
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

fn save_config(
    connection: &Connection,
    config: TopolographConfig,
) -> Result<TopolographConfig, String> {
    let config = normalized_persisted_config(config)?;
    connection
        .execute(
            "INSERT INTO topolograph_config
                (singleton_id, enabled, base_url, api_key, verify_tls, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(singleton_id) DO UPDATE SET
                enabled = excluded.enabled,
                base_url = excluded.base_url,
                api_key = excluded.api_key,
                verify_tls = excluded.verify_tls,
                updated_at = excluded.updated_at",
            params![
                config.singleton_id,
                if config.enabled { 1 } else { 0 },
                config.base_url,
                config.api_key,
                if config.verify_tls { 1 } else { 0 },
                config.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(config)
}

#[tauri::command]
pub fn topolograph_config_save(
    state: State<'_, AppState>,
    config: TopolographConfig,
) -> Result<(), String> {
    let connection = state.db.lock();
    let config = save_config(&connection, config)?;
    let warnings = security_warnings(&config.base_url, config.verify_tls);
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
    let params = config.direct_params()?;
    let started = std::time::Instant::now();
    let response = call_topolograph(&state, "topolograph.test_connection", params).await?;
    let report = connection_report_from_agent_response(response, warnings, &config.api_key)?;
    let error_code = if report.ok {
        String::new()
    } else {
        sidecar_error_code(&report.message, &config.api_key)
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

fn upload_config(state: &AppState) -> Result<TopolographConfig, String> {
    let config = persisted_config(state)?;
    normalized_complete_config(config)
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
    let config = upload_config(&state)?;
    let mut params = config.direct_params()?;
    params["content"] = json!(String::from_utf8(content.clone())
        .map_err(|_| "Topolograph LSDB upload file must be UTF-8 text".to_string())?);
    params["vendor"] = json!("Cisco");
    params["protocol"] = json!(request.protocol);
    let warnings = security_warnings(&config.base_url, config.verify_tls);
    let started = std::time::Instant::now();
    let response = call_topolograph(&state, "topolograph.upload_lsdb", params).await?;
    let result = upload_result_from_agent_response(
        response,
        content.len() as u64,
        warnings,
        &config.api_key,
    )?;
    let error_code = if result.ok {
        String::new()
    } else {
        sidecar_error_code(&result.message, &config.api_key)
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
    let config = upload_config(&state)?;
    let mut params = config.direct_params()?;
    params["content"] = json!(String::from_utf8(content.clone())
        .map_err(|_| "Topolograph YAML upload file must be UTF-8 text".to_string())?);
    let warnings = security_warnings(&config.base_url, config.verify_tls);
    let started = std::time::Instant::now();
    let response = call_topolograph(&state, "topolograph.upload_yaml", params).await?;
    let result = upload_result_from_agent_response(
        response,
        content.len() as u64,
        warnings,
        &config.api_key,
    )?;
    let error_code = if result.ok {
        String::new()
    } else {
        sidecar_error_code(&result.message, &config.api_key)
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
        let report = connection_report_from_agent_response(
            done,
            Vec::new(),
            "synthetic direct token",
        )
        .unwrap();
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
        let failed = connection_report_from_agent_response(
            error,
            Vec::new(),
            "synthetic direct token",
        )
        .unwrap();
        assert!(!failed.ok);
        assert!(failed.message.contains("UPSTREAM_RPC_ERROR"));
        assert!(!failed.message.contains("selected-token"));
        assert!(!failed.message.contains("raw-body"));
    }

    #[test]
    fn connection_reports_redact_a_reflected_api_key_from_all_sidecar_strings() {
        let response = crate::agent_bridge::AgentResponse::Done {
            result: json!({
                "ok": false,
                "message": "connection rejected synthetic direct token",
                "warnings": ["warning synthetic direct token"],
                "server_name": "server synthetic direct token",
                "server_version": "version synthetic direct token",
                "tools": ["tool synthetic direct token"],
                "missing_tools": ["missing synthetic direct token"],
                "unexpected_tools": ["unexpected synthetic direct token"],
                "stages": [{"name": "stage synthetic direct token", "status": "failed"}],
            }),
        };

        let report = connection_report_from_agent_response(
            response,
            Vec::new(),
            "synthetic direct token",
        )
        .unwrap();
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("synthetic direct token"));
        assert!(serialized.contains("[REDACTED]"));

        let failed = connection_report_from_agent_response(
            crate::agent_bridge::AgentResponse::Error {
                message: "UPSTREAM_ERROR: synthetic direct token".into(),
            },
            vec!["warning synthetic direct token".into()],
            "synthetic direct token",
        )
        .unwrap();
        assert!(!serde_json::to_string(&failed)
            .unwrap()
            .contains("synthetic direct token"));
    }

    #[test]
    fn upload_results_redact_a_reflected_api_key_from_messages_warnings_and_errors() {
        let result = upload_result_from_agent_response(
            crate::agent_bridge::AgentResponse::Done {
                result: json!({
                    "ok": true,
                    "message": "uploaded with synthetic direct token",
                }),
            },
            12,
            vec!["warning synthetic direct token".into()],
            "synthetic direct token",
        )
        .unwrap();
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("synthetic direct token"));
        assert!(serialized.contains("[REDACTED]"));

        let failed = upload_result_from_agent_response(
            crate::agent_bridge::AgentResponse::Error {
                message: "UPLOAD_ERROR: synthetic direct token".into(),
            },
            0,
            Vec::new(),
            "synthetic direct token",
        )
        .unwrap();
        assert!(!failed.message.contains("synthetic direct token"));
    }

    #[test]
    fn audit_error_codes_reject_a_configured_key_shaped_like_a_sidecar_code() {
        let audit_shaped_key = "synthetic direct token"
            .to_ascii_uppercase()
            .replace('-', "_");
        assert_eq!(
            sidecar_error_code(&format!("{audit_shaped_key}: rejected"), &audit_shaped_key),
            "SIDECAR_ERROR"
        );
    }

    #[test]
    fn topolograph_config_debug_redacts_the_api_key() {
        let config = TopolographConfig {
            enabled: true,
            base_url: "https://topolograph.example".into(),
            api_key: "synthetic direct token".into(),
            ..TopolographConfig::default()
        };

        let debug = format!("{config:?}");
        assert!(!debug.contains("synthetic direct token"));
        assert!(debug.contains("https://topolograph.example"));
        assert!(debug.contains("[REDACTED]"));
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
        assert!(saved.api_key.is_empty());
    }

    #[test]
    fn migration_and_config_save_preserve_legacy_secret_while_round_tripping_direct_key() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../migrations/V0089__topolograph.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../../migrations/V0090__stp.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!(
                "../../migrations/V0091__topolograph_direct_api_key.sql"
            ))
            .unwrap();

        let columns = connection
            .prepare("PRAGMA table_info(topolograph_config)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            columns,
            vec![
                "singleton_id",
                "enabled",
                "base_url",
                "secret_id",
                "verify_tls",
                "updated_at",
                "api_key",
            ]
        );

        connection
            .execute(
                "INSERT INTO topolograph_config
                    (singleton_id, enabled, base_url, secret_id, verify_tls, updated_at)
                 VALUES (?1, 1, 'https://legacy.example', 'legacy-vault-reference', 1, 1)",
                params![TOPOLOGRAPH_SINGLETON_ID],
            )
            .unwrap();
        save_config(
            &connection,
            TopolographConfig {
                enabled: true,
                base_url: "https://topolograph.example/".into(),
                api_key: "  synthetic direct token  ".into(),
                verify_tls: false,
                ..TopolographConfig::default()
            },
        )
        .unwrap();

        let stored: (String, String) = connection
            .query_row(
                "SELECT secret_id, api_key FROM topolograph_config WHERE singleton_id = ?1",
                params![TOPOLOGRAPH_SINGLETON_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            stored,
            ("legacy-vault-reference".into(), "synthetic direct token".into())
        );

        let loaded = read_config(&connection).unwrap().unwrap();
        assert_eq!(loaded.api_key, "synthetic direct token");
        let serialized = serde_json::to_value(loaded).unwrap();
        assert_eq!(serialized["apiKey"], "synthetic direct token");
        assert!(serialized.get("secretId").is_none());
    }

    #[test]
    fn direct_params_and_runtime_bindings_use_only_the_config_api_key() {
        let config = TopolographConfig {
            singleton_id: TOPOLOGRAPH_SINGLETON_ID.to_string(),
            enabled: true,
            base_url: "https://topolograph.example".to_string(),
            api_key: "synthetic direct token".to_string(),
            verify_tls: false,
            updated_at: 0,
        };

        assert_eq!(
            config.direct_params().unwrap(),
            json!({
                "base_url": "https://topolograph.example",
                "verify_tls": false,
                "token": "synthetic direct token",
                "enabled": true,
                "configured": true,
                "unlocked": true,
            })
        );
        let expected_binding = json!({
            "base_url": "https://topolograph.example",
            "verify_tls": false,
            "token": "synthetic direct token",
        });
        assert_eq!(
            topolograph_dedicated_runtime_binding_with(Ok(config.clone())).unwrap(),
            expected_binding
        );
        assert_eq!(
            topolograph_architect_runtime_binding_with(Ok(config)),
            Some(expected_binding)
        );
    }

    #[test]
    fn direct_operations_reject_an_empty_api_key_before_sidecar_params_exist() {
        let usable = TopolographConfig {
            singleton_id: TOPOLOGRAPH_SINGLETON_ID.to_string(),
            enabled: true,
            base_url: "https://topolograph.example".to_string(),
            api_key: "synthetic direct token".to_string(),
            verify_tls: true,
            updated_at: 0,
        };
        let cases = [
            ("missing persisted configuration", Err("not saved".to_string())),
            (
                "disabled connector",
                Ok(TopolographConfig {
                    enabled: false,
                    ..usable.clone()
                }),
            ),
            (
                "empty base URL",
                Ok(TopolographConfig {
                    base_url: String::new(),
                    ..usable.clone()
                }),
            ),
            (
                "empty API key",
                Ok(TopolographConfig {
                    api_key: String::new(),
                    ..usable.clone()
                }),
            ),
        ];

        for (case, config) in cases {
            assert!(
                topolograph_architect_runtime_binding_with(config).is_none(),
                "{case}"
            );
        }

        assert_eq!(
            TopolographConfig {
                enabled: true,
                base_url: "https://topolograph.example".into(),
                api_key: "   ".into(),
                ..TopolographConfig::default()
            }
            .direct_params()
            .unwrap_err(),
            "Topolograph API key is required"
        );
    }

    #[test]
    fn response_and_audit_serialization_do_not_disclose_the_direct_key() {
        let response = crate::agent_bridge::AgentResponse::Done {
            result: json!({
                "server_name": "Topolograph MCP",
                "server_version": "1.3.1",
                "token": "synthetic direct token",
            }),
        };
        let report = connection_report_from_agent_response(
            response,
            Vec::new(),
            "synthetic direct token",
        )
        .unwrap();
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("synthetic direct token"));

        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../migrations/V0089__topolograph.sql"))
            .unwrap();
        insert_audit(
            &connection,
            "connection.test",
            "topolograph",
            "ok",
            1,
            "",
        )
        .unwrap();
        let audit_text: String = connection
            .query_row(
                "SELECT caller_kind || caller_id || action || target_label || outcome || error_code
                 FROM topolograph_audit",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!audit_text.contains("synthetic direct token"));
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
