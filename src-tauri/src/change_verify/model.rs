use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckBundle {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub vendor: String,
    pub platform: String,
    pub commands: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewCheckBundle {
    pub name: String,
    pub description: Option<String>,
    pub vendor: String,
    pub platform: String,
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSnapshot {
    pub id: String,
    pub tab_id: String,
    pub bundle_id: String,
    pub label: SnapshotLabel,
    pub captured_at: i64,
    pub results: Vec<ChangeSnapshotResult>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotLabel { Pre, Post }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSnapshotResult {
    pub command: String,
    pub parsed_output_id: i64,
}
