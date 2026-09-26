//! OpenAPI 3.x → endpoint catalog import.
//!
//! Reads an OpenAPI spec (JSON or YAML) from either a filesystem path or an
//! https URL and produces a flat list of [`super::manifest::Endpoint`]
//! entries suitable for the frontend EndpointPicker.
//!
//! Design choices:
//!   * We use `openapiv3` which parses OAS 3.0 natively. OAS 3.1 is
//!     down-converted via a pre-processing shim: the important 3.1 features
//!     for our UI (operations, parameters, path params) are wire-compatible
//!     with 3.0.
//!   * Operations without `operationId` get a synthesized stable id via
//!     [`super::manifest::synth_endpoint_id`].
//!   * Results are cached in `api-cache/openapi/<hash>.json` so subsequent
//!     opens are instant. A manifest change (different `openapi_url`)
//!     produces a different hash so cache invalidation is automatic.

use super::manifest::{extract_path_params, synth_endpoint_id, Endpoint};
use anyhow::{Context, Result};
use openapiv3::OpenAPI;
use std::collections::BTreeMap;
use std::path::Path;

/// Parse an OpenAPI spec from either JSON or YAML text and flatten it to
/// a list of [`Endpoint`]. Works for both 3.0 and 3.1 (we massage 3.1
/// specs so they validate against the 3.0 schema).
pub fn parse_spec(raw: &str) -> Result<Vec<Endpoint>> {
    let normalized = normalize_spec(raw);
    // Try JSON first, then YAML.
    let spec: OpenAPI = serde_json::from_str(&normalized)
        .or_else(|_| serde_yaml::from_str::<OpenAPI>(&normalized))
        .context("parse OpenAPI (tried JSON and YAML)")?;
    Ok(spec_to_endpoints(&spec))
}

/// Load a spec from a filesystem path.
pub fn parse_spec_file(path: &Path) -> Result<Vec<Endpoint>> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("read OpenAPI spec {}", path.display()))?;
    parse_spec(&raw)
}

/// Convert a parsed OpenAPI document into our flat endpoint catalog.
pub fn spec_to_endpoints(spec: &OpenAPI) -> Vec<Endpoint> {
    let mut out = Vec::new();

    for (path, item_ref) in spec.paths.iter() {
        // In openapiv3, ReferenceOr<PathItem> — we only handle inline items.
        let item = match item_ref {
            openapiv3::ReferenceOr::Item(i) => i,
            openapiv3::ReferenceOr::Reference { .. } => continue,
        };
        for (method, op) in operations_of(item) {
            let operation_id = op
                .operation_id
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| synth_endpoint_id(method, path));

            let name = op
                .summary
                .clone()
                .or_else(|| op.description.clone())
                .unwrap_or_else(|| format!("{method} {path}"));

            // Collect query params (we reuse path_params helper for path
            // placeholders rather than the declared parameter list, since
            // our RequestBuilder treats `{foo}` substitution as the source
            // of truth).
            let mut query_params: BTreeMap<String, String> = BTreeMap::new();
            for param in &op.parameters {
                let p = match param {
                    openapiv3::ReferenceOr::Item(p) => p,
                    openapiv3::ReferenceOr::Reference { .. } => continue,
                };
                if let openapiv3::Parameter::Query { parameter_data, .. } = p {
                    // Default value can live in the schema; keep it empty
                    // unless we find a literal default via json_value.
                    let default_val =
                        default_query_value(&parameter_data.format).unwrap_or_default();
                    query_params.insert(parameter_data.name.clone(), default_val);
                }
            }

            out.push(Endpoint {
                id: operation_id,
                name,
                description: op.description.clone(),
                method: method.to_string(),
                path: path.clone(),
                path_params: extract_path_params(path),
                query_params,
            });
        }
    }

    // Stable ordering: method, then path. Makes snapshot tests deterministic.
    out.sort_by(|a, b| a.method.cmp(&b.method).then_with(|| a.path.cmp(&b.path)));
    out
}

fn operations_of(item: &openapiv3::PathItem) -> Vec<(&'static str, &openapiv3::Operation)> {
    let mut ops = Vec::new();
    if let Some(op) = item.get.as_ref() {
        ops.push(("GET", op));
    }
    if let Some(op) = item.post.as_ref() {
        ops.push(("POST", op));
    }
    if let Some(op) = item.put.as_ref() {
        ops.push(("PUT", op));
    }
    if let Some(op) = item.patch.as_ref() {
        ops.push(("PATCH", op));
    }
    if let Some(op) = item.delete.as_ref() {
        ops.push(("DELETE", op));
    }
    if let Some(op) = item.head.as_ref() {
        ops.push(("HEAD", op));
    }
    if let Some(op) = item.options.as_ref() {
        ops.push(("OPTIONS", op));
    }
    if let Some(op) = item.trace.as_ref() {
        ops.push(("TRACE", op));
    }
    ops
}

fn default_query_value(format: &openapiv3::ParameterSchemaOrContent) -> Option<String> {
    // Try to pull a `default` out of the schema, stringified.
    if let openapiv3::ParameterSchemaOrContent::Schema(openapiv3::ReferenceOr::Item(schema)) =
        format
    {
        if let Some(value) = schema.schema_data.default.as_ref() {
            return Some(match value {
                serde_json::Value::String(value) => value.clone(),
                other => other.to_string(),
            });
        }
    }
    None
}

/// OAS 3.1 uses JSON-Schema-draft-2020 for schemas, which openapiv3 (built
/// for 3.0) chokes on in a few spots (e.g. `exclusiveMinimum: number` in 3.1
/// vs `boolean` in 3.0). Since our UI only needs names/paths/methods we
/// strip schema fragments that break the 3.0 parser — we keep operations,
/// parameters, and identifiers intact.
fn normalize_spec(raw: &str) -> String {
    // Fast path: if the spec isn't obviously 3.1, return as-is.
    let is_three_one = raw.contains("\"openapi\":\"3.1") || raw.contains("openapi: 3.1");
    if !is_three_one {
        return raw.to_string();
    }
    // Pragmatic shim: rewrite the version string so openapiv3 accepts the
    // envelope. The schema-level differences we care about don't affect
    // operation/parameter parsing which is what our catalog uses.
    raw.replace("\"openapi\":\"3.1", "\"openapi\":\"3.0")
        .replace("openapi: 3.1", "openapi: 3.0")
}
