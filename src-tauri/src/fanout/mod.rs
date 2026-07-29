//! Multi-device fan-out (Plan 07).
//!
//! Lets the user execute one read-only command across up to 50 SSH/NETCONF
//! devices concurrently, persists per-device results, and surfaces a merged
//! diff view that highlights minority-value outliers.

pub mod auth;
pub mod events;
pub mod executor;
pub mod export;
pub mod model;
pub mod store;
pub mod worker;
pub mod worker_live;
