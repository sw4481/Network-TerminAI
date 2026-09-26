//! Fan-out runner for palette search.
//!
//! Calls every source in [`super::sources`], merges hits, applies recency
//! + frequency boosts from `palette_usage`, optionally filters by kind, and
//! sorts by composite score before truncating to `args.limit`.
//!
//! ## Scoring
//!
//! - `base_score` is the source-native score (FTS rows pre-convert BM25 to
//!   `1/(1+|bm25|)`; non-FTS rows ship `1.0`).
//! - `recency_boost   = exp(-age_seconds / 86_400)` — half-life ~1 day.
//! - `frequency_boost = log10(1 + use_count) * 0.5` — diminishing returns.
//! - `composite       = base_score * (1 + recency_boost + frequency_boost)`.
//!
//! Hits are then sorted by composite descending. The boosts and the
//! `last_used_at` / `use_count` fields are also injected back into
//! `hit.meta` so the frontend can render the meta column without a second
//! round-trip.

use anyhow::Result;
use rusqlite::Connection;

use super::recent;
use super::sources::{blocks, commands, devices, notebooks, ssh, workflows};
use super::types::{PaletteHit, PaletteKind, PaletteScope, PaletteSearchArgs};
use super::usage;

const ALL_KINDS: [PaletteKind; 6] = [
    PaletteKind::Command,
    PaletteKind::Workflow,
    PaletteKind::Notebook,
    PaletteKind::Device,
    PaletteKind::Block,
    PaletteKind::Ssh,
];

pub fn run(conn: &Connection, args: PaletteSearchArgs) -> Result<Vec<PaletteHit>> {
    let scope = PaletteScope::parse(&args.scope).unwrap_or(PaletteScope::Global);
    let tab = args.active_tab_id.as_deref();
    let dev = args.active_device_id.as_deref();
    let q = args.query.trim();
    let per_source = args.limit.max(10);

    // Empty query — short-circuit to "what did I just do?" view ordered by
    // last_used_at. This skips the source fan-out entirely (none of the
    // sources match an empty query usefully) and returns hits in insertion
    // order from palette_usage.
    if q.is_empty() {
        return recent::top_recent_picks(conn, args.kind_filter, scope, tab, dev, args.limit);
    }

    let mut out: Vec<PaletteHit> = Vec::new();
    for result in [
        commands::search(conn, q, scope, tab, dev, per_source),
        blocks::search_with_device(conn, q, scope, tab, dev, per_source),
        workflows::search(conn, q, scope, tab, dev, per_source),
        notebooks::search(conn, q, scope, tab, dev, per_source),
        devices::search(conn, q, scope, tab, dev, per_source),
        ssh::search(conn, q, scope, per_source),
    ] {
        match result {
            Ok(hits) => out.extend(hits),
            Err(e) => tracing::warn!(?e, "palette source failed — ignoring"),
        }
    }

    if let Some(k) = args.kind_filter {
        out.retain(|h| h.kind == k);
    }

    apply_usage_boosts(conn, &mut out);
    sort_by_composite(&mut out);

    out.truncate(args.limit);
    Ok(out)
}

/// Annotate every hit with `recency_boost` + `frequency_boost` from
/// `palette_usage`, and copy `last_used_at` / `use_count` into `meta` so
/// the frontend can render the time-ago + use-count column without an
/// extra IPC call.
fn apply_usage_boosts(conn: &Connection, hits: &mut [PaletteHit]) {
    use std::collections::HashMap;

    let mut by_kind: HashMap<PaletteKind, HashMap<String, usage::UsageRow>> = HashMap::new();
    for &kind in ALL_KINDS.iter() {
        match usage::map_for_type(conn, kind.as_target_type()) {
            Ok(map) => {
                by_kind.insert(kind, map);
            }
            Err(e) => tracing::warn!(?e, ?kind, "palette_usage lookup failed"),
        }
    }

    let now = unix_now_seconds();
    for hit in hits.iter_mut() {
        let row_opt = by_kind.get(&hit.kind).and_then(|m| m.get(&hit.target_id));
        if let Some(row) = row_opt {
            let age = (now - row.last_used_at).max(0) as f64;
            hit.recency_boost = (-age / 86_400.0).exp();
            hit.frequency_boost = (1.0 + row.use_count as f64).log10() * 0.5;
            // Splice the usage metadata into `hit.meta` so the UI can render
            // it. We avoid clobbering whatever the source already wrote.
            if let serde_json::Value::Object(ref mut map) = hit.meta {
                map.insert(
                    "last_used_at".to_string(),
                    serde_json::Value::from(row.last_used_at),
                );
                map.insert(
                    "use_count".to_string(),
                    serde_json::Value::from(row.use_count),
                );
            }
        }
    }
}

fn sort_by_composite(hits: &mut [PaletteHit]) {
    hits.sort_by(|a, b| {
        let sa = composite_score(a);
        let sb = composite_score(b);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn composite_score(hit: &PaletteHit) -> f64 {
    hit.score * (1.0 + hit.recency_boost + hit.frequency_boost)
}

fn unix_now_seconds() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
