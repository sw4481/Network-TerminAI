//! Pure CLI-to-XML wrapper for Cisco devices.
//!
//! Cisco IOS-XE and NX-OS support wrapping CLI commands inside NETCONF `<rpc>`
//! payloads via proprietary XML envelopes. This module provides the wrapping
//! logic without any I/O — the caller handles sending the wrapped XML.
//!
//! ## IOS-XE
//!
//! IOS-XE config commands use the `Cisco-IOS-XE-cli-rpc` module's
//! `config-ios-cli-rpc` RPC. This is the same mechanism Cisco YANG Suite uses
//! and is verified working on IOS-XE 17.x (ConfD-based NETCONF). The CLI text
//! goes verbatim inside `<config-clis>`:
//! ```xml
//! <rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="101">
//!   <config-ios-cli-rpc xmlns="http://cisco.com/ns/yang/Cisco-IOS-XE-cli-rpc">
//!     <config-clis>
//! interface Loopback99
//!  description test
//!     </config-clis>
//!   </config-ios-cli-rpc>
//! </rpc>
//! ```
//!
//! NOTE: This RPC is **config-only**. Modern IOS-XE NETCONF does not expose a
//! generic `show`/exec-over-NETCONF RPC, so operational commands (e.g.
//! `show version`) must be run over SSH, not here.
//!
//! ## NX-OS
//!
//! All commands use `<nxos:exec-command>` or `<nxos:conf-command>`:
//! ```xml
//! <rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="103">
//!   <nxos:exec-command xmlns:nxos="http://www.cisco.com/nxos:1.0">
//!     <nxos:cmd>show version</nxos:cmd>
//!   </nxos:exec-command>
//! </rpc>
//! ```

use crate::netconf_runner::error::{NetconfError, Result};

/// Target platform for CLI wrapping. Determines the XML envelope format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    IosXe,
    NxOs,
}

/// Wrap CLI text into NETCONF RPC content for the given platform.
///
/// Returns the RPC **inner content** (not wrapped in `<rpc>` tags). The session
/// layer adds the `<rpc>` wrapper with auto-incremented `message-id`.
///
/// # Heuristics
///
/// - If `cli_text` starts with `show `, `display `, `ping `, etc. → exec mode.
/// - Otherwise → config mode.
///
/// IOS-XE config commands wrap with `config-ios-cli-rpc`; NX-OS uses
/// `<conf-command>`. IOS-XE exec/show commands are rejected because modern
/// IOS-XE NETCONF has no generic show-over-NETCONF RPC (use SSH instead).
pub fn wrap(platform: Platform, cli_text: &str) -> Result<String> {
    if cli_text.trim().is_empty() {
        return Err(NetconfError::Rpc("CLI text is empty".to_string()));
    }

    let trimmed = cli_text.trim();
    let is_exec = is_exec_command(trimmed);

    match platform {
        Platform::IosXe => wrap_iosxe(trimmed, is_exec),
        Platform::NxOs => wrap_nxos(trimmed, is_exec),
    }
}

fn is_exec_command(cli: &str) -> bool {
    let lower = cli.to_lowercase();
    lower.starts_with("show ")
        || lower.starts_with("display ")
        || lower.starts_with("ping ")
        || lower.starts_with("traceroute ")
        || lower.starts_with("telnet ")
        || lower.starts_with("ssh ")
        || lower.starts_with("debug ")
        || lower.starts_with("undebug ")
}

fn wrap_iosxe(cli: &str, is_exec: bool) -> Result<String> {
    if is_exec {
        // Modern IOS-XE NETCONF (ConfD) exposes no generic show/exec-over-NETCONF
        // RPC. Reject with a clear, actionable message instead of sending a
        // payload the device will refuse with an opaque "unknown-element".
        return Err(NetconfError::Rpc(
            "IOS-XE does not support show/exec commands over NETCONF. \
             Run operational commands (show, ping, etc.) over SSH instead. \
             Only configuration commands work here."
                .to_string(),
        ));
    }
    // Config commands: use the Cisco-IOS-XE-cli-rpc module's config-ios-cli-rpc.
    // This is the format Cisco YANG Suite uses; verified on IOS-XE 17.x.
    // The CLI text is placed verbatim inside <config-clis>.
    Ok(format!(
        r#"<config-ios-cli-rpc xmlns="http://cisco.com/ns/yang/Cisco-IOS-XE-cli-rpc">
  <config-clis>
{}
  </config-clis>
</config-ios-cli-rpc>"#,
        escape_xml(cli)
    ))
}

fn wrap_nxos(cli: &str, is_exec: bool) -> Result<String> {
    if is_exec {
        Ok(format!(
            r#"<exec-command xmlns="http://www.cisco.com/nxos:1.0">
  <cmd>{}</cmd>
</exec-command>"#,
            escape_xml(cli)
        ))
    } else {
        Ok(format!(
            r#"<conf-command xmlns="http://www.cisco.com/nxos:1.0">
  <cmd>{}</cmd>
</conf-command>"#,
            escape_xml(cli)
        ))
    }
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_iosxe_show_command_rejected() {
        // Modern IOS-XE NETCONF has no show/exec RPC — wrap must reject with a
        // clear message pointing the user at SSH.
        let result = wrap(Platform::IosXe, "show version");
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("SSH"));
        assert!(msg.to_lowercase().contains("not support"));
    }

    #[test]
    fn test_iosxe_config_command() {
        let result = wrap(Platform::IosXe, "interface Loopback99\ndescription test").unwrap();
        assert!(result.contains("<config-ios-cli-rpc"));
        assert!(result.contains("xmlns=\"http://cisco.com/ns/yang/Cisco-IOS-XE-cli-rpc\""));
        assert!(result.contains("<config-clis>"));
        assert!(result.contains("interface Loopback99"));
        assert!(result.contains("description test"));
        assert!(!result.contains("<rpc")); // No <rpc> wrapper
    }

    #[test]
    fn test_nxos_show_command() {
        let result = wrap(Platform::NxOs, "show version").unwrap();
        assert!(result.contains("<exec-command"));
        assert!(result.contains("<cmd>show version</cmd>"));
        assert!(!result.contains("<rpc")); // No <rpc> wrapper
    }

    #[test]
    fn test_nxos_config_command() {
        let result = wrap(Platform::NxOs, "interface loopback 99\ndescription test").unwrap();
        assert!(result.contains("<conf-command"));
        assert!(result.contains("<cmd>interface loopback 99"));
        assert!(!result.contains("<rpc")); // No <rpc> wrapper
    }

    #[test]
    fn test_empty_cli() {
        let result = wrap(Platform::IosXe, "   ");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("empty"));
    }

    #[test]
    fn test_xml_escaping() {
        // Use a config command (banner) that legitimately contains XML-special chars.
        let result = wrap(Platform::IosXe, "banner motd #<test>#").unwrap();
        assert!(result.contains("&lt;test&gt;"));
        assert!(!result.contains("<test>"));
    }

    #[test]
    fn test_heuristic_show() {
        assert!(is_exec_command("show version"));
        assert!(is_exec_command("Show Version"));
        assert!(is_exec_command("SHOW VERSION"));
    }

    #[test]
    fn test_heuristic_config() {
        assert!(!is_exec_command("interface Loopback99"));
        assert!(!is_exec_command("hostname test"));
        assert!(!is_exec_command("no ip domain-lookup"));
    }

    #[test]
    fn test_multiline_config() {
        let cli = "interface Loopback99\n description test\n ip address 1.1.1.1 255.255.255.255";
        let result = wrap(Platform::IosXe, cli).unwrap();
        assert!(result.contains("<config-ios-cli-rpc"));
        assert!(result.contains("<config-clis>"));
        assert!(result.contains("interface Loopback99"));
        assert!(result.contains("description test"));
        assert!(result.contains("ip address 1.1.1.1 255.255.255.255"));
    }
}
