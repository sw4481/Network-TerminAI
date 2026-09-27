use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TftpConfig {
    pub bind_host: String,
    pub bind_port: u16,
    /// Empty string means "use default_tftp_root()".
    pub root_dir: String,
    pub read_only: bool,
    pub auto_start: bool,
}

impl Default for TftpConfig {
    fn default() -> Self {
        TftpConfig {
            bind_host: "0.0.0.0".into(),
            bind_port: 69,
            root_dir: String::new(),
            read_only: false,
            auto_start: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TftpStatus {
    pub running: bool,
    pub bind_address: Option<String>,
    pub started_at: Option<i64>,
    pub last_error: Option<String>,
    /// True when served by the elevated helper process (port < 1024).
    pub elevated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TftpEvent {
    pub id: i64,
    pub ts: i64,
    pub kind: String,
    pub client_ip: Option<String>,
    pub path: Option<String>,
    pub detail: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_port_69_all_ifaces() {
        let c = TftpConfig::default();
        assert_eq!(c.bind_port, 69);
        assert_eq!(c.bind_host, "0.0.0.0");
        assert!(c.root_dir.is_empty());
        assert!(!c.read_only);
        assert!(!c.auto_start);
    }
}
