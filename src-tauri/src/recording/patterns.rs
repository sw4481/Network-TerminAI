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
    (
        "snmp_trap_host_community",
        r"(?i)snmp-server\s+host\s+\S+\s+(?:traps\s+|informs\s+)?version\s+(?:1|2c)\s+(\S+)",
    ),
    (
        "snmp_default_trap_host_community",
        r"(?i)snmp-server\s+host\s+\S+\s+(?:traps\s+|informs\s+)?(\S+)",
    ),
    (
        "snmpv3_auth_password",
        r"(?i)snmp-server\s+user\s+\S+\s+\S+[^\r\n]*?\sauth\s+\S+(?:\s+(?:128|192|224|256|384|512))?\s+(\S+)",
    ),
    (
        "snmpv3_priv_password",
        r"(?i)snmp-server\s+user\s+\S+\s+\S+[^\r\n]*?\spriv\s+\S+(?:\s+(?:128|192|256))?\s+(\S+)",
    ),
    // Network AAA and tunnel shared secrets. These patterns protect both
    // exported scrollback and the terminal context handed to agents.
    ("aaa_indented_key", r"(?im)^\s*key\s+(?:(?:0|7)\s+)?(\S+)"),
    (
        "prompt_prefixed_hierarchical_key",
        r"(?im)^[^\r\n]*[>#]\s*key\s+(?:(?:0|7)\s+)?(\S+)",
    ),
    (
        "legacy_radius_server_key",
        r"(?i)radius-server\s+key\s+(?:(?:0|7)\s+)?(\S+)",
    ),
    (
        "legacy_tacacs_server_key",
        r"(?i)tacacs-server\s+key\s+(?:(?:0|7)\s+)?(\S+)",
    ),
    ("isakmp_pre_shared_key", r"(?i)crypto\s+isakmp\s+key\s+(\S+)"),
    (
        "named_pre_shared_key",
        r"(?i)(?:pre-shared-key|preshared-key)\s+(?:local|remote)\s+(\S+)",
    ),
    ("generic_pre_shared_key", r"(?i)(?:pre-shared-key|preshared-key)\s+(\S+)"),
    // Bearer tokens & API keys
    ("bearer_token", r"(?i)bearer\s+([A-Za-z0-9._\-]+)"),
    ("authorization_header", r"(?i)authorization:\s*(\S+)"),
    ("aws_access_key", r"AKIA[0-9A-Z]{16}"),
    ("generic_api_key", r#"(?i)api[_\-]?key["'\s:=]+([A-Za-z0-9_\-]{16,})"#),
    // NETCONF password in XML
    ("netconf_password_xml", r"(?i)<password[^>]*>([^<]+)</password>"),
];
