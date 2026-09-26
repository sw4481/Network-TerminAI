use ccie_terminal_lib::parsers::cache::ParseCache;

#[test]
fn cache_roundtrip() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let cache = ParseCache::open(tmp.path()).unwrap();
    let key = cache.key("cisco", "iosxe", "show ip int br", "raw-output");

    assert!(cache.get(&key).unwrap().is_none());

    cache
        .put(&key, "cisco", "iosxe", "show ip int br", "genie", r#"{"a":1}"#)
        .unwrap();

    let hit = cache.get(&key).unwrap().unwrap();
    assert_eq!(hit.parser, "genie");
    assert_eq!(hit.data_json, r#"{"a":1}"#);
}

#[test]
fn cache_key_is_deterministic_and_input_sensitive() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let cache = ParseCache::open(tmp.path()).unwrap();

    let a = cache.key("cisco", "iosxe", "show version", "output");
    let b = cache.key("cisco", "iosxe", "show version", "output");
    let c = cache.key("cisco", "iosxe", "show version", "different-output");

    assert_eq!(a, b, "same inputs must produce same key");
    assert_ne!(a, c, "different raw must produce different key");
    assert_eq!(a.len(), 64, "sha256 hex digest is 64 chars");
}
