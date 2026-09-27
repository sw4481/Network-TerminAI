//! Parsing real NETCONF hello messages from Cisco IOS-XE devices.

use ccie_terminal_lib::netconf_runner::hello;

/// Abbreviated but structurally realistic IOS-XE hello.
const IOSXE_HELLO: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <capabilities>
    <capability>urn:ietf:params:netconf:base:1.0</capability>
    <capability>urn:ietf:params:netconf:base:1.1</capability>
    <capability>urn:ietf:params:netconf:capability:writable-running:1.0</capability>
    <capability>urn:ietf:params:netconf:capability:candidate:1.0</capability>
  </capabilities>
  <session-id>42</session-id>
</hello>"#;

#[test]
fn parse_extracts_session_id_and_capabilities() {
    let parsed = hello::parse(IOSXE_HELLO).unwrap();
    assert_eq!(parsed.session_id, 42);
    assert!(parsed
        .capabilities
        .iter()
        .any(|c| c == "urn:ietf:params:netconf:base:1.0"));
    assert!(parsed
        .capabilities
        .iter()
        .any(|c| c == "urn:ietf:params:netconf:base:1.1"));
    assert_eq!(parsed.capabilities.len(), 4);
}

#[test]
fn chooses_1_1_when_both_advertised() {
    let parsed = hello::parse(IOSXE_HELLO).unwrap();
    assert_eq!(parsed.framing(), hello::Framing::Chunked);
}

#[test]
fn falls_back_to_1_0_when_only_base_advertised() {
    let only_10 = r#"<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
      <capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities>
      <session-id>7</session-id></hello>"#;
    let parsed = hello::parse(only_10).unwrap();
    assert_eq!(parsed.framing(), hello::Framing::EndOfMessage);
}

#[test]
fn errors_on_missing_session_id() {
    let bad = r#"<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
      <capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities>
      </hello>"#;
    let err = hello::parse(bad).unwrap_err();
    assert!(format!("{err}").contains("session-id"), "got {err}");
}

#[test]
fn build_our_hello_advertises_both_base_versions() {
    let xml = hello::build_client_hello();
    assert!(xml.contains("urn:ietf:params:netconf:base:1.0"));
    assert!(xml.contains("urn:ietf:params:netconf:base:1.1"));
    assert!(xml.starts_with("<?xml"));
    assert!(xml.contains("<hello"));
}
