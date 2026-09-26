//! Configuration intent + drift detection (Plan 08).
//!
//! Lets the engineer declare *intended* configuration for each device — either
//! a pinned golden running-config or a Jinja2 template + variables — then
//! diff that intent against live `show running-config` output.

pub mod archive;
pub mod diff;
pub mod exception;
pub mod intent;
pub mod normalize;
pub mod presence;
pub mod render;
pub mod report;
pub mod runner;
pub mod schedule;
pub mod scheduler;
