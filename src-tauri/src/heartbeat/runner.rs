use crate::agent_bridge::AgentBridge;
use crate::heartbeat::repo::HeartbeatRepo;
use crate::heartbeat::types::*;
use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::Connection;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone)]
pub struct ExecutionResult {
    pub execution_id: String,
    pub status: String,
    pub severity: String,
    pub summary: String,
    pub heartbeat_name: String,
}

#[derive(Debug, Clone)]
struct Finding {
    severity: String,
    title: String,
    message: String,
    metadata_json: String,
}

pub async fn run_heartbeat(
    db: Arc<Mutex<Connection>>,
    agent_bridge: AgentBridge,
    heartbeat_id: &str,
) -> Result<ExecutionResult> {
    let started_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;

    // Load heartbeat and checks
    let (heartbeat, checks) = {
        let conn = db.lock();
        let detail = HeartbeatRepo::get_heartbeat_with_checks(&conn, heartbeat_id)?
            .ok_or_else(|| anyhow::anyhow!("heartbeat not found"))?;
        (detail.heartbeat, detail.checks)
    };

    // Create execution record
    let execution_id = {
        let conn = db.lock();
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO heartbeat_executions (id, heartbeat_id, status, started_at, overall_severity)
             VALUES (?1, ?2, 'running', ?3, 'info')",
            rusqlite::params![&id, heartbeat_id, started_at],
        )?;
        id
    };

    // Group checks by check_group_name to execute in parallel
    let mut check_groups: HashMap<String, Vec<HeartbeatCheck>> = HashMap::new();
    for check in checks {
        check_groups
            .entry(check.check_group_name.clone())
            .or_default()
            .push(check);
    }

    // Execute all check groups (for now, sequentially - can parallelize later)
    let mut all_findings: Vec<(String, Result<Vec<Finding>>)> = Vec::new();
    for (_group_name, group_checks) in check_groups {
        let results = execute_check_group(&agent_bridge, group_checks).await;
        all_findings.extend(results);
    }

    // Store findings and compute overall status/severity
    let mut overall_severity = "ok".to_string();
    let mut has_errors = false;

    for (check_id, result) in &all_findings {
        match result {
            Ok(findings) => {
                for finding in findings {
                    // Store finding in database
                    let finding_id = uuid::Uuid::new_v4().to_string();
                    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
                    let conn = db.lock();
                    conn.execute(
                        "INSERT INTO heartbeat_findings (id, execution_id, check_id, severity, title, message, metadata_json, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        rusqlite::params![
                            &finding_id,
                            &execution_id,
                            check_id,
                            &finding.severity,
                            &finding.title,
                            &finding.message,
                            &finding.metadata_json,
                            now
                        ],
                    )?;

                    // Update overall severity
                    overall_severity = max_severity(&overall_severity, &finding.severity);
                }
            }
            Err(e) => {
                has_errors = true;
                overall_severity = max_severity(&overall_severity, "error");

                // Persist an error finding so the user sees WHAT failed instead
                // of an empty "completed_with_errors" run. Previously errors
                // (including the 300s timeout) updated severity but wrote no
                // finding, leaving the execution detail blank.
                let finding_id = uuid::Uuid::new_v4().to_string();
                let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
                let conn = db.lock();
                conn.execute(
                    "INSERT INTO heartbeat_findings (id, execution_id, check_id, severity, title, message, metadata_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![
                        &finding_id,
                        &execution_id,
                        check_id,
                        "error",
                        "Check failed",
                        &format!("{}", e),
                        "{}",
                        now
                    ],
                )?;
            }
        }
    }

    // Determine final status
    let status = if has_errors {
        "completed_with_errors"
    } else {
        "completed"
    };

    // Update execution record
    let completed_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
    let duration_ms = (completed_at - started_at) * 1000;

    {
        let conn = db.lock();
        conn.execute(
            "UPDATE heartbeat_executions SET status = ?1, completed_at = ?2, duration_ms = ?3, overall_severity = ?4 WHERE id = ?5",
            rusqlite::params![status, completed_at, duration_ms, overall_severity, &execution_id],
        )?;
    }

    let total_checks = all_findings.len();
    let failed_checks = all_findings.iter().filter(|(_, r)| r.is_err()).count();
    let summary = if failed_checks > 0 {
        format!(
            "{}/{} checks completed",
            total_checks - failed_checks,
            total_checks
        )
    } else {
        format!("{} checks completed", total_checks)
    };

    Ok(ExecutionResult {
        execution_id,
        status: status.to_string(),
        severity: overall_severity.to_string(),
        summary,
        heartbeat_name: heartbeat.name,
    })
}

async fn execute_check_group(
    agent_bridge: &AgentBridge,
    checks: Vec<HeartbeatCheck>,
) -> Vec<(String, Result<Vec<Finding>>)> {
    let mut results = Vec::new();

    for check in checks {
        // Must sit ABOVE the Python AGENT_TIMEOUT_SECONDS (540s in
        // heartbeat_executor.py) so the sidecar returns its own clean "timeout"
        // finding first, and BELOW the bridge idle guard (720s in bridge.rs).
        // Measured: a full org-wide check is ~8 LLM steps at 40-70s each on
        // hosted gpt-oss-120b, reaching the grader at ~312s; 300s killed it.
        let result = timeout(
            Duration::from_secs(600), // 10 minutes — above Python's 540s cap
            execute_single_check(agent_bridge, &check),
        )
        .await;

        let findings = match result {
            Ok(Ok(findings)) => Ok(findings),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(anyhow::anyhow!("Check timed out after 10 minutes")),
        };

        results.push((check.id, findings));
    }

    results
}

async fn execute_single_check(
    agent_bridge: &AgentBridge,
    check: &HeartbeatCheck,
) -> Result<Vec<Finding>> {
    // Call the agent with the check's prompt. We use a simple agent.call for
    // heartbeat checks (not the full react_loop) to get a structured response
    // with findings. The sidecar's heartbeat handler parses the agent's output
    // and returns { "findings": [{ "severity", "title", "message", "metadata" }] }.
    let params = json!({
        "agent_id": &check.agent_id,
        "prompt": &check.agent_prompt,
        "check_id": &check.id,
    });

    match agent_bridge.call("heartbeat.execute_check", params).await {
        Ok(crate::agent_bridge::AgentResponse::Done { result }) => {
            // Parse findings from agent response
            let findings = result
                .get("findings")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|f| {
                            Some(Finding {
                                severity: f.get("severity")?.as_str()?.to_string(),
                                title: f.get("title")?.as_str()?.to_string(),
                                message: f.get("message")?.as_str()?.to_string(),
                                metadata_json: f
                                    .get("metadata")
                                    .map(|m| {
                                        serde_json::to_string(m)
                                            .unwrap_or_else(|_| "{}".to_string())
                                    })
                                    .unwrap_or_else(|| "{}".to_string()),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            // If the agent returned no findings, treat it as an "ok" result
            if findings.is_empty() {
                Ok(vec![Finding {
                    severity: "ok".to_string(),
                    title: format!("Check {} completed", check.check_group_name),
                    message: "No issues detected".to_string(),
                    metadata_json: "{}".to_string(),
                }])
            } else {
                Ok(findings)
            }
        }
        Ok(crate::agent_bridge::AgentResponse::Error { message }) => {
            // Agent returned an error - treat as failed check
            Err(anyhow::anyhow!("Agent error: {}", message))
        }
        Err(e) => {
            // Infrastructure error (sidecar down, etc.)
            Err(e.context("Agent call failed"))
        }
        _ => Err(anyhow::anyhow!("Unexpected agent response type")),
    }
}

fn max_severity(a: &str, b: &str) -> String {
    let order = ["critical", "error", "warning", "info", "ok"];
    let a_idx = order.iter().position(|&s| s == a).unwrap_or(999);
    let b_idx = order.iter().position(|&s| s == b).unwrap_or(999);
    if a_idx <= b_idx {
        a.to_string()
    } else {
        b.to_string()
    }
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
