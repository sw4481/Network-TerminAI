//! OpenAPI 3.x → endpoint catalog tests.

use ccie_terminal_lib::api_runner::openapi::parse_spec;

const SPEC_3_0: &str = include_str!("fixtures/mini_openapi_3_0.json");
const SPEC_3_1: &str = include_str!("fixtures/mini_openapi_3_1.json");

#[test]
fn parses_openapi_3_0_with_operation_ids() {
    let endpoints = parse_spec(SPEC_3_0).expect("parse 3.0");
    // 2 paths × (GET, GET+POST) = 3 operations
    assert_eq!(endpoints.len(), 3);
    let get_orgs = endpoints
        .iter()
        .find(|e| e.id == "listOrganizations")
        .expect("should keep operationId");
    assert_eq!(get_orgs.method, "GET");
    assert_eq!(get_orgs.path, "/organizations");
    assert!(get_orgs
        .description
        .as_deref()
        .unwrap_or("")
        .contains("caller has access"));
    // Query parameter captured with stringified default.
    assert_eq!(
        get_orgs.query_params.get("perPage").map(String::as_str),
        Some("100")
    );
}

#[test]
fn synthesizes_id_when_operation_id_missing() {
    let endpoints = parse_spec(SPEC_3_0).unwrap();
    let list_networks = endpoints
        .iter()
        .find(|e| e.path == "/organizations/{organizationId}/networks" && e.method == "GET")
        .expect("find list networks");
    // operationId was missing on the GET → synthesized
    assert!(list_networks.id.starts_with("GET__"));
    assert_eq!(
        list_networks.path_params,
        vec!["organizationId".to_string()]
    );
}

#[test]
fn parses_openapi_3_1() {
    let endpoints = parse_spec(SPEC_3_1).expect("parse 3.1");
    assert_eq!(endpoints.len(), 2);
    let by_id = endpoints
        .iter()
        .find(|e| e.id == "getDeviceById")
        .expect("by-id endpoint");
    assert_eq!(by_id.path_params, vec!["id".to_string()]);
}

#[test]
fn catalog_is_deterministically_ordered() {
    let a = parse_spec(SPEC_3_0).unwrap();
    let b = parse_spec(SPEC_3_0).unwrap();
    let ids_a: Vec<_> = a.iter().map(|e| (e.method.clone(), e.path.clone())).collect();
    let ids_b: Vec<_> = b.iter().map(|e| (e.method.clone(), e.path.clone())).collect();
    assert_eq!(ids_a, ids_b);
    // Sorted by method then path
    for w in ids_a.windows(2) {
        let (a_m, a_p) = &w[0];
        let (b_m, b_p) = &w[1];
        assert!(a_m < b_m || (a_m == b_m && a_p <= b_p));
    }
}

#[test]
fn rejects_garbage_input() {
    assert!(parse_spec("this is not yaml or json").is_err());
}

#[test]
fn yaml_spec_also_works() {
    let y = r#"
openapi: "3.0.3"
info:
  title: Mini YAML
  version: "1.0"
paths:
  /hello:
    get:
      operationId: getHello
      summary: Say hi
      responses:
        "200":
          description: OK
"#;
    let endpoints = parse_spec(y).expect("parse yaml");
    assert_eq!(endpoints.len(), 1);
    assert_eq!(endpoints[0].id, "getHello");
}

#[test]
fn missing_summary_falls_back_to_method_and_path() {
    let y = r#"
openapi: "3.0.3"
info: { title: X, version: "1.0" }
paths:
  /no-meta:
    get:
      responses:
        "200": { description: OK }
"#;
    let endpoints = parse_spec(y).unwrap();
    assert!(endpoints[0].name.contains("GET") || endpoints[0].name.contains("/no-meta"));
}
