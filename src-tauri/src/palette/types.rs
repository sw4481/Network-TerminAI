//! Public types for palette search.
//!
//! [`PaletteKind`] uses serde lowercase so it round-trips with the TS union
//! `'command' | 'workflow' | 'notebook' | 'device' | 'block' | 'ssh'`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaletteKind {
    Command,
    Workflow,
    Notebook,
    Device,
    Block,
    Ssh,
}

impl PaletteKind {
    /// Stable string used as `palette_usage.target_type`. Must stay in sync
    /// with the lowercase serde rename.
    pub fn as_target_type(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Workflow => "workflow",
            Self::Notebook => "notebook",
            Self::Device => "device",
            Self::Block => "block",
            Self::Ssh => "ssh",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteScope {
    Tab,
    Device,
    Global,
}

impl PaletteScope {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "tab" => Some(Self::Tab),
            "device" => Some(Self::Device),
            "global" => Some(Self::Global),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PaletteHit {
    pub kind: PaletteKind,
    pub target_id: String,
    pub title: String,
    pub subtitle: Option<String>,
    /// Source-native score (higher = better). FTS rows pre-convert BM25 ranks
    /// to `1/(1+bm25)`; non-FTS rows use a flat `1.0`.
    pub score: f64,
    /// Populated by [`super::search::run`] from `palette_usage`. Phase 1
    /// always leaves this at 0.0; Phase 3 fills it in.
    pub recency_boost: f64,
    pub frequency_boost: f64,
    pub meta: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PaletteSearchArgs {
    pub query: String,
    pub scope: String, // "tab" | "device" | "global"
    pub active_tab_id: Option<String>,
    pub active_device_id: Option<String>,
    pub kind_filter: Option<PaletteKind>,
    pub limit: usize,
}
