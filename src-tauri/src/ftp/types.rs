use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpConfig {
    pub bind_host: String,
    pub bind_port: u16,
    pub passive_min: u16,
    pub passive_max: u16,
    pub greeting: String,
    pub auto_start: bool,
}

impl Default for FtpConfig {
    fn default() -> Self {
        FtpConfig {
            bind_host: "0.0.0.0".into(),
            bind_port: 2121,
            passive_min: 49152,
            passive_max: 49200,
            greeting: "CCIE Terminal FTP".into(),
            auto_start: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpUser {
    pub id: String,
    pub username: String,
    /// Stored plaintext for MVP (see TODO: hash with argon2).
    pub password: String,
    pub home_dir: String,
    pub read_only: bool,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFtpUserInput {
    pub username: String,
    pub password: String,
    /// If None, the command layer will default to ~/.ccie-terminal/ftp/<username>/
    #[serde(default)]
    pub home_dir: Option<String>,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFtpUserInput {
    pub id: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub home_dir: Option<String>,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpStatus {
    pub running: bool,
    pub bind_address: Option<String>,
    pub started_at: Option<i64>,
    /// Last error message, if the server failed to start or crashed.
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpEvent {
    pub id: i64,
    pub ts: i64,
    pub kind: String,
    pub username: Option<String>,
    pub client_ip: Option<String>,
    pub path: Option<String>,
    pub detail: Option<String>,
}
