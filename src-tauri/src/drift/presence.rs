//! Presence matcher (Catalyst-Center-style "partial" intent mode).
//!
//! Unlike `diff.rs` (a symmetric two-way diff of the whole intent vs the whole
//! running-config), this judges ONLY the lines the intent declares:
//!   - intended line present verbatim (under its parent block) → OK (dropped)
//!   - same command, different trailing value                  → Changed
//!   - not found at all                                        → Missing
//! Device config the intent doesn't mention is ignored entirely.

use crate::drift::diff::{DriftBlock, DriftPatch, DriftSeverity, DriftStats, LineChange};
use std::collections::BTreeMap;

/// Parse config text into (parent_block, own_line) pairs. A non-indented
/// block header (interface/router/…) starts a new parent; indented lines
/// belong to the most recent header. Blank and bare `!` lines are skipped.
/// Mirrors the header rules in `diff::is_block_header`.
fn parse_blocks(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut current = "<root>".to_string();
    for raw in text.lines() {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed == "!" {
            continue;
        }
        let indented = raw.starts_with(' ') || raw.starts_with('\t');
        if !indented && is_block_header(trimmed) {
            current = trimmed.to_string();
            // The header line itself is also a matchable intended line.
            out.push(("<root>".to_string(), trimmed.to_string()));
        } else if indented {
            out.push((current.clone(), trimmed.to_string()));
        } else {
            // Top-level non-header line (e.g. `hostname R1`).
            out.push(("<root>".to_string(), trimmed.to_string()));
        }
    }
    out
}

/// Copy of diff.rs's header rule (kept local to avoid widening that module's
/// public surface). If diff.rs later exposes `is_block_header`, switch to it.
fn is_block_header(line: &str) -> bool {
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    let lc = line.to_ascii_lowercase();
    let ios_prefixes = [
        "interface ", "router ", "ip access-list ", "ipv6 access-list ",
        "vrf definition ", "class-map ", "policy-map ", "line vty",
        "line con", "line aux", "route-map ", "crypto ", "aaa ",
        "ip prefix-list ", "ip community-list ", "object-group ",
    ];
    if ios_prefixes.iter().any(|p| lc.starts_with(p)) {
        return true;
    }
    let trimmed = line.trim_end();
    if let Some(stripped) = trimmed.strip_suffix('{') {
        let head = stripped.trim();
        if !head.is_empty() && !head.contains(' ') {
            return true;
        }
    }
    false
}

/// The stable "command key" of a line = all tokens except a trailing value
/// run. We extract the command prefix by finding where the "value tail" starts.
/// A value tail is a run of tokens that look like values (numbers, IPs, etc.).
/// For commands like "metric weights 0 1 2 3 4 5", the key is "metric weights".
/// Conservative: if no clear value tail is detected, the whole line is the key.
fn command_key(line: &str) -> String {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() <= 1 {
        return line.to_string();
    }

    // Find the first token that looks like a value from the right
    let mut key_end = tokens.len();
    for (i, token) in tokens.iter().enumerate().rev() {
        if is_value_token(token) {
            key_end = i;
        } else {
            // Hit a non-value token, stop scanning
            break;
        }
    }

    // If all tokens are values or no values found, use the whole line
    if key_end == 0 || key_end == tokens.len() {
        return line.to_string();
    }

    // Reconstruct the key from tokens up to key_end
    tokens[..key_end].join(" ")
}

/// Check if a token looks like a value (number, IP address, etc.)
fn is_value_token(token: &str) -> bool {
    // Numbers (including floats)
    if token.chars().all(|c| c.is_numeric() || c == '.') {
        return true;
    }
    // IP addresses or network masks
    if token.contains('.') && token.split('.').all(|part| part.parse::<u8>().is_ok()) {
        return true;
    }
    false
}

pub fn match_intent_presence(intent: &str, running: &str) -> DriftPatch {
    let running_pairs = parse_blocks(running);
    // Index running lines by (block, full line) for exact hits, and by
    // (block, command_key) for change detection.
    let mut exact: BTreeMap<(String, String), ()> = BTreeMap::new();
    let mut by_key: BTreeMap<(String, String), String> = BTreeMap::new();
    for (block, line) in &running_pairs {
        exact.insert((block.clone(), line.clone()), ());
        by_key
            .entry((block.clone(), command_key(line)))
            .or_insert_with(|| line.clone());
    }

    let intent_pairs = parse_blocks(intent);
    // Group changes by block, preserving intent order.
    let mut blocks_map: Vec<(String, Vec<LineChange>, usize, usize)> = Vec::new();
    let find_block = |blocks: &mut Vec<(String, Vec<LineChange>, usize, usize)>, name: &str| -> usize {
        if let Some(i) = blocks.iter().position(|(b, _, _, _)| b == name) {
            i
        } else {
            blocks.push((name.to_string(), Vec::new(), 0, 0));
            blocks.len() - 1
        }
    };

    let mut total_add = 0usize; // Missing
    let mut total_del = 0usize; // Changed

    for (block, line) in &intent_pairs {
        if exact.contains_key(&(block.clone(), line.clone())) {
            continue; // OK — present verbatim
        }
        let key = command_key(line);
        // Only treat as Changed if the command key exists in the SAME block
        // and the key is a strict prefix (i.e. there IS a value tail).
        let has_value_tail = key != *line;
        if has_value_tail && by_key.contains_key(&(block.clone(), key.clone())) {
            // Changed: intended value differs from device value.
            let idx = find_block(&mut blocks_map, block);
            blocks_map[idx].1.push(LineChange::Delete { line: line.clone() });
            blocks_map[idx].3 += 1;
            total_del += 1;
        } else {
            // Missing: not present at all.
            let idx = find_block(&mut blocks_map, block);
            blocks_map[idx].1.push(LineChange::Insert { line: line.clone() });
            blocks_map[idx].2 += 1;
            total_add += 1;
        }
    }

    let blocks: Vec<DriftBlock> = blocks_map
        .into_iter()
        .map(|(block_path, changes, adds, dels)| {
            let severity = if adds > 0 {
                DriftSeverity::Destructive
            } else if dels > 0 {
                DriftSeverity::Additive
            } else {
                DriftSeverity::None
            };
            DriftBlock { block_path, changes, severity }
        })
        .collect();

    let overall = if total_add == 0 && total_del == 0 {
        DriftSeverity::None
    } else if total_add > 0 {
        // Missing (a declared line absent) is the serious case → destructive.
        DriftSeverity::Destructive
    } else {
        DriftSeverity::Additive
    };
    let status = if matches!(overall, DriftSeverity::None) { "in_sync" } else { "drift" };

    DriftPatch {
        status: status.to_string(),
        severity: overall,
        stats: DriftStats {
            additions: total_add,
            deletions: total_del,
            blocks_changed: blocks.len(),
        },
        blocks,
    }
}
