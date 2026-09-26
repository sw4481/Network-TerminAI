use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    IosXe,
    Nxos,
    Junos,
    Eos,
    Local,
}

impl DeviceKind {
    pub fn as_db_str(self) -> &'static str {
        match self {
            DeviceKind::IosXe => "iosxe",
            DeviceKind::Nxos => "nxos",
            DeviceKind::Junos => "junos",
            DeviceKind::Eos => "eos",
            DeviceKind::Local => "local",
        }
    }

    pub fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "iosxe" => Some(DeviceKind::IosXe),
            "nxos" => Some(DeviceKind::Nxos),
            "junos" => Some(DeviceKind::Junos),
            "eos" => Some(DeviceKind::Eos),
            "local" => Some(DeviceKind::Local),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureSpec {
    pub capture_name: String,
    pub device_kind: DeviceKind,
    pub interface: String,
    pub acl: Option<String>,
    pub duration_s: u32,
    pub buffer_mb: u32,
    pub on_device_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureScript {
    pub setup: Vec<String>,
    pub start: Vec<String>,
    pub poll: Option<String>,
    pub stop: Vec<String>,
    pub cleanup: Vec<String>,
    pub remote_pcap_path: String,
}
