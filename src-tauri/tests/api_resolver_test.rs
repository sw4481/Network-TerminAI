//! Placeholder resolver coverage: env/var precedence, nested, cycles,
//! escapes, unresolved-error detail, and `resolve_request` end-to-end.

use ccie_terminal_lib::api_runner::resolver::{
    resolve, resolve_request, ResolveError, ResolverContext, MAX_DEPTH,
};
use ccie_terminal_lib::api_runner::types::{
    ApiAuth, ApiRequest, BodyKind, BodyKindDefault, HttpMethod,
};
use std::collections::BTreeMap;

fn ctx(entries: &[(&str, &str)]) -> ResolverContext {
    let mut c = ResolverContext::default();
    for (k, v) in entries {
        c.insert(*k, *v);
    }
    c
}

fn req(url: &str) -> ApiRequest {
    ApiRequest {
        method: HttpMethod::Get,
        url: url.to_string(),
        headers: BTreeMap::new(),
        query: BTreeMap::new(),
        body_kind: BodyKindDefault(BodyKind::None),
        body_text: None,
        body_bytes: None,
        auth: ApiAuth::None,
        timeout_secs: None,
        insecure_skip_verify: false,
        tls_ca_bundle: None,
        tls_client_cert: None,
    }
}

// ---- basic resolution ----------------------------------------------------

#[test]
fn resolves_simple_env_placeholder() {
    let c = ctx(&[("KEY", "abc123")]);
    assert_eq!(resolve("Bearer ${env:KEY}", &c).unwrap(), "Bearer abc123");
}

#[test]
fn resolves_var_placeholder() {
    let c = ctx(&[("orgId", "L_9")]);
    assert_eq!(
        resolve("/organizations/${var:orgId}/networks", &c).unwrap(),
        "/organizations/L_9/networks"
    );
}

#[test]
fn env_and_var_are_interchangeable_lookups() {
    let c = ctx(&[("X", "42")]);
    assert_eq!(resolve("${env:X}", &c).unwrap(), "42");
    assert_eq!(resolve("${var:X}", &c).unwrap(), "42");
}

#[test]
fn text_without_placeholders_is_passthrough() {
    let c = ctx(&[("X", "1")]);
    assert_eq!(
        resolve("just a plain string", &c).unwrap(),
        "just a plain string"
    );
}

#[test]
fn empty_string_stays_empty() {
    assert_eq!(resolve("", &ResolverContext::default()).unwrap(), "");
}

// ---- unresolved ----------------------------------------------------------

#[test]
fn unresolved_variable_errors_with_name() {
    let err = resolve("Bearer ${env:MISSING}", &ResolverContext::default()).unwrap_err();
    match err {
        ResolveError::Unresolved(names) => assert_eq!(names, vec!["MISSING".to_string()]),
        other => panic!("expected Unresolved, got {other:?}"),
    }
}

#[test]
fn unresolved_aggregates_every_missing_name() {
    let err = resolve("${env:A}-${env:B}-${var:C}", &ResolverContext::default()).unwrap_err();
    match err {
        ResolveError::Unresolved(names) => {
            let mut sorted = names.clone();
            sorted.sort();
            assert_eq!(sorted, vec!["A", "B", "C"]);
        }
        other => panic!("expected Unresolved, got {other:?}"),
    }
}

#[test]
fn unresolved_dedupes_repeated_names() {
    let err = resolve("${env:X}/${env:X}", &ResolverContext::default()).unwrap_err();
    match err {
        ResolveError::Unresolved(names) => assert_eq!(names, vec!["X".to_string()]),
        other => panic!("expected Unresolved, got {other:?}"),
    }
}

// ---- escapes --------------------------------------------------------------

#[test]
fn double_dollar_escapes_to_literal_dollar() {
    assert_eq!(
        resolve("price = $$50", &ResolverContext::default()).unwrap(),
        "price = $50"
    );
}

#[test]
fn brace_escapes_survive() {
    assert_eq!(
        resolve("literal $\\{brace$\\}", &ResolverContext::default()).unwrap(),
        "literal {brace}"
    );
}

#[test]
fn dollar_with_no_placeholder_passes_through() {
    // `$foo` (no braces) is just a literal — only `${...}` is a placeholder.
    assert_eq!(
        resolve("$PATH is not $expanded", &ResolverContext::default()).unwrap(),
        "$PATH is not $expanded"
    );
}

// ---- malformed placeholders ---------------------------------------------

#[test]
fn unterminated_placeholder_errors() {
    let err = resolve("hello ${env:X", &ResolverContext::default()).unwrap_err();
    assert!(matches!(err, ResolveError::Malformed(_)));
}

#[test]
fn placeholder_without_prefix_passes_through_literally() {
    // Future placeholder syntaxes (e.g. `${response.foo.bar}` in Step 7)
    // may not use the `prefix:name` form. Unknown shapes MUST NOT silently
    // resolve to empty — they pass through as literals so the user can see
    // what didn't expand.
    assert_eq!(resolve("${FOO}", &ResolverContext::default()).unwrap(), "${FOO}");
}

#[test]
fn unknown_prefix_is_left_literal_for_future_resolvers() {
    // Future prefixes we don't recognize yet (e.g. a hypothetical
    // `${ask:...}` in a later step) must NOT be silently treated as env
    // lookups or become empty. We leave them as literals so the UI shows
    // the user the placeholder survived unchanged.
    let out = resolve(
        "/echo?p=${ask:something}",
        &ctx(&[("ask:something", "should-not-match")]),
    )
    .unwrap();
    assert_eq!(out, "/echo?p=${ask:something}");
}

// ---- nesting + cycles ----------------------------------------------------

#[test]
fn nested_vars_resolve_transitively() {
    let c = ctx(&[
        ("A", "${var:B}"),
        ("B", "${var:C}"),
        ("C", "deep-value"),
    ]);
    assert_eq!(resolve("${var:A}", &c).unwrap(), "deep-value");
}

#[test]
fn cycle_is_detected() {
    let c = ctx(&[("A", "${var:B}"), ("B", "${var:A}")]);
    let err = resolve("${var:A}", &c).unwrap_err();
    assert!(matches!(err, ResolveError::CycleDetected(_)), "{err:?}");
}

#[test]
fn max_depth_is_enforced() {
    // Build a chain longer than MAX_DEPTH to trip the guard.
    let mut entries = Vec::new();
    let len = MAX_DEPTH + 3;
    for i in 0..len {
        let key = format!("K{i}");
        let val = if i + 1 == len {
            "tail".to_string()
        } else {
            format!("${{var:K{}}}", i + 1)
        };
        entries.push((key, val));
    }
    let mut c = ResolverContext::default();
    for (k, v) in &entries {
        c.insert(k.clone(), v.clone());
    }
    let err = resolve("${var:K0}", &c).unwrap_err();
    assert!(matches!(err, ResolveError::MaxDepth(_)), "{err:?}");
}

// ---- resolve_request end-to-end ------------------------------------------

#[test]
fn resolve_request_rewrites_url_headers_query_body_and_auth() {
    let c = ctx(&[
        ("HOST", "api.meraki.com"),
        ("ORG", "L_9"),
        ("KEY", "deadbeef"),
    ]);
    let mut r = req("https://${env:HOST}/api/v1/organizations/${var:ORG}/networks");
    r.headers
        .insert("X-Key".into(), "Bearer ${env:KEY}".into());
    r.query.insert("per_page".into(), "${var:ORG}".into());
    r.body_text = Some("{\"org\":\"${var:ORG}\"}".into());
    r.body_kind = BodyKindDefault(BodyKind::Json);
    r.auth = ApiAuth::Bearer {
        token: "${env:KEY}".into(),
    };

    resolve_request(&mut r, &c).unwrap();

    assert_eq!(
        r.url,
        "https://api.meraki.com/api/v1/organizations/L_9/networks"
    );
    assert_eq!(r.headers.get("X-Key").map(String::as_str), Some("Bearer deadbeef"));
    assert_eq!(r.query.get("per_page").map(String::as_str), Some("L_9"));
    assert_eq!(
        r.body_text.as_deref(),
        Some("{\"org\":\"L_9\"}")
    );
    match r.auth {
        ApiAuth::Bearer { token } => assert_eq!(token, "deadbeef"),
        other => panic!("expected Bearer, got {other:?}"),
    }
}

#[test]
fn resolve_request_returns_unresolved_error_with_every_missing_name() {
    let c = ctx(&[("HOST", "api.ex.com")]);
    let mut r = req("https://${env:HOST}/${var:MISSING_A}");
    r.headers.insert("X".into(), "${env:MISSING_B}".into());
    let err = resolve_request(&mut r, &c).unwrap_err();
    match err {
        ResolveError::Unresolved(names) => {
            let mut s = names.clone();
            s.sort();
            assert_eq!(s, vec!["MISSING_A", "MISSING_B"]);
        }
        other => panic!("expected Unresolved, got {other:?}"),
    }
}

#[test]
fn resolve_request_auth_header_name_can_also_be_templated() {
    let c = ctx(&[("HDR", "X-Cisco-Meraki-API-Key"), ("KEY", "deadbeef")]);
    let mut r = req("https://api.meraki.com/");
    r.auth = ApiAuth::Header {
        name: "${env:HDR}".into(),
        value: "${env:KEY}".into(),
    };
    resolve_request(&mut r, &c).unwrap();
    match r.auth {
        ApiAuth::Header { name, value } => {
            assert_eq!(name, "X-Cisco-Meraki-API-Key");
            assert_eq!(value, "deadbeef");
        }
        other => panic!("expected Header auth, got {other:?}"),
    }
}
