//! Step 8: every built-in manifest must parse cleanly and expose its full
//! catalog through the `catalog::load_all` entry point.
//!
//! Counts are a floor check, not an exact match — when Cisco publishes new
//! endpoints and a future regen adds them, we don't want to fail CI. The
//! floor is the number of endpoints this commit shipped, minus a small
//! slack to account for the dedupe pass.

use ccie_terminal_lib::api_runner::catalog::{
    catalog_for_manifest, load_all, seed_builtin_manifests,
};
use tempfile::TempDir;

fn setup() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
    let tmp = TempDir::new().unwrap();
    let builtin_dir = tmp.path().join("builtin");
    let user_dir = tmp.path().join("user");
    seed_builtin_manifests(&builtin_dir).unwrap();
    std::fs::create_dir_all(&user_dir).unwrap();
    (tmp, builtin_dir, user_dir)
}

#[test]
fn every_builtin_manifest_parses() {
    let (_tmp, b, u) = setup();
    let loaded = load_all(&b, &u).unwrap();
    let ids: Vec<_> = loaded.builtin.iter().map(|(m, _)| m.id.as_str()).collect();
    // Sorted by `load_dir` → alphabetical.
    assert_eq!(
        ids,
        vec!["catalyst_center", "ise", "meraki", "sna"],
        "all 4 built-in manifests should load",
    );
}

#[test]
fn meraki_has_hundreds_of_endpoints() {
    let (_tmp, b, u) = setup();
    let loaded = load_all(&b, &u).unwrap();
    let m = loaded.find("meraki").expect("meraki manifest");
    let endpoints = catalog_for_manifest(m);
    assert!(
        endpoints.len() >= 700,
        "meraki.yaml ships full OpenAPI catalog (got {})",
        endpoints.len()
    );
}

#[test]
fn catalyst_center_has_hundreds_of_endpoints() {
    let (_tmp, b, u) = setup();
    let loaded = load_all(&b, &u).unwrap();
    let m = loaded.find("catalyst_center").expect("catalyst_center manifest");
    let endpoints = catalog_for_manifest(m);
    assert!(
        endpoints.len() >= 800,
        "catalyst_center.yaml ships the full SDK-derived catalog (got {})",
        endpoints.len()
    );
}

#[test]
fn ise_has_hundreds_of_endpoints() {
    let (_tmp, b, u) = setup();
    let loaded = load_all(&b, &u).unwrap();
    let m = loaded.find("ise").expect("ise manifest");
    let endpoints = catalog_for_manifest(m);
    assert!(
        endpoints.len() >= 600,
        "ise.yaml ships the full SDK-derived catalog (got {})",
        endpoints.len()
    );
}

#[test]
fn sna_has_its_full_starter_catalog() {
    // SNA's public API surface is small; we ship the Postman-collection
    // set plus the script-grep extras.
    let (_tmp, b, u) = setup();
    let loaded = load_all(&b, &u).unwrap();
    let m = loaded.find("sna").expect("sna manifest");
    let endpoints = catalog_for_manifest(m);
    assert!(
        endpoints.len() >= 15,
        "sna.yaml starter catalog should have the Postman set (got {})",
        endpoints.len()
    );
}

#[test]
fn every_endpoint_has_a_non_empty_id_and_path() {
    let (_tmp, b, u) = setup();
    let loaded = load_all(&b, &u).unwrap();
    for (m, src) in &loaded.builtin {
        let endpoints = catalog_for_manifest(m);
        for e in &endpoints {
            assert!(
                !e.id.is_empty(),
                "{} endpoint has empty id: {:?}",
                src.display(),
                e
            );
            assert!(
                !e.path.is_empty() && e.path.starts_with('/'),
                "{} endpoint has bad path: {:?}",
                src.display(),
                e
            );
            assert!(
                !e.method.is_empty(),
                "{} endpoint has empty method: {:?}",
                src.display(),
                e
            );
        }
    }
}

#[test]
fn every_manifest_has_an_openapi_url_for_reimport() {
    let (_tmp, b, u) = setup();
    let loaded = load_all(&b, &u).unwrap();
    for (m, src) in &loaded.builtin {
        assert!(
            m.openapi_url.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
            "{} needs an openapi_url so the UI's Import button has something to fetch",
            src.display(),
        );
    }
}

#[test]
fn endpoint_ids_are_unique_within_each_manifest() {
    let (_tmp, b, u) = setup();
    let loaded = load_all(&b, &u).unwrap();
    for (m, src) in &loaded.builtin {
        let endpoints = catalog_for_manifest(m);
        let mut seen = std::collections::HashSet::new();
        for e in &endpoints {
            assert!(
                seen.insert(e.id.clone()),
                "{} has duplicate endpoint id: {}",
                src.display(),
                e.id
            );
        }
    }
}

#[test]
fn sna_does_not_force_accept_json_header() {
    // Regression for the "406 Not Acceptable" bug on
    // /sw-reporting/v1/tenants and similar text/plain endpoints.
    // SNA serves heterogeneous content types; forcing Accept:
    // application/json makes the text/plain endpoints reject the request.
    // Users can still add Accept per-request when targeting JSON endpoints.
    let (_tmp, b, u) = setup();
    let loaded = load_all(&b, &u).unwrap();
    let sna = loaded.find("sna").expect("sna manifest");
    assert!(
        !sna.defaults.headers.contains_key("Accept"),
        "SNA must NOT declare a default Accept header",
    );
}

#[test]
fn sna_uses_form_body_credentials_for_session_login() {
    // Regression for the "415 Unsupported Media Type" bug.
    // /token/v2/authenticate expects application/x-www-form-urlencoded;
    // sending JSON fails the login entirely.
    use ccie_terminal_lib::api_runner::manifest::{
        ManifestAuth, ManifestLoginCredentials,
    };
    let (_tmp, b, u) = setup();
    let loaded = load_all(&b, &u).unwrap();
    let sna = loaded.find("sna").expect("sna manifest");
    match &sna.auth {
        ManifestAuth::SessionCookie { login } => match &login.credentials {
            ManifestLoginCredentials::FormBody { .. } => {}
            other => panic!(
                "SNA login must be form_body (got {:?}) — JSON body causes 415 at /token/v2/authenticate",
                other
            ),
        },
        other => panic!("SNA must use session_cookie auth (got {:?})", other),
    }
}
