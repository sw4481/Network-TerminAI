use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Ssh,
    Netconf,
}

impl DeviceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            DeviceKind::Ssh => "ssh",
            DeviceKind::Netconf => "netconf",
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "ssh" => Ok(DeviceKind::Ssh),
            "netconf" => Ok(DeviceKind::Netconf),
            other => Err(format!("unknown device_kind {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FanoutGroup {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub member_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FanoutMember {
    pub device_id: String,
    pub device_kind: DeviceKind,
    pub display_name: String,
    pub host: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FanoutRunSummary {
    pub id: String,
    pub group_id: Option<String>,
    pub command: String,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceResultRow {
    pub device_id: String,
    pub device_kind: DeviceKind,
    pub display_name: String,
    pub status: String,
    pub error: Option<String>,
    pub block_id: Option<String>,
    pub parsed_output_id: Option<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub attempt_number: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FanoutRunDetail {
    pub summary: FanoutRunSummary,
    pub devices: Vec<DeviceResultRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvImportResult {
    pub added: usize,
    pub warnings: Vec<String>,
}
