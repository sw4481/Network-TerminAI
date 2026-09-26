use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum IaCTool {
    Terraform,
    Ansible,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IaCCommand {
    pub tool: IaCTool,
    pub subcommand: String,
    pub flags: Vec<String>,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
    pub is_mutating: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResourceAction {
    Create,
    Update,
    Destroy,
    Ok,
    Changed,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEvent {
    pub resource_type: String,
    pub resource_name: String,
    pub resource_id: Option<String>,
    pub action: ResourceAction,
    pub timestamp: u64,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IaCMetadata {
    pub resources_changed: u32,
    pub resources_failed: u32,
    pub resource_events: Vec<ResourceEvent>,
    pub summary: String,
}
