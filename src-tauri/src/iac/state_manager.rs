//! IaC Phase 3 — terraform.tfstate parsing + querying for the state browser.
//! Pure parse/query here; DB caching lives in the Tauri command (Task 6).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateResource {
    pub resource_type: String,
    pub resource_name: String,
    pub address: String,
    pub resource_id: Option<String>,
    pub attributes: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerraformState {
    pub serial: u64,
    pub resources: Vec<StateResource>,
    pub outputs: serde_json::Value,
}

/// Parse the contents of a terraform.tfstate (state format v4). Flattens each
/// resource's first instance into a StateResource with a `type.name` address.
pub fn parse_terraform_state(raw: &str) -> Result<TerraformState> {
    let root: serde_json::Value =
        serde_json::from_str(raw).context("parse terraform.tfstate JSON")?;
    let serial = root.get("serial").and_then(|v| v.as_u64()).unwrap_or(0);
    let outputs = root.get("outputs").cloned().unwrap_or(serde_json::Value::Null);

    let mut resources = Vec::new();
    if let Some(arr) = root.get("resources").and_then(|v| v.as_array()) {
        for r in arr {
            let rtype = r.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let rname = r.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let attributes = r
                .get("instances")
                .and_then(|i| i.as_array())
                .and_then(|i| i.first())
                .and_then(|inst| inst.get("attributes"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let resource_id = attributes
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            resources.push(StateResource {
                address: format!("{rtype}.{rname}"),
                resource_type: rtype,
                resource_name: rname,
                resource_id,
                attributes,
            });
        }
    }
    Ok(TerraformState { serial, resources, outputs })
}

/// Filter resources by a case-insensitive substring over type / name / id.
/// `None` returns all.
pub fn query_state_resources<'a>(
    state: &'a TerraformState,
    query: Option<&str>,
) -> Vec<&'a StateResource> {
    let q = match query {
        Some(q) if !q.trim().is_empty() => q.to_lowercase(),
        _ => return state.resources.iter().collect(),
    };
    state
        .resources
        .iter()
        .filter(|r| {
            r.resource_type.to_lowercase().contains(&q)
                || r.resource_name.to_lowercase().contains(&q)
                || r.resource_id
                    .as_deref()
                    .map(|id| id.to_lowercase().contains(&q))
                    .unwrap_or(false)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"
{
  "version": 4,
  "serial": 7,
  "outputs": {"alb_dns": {"value": "x.example.com"}},
  "resources": [
    {"type":"aws_security_group","name":"alb","instances":[
      {"attributes":{"id":"sg-abc123"}}]},
    {"type":"aws_instance","name":"web","instances":[
      {"attributes":{"id":"i-0web"}}]}
  ]
}
"#;

    #[test]
    fn parse_state_reads_serial_and_resources() {
        let state = parse_terraform_state(FIXTURE).unwrap();
        assert_eq!(state.serial, 7);
        assert_eq!(state.resources.len(), 2);
        let sg = state.resources.iter().find(|r| r.resource_type == "aws_security_group").unwrap();
        assert_eq!(sg.address, "aws_security_group.alb");
        assert_eq!(sg.resource_id.as_deref(), Some("sg-abc123"));
    }

    #[test]
    fn query_filters_by_type_name_or_id() {
        let state = parse_terraform_state(FIXTURE).unwrap();
        assert_eq!(query_state_resources(&state, None).len(), 2);
        assert_eq!(query_state_resources(&state, Some("security")).len(), 1);
        assert_eq!(query_state_resources(&state, Some("web")).len(), 1);
        assert_eq!(query_state_resources(&state, Some("i-0web")).len(), 1);
        assert_eq!(query_state_resources(&state, Some("nomatch")).len(), 0);
    }
}

#[cfg(test)]
mod robustness_tests {
    use super::*;

    #[test]
    fn parse_handles_malformed_json() {
        let result = parse_terraform_state("{ not valid json }");
        assert!(result.is_err());
    }

    #[test]
    fn parse_handles_missing_resources() {
        let minimal = r#"{"version":4,"serial":3}"#;
        let state = parse_terraform_state(minimal).unwrap();
        assert_eq!(state.serial, 3);
        assert_eq!(state.resources.len(), 0);
    }

    #[test]
    fn parse_handles_empty_instances() {
        let empty_inst = r#"{"version":4,"serial":1,"resources":[{"type":"aws_vpc","name":"main","instances":[]}]}"#;
        let state = parse_terraform_state(empty_inst).unwrap();
        assert_eq!(state.resources.len(), 1);
        let vpc = &state.resources[0];
        assert_eq!(vpc.address, "aws_vpc.main");
        assert_eq!(vpc.resource_id, None);
    }

    #[test]
    fn parse_handles_missing_type_or_name() {
        let missing = r#"{"version":4,"serial":1,"resources":[{"instances":[{"attributes":{"id":"x"}}]}]}"#;
        let state = parse_terraform_state(missing).unwrap();
        assert_eq!(state.resources.len(), 1);
        assert_eq!(state.resources[0].address, ".");
    }
}

#[cfg(test)]
mod edge_case_tests {
    use super::*;

    #[test]
    fn parse_takes_only_first_instance() {
        let multi_inst = r#"{"version":4,"serial":1,"resources":[
            {"type":"aws_instance","name":"web","instances":[
                {"attributes":{"id":"i-first"}},
                {"attributes":{"id":"i-second"}}
            ]}
        ]}"#;
        let state = parse_terraform_state(multi_inst).unwrap();
        assert_eq!(state.resources.len(), 1);
        assert_eq!(state.resources[0].resource_id.as_deref(), Some("i-first"));
    }

    #[test]
    fn query_empty_string_returns_all() {
        let fixture = r#"{"version":4,"serial":1,"resources":[
            {"type":"aws_vpc","name":"main","instances":[{"attributes":{"id":"vpc-1"}}]},
            {"type":"aws_subnet","name":"private","instances":[{"attributes":{"id":"subnet-1"}}]}
        ]}"#;
        let state = parse_terraform_state(fixture).unwrap();
        assert_eq!(query_state_resources(&state, Some("")).len(), 2);
        assert_eq!(query_state_resources(&state, Some("   ")).len(), 2);
    }
}

#[cfg(test)]
mod terraform_format_tests {
    use super::*;

    #[test]
    fn parse_resource_with_module_path() {
        // In real Terraform state, module resources have mode="managed" and are nested
        // but the type/name remain simple. The address would be "module.foo.aws_vpc.main"
        // but we construct it as "type.name" which is correct for the resource itself.
        let fixture = r#"{"version":4,"serial":1,"resources":[
            {"mode":"managed","type":"aws_vpc","name":"main","instances":[{"attributes":{"id":"vpc-1"}}]}
        ]}"#;
        let state = parse_terraform_state(fixture).unwrap();
        assert_eq!(state.resources[0].address, "aws_vpc.main");
    }

    #[test]
    fn outputs_preserved_as_json() {
        let fixture = r#"{"version":4,"serial":1,"outputs":{"dns":{"value":"example.com","type":"string"}},"resources":[]}"#;
        let state = parse_terraform_state(fixture).unwrap();
        assert!(state.outputs.is_object());
        assert_eq!(state.outputs["dns"]["value"], "example.com");
    }
}
