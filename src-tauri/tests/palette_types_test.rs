//! Round-trip tests for the public palette types — these are the wire shape
//! shared with the TS frontend, so the lowercase serde rename and the parse
//! contract on PaletteScope must stay stable.

use ccie_terminal_lib::palette::types::{PaletteHit, PaletteKind, PaletteScope};

#[test]
fn palette_hit_serializes_kind_as_lowercase_string() {
    let hit = PaletteHit {
        kind: PaletteKind::Workflow,
        target_id: "wf-123".into(),
        title: "Run show tech".into(),
        subtitle: Some("site-atl".into()),
        score: 0.87,
        recency_boost: 0.1,
        frequency_boost: 0.05,
        meta: serde_json::json!({ "param_count": 3 }),
    };
    let js = serde_json::to_value(&hit).unwrap();
    assert_eq!(js["kind"], "workflow");
    assert_eq!(js["target_id"], "wf-123");
    assert_eq!(js["title"], "Run show tech");
    assert_eq!(js["subtitle"], "site-atl");
    assert_eq!(js["meta"]["param_count"], 3);
}

#[test]
fn palette_kind_lowercase_round_trip() {
    for kind in [
        PaletteKind::Command,
        PaletteKind::Workflow,
        PaletteKind::Notebook,
        PaletteKind::Device,
        PaletteKind::Block,
        PaletteKind::Ssh,
    ] {
        let s = serde_json::to_value(kind).unwrap();
        assert!(s.is_string(), "{kind:?} must serialise as a string");
        let restored: PaletteKind = serde_json::from_value(s.clone()).unwrap();
        assert_eq!(restored, kind);
        // Lowercase string matches the as_target_type() helper.
        assert_eq!(s.as_str().unwrap(), kind.as_target_type());
    }
}

#[test]
fn palette_scope_parses_from_string() {
    assert_eq!(PaletteScope::parse("tab"), Some(PaletteScope::Tab));
    assert_eq!(PaletteScope::parse("device"), Some(PaletteScope::Device));
    assert_eq!(PaletteScope::parse("global"), Some(PaletteScope::Global));
    assert_eq!(PaletteScope::parse("bogus"), None);
    assert_eq!(PaletteScope::parse(""), None);
    // Case-sensitive — the frontend always sends lowercase.
    assert_eq!(PaletteScope::parse("Global"), None);
}
