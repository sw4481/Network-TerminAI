# CCIE Terminal — Feature Roadmap Plans

> **Index for plan execution.** Read this first. Each plan below is self-contained. Execute in the order shown unless a dependency note says otherwise.

Created 2026-05-13.

## Execution conventions (applies to every plan)

1. **Plan location.** All plans live here in `/Plans`. When a phase is complete, update the plan's checkbox list AND append a `## Phase N — COMPLETED YYYY-MM-DD` block at the bottom with a 2-3 line summary so a fresh session can pick up without re-reading everything.

2. **Parallel sub-phase execution.** Within a phase, sub-tasks labeled `1.1`, `1.2`, `1.3` that are marked `PARALLEL` have no shared mutable state — dispatch them simultaneously via the `Agent` tool (`subagent_type: general-purpose`) in a single message. Sub-tasks labeled `SEQUENTIAL` depend on prior sub-task output and must run one at a time.

3. **Regression testing per phase.** Every phase ends with a `Regression` task that runs:
   ```bash
   bun run test          # Vitest unit/integration
   cargo test --manifest-path src-tauri/Cargo.toml
   bunx playwright test --grep @smoke   # Playwright smoke E2E
   ```
   A phase is NOT complete until all three are green.

4. **Code review per phase.** After regression passes, dispatch the `feature-dev:code-reviewer` subagent over the phase's diff. Fix any `must-fix` findings before advancing.

5. **UI/UX review (for UI phases).** Dispatch the `frontend-design` skill BEFORE implementation (design spec) and AFTER (screenshot review). Both checkpoints are explicit tasks.

6. **No guessing.** If a task references a vendor command, protocol, or library behavior that is not verified in the codebase, either:
   - Ask the user, OR
   - Run a web search + `mcp__plugin_context7_context7__query-docs` to confirm, then paste the authoritative source into the plan before coding.

7. **Frequent commits.** Every numbered step that changes files ends with a `git commit` step.

8. **Tauri sidecar.** Python parsing (Genie/TextFSM/pyshark) lives in `sidecar/src/ccie_sidecar/` and is invoked via the existing NDJSON protocol. New sidecar modules follow `sidecar/src/ccie_sidecar/<feature>.py` pattern. Packaging: PyInstaller tauri sidecar binary (see Plan 00).

9. **Storage.** SQLite via `rusqlite` with refinery migrations in `src-tauri/migrations/V00XX__*.sql`. Next free migration number: **V0027**. Plans claim migration numbers in sequence as listed below.

## Dependency chain & execution order

```
00 Foundation (sidecar + parsing + DB conventions)
   │
   ├── 01 Command Blocks (core Warp port — many others depend on this)
   │      │
   │      ├── 02 Workflows / Parameterized Commands
   │      ├── 03 Notebooks (runnable MOPs)
   │      ├── 04 Command Palette (Cmd+P)
   │      ├── 05 Structured Show-Output Layer   ◄── uses sidecar (00)
   │      │        │
   │      │        ├── 06 Pre/Post Change Verification
   │      │        ├── 07 Multi-Device Fan-Out
   │      │        ├── 08 Config Intent + Drift
   │      │        └── 11 Packet Capture Panel   ◄── independent, bundled here
   │      │
   │      ├── 09 AI Guardrails (Blast-Radius Analyzer)
   │      ├── 10 Session Restoration per-Device
   │      ├── 12 RAG Tab (Vendor-Aware Completion)
   │      ├── 13 Inline Topology Awareness
   │      ├── 14 Credential Vault + Session Recording
   │      └── 15 AI-Driven Troubleshooting Tree
   │
   └── (Warp Drive-style sharing — deferred; see notes below)
```

## Migration number reservations

| Plan | Migration(s) | Purpose |
|------|--------------|---------|
| 00 Foundation | V0027 | `parsers_cache`, `sidecar_status` |
| 01 Blocks | V0028 | `block_tags`, `block_pins`, `block_shares` |
| 02 Workflows | V0029 | `workflows`, `workflow_params` |
| 03 Notebooks | V0030 | `notebook_cells`, `notebook_runs` |
| 04 Palette | V0031 | `palette_index` (FTS5 external content) |
| 05 Structured | V0032 | `parsed_outputs`, `parse_schema` |
| 06 Pre/Post | V0033 | `change_snapshots`, `change_diffs` |
| 07 Fan-Out | V0034 | `fanout_groups`, `fanout_runs` |
| 08 Drift | V0035 | `intent_templates`, `drift_reports` |
| 09 Guardrails | V0036 | `blast_radius_rules`, `guardrail_decisions` |
| 10 Session Restore | V0037 | `session_chains`, `jump_host_links` |
| 11 Packet Capture | V0038 | `pcap_captures` |
| 12 RAG | V0039 | `rag_documents`, `rag_embeddings`, `rag_tags` |
| 13 Topology | V0040 | `topology_graphs`, `neighbor_cache` |
| 14 Vault | V0041 | `session_recordings`, `recording_redactions` |
| 15 Troubleshooter | V0042 | `troubleshoot_playbooks`, `troubleshoot_runs` |

## Warp Drive (team sharing) — deferred

Team sharing was requested during brainstorm but requires auth/backend infra decisions (self-hosted vs. hosted). Deferred until after Plan 15. Revisit with a dedicated brainstorm session once the local features stabilize.

## Plan list

| # | Title | Status |
|---|-------|--------|
| [00](./00-foundation-sidecar-parsing.md) | Foundation: Python sidecar + parsing pipeline + DB conventions | ✅ Complete (2026-05-14) |
| [01](./01-command-blocks.md) | Command Blocks (collapse/pin/share/tag) | ✅ Complete (2026-05-16) |
| [02](./02-workflows-parameterized.md) | Workflows / parameterized commands | ✅ Complete (2026-05-17) |
| [03](./03-notebooks-runnable-mops.md) | Notebooks — runnable markdown MOPs | ✅ Complete (2026-05-17) |
| [04](./04-command-palette.md) | Command palette (Cmd+P) — fuzzy history | ✅ Complete (2026-05-17) |
| [05](./05-structured-show-output.md) | Structured show-output (Genie + TextFSM dataframe layer) | ✅ Complete (2026-05-18) |
| [06](./06-pre-post-change-verification.md) | Pre/Post change verification (snapshot + diff) | ✅ Complete (2026-05-18) |
| [07](./07-multi-device-fanout.md) | Multi-device fan-out (50 concurrent) | ✅ Complete (2026-05-18) |
| [08](./08-config-intent-drift.md) | Config intent + drift detection | ✅ Complete (2026-05-18) |
| [09](./09-ai-guardrails-blast-radius.md) | AI guardrails — blast-radius analyzer | ✅ Complete (2026-05-18) |
| [10](./10-session-restoration.md) | Session restoration per-device (jump-host chains) | ✅ Complete (2026-05-19) |
| [11](./11-packet-capture-panel.md) | Packet capture panel (IOS-XE monitor capture → pcap inline) | ✅ Complete (2026-05-19) |
| [12](./12-rag-vendor-aware-completion.md) | RAG tab — vendor-aware AI completion | ✅ Complete (2026-05-19) |
| [13](./13-inline-topology-awareness.md) | Inline topology awareness (CDP/LLDP graph) | ✅ Complete (2026-05-19) |
| [14](./14-credential-vault-session-recording.md) | Credential vault + session recording (audit) | ✅ Complete (2026-05-20) |
| [15](./15-ai-troubleshooting-tree.md) | AI-driven troubleshooting tree | ✅ Complete (2026-05-20) |

## How to execute a plan

1. Pick a plan. Confirm its prerequisites (top of file) are complete.
2. Use `superpowers:subagent-driven-development` — fresh subagent per phase.
3. After each phase: regression → code review → UI review (if UI) → **update the plan file's checkboxes + completion block** → commit → next phase.
4. At plan end, update this README's status column to `✅ Complete`.
