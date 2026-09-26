use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub id: String,
    pub name: String,
    pub description: String,
    pub interval_minutes: u32,
    pub retention_days: u32,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatCheck {
    pub id: String,
    pub heartbeat_id: String,
    pub check_group_name: String,
    pub agent_id: String,
    pub agent_prompt: String,
    pub sort_order: i32,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatExecution {
    pub id: String,
    pub heartbeat_id: String,
    pub status: String,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub overall_severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatFinding {
    pub id: String,
    pub execution_id: String,
    pub check_id: String,
    pub severity: String,
    pub title: String,
    pub message: String,
    pub metadata_json: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatSuggestion {
    pub id: String,
    pub heartbeat_id: String,
    pub suggestion_type: String,
    pub description: String,
    pub proposed_checks_json: String,
    pub created_at: i64,
    pub dismissed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatDetail {
    pub heartbeat: Heartbeat,
    pub checks: Vec<HeartbeatCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckGroup {
    pub id: String,
    pub name: String,
    pub severity: String,
    pub findings: Vec<FindingDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingDetail {
    pub id: String,
    pub severity: String,
    pub title: String,
    pub message: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDetail {
    pub execution: HeartbeatExecution,
    pub check_groups: Vec<CheckGroup>,
}
