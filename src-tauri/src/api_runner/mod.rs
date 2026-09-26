//! API Runner — Postman-like HTTP client tailored for Cisco/networking APIs.
//!
//! Scope (Step 2): raw-mode request execution with three auth strategies
//! (static header, HTTP Basic, Bearer). Target profiles, OpenAPI import,
//! environments, and the remaining auth types (token_login, session_cookie,
//! hook, TLS options) are filled in by later steps.

pub mod auth;
pub mod auth_state;
pub mod catalog;
pub mod env_store;
pub mod executor;
pub mod history;
pub mod manifest;
pub mod openapi;
pub mod postman;
pub mod resolver;
pub mod types;

pub use auth_state::{
    AuthCacheKey, AuthStateStore, DisabledHookRunner, HookRunner, SidecarHookRunner,
};
pub use executor::execute_request;
pub use manifest::{Endpoint, TargetManifest, TargetSummary};
pub use types::{ApiAuth, ApiRequest, ApiResponse, BodyKind};
