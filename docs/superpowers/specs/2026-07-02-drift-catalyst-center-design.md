# Catalyst-Center-style Drift Detection — Design

**Date:** 2026-07-02
**Status:** Approved (design), pending spec review → implementation plan
**Scope:** Improve config drift detection to behave more like Cisco Catalyst
Center's compliance model. Covers four capabilities: (1) presence/partial
intent matching, (2) three-way Missing/Changed/OK reporting, (3) a versioned
config archive, (4) per-line drift exceptions.

---

## Problem

The current drift engine (`src-tauri/src/drift/diff.rs`) does a **symmetric
two-way text diff** of the *whole intent body* against the *whole
`show running-config`*. When an intent is a small feature snippet (e.g. a
3-line EIGRP config), every other line on the device is reported as a
"deletion from the intent's point of view." A real run against a 3-line EIGRP
intent produced **2,093 false destructive deltas** while the 3 EIGRP lines
actually matched (`equal`).

Catalyst Center avoids this by using **line-presence matching**: it only
judges whether each *intended* line is present/correct in the running config;
config the device has but the intent doesn't mention is ignored. It also keeps
a **versioned config archive** and lets operators **label/except** known
deltas so they stop re-alarming.

This design brings those four behaviors to our drift subsystem.

---

## Current-state references

- Intent model: `src-tauri/src/drift/intent.rs` (`IntentTemplate`, `IntentKind`
  = Golden|Jinja, `IntentSelector`).
- Diff engine: `src-tauri/src/drift/diff.rs`
  (`diff_intent_vs_running`, `nearest_block_header`, severity none/additive/
  destructive).
- Normalization: `src-tauri/src/drift/normalize.rs` (per-vendor drop/redact).
- Runner: `src-tauri/src/drift/runner.rs` (`run_on_demand`: resolve selector →
  fan-out SSH `show running-config` → normalize → diff → store report). Command
  is hardcoded to `show running-config`.
- Reports/schedules: `drift_reports`, `drift_schedules` tables; scheduler in
  `src-tauri/src/drift/scheduler.rs`.
- Remediation UI: `src/components/RemediationDialog.tsx` (push disabled/gated).
- Intent editor UI: `src/components/IntentEditor.tsx`; sidebar
  `src/components/DriftSidebar.tsx`.

---

## Section A — Data model changes

### A1. `match_mode` on `intent_templates`
New column `match_mode TEXT NOT NULL DEFAULT 'baseline'` with two values:

- `baseline` — current whole-config two-way diff (existing behavior).
- `partial` — new presence match (only judges intended lines).

**Migration:** new SQL migration adds the column; **existing rows default to
`baseline`** (zero behavior change for current intents). New intents created in
`IntentEditor` default to `partial`. `match_mode` is independent of the
existing `kind` (Golden/Jinja) — both render paths continue to work in either
mode.

### A2. `config_snapshots` table (the archive)
Columns:
- `id TEXT PRIMARY KEY`
- `device_id TEXT NOT NULL`
- `device_kind TEXT NOT NULL` (`ssh` | `netconf`)
- `vendor TEXT`, `platform TEXT`
- `normalized_config TEXT NOT NULL`
- `captured_at INTEGER NOT NULL`
- `label TEXT` (nullable; labeled snapshots are never auto-evicted)
- `source TEXT NOT NULL` (`drift_run` | `manual`)

Indexes: `(device_id, device_kind, captured_at DESC)`.

**Retention:** on insert, keep the newest ~15 per `(device_id, device_kind)`;
evict the oldest **unlabeled** rows beyond that. **Dedup:** skip the insert if
`normalized_config` is byte-identical to that device's most recent snapshot.

### A3. `drift_exceptions` table
Columns:
- `id TEXT PRIMARY KEY`
- `template_id TEXT NOT NULL` (FK to `intent_templates`)
- `line TEXT NOT NULL` (exact normalized delta line being acknowledged)
- `note TEXT` (nullable)
- `created_at INTEGER NOT NULL`

Index: `(template_id, line)`.

---

## Section B — The presence matcher (items 1 + 2)

New module `src-tauri/src/drift/presence.rs` alongside `diff.rs`.
`runner.rs` branches on `match_mode`:
- `baseline` → existing `diff_intent_vs_running` (untouched).
- `partial` → new `match_intent_presence(intent, running) -> DriftPatch`.

### Algorithm (indent/parent-block aware)
1. Parse both intent and running config into `(parent_block, line)` pairs using
   the existing block-header detection from `diff.rs`
   (`nearest_block_header` / `is_block_header`).
2. For each **intended** line, search within its parent block in the running
   config:
   - **Found verbatim** → `OK` (not surfaced as drift; may render green/equal).
   - **Command prefix matches, trailing value differs** → `Changed`
     (record intended vs actual).
   - **Not found at all** → `Missing`.
3. Device lines **outside** the intent are ignored — never reported.

### "Changed" keying (item 2)
Split a line into `command-key` + `value` at the last stable token boundary.
Pair an intended line with a running line **only** when the command token
sequence up to the differing value matches exactly **within the same parent
block**. If we cannot confidently pair, **fall back to `Missing`** rather than
emit a wrong "Changed". This conservative stance is deliberate — false
"Missing" is safe (operator sees the intended line isn't verbatim present);
false "Changed" would misreport actual values.

### Output & severity
Reuse the existing `DriftPatch`/`DriftBlock` structures, tagging each surfaced
delta as `Missing` or `Changed` (an `OK` line is not surfaced). Map to the
existing `DriftSeverity` enum so the report schema and UI status dots are
unchanged:
- Any `Missing` → `destructive` (device is missing intended config — the
  serious case).
- `Changed` present but no `Missing` → `additive`.
- All intended lines `OK` → `none` → status `in_sync`.

The `error` status remains caller-set as today. No new severity variants are
introduced, so `drift_reports.severity` and the sidebar's color mapping need no
schema change.

### Test coverage
TDD the matcher against EIGRP, ACL, and interface samples, including:
- All intended lines present verbatim → in_sync (the EIGRP regression case).
- One intended line missing → Missing.
- Same command, different value → Changed with correct intended/actual.
- Ambiguous pairing → falls back to Missing (no false Changed).
- Nested/indented lines matched under the correct parent block.

---

## Section C — Config archive (item 3)

### C1. Snapshot on every drift run
In `runner.rs`, after pulling + normalizing each device's running-config (for
**both** modes), write a `config_snapshots` row with `source='drift_run'`
(dedup + retention per A2). Archiving is independent of intent matching, so it
also captures history for `baseline` intents.

### C2. "Snapshot now" (manual capture)
New Tauri command `drift_snapshot_device` that takes a target (SSH connection
id or fan-out group + optional password), SSHes, pulls `show running-config`,
normalizes, and stores a snapshot with `source='manual'` — **without** running
an intent diff. Reuses the SSH path already used by the runner (auto-decrypts
the saved connection password; no prompt).

A **"Snapshot now"** button in `DriftSidebar` invokes it.

### C3. Archive viewer
A panel/section listing a device's snapshots (timestamp, label, source). The
operator can:
- Pick **any two** versions → render a version-vs-version diff (reuse
  `diff_intent_vs_running` or a plain line diff).
- **"Diff latest vs previous"** shortcut.
- **Label / unlabel** a snapshot (labeled = never auto-evicted).

New Tauri commands: list snapshots for a device, get a snapshot's config, diff
two snapshots, set/clear a label. (Delete handled implicitly by retention;
explicit delete optional.)

---

## Section D — Exceptions (item 4) + UI wiring

### D1. Acknowledge a delta
Each `Missing`/`Changed` delta in a report gets an **"Acknowledge"** action →
inserts a `drift_exceptions` row (`template_id` + exact `line` + optional
`note`).

### D2. Runner filtering
When building a report, filter/downgrade any delta whose exact `line` has an
active exception for that `template_id`, so it stops re-alarming. Show a small
"N acknowledged" summary so suppressed items remain discoverable.

### D3. Exception management
A simple list UI to view and remove exceptions (an acknowledgement can be
undone; removing it makes the delta re-alarm on the next run).

### D4. IntentEditor + DriftSidebar
- `IntentEditor`: add a `match_mode` toggle (Baseline / Partial) with a
  one-line explanation of each mode.
- `DriftSidebar`: render `partial`-mode reports grouped as **Missing /
  Changed / OK** (intended-vs-actual shown for Changed); add the Snapshot-now
  button and archive access.

---

## Sequencing (four shippable phases)

Each phase is independently testable; TDD the Rust core.

1. **Presence matcher (B) + `match_mode` field (A1).** Fixes the EIGRP false-
   drift case. Ships the biggest win first.
2. **Config archive (C).** `config_snapshots` schema (A2), snapshot-on-run,
   Snapshot-now command + button, archive viewer + version diff.
3. **Exceptions (D1–D3).** `drift_exceptions` schema (A3), runner filtering,
   acknowledge action, exception management list.
4. **UI polish (D4).** IntentEditor mode toggle, report Missing/Changed/OK
   grouping, wiring loose ends.

---

## Out of scope (YAGNI for now)

- Remediation **push** (still gated by the guardrails plan; dialog stays
  review/copy-only).
- Syslog / config-change-triggered capture (event-driven archive).
- In-band vs out-of-band change attribution (who/how/when).
- Site-hierarchy / device-group binding beyond the existing selector.
- Aggregated compliance dashboard / trends.

These are noted as future follow-ups, not part of this effort.

---

## Risks & mitigations

- **"Changed" pairing heuristic** on unusual commands → mitigated by the
  conservative "fall back to Missing when unsure" rule and sample-based tests.
- **Archive DB growth** → bounded by the ~15/device retention cap with
  identical-consecutive dedup; labeled snapshots are exempt but visible.
- **Behavior change for existing intents** → avoided: `match_mode` defaults
  existing rows to `baseline`; only new intents default to `partial`.
