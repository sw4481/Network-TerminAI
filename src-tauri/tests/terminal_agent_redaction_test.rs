use ccie_terminal_lib::transcript_export::render_redacted_scrollback;

#[test]
fn redacts_radius_tacacs_and_pre_shared_secrets_before_agent_context() {
    let raw = br#"
radius server ISE-1
 key 0 radius-cleartext
tacacs server TAC-1
 key 7 08314D5D1A48
crypto isakmp key vpn-secret address 192.0.2.1
pre-shared-key local psk-local
preshared-key psk-generic
snmp-server community public RO
radius-server key legacy-radius
tacacs-server key 7 legacy-tacacs
snmp-server host 192.0.2.10 version 2c trap-community
Access-1(config)#snmp-server host 192.0.2.11 traps default-community
Access-1(config)#snmp-server user monitor NMS v3 auth sha-2 256 auth-password priv aes 256 priv-password
Access-1(config-radius-server)#key 0 prompt-radius-secret
"#;

    let redacted = render_redacted_scrollback(raw).unwrap();
    for secret in [
        "radius-cleartext",
        "08314D5D1A48",
        "vpn-secret",
        "psk-local",
        "psk-generic",
        "public",
        "legacy-radius",
        "legacy-tacacs",
        "trap-community",
        "default-community",
        "auth-password",
        "priv-password",
        "prompt-radius-secret",
    ] {
        assert!(!redacted.contains(secret), "secret leaked: {secret}");
    }
    assert!(redacted.contains("radius server ISE-1"));
    assert!(redacted.contains("tacacs server TAC-1"));
}
