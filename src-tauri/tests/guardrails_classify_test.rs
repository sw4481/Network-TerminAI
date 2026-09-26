use ccie_terminal_lib::guardrails::classifier::{classify, Tier};
use ccie_terminal_lib::guardrails::rules::RuleSet;

fn load_builtin() -> RuleSet {
    RuleSet::load_builtin().expect("builtin rules load")
}

#[test]
fn builtin_ruleset_loads_at_least_200_rules() {
    let rs = load_builtin();
    assert!(
        rs.len() >= 200,
        "builtin ruleset should have >= 200 rules, found {}",
        rs.len()
    );
}

#[test]
fn iosxe_show_version_is_tier0() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "show version");
    assert_eq!(d.tier, Tier::T0);
    assert!(d.rule_id.is_some(), "must match a builtin T0 rule");
}

#[test]
fn iosxe_reload_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "reload");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn iosxe_write_erase_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "write erase");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn iosxe_no_router_bgp_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "no router bgp 65000");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn iosxe_interface_shutdown_is_tier2() {
    let rs = load_builtin();
    let d = classify(
        &rs,
        "cisco",
        "iosxe",
        "interface GigabitEthernet0/1\n shutdown",
    );
    assert_eq!(d.tier, Tier::T2);
}

#[test]
fn nxos_clear_ip_bgp_soft_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "nxos", "clear ip bgp * soft out");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn junos_request_system_reboot_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "juniper", "junos", "request system reboot");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn junos_show_route_is_tier0() {
    let rs = load_builtin();
    let d = classify(&rs, "juniper", "junos", "show route");
    assert_eq!(d.tier, Tier::T0);
}

#[test]
fn arista_reload_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "arista", "eos", "reload");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn iosxe_hostname_is_tier1() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "hostname R99");
    assert_eq!(d.tier, Tier::T1);
}

#[test]
fn no_rule_match_returns_ambiguous_for_config_commands() {
    let rs = load_builtin();
    // A config-like command with no builtin rule → ambiguous, caller decides whether
    // to route to LLM second-opinion.
    let d = classify(&rs, "cisco", "iosxe", "archive path disk0:foobar.cfg");
    assert_eq!(d.tier, Tier::Ambiguous);
}

#[test]
fn unknown_exec_command_defaults_to_safe_tier() {
    // Safety default: unknown commands are NEVER auto-approved. Prefer over-gating.
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "test crypto self-test");
    // Either Ambiguous (unknown) or T1+ (safety default) — both acceptable.
    assert!(
        matches!(d.tier, Tier::T1 | Tier::T2 | Tier::T3 | Tier::Ambiguous),
        "unknown commands must never be T0; got {:?}",
        d.tier
    );
}

#[test]
fn show_prefix_safety_default_for_unknown_vendor() {
    // Unknown vendor + show command should still hit the universal `*/*` show fallback
    // OR the read-only-prefix safety default — both yield T0.
    let rs = load_builtin();
    let d = classify(&rs, "unknown-vendor", "unknown-platform", "show interface diagnostics");
    assert_eq!(d.tier, Tier::T0);
}

#[test]
fn higher_tier_wins_on_overlap() {
    // `no router bgp` matches both an iosxe-specific T3 rule and any
    // less-specific rule. T3 must win.
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "no router bgp 64512");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn iosxe_show_running_config_is_tier0() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "show running-config");
    assert_eq!(d.tier, Tier::T0);
}

#[test]
fn junos_commit_is_tier2() {
    let rs = load_builtin();
    let d = classify(&rs, "juniper", "junos", "commit");
    assert_eq!(d.tier, Tier::T2);
}

#[test]
fn junos_commit_check_is_tier0() {
    let rs = load_builtin();
    let d = classify(&rs, "juniper", "junos", "commit check");
    assert_eq!(d.tier, Tier::T0);
}
