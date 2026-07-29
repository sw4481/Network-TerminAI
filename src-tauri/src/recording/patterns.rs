//! Builtin redaction patterns.
//!
//! Each tuple is `(pattern_id, regex)`. Capture group 1, when present,
//! marks the bytes to redact (so surrounding context like `enable secret 5 `
//! is preserved for forensic replay). When no capture group is present
//! the entire match is redacted.

pub const BUILTIN: &[(&str, &str)] = &[
    // Cisco enable secret / password in `show run` output
    ("cisco_enable_secret", r"(?i)enable\s+secret\s+\d+\s+(\S+)"),
    ("cisco_username_password", r"(?i)username\s+\S+\s+password\s+\d+\s+(\S+)"),
    ("cisco_type7_password", r"(?i)password\s+7\s+([0-9A-Fa-f]{2,})"),
    // SSH password prompt — marks the prompt; the state machine handles
    // the actual password bytes that follow.
    ("ssh_password_prompt", r"(?im)(password:|passphrase[^:\n]*:)"),
    // SNMP community strings
    ("snmp_community", r"(?i)snmp-server\s+community\s+(\S+)"),
    ("snmp_community_v2", r"(?i)community\s+(\S+)\s+(?:RO|RW)"),
    // Bearer tokens & API keys
    ("bearer_token", r"(?i)bearer\s+([A-Za-z0-9._\-]+)"),
    ("authorization_header", r"(?i)authorization:\s*(\S+)"),
    ("aws_access_key", r"AKIA[0-9A-Z]{16}"),
    ("generic_api_key", r#"(?i)api[_\-]?key["'\s:=]+([A-Za-z0-9_\-]{16,})"#),
    // NETCONF password in XML
    ("netconf_password_xml", r"(?i)<password[^>]*>([^<]+)</password>"),
];
