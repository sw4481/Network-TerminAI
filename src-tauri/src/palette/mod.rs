//! Command palette aggregator (Plan 04).
//!
//! Provides a single search entry point (`search::run`) that fans out across
//! six data sources — commands, command blocks, workflows, runnable
//! notebooks, NETCONF/SSH devices, and saved SSH connections — and returns a
//! ranked, kind-tagged list of [`PaletteHit`]s for the frontend palette.

pub mod recent;
pub mod search;
pub mod sources;
pub mod types;
pub mod usage;
pub mod util;
