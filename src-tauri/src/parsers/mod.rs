//! Structured show-output parsing bridge to the Python sidecar.
//!
//! Flow: Tauri command `parse_show` -> cache lookup -> on miss, call sidecar
//! `parse.request` -> persist result in cache.

pub mod bridge;
pub mod cache;
