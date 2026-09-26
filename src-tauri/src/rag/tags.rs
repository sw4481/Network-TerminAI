//! Plan 12 + RAG user-tags follow-up — RAG tag shape rules.
//!
//! `TAG_TAXONOMY` lists the seven builtin vendor tags. They participate
//! in retrieval as the OR-filter set (caller's vendor + `generic`).
//! Any other tag that passes `validate_tag_shape` is treated as a user
//! tag. User tags participate in retrieval as an additional AND
//! (subset) filter — see `src-tauri/src/rag/retrieve.rs`.

use anyhow::{bail, Result};

/// Authoritative builtin taxonomy. Order matches the original Plan 12
/// brief and the `BUILTIN_RAG_TAGS` constant in `src/lib/rag.ts`.
pub const TAG_TAXONOMY: &[&str] = &[
    "cisco-iosxe-switch",
    "cisco-iosxe-router",
    "cisco-nxos",
    "cisco-meraki",
    "juniper-junos",
    "arista-eos",
    "generic",
];

/// Reserved prefixes — a non-builtin tag may not start with any of
/// these. Protects the vendor namespace from typo'd lookalikes
/// (e.g. `cisco-iosx-router`).
const RESERVED_PREFIXES: &[&str] = &["cisco-", "juniper-", "arista-"];

/// True iff `t` is an exact member of [`TAG_TAXONOMY`]. Used by the
/// retriever to split an incoming tag list into the builtin (OR) set
/// and the user (AND) set.
pub fn is_builtin_tag(t: &str) -> bool {
    TAG_TAXONOMY.contains(&t)
}

/// Deprecated transition shim — kept ONLY so `store.rs`, `retrieve.rs`, and
/// `commands/rag.rs` keep compiling until Tasks 2/3/4 swap them to
/// `validate_tag_shape`. Behavior matches the pre-refactor `validate_tag`:
/// strict whitelist against [`TAG_TAXONOMY`]. Do not call from new code.
#[deprecated(
    note = "STRICT WHITELIST ONLY — kept for transition. Use validate_tag_shape for shape + reserved-prefix validation."
)]
pub fn validate_tag(t: &str) -> Result<()> {
    if is_builtin_tag(t) {
        Ok(())
    } else {
        bail!("tag '{}' is not in the RAG taxonomy: {:?}", t, TAG_TAXONOMY);
    }
}

/// Slug-shape + reserved-prefix check.
///
/// Rules:
/// - 1..=32 ASCII characters.
/// - Lowercase letter or digit at position 0.
/// - Subsequent characters: `[a-z0-9-]`.
/// - Tags equal to a builtin (exact match in [`TAG_TAXONOMY`]) always
///   pass.
/// - Non-builtin tags must not start with a reserved vendor prefix
///   (`cisco-`, `juniper-`, `arista-`) and must not equal `generic`.
pub fn validate_tag_shape(t: &str) -> Result<()> {
    if is_builtin_tag(t) {
        return Ok(());
    }
    if t.is_empty() {
        bail!("tag must not be empty");
    }
    if t.chars().count() > 32 {
        bail!("tag '{t}' exceeds 32-character cap");
    }
    let mut chars = t.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        bail!("tag '{t}' must start with a lowercase letter or digit");
    }
    for c in chars {
        if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            bail!("tag '{t}' contains invalid character '{c}' (allowed: a-z, 0-9, -)");
        }
    }
    for prefix in RESERVED_PREFIXES {
        if t.starts_with(prefix) {
            bail!("tag '{t}' uses reserved vendor prefix '{prefix}'");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taxonomy_contains_canonical_seven() {
        assert_eq!(TAG_TAXONOMY.len(), 7);
        for expected in [
            "cisco-iosxe-switch",
            "cisco-iosxe-router",
            "cisco-nxos",
            "cisco-meraki",
            "juniper-junos",
            "arista-eos",
            "generic",
        ] {
            assert!(TAG_TAXONOMY.contains(&expected), "missing {expected}");
        }
    }

    #[test]
    fn is_builtin_tag_matches_taxonomy_only() {
        assert!(is_builtin_tag("cisco-iosxe-router"));
        assert!(is_builtin_tag("generic"));
        assert!(!is_builtin_tag("customer-acme"));
        assert!(!is_builtin_tag(""));
    }

    #[test]
    fn validate_shape_accepts_builtins() {
        for t in TAG_TAXONOMY {
            assert!(validate_tag_shape(t).is_ok(), "builtin {t} rejected");
        }
    }

    #[test]
    fn validate_shape_accepts_user_slugs() {
        assert!(validate_tag_shape("customer-acme").is_ok());
        assert!(validate_tag_shape("project1").is_ok());
        assert!(validate_tag_shape("a").is_ok());
        assert!(validate_tag_shape("0").is_ok());
        assert!(validate_tag_shape(&"a".repeat(32)).is_ok());
    }

    #[test]
    fn validate_shape_rejects_bad_shape() {
        assert!(validate_tag_shape("").is_err());
        assert!(validate_tag_shape("Customer-ACME").is_err());
        assert!(validate_tag_shape("-leading").is_err());
        assert!(validate_tag_shape("bad space").is_err());
        assert!(validate_tag_shape("emoji-🔥").is_err());
        assert!(validate_tag_shape(&"a".repeat(33)).is_err());
    }

    #[test]
    fn validate_shape_rejects_reserved_prefixes() {
        assert!(validate_tag_shape("cisco-foo").is_err());
        assert!(validate_tag_shape("juniper-x").is_err());
        assert!(validate_tag_shape("arista-foo").is_err());
        // Builtins still pass — they're whitelisted by exact match.
        assert!(validate_tag_shape("cisco-iosxe-router").is_ok());
        assert!(validate_tag_shape("juniper-junos").is_ok());
    }
}
