//! Target-manifest parsing.
//!
//! A target manifest is a YAML file that describes one upstream API:
//!   * identifier + display name
//!   * base URL (may contain `${var:...}` / `${env:...}` placeholders)
//!   * auth strategy (static — token_login/session_cookie/hook arrive in Step 5)
//!   * default headers
//!   * TLS options
//!   * either an inline endpoints list OR a pointer to an OpenAPI spec
//!
//! The file is loaded with `serde_yaml` using the safe loader (no tag
//! resolution). Unknown top-level fields are rejected so the user gets a
//! clear error when they misspell a key.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Currently-supported manifest schema version. Manifests declare this as
/// a top-level field; the loader rejects anything newer so future additive
/// fields can't silently break older installs.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TargetManifest {
    /// Stable identifier used by the URL and history: e.g. "meraki".
    pub id: String,
    pub display_name: String,
    /// Optional explicit schema version. Absent = `1`.
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub base_url: String,
    #[serde(default)]
    pub auth: ManifestAuth,
    #[serde(default)]
    pub tls: TlsOptions,
    /// Optional: default headers merged into every request.
    #[serde(default)]
    pub defaults: ManifestDefaults,
    /// URL or filesystem path to an OpenAPI 3.x spec. Present means the
    /// endpoint catalog is populated by the OpenAPI importer.
    #[serde(default)]
    pub openapi_url: Option<String>,
    /// Optional: inline endpoint list (used when no OpenAPI spec is available
    /// or to override / augment the spec).
    #[serde(default)]
    pub endpoints: Vec<ManifestEndpoint>,
}

fn default_schema_version() -> u32 {
    SCHEMA_VERSION
}

/// Auth strategies at the manifest level. Mirrors the wire-level
/// [`crate::api_runner::ApiAuth`] enum but is the user-editable YAML shape.
/// All seven variants from Step 5 are supported here so built-in target
/// manifests can declare `token_login` / `session_cookie` / `hook` directly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[derive(Default)]
pub enum ManifestAuth {
    #[default]
    None,
    Header {
        header_name: String,
        value: String,
    },
    Basic {
        username: String,
        password: String,
    },
    Bearer {
        token: String,
    },
    TokenLogin {
        login: ManifestTokenLogin,
        apply: ManifestTokenApply,
        #[serde(default)]
        refresh_on_status: Vec<u16>,
    },
    SessionCookie {
        login: ManifestSessionCookieLogin,
    },
    Hook {
        module: String,
        function: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManifestTokenLogin {
    pub method: String,
    pub url: String,
    pub credentials: ManifestLoginCredentials,
    pub token_jsonpath: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManifestSessionCookieLogin {
    pub method: String,
    pub url: String,
    pub credentials: ManifestLoginCredentials,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ManifestLoginCredentials {
    Basic {
        username: String,
        password: String,
    },
    JsonBody {
        body: String,
    },
    /// application/x-www-form-urlencoded body, e.g. SNA's
    /// `username=...&password=...` login.
    FormBody {
        body: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ManifestTokenApply {
    Header { name: String },
    Bearer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TlsOptions {
    /// Default `true` — verify certs. Set false for self-signed labs.
    #[serde(default = "default_true")]
    pub verify: bool,
    /// Optional path to a custom CA bundle (PEM).
    #[serde(default)]
    pub ca_bundle: Option<String>,
    /// Optional path to a client-cert bundle (PEM) for mTLS.
    #[serde(default)]
    pub client_cert: Option<String>,
}

impl Default for TlsOptions {
    fn default() -> Self {
        Self {
            verify: true,
            ca_bundle: None,
            client_cert: None,
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManifestDefaults {
    /// Always-applied headers. Per-request headers override these.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManifestEndpoint {
    /// Stable id within the target. If omitted, the loader synthesizes one
    /// from `method + path`.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
}

// ---- Summary / catalog structs returned to the frontend ------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TargetSummary {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    /// `true` = builtin (read-only), `false` = user-added.
    pub builtin: bool,
    pub has_openapi: bool,
    pub endpoint_count: usize,
}

/// Endpoint entry as surfaced to the frontend. Synthesized either from the
/// manifest's inline list or from an OpenAPI spec (see `openapi.rs`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Endpoint {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub method: String,
    pub path: String,
    /// Path parameters (e.g. `organizationId` in `/organizations/{orgId}`).
    #[serde(default)]
    pub path_params: Vec<String>,
    /// Query parameters: name → default value (empty string if no default).
    #[serde(default)]
    pub query_params: BTreeMap<String, String>,
}

// ---- Parsing + loading ----------------------------------------------------

/// Parse a manifest from a YAML string.
pub fn parse_manifest(yaml: &str) -> Result<TargetManifest> {
    // `serde_yaml::from_str` uses the safe loader by default; we additionally
    // reject any document that contains an explicit YAML tag directive or
    // binary tag to harden against attacker-controlled files.
    if yaml.contains("!!python/") || yaml.contains("!!binary") {
        return Err(anyhow!("manifest contains disallowed YAML tag"));
    }
    let manifest: TargetManifest = serde_yaml::from_str(yaml).context("parse target manifest")?;
    if manifest.schema_version > SCHEMA_VERSION {
        return Err(anyhow!(
            "manifest schema_version {} is newer than supported ({})",
            manifest.schema_version,
            SCHEMA_VERSION
        ));
    }
    if manifest.id.is_empty() {
        return Err(anyhow!("manifest.id must be non-empty"));
    }
    if manifest.display_name.is_empty() {
        return Err(anyhow!("manifest.display_name must be non-empty"));
    }
    if manifest.base_url.is_empty() {
        return Err(anyhow!("manifest.base_url must be non-empty"));
    }
    Ok(manifest)
}

/// Load and parse one manifest from disk.
pub fn load_manifest(path: &Path) -> Result<TargetManifest> {
    let yaml = std::fs::read_to_string(path)
        .with_context(|| format!("read manifest file {}", path.display()))?;
    parse_manifest(&yaml)
}

/// Scan a directory non-recursively for `*.yaml` / `*.yml` manifests.
/// Returns `(manifest, source_path)` pairs. Files that fail to parse are
/// logged via `tracing::warn` and skipped rather than aborting the whole scan.
pub fn load_dir(dir: &Path) -> Result<Vec<(TargetManifest, PathBuf)>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).with_context(|| format!("read_dir {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "yaml" && ext != "yml" {
            continue;
        }
        match load_manifest(&path) {
            Ok(m) => out.push((m, path)),
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "skipping bad manifest");
            }
        }
    }
    // Stable ordering by id makes `api_list_targets` deterministic for tests.
    out.sort_by(|a, b| a.0.id.cmp(&b.0.id));
    Ok(out)
}

/// Derive endpoint catalog from an inline manifest list only.
/// OpenAPI-driven catalogs go through `openapi::load_catalog` and are merged
/// in the command layer (see `api_runner::catalog_for_target`).
pub fn endpoints_from_manifest(m: &TargetManifest) -> Vec<Endpoint> {
    m.endpoints
        .iter()
        .map(|e| {
            let id =
                e.id.clone()
                    .unwrap_or_else(|| synth_endpoint_id(&e.method, &e.path));
            let path_params = extract_path_params(&e.path);
            Endpoint {
                id,
                name: e.name.clone(),
                description: e.description.clone(),
                method: e.method.to_uppercase(),
                path: e.path.clone(),
                path_params,
                query_params: e.query.clone(),
            }
        })
        .collect()
}

/// `{foo}` `/orgs/{organizationId}/networks` → `["organizationId"]`.
pub fn extract_path_params(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && bytes[j] != b'}' {
                j += 1;
            }
            if j < bytes.len() {
                if let Ok(name) = std::str::from_utf8(&bytes[start..j]) {
                    if !name.is_empty() {
                        out.push(name.to_string());
                    }
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Derive a stable endpoint id like `GET__orgs__orgId__networks` when the
/// manifest/OpenAPI source doesn't provide an explicit `operationId`.
/// The shape is stable across scans: same method+path → same id.
pub fn synth_endpoint_id(method: &str, path: &str) -> String {
    let method = method.to_ascii_uppercase();
    let cleaned: String = path
        .chars()
        .map(|c| match c {
            '/' => '_',
            '{' | '}' => '_',
            c if c.is_ascii_alphanumeric() || c == '-' || c == '_' => c,
            _ => '_',
        })
        .collect();
    // Collapse runs of '_' to a single '_', trim edges.
    let mut collapsed = String::with_capacity(cleaned.len());
    let mut prev_underscore = false;
    for c in cleaned.chars() {
        if c == '_' {
            if !prev_underscore {
                collapsed.push(c);
            }
            prev_underscore = true;
        } else {
            collapsed.push(c);
            prev_underscore = false;
        }
    }
    let trimmed = collapsed.trim_matches('_');
    format!("{method}__{trimmed}")
}
