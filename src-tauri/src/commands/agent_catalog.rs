use super::AppState;
use crate::agent_bridge::AgentResponse;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiCatalogUpdateResult {
    pub agent_id: String,
    pub catalog_id: String,
    pub job_id: Option<String>,
    pub state: String,
    pub phase: Option<String>,
    pub added: usize,
    pub already_known: usize,
    pub skipped: usize,
    pub warnings: Vec<String>,
    pub source_urls: Vec<String>,
    pub checked_at: Option<String>,
    pub error: Option<String>,
}

fn validate_product(agent_id: &str) -> Result<(), String> {
    match agent_id {
        "stealthwatch" | "ise" | "cml" | "catalyst-center" | "splunk" | "aci" | "fmc"
        | "thousandeyes" | "meraki" | "secure-endpoint" | "cisco-xdr" => Ok(()),
        _ => Err("Select one Cisco product in Settings.".into()),
    }
}

fn decode_result(
    agent_id: &str,
    value: serde_json::Value,
) -> Result<ApiCatalogUpdateResult, String> {
    let result: ApiCatalogUpdateResult = serde_json::from_value(value)
        .map_err(|_| "Invalid API update status from sidecar.".to_string())?;
    if result.agent_id != agent_id
        || result.catalog_id != agent_id.replace('-', "_")
        || !matches!(
            result.state.as_str(),
            "idle" | "running" | "completed" | "failed" | "busy"
        )
    {
        return Err("API update status does not match the selected product.".into());
    }
    Ok(result)
}

async fn call_updater(
    state: &AppState,
    method: &str,
    agent_id: &str,
    job_id: Option<String>,
) -> Result<ApiCatalogUpdateResult, String> {
    validate_product(agent_id)?;
    if job_id.as_ref().is_some_and(|id| id.len() > 128) {
        return Err("Invalid API update job ID.".into());
    }
    let mut params = serde_json::json!({ "agent_id": agent_id });
    if method == "agent.catalog_update_status" {
        params["job_id"] = serde_json::json!(job_id);
    }
    let response = state.agent.call(method, params).await
        .map_err(|_| "Could not contact the API updater. Check this product's status after the sidecar is available.".to_string())?;
    let mut result = match response {
        AgentResponse::Done { result } => decode_result(agent_id, result)?,
        AgentResponse::Error { message } => return Err(message),
        _ => return Err("Unexpected API update response.".into()),
    };
    if result.state == "completed"
        && result.added > 0
        && state.agents_loader.reload_agent(agent_id).is_err()
    {
        result.warnings.push("Catalog saved, but agent metadata could not be reloaded. Restart TerminAI before using additions; the saved catalog was not rolled back.".into());
    }
    Ok(result)
}

#[tauri::command]
pub async fn agent_catalog_update_start(
    state: State<'_, AppState>,
    agent_id: String,
) -> Result<ApiCatalogUpdateResult, String> {
    call_updater(&state, "agent.catalog_update_start", &agent_id, None).await
}

#[tauri::command]
pub async fn agent_catalog_update_status(
    state: State<'_, AppState>,
    agent_id: String,
    job_id: Option<String>,
) -> Result<ApiCatalogUpdateResult, String> {
    call_updater(&state, "agent.catalog_update_status", &agent_id, job_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_individual_cisco_products() {
        for product in [
            "stealthwatch",
            "ise",
            "cml",
            "catalyst-center",
            "splunk",
            "aci",
            "fmc",
            "thousandeyes",
            "meraki",
            "secure-endpoint",
            "cisco-xdr",
        ] {
            assert!(validate_product(product).is_ok());
        }
        for other in [
            "../ise",
            "network-architect",
            "all",
            "catalyst_center",
            "cisco_workflows",
            "https://example.com",
        ] {
            assert!(validate_product(other).is_err());
        }
    }

    #[test]
    fn rejects_another_products_status() {
        let value = serde_json::json!({"agent_id":"splunk", "catalog_id":"splunk", "job_id":null,
            "state":"idle", "phase":null, "added":0, "already_known":0, "skipped":0,
            "warnings":[], "source_urls":[], "checked_at":null, "error":null});
        assert!(decode_result("ise", value.clone()).is_err());
        assert!(decode_result("splunk", value).is_ok());
    }
}
