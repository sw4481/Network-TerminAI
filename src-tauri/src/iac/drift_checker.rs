//! IaC Phase 3 — read-only drift detection.
//!
//! Runs `terraform plan -detailed-exitcode -json -no-color` (never mutates) and
//! parses `resource_drift` events (changes terraform found OUTSIDE its state —
//! i.e. real drift, as opposed to `planned_change` which is the user's intended
//! change). Exit codes: 0 = no changes, 2 = changes present, 1 = error.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriftedResource {
    pub resource_type: String,
    pub resource_name: String,
    pub address: String,
    pub detected_changes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftResult {
    pub has_drift: bool,
    pub drifted: Vec<DriftedResource>,
}

/// Map a `terraform plan -detailed-exitcode` status into has-drift / error.
/// 0 -> false (clean), 2 -> true (drift), anything else -> Err.
pub fn interpret_exit_code(code: i32) -> Result<bool> {
    match code {
        0 => Ok(false),
        2 => Ok(true),
        other => bail!("terraform plan failed (exit {other})"),
    }
}

/// Pure: extract drifted resources from `terraform plan -json` stdout.
/// Counts only `resource_drift` events. Malformed lines are skipped.
pub fn parse_drift(plan_json: &str) -> Vec<DriftedResource> {
    let mut out = Vec::new();
    for line in plan_json.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let obj: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if obj.get("type").and_then(|t| t.as_str()) != Some("resource_drift") {
            continue;
        }
        let res = obj
            .get("change")
            .and_then(|c| c.get("resource"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let address = res
            .get("addr")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let resource_type = res
            .get("resource_type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let resource_name = res
            .get("resource_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let action = obj
            .get("change")
            .and_then(|c| c.get("action"))
            .and_then(|v| v.as_str())
            .unwrap_or("update")
            .to_string();
        if address.is_empty() {
            continue;
        }
        out.push(DriftedResource {
            resource_type,
            resource_name,
            address,
            detected_changes: format!("drifted ({action})"),
        });
    }
    out
}

/// Run `terraform plan -detailed-exitcode -json -no-color` (read-only) and
/// return the parsed drift. Err on missing terraform or a plan error (exit 1)
/// so the caller can REPORT inability rather than record a false "clean".
pub fn run_drift_plan(project_path: &Path) -> Result<DriftResult> {
    let output = Command::new("terraform")
        .arg("plan")
        .arg("-detailed-exitcode")
        .arg("-json")
        .arg("-no-color")
        .arg("-input=false")
        .current_dir(project_path)
        .output()?;
    let code = output.status.code().unwrap_or(-1);
    let has_drift = interpret_exit_code(code)
        .map_err(|e| anyhow::anyhow!("{e}: {}", String::from_utf8_lossy(&output.stderr).trim()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let drifted = if has_drift {
        parse_drift(&stdout)
    } else {
        Vec::new()
    };
    Ok(DriftResult {
        has_drift: has_drift && !drifted.is_empty(),
        drifted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpret_exit_code_clean_drift_error() {
        assert!(!interpret_exit_code(0).unwrap()); // no drift
        assert!(interpret_exit_code(2).unwrap()); // drift present
        assert!(interpret_exit_code(1).is_err()); // plan error
    }

    #[test]
    fn parse_drift_extracts_resource_drift_events() {
        let plan = r#"
{"type":"resource_drift","change":{"resource":{"addr":"aws_security_group.alb","resource_type":"aws_security_group","resource_name":"alb"},"action":"update"}}
{"type":"planned_change","change":{"resource":{"addr":"aws_instance.web","resource_type":"aws_instance","resource_name":"web"},"action":"update"}}
"#;
        let drifted = parse_drift(plan);
        assert_eq!(drifted.len(), 1);
        assert_eq!(drifted[0].address, "aws_security_group.alb");
        assert_eq!(drifted[0].resource_type, "aws_security_group");
        assert_eq!(drifted[0].resource_name, "alb");
    }

    #[test]
    fn parse_drift_empty_on_clean_or_malformed() {
        assert!(parse_drift("").is_empty());
        assert!(parse_drift("not json\n{also not}").is_empty());
    }
}
