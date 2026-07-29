use ccie_terminal_lib::drift::normalize::{normalize, Vendor};
use std::fs;

#[test]
fn iosxe_drops_volatile_lines_and_redacts_secrets() {
    let raw = fs::read_to_string("tests/fixtures/drift/iosxe_running.txt").unwrap();
    let got = normalize(Vendor::CiscoIosXe, &raw);

    assert!(!got.contains("Building configuration"));
    assert!(!got.contains("Current configuration : 4823 bytes"));
    assert!(!got.contains("Last configuration change"));
    assert!(!got.contains("NVRAM config last updated"));

    // Secrets get the redaction marker, original ciphertext gone
    assert!(got.contains("enable secret 9 <REDACTED>"));
    assert!(got.contains("username admin privilege 15 secret 9 <REDACTED>"));
    assert!(got.contains("username readonly password 7 <REDACTED>"));
    assert!(got.contains("password 7 <REDACTED>"));
    assert!(got.contains("snmp-server community <REDACTED> RO"));
    assert!(got.contains("tacacs-server key 7 <REDACTED>"));

    assert!(!got.contains("$9$abcdef1234567890"));
    assert!(!got.contains("13061E010803"));

    // Intent-bearing lines preserved
    assert!(got.contains("hostname core-01-atl"));
    assert!(got.contains("interface Loopback0"));
    assert!(got.contains("router bgp 65001"));
    assert!(got.contains("ip domain-name example.com"));

    // Bare `!` separators preserved
    assert!(got.lines().any(|l| l == "!"));
}

#[test]
fn nxos_drops_time_banner() {
    let raw = fs::read_to_string("tests/fixtures/drift/nxos_running.txt").unwrap();
    let got = normalize(Vendor::CiscoNxos, &raw);
    assert!(!got.contains("!Time:"));
    assert!(got.contains("hostname dc1-spine-01"));
    assert!(got.contains("snmp-server community <REDACTED>"));
}

#[test]
fn junos_drops_last_commit_and_redacts_keys() {
    let raw = fs::read_to_string("tests/fixtures/drift/junos_running.txt").unwrap();
    let got = normalize(Vendor::JuniperJunos, &raw);
    assert!(!got.contains("Last commit:"));
    assert!(!got.contains("Last changed:"));
    assert!(got.contains(r#"encrypted-password "<REDACTED>""#));
    assert!(got.contains(r#"ssh-rsa "<REDACTED>""#));
    assert!(!got.contains("$6$abcd1234efgh5678"));
    assert!(!got.contains("AAAAB3NzaC1yc2EAAA=="));
    assert!(got.contains("host-name edge-mx-01"));
    assert!(got.contains("description \"WAN UPLINK\""));
}

#[test]
fn collapses_runs_of_blank_lines_to_one() {
    let raw = "hostname a\n\n\n\nhostname b\n";
    let got = normalize(Vendor::CiscoIosXe, raw);
    // Should have at most 1 consecutive blank line; effectively zero between
    // text lines because trailing-whitespace trim makes them empty + collapse.
    let lines: Vec<&str> = got.lines().collect();
    let max_consecutive_blanks = lines.windows(2).fold(0, |mx, w| {
        if w[0].is_empty() && w[1].is_empty() {
            mx + 1
        } else {
            0.max(mx)
        }
    });
    assert!(max_consecutive_blanks == 0, "lines: {:?}", lines);
}

#[test]
fn idempotent_when_run_twice() {
    let raw = fs::read_to_string("tests/fixtures/drift/iosxe_running.txt").unwrap();
    let once = normalize(Vendor::CiscoIosXe, &raw);
    let twice = normalize(Vendor::CiscoIosXe, &once);
    assert_eq!(once, twice, "normalize must be idempotent");
}

#[test]
fn vendor_parse_routing() {
    assert_eq!(
        Vendor::parse("cisco", "iosxe"),
        Vendor::CiscoIosXe
    );
    assert_eq!(Vendor::parse("juniper", "junos"), Vendor::JuniperJunos);
    assert_eq!(Vendor::parse("arista", "eos"), Vendor::AristaEos);
    assert_eq!(Vendor::parse("unknown", "weird"), Vendor::Generic);
}

#[test]
fn generic_passes_through_unchanged() {
    let raw = "anything goes\n   trailing-trimmed   \n";
    let got = normalize(Vendor::Generic, raw);
    assert_eq!(got, "anything goes\n   trailing-trimmed\n");
}
