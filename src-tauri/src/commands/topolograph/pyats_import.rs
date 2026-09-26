use super::{
    call_topolograph, insert_audit, sanitize_warnings, security_warnings, sidecar_error_code,
    upload_config, upload_result_from_agent_response, AppState, TopolographConfig, UploadResult,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PyatsDeviceSummary {
    pub name: String,
    pub os: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct SavedPyatsTestbed {
    devices: BTreeMap<String, SavedPyatsDevice>,
}

#[derive(Debug, Deserialize)]
struct SavedPyatsDevice {
    os: Option<String>,
}

struct PyatsDeviceCatalog {
    testbed_path: PathBuf,
}

impl PyatsDeviceCatalog {
    fn new(testbed_path: PathBuf) -> Self {
        Self { testbed_path }
    }

    fn supported_devices(&self) -> Result<Vec<PyatsDeviceSummary>, String> {
        let yaml = match std::fs::read_to_string(&self.testbed_path) {
            Ok(yaml) => yaml,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err("Saved pyATS testbed could not be read.".into()),
        };
        let testbed: SavedPyatsTestbed = serde_yaml::from_str(&yaml)
            .map_err(|_| "Saved pyATS testbed is invalid.".to_string())?;
        let mut devices = testbed
            .devices
            .into_iter()
            .filter_map(|(name, device)| {
                let name = name.trim().to_string();
                let os = device.os?.trim().to_ascii_lowercase();
                (!name.is_empty() && matches!(os.as_str(), "iosxe" | "nxos"))
                    .then_some(PyatsDeviceSummary { name, os })
            })
            .collect::<Vec<_>>();
        devices.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(devices)
    }
}

#[tauri::command]
pub fn pyats_list_supported_devices() -> Result<Vec<PyatsDeviceSummary>, String> {
    PyatsDeviceCatalog::new(crate::pyats::pyats_dir().join("testbed.yaml")).supported_devices()
}

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
    testbed_path: &Path,
    request: &TopolographPyatsLsdbImportRequest,
) -> Result<Value, String> {
    let mut params = config.direct_params()?;
    params["testbed_path"] = json!(testbed_path.to_string_lossy());
    params["device"] = json!(request.device);
    params["protocol"] = json!(request.protocol);
    params["description"] = json!(request.description);
    Ok(params)
}

fn pyats_lsdb_import_result_from_agent_response(
    response: crate::agent_bridge::AgentResponse,
    warnings: Vec<String>,
    api_key: &str,
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
                api_key,
            )
        }
        crate::agent_bridge::AgentResponse::Error { message } => {
            let code = sidecar_error_code(&message, api_key);
            Ok(UploadResult {
                ok: false,
                message: format!("Topolograph LSDB import failed: {code}"),
                bytes: 0,
                warnings: sanitize_warnings(warnings, api_key),
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
    api_key: &str,
) -> Result<(), String> {
    let error_code = if result.ok {
        String::new()
    } else {
        sidecar_error_code(&result.message, api_key)
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
    let config = upload_config(&state)?;
    let testbed_path = crate::pyats::pyats_dir().join("testbed.yaml");
    let params = pyats_lsdb_import_params(&config, &testbed_path, &request)?;
    let warnings = security_warnings(&config.base_url, config.verify_tls);
    let started = std::time::Instant::now();
    let response = call_topolograph(&state, "topolograph.import_lsdb_from_pyats", params).await?;
    let result =
        pyats_lsdb_import_result_from_agent_response(response, warnings, &config.api_key)?;
    let connection = state.db.lock();
    insert_pyats_lsdb_import_audit(
        &connection,
        &request.device,
        &result,
        started.elapsed().as_millis() as i64,
        &config.api_key,
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
            api_key: "synthetic direct token".to_string(),
            verify_tls: false,
            updated_at: 0,
        };
        let request = TopolographPyatsLsdbImportRequest {
            device: "CORE1".into(),
            protocol: "ospf".into(),
            description: None,
        };

        let params =
            pyats_lsdb_import_params(&config, Path::new("/tmp/testbed.yaml"), &request).unwrap();

        assert_eq!(
            params,
            json!({
                "base_url": "https://topolograph.example",
                "verify_tls": false,
                "token": "synthetic direct token",
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
            "synthetic direct token",
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
            "synthetic direct token",
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
    fn pyats_results_redact_reflected_api_keys_from_messages_warnings_and_errors() {
        let result = pyats_lsdb_import_result_from_agent_response(
            crate::agent_bridge::AgentResponse::Done {
                result: json!({
                    "ok": true,
                    "message": "imported with synthetic direct token",
                    "bytes": 128,
                }),
            },
            vec!["warning synthetic direct token".into()],
            "synthetic direct token",
        )
        .unwrap();
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("synthetic direct token"));
        assert!(serialized.contains("[REDACTED]"));

        let failed = pyats_lsdb_import_result_from_agent_response(
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
    fn pyats_audit_uses_a_fixed_fallback_when_the_error_code_is_the_api_key() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../../migrations/V0089__topolograph.sql"))
            .unwrap();
        let audit_shaped_key = "synthetic direct token"
            .to_ascii_uppercase()
            .replace('-', "_");
        let result = UploadResult {
            ok: false,
            message: format!("Topolograph LSDB import failed: {audit_shaped_key}"),
            bytes: 0,
            warnings: Vec::new(),
        };

        insert_pyats_lsdb_import_audit(
            &connection,
            "CORE1",
            &result,
            37,
            &audit_shaped_key,
        )
        .unwrap();

        let error_code: String = connection
            .query_row("SELECT error_code FROM topolograph_audit", [], |row| row.get(0))
            .unwrap();
        assert_eq!(error_code, "SIDECAR_ERROR");
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

        insert_pyats_lsdb_import_audit(
            &connection,
            "CORE1",
            &result,
            37,
            "synthetic direct token",
        )
        .unwrap();

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
    fn lists_only_supported_devices_without_exposing_testbed_details() {
        let temp = tempfile::tempdir().unwrap();
        let testbed_path = temp.path().join("testbed.yaml");
        std::fs::write(
            &testbed_path,
            r#"
devices:
  CORE1:
    os: iosxe
    credentials:
      default:
        username: admin
        password: private-password
    connections:
      cli:
        ip: 192.0.2.10
  EDGE1:
    os: NXOS
    custom:
      environment: private-environment
  ROUTER1:
    os: iosxr
"#,
        )
        .unwrap();

        let devices = PyatsDeviceCatalog::new(testbed_path)
            .supported_devices()
            .unwrap();

        assert_eq!(
            devices,
            vec![
                PyatsDeviceSummary {
                    name: "CORE1".into(),
                    os: "iosxe".into(),
                },
                PyatsDeviceSummary {
                    name: "EDGE1".into(),
                    os: "nxos".into(),
                },
            ]
        );
        assert_eq!(
            serde_json::to_value(&devices).unwrap(),
            json!([
                { "name": "CORE1", "os": "iosxe" },
                { "name": "EDGE1", "os": "nxos" },
            ])
        );
        let encoded = serde_json::to_string(&devices).unwrap();
        for forbidden in [
            "192.0.2.10",
            "admin",
            "private-password",
            "private-environment",
            "credentials",
            "connections",
        ] {
            assert!(!encoded.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn returns_safe_catalog_states_for_missing_and_invalid_testbeds() {
        let temp = tempfile::tempdir().unwrap();
        let missing = PyatsDeviceCatalog::new(temp.path().join("missing.yaml"));
        assert_eq!(missing.supported_devices().unwrap(), Vec::new());

        let invalid_path = temp.path().join("invalid.yaml");
        std::fs::write(&invalid_path, "devices: [private-invalid-value").unwrap();
        let error = PyatsDeviceCatalog::new(invalid_path)
            .supported_devices()
            .unwrap_err();
        assert_eq!(error, "Saved pyATS testbed is invalid.");
        assert!(!error.contains("private-invalid-value"));
        assert!(!error.contains(temp.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn registers_only_the_dedicated_pyats_commands() {
        let command_table = include_str!("../../lib.rs");
        assert_eq!(
            command_table
                .matches(
                    "commands::topolograph::pyats_import::topolograph_import_lsdb_from_pyats,",
                )
                .count(),
            1
        );
        assert_eq!(
            command_table
                .matches("commands::topolograph::pyats_import::pyats_list_supported_devices,",)
                .count(),
            1
        );
    }
}
