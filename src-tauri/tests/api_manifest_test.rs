//! Manifest parsing + directory-scan tests.

use ccie_terminal_lib::api_runner::manifest::{
    endpoints_from_manifest, extract_path_params, load_dir, parse_manifest, synth_endpoint_id,
    ManifestAuth, TargetManifest, SCHEMA_VERSION,
};
use tempfile::TempDir;

const MERAKI_YAML: &str = include_str!(
    "../resources/api-targets-builtin/meraki.yaml"
);

// ---- parse_manifest -------------------------------------------------------

#[test]
fn parses_builtin_meraki_manifest() {
    let m = parse_manifest(MERAKI_YAML).expect("parse meraki");
    assert_eq!(m.id, "meraki");
    assert_eq!(m.display_name, "Cisco Meraki Dashboard");
    assert_eq!(m.base_url, "https://api.meraki.com/api/v1");
    assert!(matches!(m.auth, ManifestAuth::Header { .. }));
    assert!(m.tls.verify);
    assert!(m.defaults.headers.contains_key("Accept"));
    assert!(m.endpoints.len() >= 5);
    assert_eq!(m.schema_version, SCHEMA_VERSION);
}

#[test]
fn rejects_unknown_top_level_field() {
    let bad = "id: x\ndisplay_name: y\nbase_url: https://x\nunexpected: true\n";
    assert!(parse_manifest(bad).is_err());
}

#[test]
fn rejects_unknown_auth_type() {
    let bad = r#"
id: x
display_name: y
base_url: https://x
auth:
  type: oauth42
  token: nope
"#;
    assert!(parse_manifest(bad).is_err());
}

#[test]
fn rejects_future_schema_version() {
    let bad = r#"
id: x
display_name: y
schema_version: 9999
base_url: https://x
"#;
    let err = parse_manifest(bad).unwrap_err().to_string();
    assert!(err.contains("schema_version"));
}

#[test]
fn rejects_empty_required_fields() {
    assert!(parse_manifest("id: \"\"\ndisplay_name: x\nbase_url: https://x").is_err());
    assert!(parse_manifest("id: x\ndisplay_name: \"\"\nbase_url: https://x").is_err());
    assert!(parse_manifest("id: x\ndisplay_name: y\nbase_url: \"\"").is_err());
}

#[test]
fn rejects_python_tag_injection() {
    // YAML tag injection attempt — serde_yaml's safe loader rejects already,
    // but we also have a belt-and-suspenders check.
    let bad = "id: x\ndisplay_name: !!python/object/apply:os.system ['rm -rf /']\nbase_url: https://x";
    assert!(parse_manifest(bad).is_err());
}

#[test]
fn rejects_binary_tag() {
    let bad = "id: x\ndisplay_name: y\nbase_url: !!binary aGVsbG8=";
    assert!(parse_manifest(bad).is_err());
}

#[test]
fn bearer_auth_roundtrip() {
    let y = r#"
id: github
display_name: GitHub
base_url: https://api.github.com
auth:
  type: bearer
  token: ${env:GITHUB_TOKEN}
"#;
    let m = parse_manifest(y).unwrap();
    match m.auth {
        ManifestAuth::Bearer { token } => {
            assert_eq!(token, "${env:GITHUB_TOKEN}");
        }
        other => panic!("expected Bearer, got {other:?}"),
    }
}

#[test]
fn basic_auth_roundtrip() {
    let y = r#"
id: ise
display_name: Cisco ISE
base_url: https://ise.lab/ers
auth:
  type: basic
  username: admin
  password: ${env:ISE_PASS}
tls:
  verify: false
"#;
    let m = parse_manifest(y).unwrap();
    match m.auth {
        ManifestAuth::Basic { username, password } => {
            assert_eq!(username, "admin");
            assert_eq!(password, "${env:ISE_PASS}");
        }
        other => panic!("expected Basic, got {other:?}"),
    }
    assert!(!m.tls.verify);
}

// ---- helpers --------------------------------------------------------------

#[test]
fn extract_path_params_handles_multiple() {
    assert_eq!(
        extract_path_params("/orgs/{organizationId}/networks/{networkId}"),
        vec!["organizationId".to_string(), "networkId".to_string()]
    );
    assert!(extract_path_params("/orgs").is_empty());
    assert_eq!(
        extract_path_params("/{a}/{b}/{c}"),
        vec!["a".to_string(), "b".to_string(), "c".to_string()]
    );
    // Unclosed brace: drop it silently rather than panic.
    assert!(extract_path_params("/orgs/{broken").is_empty());
}

#[test]
fn synth_endpoint_id_is_stable_and_readable() {
    let a = synth_endpoint_id("GET", "/organizations/{organizationId}/networks");
    let b = synth_endpoint_id("get", "/organizations/{organizationId}/networks");
    assert_eq!(a, b, "method case should not matter");
    assert!(a.starts_with("GET__"));
    assert!(a.contains("organizationId"));
}

#[test]
fn endpoints_from_manifest_synthesizes_ids_when_missing() {
    let y = r#"
id: x
display_name: X
base_url: https://x
endpoints:
  - name: List things
    method: GET
    path: /things/{thingId}
"#;
    let m: TargetManifest = parse_manifest(y).unwrap();
    let endpoints = endpoints_from_manifest(&m);
    assert_eq!(endpoints.len(), 1);
    assert_eq!(endpoints[0].method, "GET");
    assert_eq!(endpoints[0].path_params, vec!["thingId".to_string()]);
    assert!(endpoints[0].id.starts_with("GET__"));
}

// ---- load_dir -------------------------------------------------------------

#[test]
fn load_dir_skips_non_yaml_and_bad_files() {
    let tmp = TempDir::new().unwrap();
    // Good manifest
    std::fs::write(tmp.path().join("good.yaml"), MERAKI_YAML).unwrap();
    // Bad manifest — should be skipped, not abort
    std::fs::write(tmp.path().join("bad.yaml"), "not: [valid yaml").unwrap();
    // Non-YAML file — should be ignored
    std::fs::write(tmp.path().join("readme.md"), "# hi").unwrap();

    let loaded = load_dir(tmp.path()).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].0.id, "meraki");
}

#[test]
fn load_dir_returns_empty_for_missing_dir() {
    let loaded = load_dir(std::path::Path::new("/nonexistent/path/xyz123")).unwrap();
    assert!(loaded.is_empty());
}

#[test]
fn load_dir_returns_stable_order() {
    let tmp = TempDir::new().unwrap();
    for id in ["zulu", "alpha", "mike"] {
        let y = format!("id: {id}\ndisplay_name: {id}\nbase_url: https://x\n");
        std::fs::write(tmp.path().join(format!("{id}.yaml")), y).unwrap();
    }
    let loaded = load_dir(tmp.path()).unwrap();
    let ids: Vec<_> = loaded.iter().map(|(m, _)| m.id.as_str()).collect();
    assert_eq!(ids, vec!["alpha", "mike", "zulu"]);
}
