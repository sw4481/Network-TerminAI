//! Serde types shared by the executor, Tauri commands, and history storage.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// HTTP method, accepted case-insensitively from the frontend.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Head,
    Options,
}

impl HttpMethod {
    pub fn as_reqwest(self) -> reqwest::Method {
        match self {
            Self::Get => reqwest::Method::GET,
            Self::Post => reqwest::Method::POST,
            Self::Put => reqwest::Method::PUT,
            Self::Patch => reqwest::Method::PATCH,
            Self::Delete => reqwest::Method::DELETE,
            Self::Head => reqwest::Method::HEAD,
            Self::Options => reqwest::Method::OPTIONS,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
            Self::Head => "HEAD",
            Self::Options => "OPTIONS",
        }
    }
}

/// How the request body should be interpreted.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BodyKind {
    None,
    /// `body_text` is a JSON document. Sent with Content-Type application/json
    /// unless the user supplied their own Content-Type header.
    Json,
    /// `body_text` is already-rendered `key1=value1&key2=value2`.
    /// Sent with Content-Type application/x-www-form-urlencoded.
    Form,
    /// Arbitrary text (user picks Content-Type). Sent as UTF-8 bytes.
    Text,
    /// Arbitrary bytes. `body_bytes` is used instead of `body_text`.
    Binary,
}

/// Built-in auth strategies. Step 5 fills out the stateful ones.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[derive(Default)]
pub enum ApiAuth {
    #[default]
    None,
    /// Add a single header with a fixed name/value (e.g. Meraki).
    Header { name: String, value: String },
    /// HTTP Basic authentication.
    Basic { username: String, password: String },
    /// Static Bearer token.
    Bearer { token: String },
    /// Cisco Catalyst Center / DNA-C style: POST creds to a login path,
    /// extract a token from the response, apply it as a header on every
    /// subsequent call. Cached per (target,env). Refreshed automatically
    /// on any of `refresh_on_status` (default [401]).
    TokenLogin {
        /// Login endpoint spec.
        login: TokenLoginEndpoint,
        /// How the token is attached to subsequent requests.
        apply: TokenApply,
        /// Status codes that should trigger a single refresh+retry.
        /// Empty → [401].
        #[serde(default)]
        refresh_on_status: Vec<u16>,
    },
    /// NDFC / vManage / ISE-config style: POST creds once, rely on the
    /// server setting a Set-Cookie that we keep in a cookie jar. Cached
    /// per (target,env).
    SessionCookie { login: SessionCookieLogin },
    /// Escape hatch: call a Python function in the sidecar to produce
    /// whatever exotic auth the target needs (Intersight HMAC-SHA256, etc.).
    Hook {
        /// Module file basename inside `~/.ccie-terminal/api-hooks/`.
        module: String,
        /// Function name to invoke. Must accept `(request_dict, env_dict)`.
        function: String,
    },
}

/// Defines how to call the login endpoint for a TokenLogin auth.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenLoginEndpoint {
    /// HTTP method for the login call, usually POST.
    pub method: HttpMethod,
    /// URL (may be relative to the main request's base_url, or absolute).
    pub url: String,
    /// Credentials to send. `Basic` is the DNA-C convention; `body`
    /// accepts a JSON template.
    pub credentials: TokenLoginCredentials,
    /// JSONPath or dotted key path used to extract the token from the
    /// login response body. Examples: `$.Token`, `token`, `data.accessToken`.
    pub token_jsonpath: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TokenLoginCredentials {
    /// HTTP Basic on the login request.
    Basic { username: String, password: String },
    /// POST a JSON body. Caller writes the full JSON literally; the
    /// resolver substitutes `${env:X}` / `${var:X}` before send.
    JsonBody { body: String },
    /// POST an application/x-www-form-urlencoded body. Cisco SNA and
    /// some legacy appliance auth endpoints expect this shape. The
    /// `body` is literal, e.g. `"username=${env:U}&password=${env:P}"`.
    FormBody { body: String },
}

/// How the fetched token is applied to subsequent requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum TokenApply {
    /// Send as a custom header (e.g. DNA-C `X-Auth-Token: <token>`).
    Header { name: String },
    /// Send as `Authorization: Bearer <token>`.
    Bearer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCookieLogin {
    pub method: HttpMethod,
    pub url: String,
    pub credentials: TokenLoginCredentials,
}

/// One HTTP request, sent by `api_send_request`.
///
/// Query and header maps are ordered (`BTreeMap`) so serialized history rows
/// are deterministic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiRequest {
    pub method: HttpMethod,
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    #[serde(default)]
    pub body_kind: BodyKindDefault,
    #[serde(default)]
    pub body_text: Option<String>,
    #[serde(default, with = "opt_bytes_as_base64")]
    pub body_bytes: Option<Vec<u8>>,
    #[serde(default)]
    pub auth: ApiAuth,
    /// Request timeout in seconds. Defaults to 30s when absent.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Skip TLS verification (self-signed Cisco gear). Default false.
    #[serde(default)]
    pub insecure_skip_verify: bool,
    /// Optional path to a custom CA bundle (PEM). Supersedes system roots
    /// only when set; system roots remain trusted.
    #[serde(default)]
    pub tls_ca_bundle: Option<String>,
    /// Optional PEM containing a client certificate + private key for mTLS.
    #[serde(default)]
    pub tls_client_cert: Option<String>,
}

/// Serde helper so `BodyKind::None` is the default when the field is omitted.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct BodyKindDefault(pub BodyKind);

impl Default for BodyKindDefault {
    fn default() -> Self {
        Self(BodyKind::None)
    }
}

impl From<BodyKind> for BodyKindDefault {
    fn from(k: BodyKind) -> Self {
        Self(k)
    }
}

/// Response returned to the frontend. Body is capped at `MAX_RESPONSE_BODY`
/// bytes; if the wire body was larger, `body_truncated` is set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse {
    pub status_code: u16,
    pub status_text: String,
    pub headers: BTreeMap<String, String>,
    #[serde(with = "bytes_as_base64")]
    pub body: Vec<u8>,
    pub body_truncated: bool,
    pub duration_ms: u64,
    /// Final URL after any redirects.
    pub final_url: String,
    /// Non-empty when the HTTP request itself failed (DNS, timeout, connect).
    /// In that case `status_code` is 0 and other fields are best-effort.
    pub error: Option<String>,
}

/// Maximum body size stored in-memory / returned to the frontend. Larger
/// bodies get streamed to a temp file in a later step; for Step 2 we simply
/// truncate and flag.
pub const MAX_RESPONSE_BODY: usize = 10 * 1024 * 1024;

/// Default request timeout when the caller doesn't override.
pub const DEFAULT_TIMEOUT_SECS: u64 = 30;

// ---- serde helpers --------------------------------------------------------

mod bytes_as_base64 {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD
            .decode(s.as_bytes())
            .map_err(serde::de::Error::custom)
    }
}

mod opt_bytes_as_base64 {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(b) => s.serialize_str(&STANDARD.encode(b)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        let opt = Option::<String>::deserialize(d)?;
        match opt {
            Some(s) => STANDARD
                .decode(s.as_bytes())
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}
