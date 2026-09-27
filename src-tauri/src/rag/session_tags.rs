//! Plan 12 Phase 5 Task 5.2 — derive RAG taxonomy tags from session
//! vendor / platform / role.
//!
//! ## Why this lives in Rust
//!
//! The plan originally specced a `derive_tags_for_tab(tab_id, db)`
//! signature, but tab vendor and platform are intentionally NOT
//! persisted on the Rust side — see the comment in
//! `src-tauri/src/structured/auto_parse.rs` line 6-7. The frontend
//! tracks them in-memory in `tabsStore`. Phase 5.3 plumbs them through
//! the `agent_chat_stream` Tauri command as optional `vendor` and
//! `platform` parameters; this function takes those values directly.
//!
//! ## Mapping
//!
//! | vendor    | platform | role     | result                                 |
//! |-----------|----------|----------|----------------------------------------|
//! | cisco     | iosxe    | switch   | `["cisco-iosxe-switch", "generic"]`    |
//! | cisco     | iosxe    | router   | `["cisco-iosxe-router", "generic"]`    |
//! | cisco     | iosxe    | None     | `["cisco-iosxe-router", "generic"]`    |
//! | cisco     | nxos     | *        | `["cisco-nxos", "generic"]`            |
//! | cisco     | meraki   | *        | `["cisco-meraki", "generic"]`          |
//! | juniper   | junos    | *        | `["juniper-junos", "generic"]`         |
//! | arista    | eos      | *        | `["arista-eos", "generic"]`            |
//! | _other_   | *        | *        | `["generic"]`                          |
//!
//! `"generic"` is ALWAYS included so that vendor-neutral docs continue
//! to surface in the retrieval over-fetch (the retrieve pipeline also
//! defensively unions in `"generic"`, but doing it here keeps the
//! Sources panel honest about which tag set was queried).

/// Build the tag list for a chat turn given the active tab's vendor /
/// platform / optional role. Inputs are normalized to lowercase before
/// matching. Empty strings are treated as `None`. Always returns a
/// non-empty vector containing at least `"generic"`.
pub fn derive_tags(
    vendor: Option<&str>,
    platform: Option<&str>,
    role: Option<&str>,
) -> Vec<String> {
    let v = normalize(vendor);
    let p = normalize(platform);
    let r = normalize(role);

    let primary: Option<&'static str> = match (v.as_deref(), p.as_deref(), r.as_deref()) {
        (Some("cisco"), Some("iosxe"), Some("switch")) => Some("cisco-iosxe-switch"),
        (Some("cisco"), Some("iosxe"), Some("router")) => Some("cisco-iosxe-router"),
        // Unknown-or-missing role on iosxe defaults to router (more
        // common deployment + Plan 12 spec mandates a deterministic
        // fall-through rather than an extra dispatch round-trip).
        (Some("cisco"), Some("iosxe"), _) => Some("cisco-iosxe-router"),
        (Some("cisco"), Some("nxos"), _) => Some("cisco-nxos"),
        (Some("cisco"), Some("meraki"), _) => Some("cisco-meraki"),
        (Some("juniper"), Some("junos"), _) => Some("juniper-junos"),
        (Some("arista"), Some("eos"), _) => Some("arista-eos"),
        _ => None,
    };

    match primary {
        Some(tag) => vec![tag.to_string(), "generic".to_string()],
        None => vec!["generic".to_string()],
    }
}

/// Lower-case a `&str`, treating `None` and empty strings as absent.
fn normalize(s: Option<&str>) -> Option<String> {
    s.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_ascii_lowercase())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn always_includes_generic() {
        for (v, p, r) in [
            (Some("cisco"), Some("iosxe"), Some("switch")),
            (Some("cisco"), Some("nxos"), None),
            (None, None, None),
            (Some("foo"), Some("bar"), Some("baz")),
        ] {
            assert!(
                derive_tags(v, p, r).contains(&"generic".to_string()),
                "expected generic in result for ({:?}, {:?}, {:?})",
                v,
                p,
                r
            );
        }
    }
}
