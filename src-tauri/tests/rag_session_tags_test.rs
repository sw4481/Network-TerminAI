//! Plan 12 Phase 5 Task 5.2 — `derive_tags` integration tests.
//!
//! Validates the vendor/platform/role -> tag-list mapping. Tab vendor
//! and platform are tracked client-side (not persisted in SQLite) per
//! the comment in `src-tauri/src/structured/auto_parse.rs`, so this
//! function takes the values directly. The frontend (Phase 5.3 +
//! beyond) plumbs them via the `agent_chat_stream` Tauri command.

use ccie_terminal_lib::rag::session_tags::derive_tags;

#[test]
fn cisco_iosxe_switch_returns_switch_plus_generic() {
    assert_eq!(
        derive_tags(Some("cisco"), Some("iosxe"), Some("switch")),
        vec!["cisco-iosxe-switch", "generic"]
    );
}

#[test]
fn cisco_iosxe_router_returns_router_plus_generic() {
    assert_eq!(
        derive_tags(Some("cisco"), Some("iosxe"), Some("router")),
        vec!["cisco-iosxe-router", "generic"]
    );
}

#[test]
fn cisco_iosxe_unknown_role_defaults_to_router() {
    assert_eq!(
        derive_tags(Some("cisco"), Some("iosxe"), None),
        vec!["cisco-iosxe-router", "generic"]
    );
}

#[test]
fn cisco_nxos_returns_nxos_plus_generic() {
    assert_eq!(
        derive_tags(Some("cisco"), Some("nxos"), None),
        vec!["cisco-nxos", "generic"]
    );
    // Role is irrelevant for NX-OS.
    assert_eq!(
        derive_tags(Some("cisco"), Some("nxos"), Some("switch")),
        vec!["cisco-nxos", "generic"]
    );
}

#[test]
fn cisco_meraki_returns_meraki_plus_generic() {
    assert_eq!(
        derive_tags(Some("cisco"), Some("meraki"), None),
        vec!["cisco-meraki", "generic"]
    );
}

#[test]
fn juniper_junos_returns_junos_plus_generic() {
    assert_eq!(
        derive_tags(Some("juniper"), Some("junos"), None),
        vec!["juniper-junos", "generic"]
    );
}

#[test]
fn arista_eos_returns_eos_plus_generic() {
    assert_eq!(
        derive_tags(Some("arista"), Some("eos"), None),
        vec!["arista-eos", "generic"]
    );
}

#[test]
fn unknown_vendor_returns_generic_only() {
    assert_eq!(
        derive_tags(Some("foo"), Some("bar"), None),
        vec!["generic"]
    );
}

#[test]
fn cisco_unknown_platform_returns_generic_only() {
    assert_eq!(
        derive_tags(Some("cisco"), Some("unknown"), None),
        vec!["generic"]
    );
}

#[test]
fn case_is_normalized_to_lowercase() {
    // Mixed-case inputs from a UI that didn't normalize must still
    // hit the right taxonomy bucket.
    assert_eq!(
        derive_tags(Some("Cisco"), Some("IOSXE"), Some("Switch")),
        vec!["cisco-iosxe-switch", "generic"]
    );
    assert_eq!(
        derive_tags(Some("JUNIPER"), Some("Junos"), None),
        vec!["juniper-junos", "generic"]
    );
}

#[test]
fn all_none_inputs_return_generic_only() {
    assert_eq!(derive_tags(None, None, None), vec!["generic"]);
}

#[test]
fn vendor_without_platform_returns_generic_only() {
    // Without a platform we can't pin a sub-taxonomy; default to
    // generic-only rather than guessing.
    assert_eq!(derive_tags(Some("cisco"), None, None), vec!["generic"]);
}

#[test]
fn empty_strings_are_treated_like_none() {
    // An empty vendor or platform is meaningless; collapse to generic.
    assert_eq!(derive_tags(Some(""), Some(""), Some("")), vec!["generic"]);
}
