//! Streaming redactor for session recordings.
//!
//! Invariant: `feed(input).len() == input.len()`. Replaced bytes are
//! overwritten 1:1 with `*` (ASCII) so cast timing stays faithful and
//! the byte stream remains length-preserving for asciinema's downstream
//! tooling.
//!
//! Cross-chunk matching: each call stitches the previous chunk's tail
//! (last `HOLDBACK_BYTES`) onto the new input, runs the pattern set
//! against the stitched buffer, and emits the bytes corresponding to the
//! new input. The held tail is then refreshed from the current input.
//! Pattern hits that fall in the held tail re-fire and are deduped by
//! offset.

use crate::recording::patterns::BUILTIN;
use regex::bytes::{Regex, RegexSet};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use thiserror::Error;

const HOLDBACK_BYTES: usize = 256;
const REPLACEMENT_BYTE: u8 = b'*';

#[derive(Debug, Error)]
pub enum RedactorError {
    #[error("regex compile error: {0}")]
    Compile(String),
}

#[derive(Debug, Clone)]
pub struct UserPattern {
    pub id: String,
    pub regex: String,
}

#[derive(Debug, Clone)]
pub struct PatternMatchSummary {
    pub pattern_id: String,
    pub matches: u64,
    pub replacement_hash: String,
}

struct CompiledPattern {
    id: String,
    re: Regex,
}

impl std::fmt::Debug for CompiledPattern {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompiledPattern")
            .field("id", &self.id)
            .finish()
    }
}

#[derive(Debug)]
pub struct Redactor {
    patterns: Vec<CompiledPattern>,
    audit: HashMap<String, u64>,
    /// Last up-to-`HOLDBACK_BYTES` bytes of the previous chunk's INPUT
    /// (not output), kept so cross-chunk patterns can be detected.
    prev_tail: Vec<u8>,
    /// Set when an `ssh_password_prompt` pattern fires; bytes after the
    /// prompt up to the next CR/LF (or `mask_budget_remaining` exhaustion)
    /// are masked to defeat keystroke echoing.
    masking_active: bool,
    /// Combined-buffer offset (relative to `combined` in the next `feed`)
    /// from which masking should begin. Set to `prev_len + N` when the
    /// prompt match ends inside the new region.
    masking_start_from: usize,
    mask_budget_remaining: usize,
}

impl Redactor {
    pub fn new(user_patterns: &[UserPattern]) -> Result<Self, RedactorError> {
        let mut patterns: Vec<CompiledPattern> =
            Vec::with_capacity(BUILTIN.len() + user_patterns.len());
        for (id, src) in BUILTIN {
            let re = Regex::new(src).map_err(|e| RedactorError::Compile(format!("{id}: {e}")))?;
            patterns.push(CompiledPattern {
                id: (*id).to_string(),
                re,
            });
        }
        for p in user_patterns {
            if p.regex.is_empty() {
                return Err(RedactorError::Compile(format!(
                    "user/{}: empty regex",
                    p.id
                )));
            }
            let re = Regex::new(&p.regex)
                .map_err(|e| RedactorError::Compile(format!("user/{}: {}", p.id, e)))?;
            patterns.push(CompiledPattern {
                id: p.id.clone(),
                re,
            });
        }
        // Validate via RegexSet so we fail fast on obviously broken sets.
        let _ = RegexSet::new(BUILTIN.iter().map(|(_, r)| *r))
            .map_err(|e| RedactorError::Compile(e.to_string()))?;
        Ok(Self {
            patterns,
            audit: HashMap::new(),
            prev_tail: Vec::new(),
            masking_active: false,
            masking_start_from: 0,
            mask_budget_remaining: 0,
        })
    }

    pub fn feed(&mut self, input: &[u8]) -> Vec<u8> {
        if input.is_empty() {
            return Vec::new();
        }
        let prev_len = self.prev_tail.len();
        let mut combined = Vec::with_capacity(prev_len + input.len());
        combined.extend_from_slice(&self.prev_tail);
        combined.extend_from_slice(input);

        // Build a mask: positions that should be replaced with `*`.
        let mut mask = vec![false; combined.len()];

        for cp in &self.patterns {
            let mut hits: u64 = 0;
            for caps in cp.re.captures_iter(&combined) {
                let target = caps.get(1).unwrap_or_else(|| caps.get(0).unwrap());
                let start = target.start();
                let end = target.end();
                if start == end {
                    // Zero-width match: skip to avoid infinite-loop concerns.
                    continue;
                }
                // Only count this hit if the matched span lies at least
                // partly in the new input region (>= prev_len). Hits
                // wholly inside the prev_tail were already counted on the
                // previous call.
                if end > prev_len {
                    hits += 1;
                }
                for masked in mask.iter_mut().take(end).skip(start) {
                    *masked = true;
                }
                if cp.id == "ssh_password_prompt" {
                    self.masking_active = true;
                    self.mask_budget_remaining = 4096;
                    // Begin masking immediately AFTER the prompt's match.
                    // If the prompt straddled the holdback (start <
                    // prev_len), start from prev_len so we don't try to
                    // mutate already-emitted bytes.
                    self.masking_start_from = end.max(prev_len);
                }
            }
            if hits > 0 {
                *self.audit.entry(cp.id.clone()).or_insert(0) += hits;
            }
        }

        // Apply state-machine masking after the prompt: starting at
        // `masking_start_from` (the byte right after the prompt's match
        // end), mask everything up to CR/LF or budget exhaustion.
        if self.masking_active {
            let start = self.masking_start_from.max(prev_len);
            for i in start..combined.len() {
                if !self.masking_active {
                    break;
                }
                let b = combined[i];
                if b == b'\n' || b == b'\r' {
                    self.masking_active = false;
                    self.mask_budget_remaining = 0;
                    continue;
                }
                if self.mask_budget_remaining == 0 {
                    self.masking_active = false;
                    break;
                }
                self.mask_budget_remaining -= 1;
                if !mask[i] {
                    mask[i] = true;
                    *self
                        .audit
                        .entry("ssh_password_body".to_string())
                        .or_insert(0) += 1;
                }
            }
            // If we're still masking at end-of-buffer, the next chunk
            // should pick up immediately.
            self.masking_start_from = combined.len();
        }

        // Build redacted combined buffer.
        for (i, b) in combined.iter_mut().enumerate() {
            if mask[i] {
                *b = REPLACEMENT_BYTE;
            }
        }

        // Output: the bytes corresponding to NEW input only.
        let out: Vec<u8> = combined[prev_len..].to_vec();

        // Update prev_tail from the new input (last HOLDBACK bytes of the
        // *original* input, not the redacted output, so cross-chunk
        // matches can still find substrings).
        let tail_start = input.len().saturating_sub(HOLDBACK_BYTES);
        self.prev_tail = input[tail_start..].to_vec();
        // Apply any masks already determined for those positions to keep
        // the count correct on the next call (the held tail is rerun with
        // matches that finish in the new region, but masks already set
        // here should be preserved). Simpler: just store the original
        // bytes and let next-feed redact again.

        out
    }

    pub fn drain_audit(&mut self) -> Vec<PatternMatchSummary> {
        let mut hasher = Sha256::new();
        hasher.update([REPLACEMENT_BYTE]);
        let replacement_hash = hex::encode(hasher.finalize());
        let mut out = Vec::with_capacity(self.audit.len());
        for (id, n) in self.audit.drain() {
            out.push(PatternMatchSummary {
                pattern_id: id,
                matches: n,
                replacement_hash: replacement_hash.clone(),
            });
        }
        out.sort_by(|a, b| a.pattern_id.cmp(&b.pattern_id));
        out
    }

    pub fn audit_snapshot(&self) -> Vec<PatternMatchSummary> {
        let mut hasher = Sha256::new();
        hasher.update([REPLACEMENT_BYTE]);
        let replacement_hash = hex::encode(hasher.finalize());
        let mut out: Vec<PatternMatchSummary> = self
            .audit
            .iter()
            .map(|(id, n)| PatternMatchSummary {
                pattern_id: id.clone(),
                matches: *n,
                replacement_hash: replacement_hash.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.pattern_id.cmp(&b.pattern_id));
        out
    }
}
