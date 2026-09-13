use super::{
    call_topolograph, insert_audit, security_warnings, sidecar_error_code,
    topolograph_direct_params, upload_config_and_token, upload_result_from_agent_response,
    AppState, TopolographConfig, UploadResult,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use tauri::State;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TopolographPyatsLsdbImportRequest {
    pub device: String,
    pub protocol: String,
    pub description: Option<String>,
}

impl TopolographPyatsLsdbImportRequest {
    fn validated(mut self) -> Result<Self, String> {
        self.device = self.device.trim().to_string();
        if self.device.is_empty() {
            return Err("Topolograph pyATS device is required".into());
        }
        self.protocol = self.protocol.trim().to_ascii_lowercase();
        if !matches!(self.protocol.as_str(), "ospf" | "ospfv3" | "isis") {
            return Err("Topolograph LSDB protocol must be ospf, ospfv3, or isis".into());
        }
        Ok(self)
    }
}

fn pyats_lsdb_import_params(
    config: &TopolographConfig,
    token: Zeroizing<Vec<u8>>,
    testbed_path: &Path,
    request: &TopolographPyatsLsdbImportRequest,
) -> Result<Value, String> {
    let mut params = topolograph_direct_params(config, token)?;
    params["testbed_path"] = json!(testbed_path.to_string_lossy());
    params["device"] = json!(request.device);
    params["protocol"] = json!(request.protocol);
    params["description"] = json!(request.description);
    Ok(params)
}

fn pyats_lsdb_import_result_from_agent_response(
    response: crate::agent_bridge::AgentResponse,
    warnings: Vec<String>,
) -> Result<UploadResult, String> {
    match response {
        crate::agent_bridge::AgentResponse::Done { result } => {
            let bytes = result.get("bytes").and_then(Value::as_u64).ok_or_else(|| {
                "Topolograph sidecar returned an invalid import result".to_string()
            })?;
            upload_result_from_agent_response(
                crate::agent_bridge::AgentResponse::Done { result },
                bytes,
                warnings,
            )
        }
        crate::agent_bridge::AgentResponse::Error { message } => {
            let code = sidecar_error_code(&message);
            Ok(UploadResult {
                ok: false,
                message: format!("Topolograph LSDB import failed: {code}"),
                bytes: 0,
                warnings,
            })
        }
        crate::agent_bridge::AgentResponse::Token { .. } => {
            Err("Topolograph sidecar returned an unexpected stream response".to_string())
        }
    }
}

fn insert_pyats_lsdb_import_audit(
    connection: &Connection,
    device: &str,
    result: &UploadResult,
    duration_ms: i64,
) -> Result<(), String> {
    let error_code = if result.ok {
        String::new()
    } else {
        sidecar_error_code(&result.message)
    };
    insert_audit(
        connection,
        "import.lsdb.pyats",
        device,
        if result.ok { "ok" } else { "error" },
        duration_ms,
        &error_code,
    )
}

#[tauri::command]
pub async fn topolograph_import_lsdb_from_pyats(
    state: State<'_, AppState>,
    request: TopolographPyatsLsdbImportRequest,
) -> Result<UploadResult, String> {
    let request = request.validated()?;
    let (config, token) = upload_config_and_token(&state)?;
    let testbed_path = crate::pyats::pyats_dir().join("testbed.yaml");
    let params = pyats_lsdb_import_params(&config, token, &testbed_path, &request)?;
    let warnings = security_warnings(&config.base_url, config.verify_tls);
    let started = std::time::Instant::now();
    let response = call_topolograph(&state, "topolograph.import_lsdb_from_pyats", params).await?;
    let result = pyats_lsdb_import_result_from_agent_response(response, warnings)?;
    let connection = state.db.lock();
    insert_pyats_lsdb_import_audit(
        &connection,
        &request.device,
        &result,
        started.elapsed().as_millis() as i64,
    )?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_normalizes_pyats_lsdb_import_requests_before_collection() {
        let request = TopolographPyatsLsdbImportRequest {
            device: "  CORE1  ".into(),
            protocol: " OSPFv3 ".into(),
            description: Some("Core LSDB".into()),
        };

        assert_eq!(
            request.validated().unwrap(),
            TopolographPyatsLsdbImportRequest {
                device: "CORE1".into(),
                protocol: "ospfv3".into(),
                description: Some("Core LSDB".into()),
            }
        );

        for invalid in [
            TopolographPyatsLsdbImportRequest {
                device: "  ".into(),
                protocol: "ospf".into(),
                description: None,
            },
            TopolographPyatsLsdbImportRequest {
                device: "CORE1".into(),
                protocol: "bgp".into(),
                description: None,
            },
        ] {
            assert!(invalid.validated().is_err());
        }

        assert!(
            serde_json::from_value::<TopolographPyatsLsdbImportRequest>(json!({
                "device": "CORE1",
                "protocol": "ospf",
                "description": 42,
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<TopolographPyatsLsdbImportRequest>(json!({
                "device": "CORE1",
                "protocol": "isis",
            }))
            .is_ok()
        );
    }

    #[test]
    fn builds_pyats_import_params_without_raw_lsdb_or_output_fields() {
        let config = TopolographConfig {
            singleton_id: super::super::TOPOLOGRAPH_SINGLETON_ID.to_string(),
            enabled: true,
            base_url: "https://topolograph.example".to_string(),
            secret_id: "selected-secret".to_string(),
            verify_tls: false,
            updated_at: 0,
        };
        let request = TopolographPyatsLsdbImportRequest {
            device: "CORE1".into(),
            protocol: "ospf".into(),
            description: None,
        };

        let params = pyats_lsdb_import_params(
            &config,
            Zeroizing::new(b"selected-token".to_vec()),
            Path::new("/tmp/testbed.yaml"),
            &request,
        )
        .unwrap();

        assert_eq!(
            params,
            json!({
                "base_url": "https://topolograph.example",
                "verify_tls": false,
                "token": "selected-token",
                "enabled": true,
                "configured": true,
                "unlocked": true,
                "testbed_path": "/tmp/testbed.yaml",
                "device": "CORE1",
                "protocol": "ospf",
                "description": null,
            })
        );
        for forbidden in ["content", "output", "raw_lsdb", "raw_output"] {
            assert!(params.get(forbidden).is_none(), "{forbidden}");
        }
    }

    #[test]
    fn parses_bounded_pyats_import_results_without_exposing_extra_sidecar_fields() {
        let response = crate::agent_bridge::AgentResponse::Done {
            result: json!({
                "ok": true,
                "message": "LSDB collected and uploaded.",
                "bytes": 128,
                "warnings": [],
                "raw_output": "RAW-LSDB",
                "token": "selected-token",
            }),
        };

        let result = pyats_lsdb_import_result_from_agent_response(
            response,
            vec!["TLS certificate verification is disabled".into()],
        )
        .unwrap();
        assert_eq!(
            result,
            UploadResult {
                ok: true,
                message: "LSDB collected and uploaded.".into(),
                bytes: 128,
                warnings: vec!["TLS certificate verification is disabled".into()],
            }
        );
        let encoded = serde_json::to_string(&result).unwrap();
        assert!(!encoded.contains("RAW-LSDB"));
        assert!(!encoded.contains("selected-token"));

        let failed = pyats_lsdb_import_result_from_agent_response(
            crate::agent_bridge::AgentResponse::Error {
                message: "UPSTREAM_TIMEOUT: unsafe raw selected-token body".into(),
            },
            Vec::new(),
        )
        .unwrap();
        assert_eq!(
            failed.message,
            "Topolograph LSDB import failed: UPSTREAM_TIMEOUT"
        );
        assert!(!failed.message.contains("selected-token"));
        assert_eq!(failed.bytes, 0);
    }

    #[test]
    fn records_pyats_import_audit_with_device_target_and_bounded_metadata() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../../migrations/V0089__topolograph.sql"))
            .unwrap();
        let result = UploadResult {
            ok: false,
            message: "Topolograph LSDB import failed: UPSTREAM_TIMEOUT".into(),
            bytes: 0,
            warnings: Vec::new(),
        };

        insert_pyats_lsdb_import_audit(&connection, "CORE1", &result, 37).unwrap();

        let event: (String, String, String, i64, String) = connection
            .query_row(
                "SELECT action, target_label, outcome, duration_ms, error_code
                 FROM topolograph_audit",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            event,
            (
                "import.lsdb.pyats".into(),
                "CORE1".into(),
                "error".into(),
                37,
                "UPSTREAM_TIMEOUT".into(),
            )
        );
    }

    #[test]
    fn registers_only_the_dedicated_pyats_lsdb_import_command() {
        let command_table = include_str!("../../lib.rs");
        assert_eq!(
            command_table
                .matches(
                    "commands::topolograph::pyats_import::topolograph_import_lsdb_from_pyats,",
                )
                .count(),
            1
        );
    }
}
