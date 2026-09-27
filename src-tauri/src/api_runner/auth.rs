//! Request-authentication strategies. Step 2 implements the three static
//! forms (header / basic / bearer). Token-login and session-cookie flows
//! land in Step 5.

use super::types::ApiAuth;
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};

/// Apply the chosen auth strategy to an outgoing header map.
///
/// Returns `Ok(())` on success, or a descriptive error if a field
/// was malformed (e.g. header name with illegal characters).
pub fn apply_auth(auth: &ApiAuth, headers: &mut HeaderMap) -> Result<()> {
    match auth {
        ApiAuth::None => Ok(()),
        ApiAuth::Header { name, value } => {
            let header_name = HeaderName::from_bytes(name.as_bytes())
                .with_context(|| format!("invalid auth header name: {name:?}"))?;
            let header_value = HeaderValue::from_str(value)
                .with_context(|| format!("invalid auth header value for {name:?}"))?;
            headers.insert(header_name, header_value);
            Ok(())
        }
        ApiAuth::Basic { username, password } => {
            // RFC 7617: base64(username:password). Username must not contain
            // a colon; reject early with a clear error.
            if username.contains(':') {
                anyhow::bail!("HTTP Basic username cannot contain ':'");
            }
            let credentials = format!("{username}:{password}");
            let encoded = STANDARD.encode(credentials);
            let value = HeaderValue::from_str(&format!("Basic {encoded}"))
                .context("failed to build Basic auth header")?;
            headers.insert(AUTHORIZATION, value);
            Ok(())
        }
        ApiAuth::Bearer { token } => {
            let value = HeaderValue::from_str(&format!("Bearer {token}"))
                .context("failed to build Bearer auth header")?;
            headers.insert(AUTHORIZATION, value);
            Ok(())
        }
        // Stateful variants are resolved into a concrete header by the
        // auth_state module BEFORE execute_request runs. If one leaks
        // through, that's a programming error — fail loudly.
        ApiAuth::TokenLogin { .. } => {
            anyhow::bail!("TokenLogin must be resolved by auth_state before apply_auth")
        }
        ApiAuth::SessionCookie { .. } => {
            anyhow::bail!("SessionCookie must be resolved by auth_state before apply_auth")
        }
        ApiAuth::Hook { .. } => {
            anyhow::bail!("Hook must be resolved by auth_state before apply_auth")
        }
    }
}
