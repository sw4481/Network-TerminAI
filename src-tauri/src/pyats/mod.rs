//! pyATS testbed materialization: turn a GUI device inventory into a
//! standard pyATS `testbed.yaml` (with %ENV{} placeholders) + a sibling `.env`
//! holding the secrets. Files are written chmod 600.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PyatsDevice {
    pub name: String,
    pub host: String,
    pub os: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub enable_password: String,
    #[serde(default)]
    pub platform: Option<String>,
}

fn default_port() -> u16 {
    22
}

/// Render the testbed.yaml body (placeholders only — no secrets).
pub fn render_testbed_yaml(devices: &[PyatsDevice]) -> String {
    let mut s = String::from("devices:\n");
    for d in devices {
        let up = d.name.to_uppercase();
        s.push_str(&format!("  {}:\n", d.name));
        s.push_str(&format!("    os: {}\n", d.os));
        if let Some(p) = &d.platform {
            s.push_str(&format!("    platform: {}\n", p));
        }
        s.push_str("    credentials:\n      default:\n");
        s.push_str(&format!("        username: \"%ENV{{{}_USERNAME}}\"\n", up));
        s.push_str(&format!("        password: \"%ENV{{{}_PASSWORD}}\"\n", up));
        s.push_str("      enable:\n");
        s.push_str(&format!("        password: \"%ENV{{{}_ENABLE}}\"\n", up));
        s.push_str("    connections:\n      cli:\n        protocol: ssh\n");
        s.push_str(&format!("        ip: \"%ENV{{{}_IP}}\"\n", up));
        s.push_str(&format!("        port: \"%ENV{{{}_PORT}}\"\n", up));
    }
    s
}

/// Render the .env body (secrets, plaintext — chmod 600 by the writer).
pub fn render_env(devices: &[PyatsDevice]) -> String {
    let mut s = String::new();
    for d in devices {
        let up = d.name.to_uppercase();
        s.push_str(&format!("{}_IP={}\n", up, d.host));
        s.push_str(&format!("{}_PORT={}\n", up, d.port));
        s.push_str(&format!("{}_USERNAME={}\n", up, d.username));
        s.push_str(&format!("{}_PASSWORD={}\n", up, d.password));
        s.push_str(&format!("{}_ENABLE={}\n", up, d.enable_password));
    }
    s
}

/// Directory holding the GUI-managed testbed (`~/.ccie-terminal/pyats`).
pub fn pyats_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".ccie-terminal").join("pyats")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<PyatsDevice> {
        vec![PyatsDevice {
            name: "CORE1".into(),
            host: "10.0.0.1".into(),
            os: "iosxe".into(),
            port: 22,
            username: "admin".into(),
            password: "secret".into(),
            enable_password: "en".into(),
            platform: None,
        }]
    }

    #[test]
    fn testbed_yaml_uses_env_placeholders_not_secrets() {
        let yaml = render_testbed_yaml(&sample());
        assert!(yaml.contains("%ENV{CORE1_IP}"));
        assert!(yaml.contains("os: iosxe"));
        assert!(!yaml.contains("secret")); // no plaintext password in the testbed
    }

    #[test]
    fn env_contains_secrets() {
        let env = render_env(&sample());
        assert!(env.contains("CORE1_IP=10.0.0.1"));
        assert!(env.contains("CORE1_PASSWORD=secret"));
    }
}
