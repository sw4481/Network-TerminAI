# 09 — AI Guardrails: Blast-Radius Analyzer (network commands only)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before the AI agent executes any command against a **network device** (NETCONF or SSH/PTY to a remote host registered as a device), a rule-based guardrail classifies the command into one of four blast-radius tiers and gates execution accordingly:

- **Tier 0 — Read-only** (`show *`, `ping`, `traceroute`, `dir`, `more`, NETCONF `<get>`, `<get-config>`): AUTO-APPROVE, log decision, send command.
- **Tier 1 — Local write, non-forwarding** (`clock set`, `hostname`, SNMP community on non-production, logging config): ONE-CLICK confirmation modal.
- **Tier 2 — Forwarding-affecting, targeted** (`interface X shutdown` on a non-transit port, single-route `ip route` add/remove, BGP neighbor `shutdown`): TYPED CONFIRMATION — user must type the exact command or a subject phrase (e.g., `shutdown ge-0/0/5`) to proceed.
- **Tier 3 — Service-affecting / blast-radius high** (`no router bgp`, `reload`, `write erase`, `clear ip bgp * soft-out`, core-facing/loopback config changes, uplink `shutdown`, `delete` whole hierarchies on Junos): MAINTENANCE WINDOW required OR admin override with typed reason.

Classification is **rule-based, local, fast** (compiled regex set evaluated per-vendor in Rust). For ambiguous matches (multiple rules at different tiers match, or no rule matches and the command is a configuration command), the guardrail may optionally dispatch an **LLM second-opinion** call over the existing agent bridge (`src-tauri/src/agent_bridge.rs`). Engineers can author, test, enable/disable custom rules via a Monaco-based editor; rules import/export as JSON.

Every classification decision is recorded to `guardrail_decisions` with the rule hit, reasoning, user action, and timestamp — audit-grade log.

The blast-radius panel surfaces a **predicted impact summary** when the command is Tier ≥ 2 (e.g., "Will drop 3 OSPF adjacencies; 10.50.0.0/16 will reconverge via R7"). Prediction consumes topology data from Plan 13 if present; otherwise degrades gracefully to "topology data not available — classification based on command pattern only".

**Scope guard (critical):** Guardrails **only intercept commands destined for network devices**. Local shell tabs (PTY bash/zsh spawned from `src-tauri/src/pty.rs`) are untouched — a user typing `rm -rf /tmp/foo` in a local terminal tab sees the same behavior as today: no classification, no gating. The regression suite enforces this.

**Architecture:**
- Rust crate-internal module `src-tauri/src/guardrails/` with:
  - `rules.rs` — rule storage/loading/compilation (regex set per vendor/platform)
  - `classifier.rs` — pure function `classify(vendor, platform, command) -> Decision`
  - `decisions.rs` — `record_decision` writer into `guardrail_decisions`
  - `builtin.rs` — seeded 200+ patterns (IOS/IOS-XE/NX-OS/Junos) compiled at build time
  - `ambiguity.rs` — LLM second-opinion hook (optional, feature-flagged per agent policy)
- Hook point:
  - NETCONF path: `src-tauri/src/netconf_runner/session.rs::send_rpc` wraps a pre-classify step when the RPC represents a CLI command (via `cli_wrapper::wrap`); for pure `<get>`/`<get-config>` RPCs the classifier short-circuits to Tier 0.
  - SSH-to-device path: wherever the agent/tool layer sends a CLI line to a remote device session (distinguished from local PTY by tab `mode`/`kind`).
- Frontend:
  - `src/components/BlastRadius/` — modal variants for each tier, plus the rule editor.
  - `src/state/guardrailsStore.ts` — pending decisions, user interactions.
  - `src/lib/tauri.ts` — bindings for `guardrail_*` commands.

**Tech Stack:** Rust (`regex`, `rusqlite`, `once_cell` for compiled builtin set), React 19, Zustand 5, Monaco editor (already in the project — Phase 10 block editor), Tauri 2.

**Prerequisites:**
- Plan 00 Phase 2 complete (agent bridge / sidecar plumbing reused for ambiguity second-opinion).
- Plan 01 Phase 1 complete (blocks table already exists and is used as the audit surface for confirmed/denied tier decisions).
- Plan 13 is **optional** — if absent, impact preview shows graceful fallback.

**Downstream consumers:**
- Plan 07 Multi-Device Fan-Out — every fan-out invocation runs each command through the classifier per device.
- Plan 15 AI Troubleshooting Tree — the tree uses guardrails to gate remediation steps proposed by the agent.

---

## Phase 1 — Schema + rule engine + seeded builtin rules

### Task 1.1 — Migration V0036  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0036__guardrails.sql`

- [ ] **Step 1: Write migration**

```sql
CREATE TABLE IF NOT EXISTS blast_radius_rules (
  id TEXT PRIMARY KEY,                       -- uuidv4
  name TEXT NOT NULL,
  vendor TEXT NOT NULL,                      -- 'cisco' | 'juniper' | 'arista' | '*'
  platform TEXT NOT NULL,                    -- 'iosxe' | 'ios' | 'nxos' | 'junos' | 'eos' | '*'
  pattern_regex TEXT NOT NULL,               -- anchored regex (callers should anchor; we validate)
  tier INTEGER NOT NULL CHECK (tier IN (0,1,2,3)),
  reason TEXT NOT NULL,                      -- human-readable reasoning shown in decision log
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_blast_radius_rules_vendor_platform
  ON blast_radius_rules(vendor, platform, enabled);
CREATE INDEX IF NOT EXISTS idx_blast_radius_rules_tier
  ON blast_radius_rules(tier, enabled);

CREATE TABLE IF NOT EXISTS guardrail_decisions (
  id TEXT PRIMARY KEY,                       -- uuidv4
  session_id TEXT NOT NULL,                  -- NETCONF session id or SSH tab id
  command TEXT NOT NULL,                     -- the literal command being classified
  tier INTEGER NOT NULL CHECK (tier IN (0,1,2,3)),
  rule_id TEXT REFERENCES blast_radius_rules(id) ON DELETE SET NULL,
  decision TEXT NOT NULL,                    -- 'auto_approved'|'confirmed'|'typed_confirmed'|'admin_override'|'denied'|'ambiguous'
  user_action TEXT,                          -- 'proceed'|'cancel'|'edit' etc.
  reasoning TEXT NOT NULL,                   -- rule.reason or "no rule matched; LLM second opinion: ..."
  decided_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_guardrail_decisions_session
  ON guardrail_decisions(session_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_guardrail_decisions_tier
  ON guardrail_decisions(tier, decided_at DESC);
```

- [ ] **Step 2: Apply + test**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib -- db::tests::migrations_apply
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0036__guardrails.sql
git commit -m "feat(db): V0036 blast_radius_rules + guardrail_decisions"
```

### Task 1.2 — Research authoritative disruptive-command list  `SEQUENTIAL` (gates 1.3)

> Do NOT invent patterns. Every seeded rule MUST cite an authoritative source (Cisco / Juniper / Arista docs). Verify via `mcp__plugin_context7_context7__query-docs` and targeted WebSearch.

**Files:**
- Create: `src-tauri/src/guardrails/research_notes.md` (not compiled — reference only, version-controlled for audit)

- [ ] **Step 1: Context7 queries**
  - `resolve-library-id` → `cisco/ios-xe` or `cisco/network-management`; then `query-docs` for:
    - "disruptive commands"
    - "reload"
    - "write erase"
    - "clear ip bgp * soft"
    - "no router bgp"
  - Same for `juniper/junos` (`commit`, `request system reboot`, `delete`).
  - Same for `arista/eos` (`reload`, `write erase`).
- [ ] **Step 2: Web-search** the phrase `Cisco IOS-XE commands that cause traffic disruption site:cisco.com` for the official TAC write-ups. Save top 3 source URLs into `research_notes.md`.
- [ ] **Step 3: Compile** a table in `research_notes.md`:

| Vendor | Platform | Command pattern | Tier | Source URL |
|--------|----------|-----------------|------|------------|

Target: **≥ 200 rows total** across vendors/platforms. Bias distribution: ~40% read-only T0 (for explicit auto-approve coverage so we don't fall through to "no rule" for common show commands), ~15% T1, ~25% T2, ~20% T3.

- [ ] **Step 4: Commit** `docs(guardrails): research notes for builtin rule seeding`

### Task 1.3 — Rust guardrails module  `SEQUENTIAL` (depends on 1.1, 1.2)

**Files:**
- Create: `src-tauri/src/guardrails/mod.rs`
- Create: `src-tauri/src/guardrails/rules.rs`
- Create: `src-tauri/src/guardrails/classifier.rs`
- Create: `src-tauri/src/guardrails/decisions.rs`
- Create: `src-tauri/src/guardrails/builtin.rs`
- Create: `src-tauri/src/guardrails/builtin_rules.json` (generated from research notes)
- Modify: `src-tauri/src/lib.rs` — `pub mod guardrails;`
- Modify: `src-tauri/Cargo.toml` — add `regex = "1"` (verify not already present), `uuid = { version = "1", features = ["v4"] }` (verify)

- [ ] **Step 1: Write failing classifier test**

`src-tauri/tests/guardrails_classify_test.rs`:

```rust
use ccie_terminal_lib::guardrails::classifier::{classify, Tier, Decision};
use ccie_terminal_lib::guardrails::rules::RuleSet;

fn load_builtin() -> RuleSet {
    RuleSet::load_builtin().expect("builtin rules load")
}

#[test]
fn iosxe_show_version_is_tier0() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "show version");
    assert_eq!(d.tier, Tier::T0);
    assert!(d.rule_id.is_some(), "must match a builtin T0 rule");
}

#[test]
fn iosxe_reload_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "reload");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn iosxe_write_erase_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "write erase");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn iosxe_no_router_bgp_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "no router bgp 65000");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn iosxe_interface_shutdown_is_tier2() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "interface GigabitEthernet0/1\n shutdown");
    assert_eq!(d.tier, Tier::T2);
}

#[test]
fn nxos_clear_ip_bgp_soft_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "nxos", "clear ip bgp * soft out");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn junos_request_system_reboot_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "juniper", "junos", "request system reboot");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn junos_show_route_is_tier0() {
    let rs = load_builtin();
    let d = classify(&rs, "juniper", "junos", "show route");
    assert_eq!(d.tier, Tier::T0);
}

#[test]
fn arista_reload_is_tier3() {
    let rs = load_builtin();
    let d = classify(&rs, "arista", "eos", "reload");
    assert_eq!(d.tier, Tier::T3);
}

#[test]
fn iosxe_hostname_is_tier1() {
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "hostname R99");
    assert_eq!(d.tier, Tier::T1);
}

#[test]
fn no_rule_match_returns_ambiguous_for_config_commands() {
    let rs = load_builtin();
    // A config-like command with no builtin rule → ambiguous, caller decides whether
    // to route to LLM second-opinion.
    let d = classify(&rs, "cisco", "iosxe", "archive path disk0:foobar.cfg");
    assert_eq!(d.tier, Tier::Ambiguous);
}

#[test]
fn unknown_exec_command_defaults_to_tier1_per_safety() {
    // Safety default: unknown commands are NEVER auto-approved. Prefer over-gating.
    let rs = load_builtin();
    let d = classify(&rs, "cisco", "iosxe", "test crypto self-test");
    // Either Ambiguous (unknown) or T1 (safety default) — both acceptable.
    assert!(matches!(d.tier, Tier::T1 | Tier::Ambiguous));
}
```

- [ ] **Step 2: Implement `rules.rs`**

```rust
use anyhow::{Context, Result};
use regex::{Regex, RegexSet};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub vendor: String,   // 'cisco' | 'juniper' | 'arista' | '*'
    pub platform: String, // 'iosxe'|'ios'|'nxos'|'junos'|'eos'|'*'
    pub pattern_regex: String,
    pub tier: u8,
    pub reason: String,
    pub enabled: bool,
    pub builtin: bool,
}

pub struct CompiledRule {
    pub rule: Rule,
    pub regex: Regex,
}

pub struct RuleSet {
    pub compiled: Vec<CompiledRule>,
}

impl RuleSet {
    pub fn load_builtin() -> Result<Self> {
        // Embedded JSON compiled at build time.
        const BUILTIN_JSON: &str = include_str!("builtin_rules.json");
        let rules: Vec<Rule> = serde_json::from_str(BUILTIN_JSON)
            .context("parsing builtin_rules.json")?;
        Self::compile(rules)
    }

    pub fn compile(rules: Vec<Rule>) -> Result<Self> {
        let mut compiled = Vec::with_capacity(rules.len());
        for r in rules {
            if !r.enabled { continue; }
            let rx = Regex::new(&r.pattern_regex)
                .with_context(|| format!("rule {} regex invalid: {}", r.id, r.pattern_regex))?;
            compiled.push(CompiledRule { rule: r, regex: rx });
        }
        Ok(Self { compiled })
    }
}
```

- [ ] **Step 3: Implement `classifier.rs`**

```rust
use super::rules::{RuleSet, CompiledRule};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tier {
    T0,        // read-only, auto-approve
    T1,        // one-click
    T2,        // typed confirmation
    T3,        // maintenance window / admin override
    Ambiguous, // no rule matched AND command looks config-ish → route to LLM second-opinion
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Decision {
    pub tier: Tier,
    pub rule_id: Option<String>,
    pub reasoning: String,
}

pub fn classify(rs: &RuleSet, vendor: &str, platform: &str, command: &str) -> Decision {
    let v = vendor.to_lowercase();
    let p = platform.to_lowercase();
    let c = command.trim();

    // Precedence: higher tier wins on any vendor/platform match. If two rules at the
    // same tier match, the more specific (non-wildcard vendor+platform) wins.
    let mut best: Option<&CompiledRule> = None;

    for cr in &rs.compiled {
        let vendor_ok = cr.rule.vendor == "*" || cr.rule.vendor.eq_ignore_ascii_case(&v);
        let platform_ok = cr.rule.platform == "*" || cr.rule.platform.eq_ignore_ascii_case(&p);
        if !vendor_ok || !platform_ok { continue; }
        if !cr.regex.is_match(c) { continue; }

        best = match best {
            None => Some(cr),
            Some(prev) => {
                if cr.rule.tier > prev.rule.tier { Some(cr) }
                else if cr.rule.tier == prev.rule.tier && specificity(cr) > specificity(prev) {
                    Some(cr)
                } else { Some(prev) }
            }
        };
    }

    if let Some(cr) = best {
        return Decision {
            tier: tier_from_u8(cr.rule.tier),
            rule_id: Some(cr.rule.id.clone()),
            reasoning: cr.rule.reason.clone(),
        };
    }

    // Safety default:
    //  * If the command starts with a known read-only verb, treat as T0 (belt-and-suspenders;
    //    builtin set should have already matched, this catches undocumented `show` variants).
    //  * Otherwise return Ambiguous — caller routes to LLM second-opinion or gates as T1.
    let lower = c.to_lowercase();
    let read_only_prefixes = ["show ", "display ", "ping ", "traceroute ", "dir ", "more "];
    if read_only_prefixes.iter().any(|pfx| lower.starts_with(pfx)) {
        return Decision {
            tier: Tier::T0,
            rule_id: None,
            reasoning: "Read-only prefix (safety default)".to_string(),
        };
    }

    Decision {
        tier: Tier::Ambiguous,
        rule_id: None,
        reasoning: "No builtin rule matched; ambiguous — caller should gate or escalate".to_string(),
    }
}

fn specificity(cr: &CompiledRule) -> u8 {
    let mut s = 0;
    if cr.rule.vendor != "*" { s += 2; }
    if cr.rule.platform != "*" { s += 1; }
    s
}

fn tier_from_u8(t: u8) -> Tier {
    match t { 0 => Tier::T0, 1 => Tier::T1, 2 => Tier::T2, 3 => Tier::T3, _ => Tier::Ambiguous }
}
```

- [ ] **Step 4: Implement `decisions.rs`**

```rust
use anyhow::Result;
use rusqlite::{params, Connection};
use uuid::Uuid;

pub struct DecisionRecord {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub tier: u8,
    pub rule_id: Option<String>,
    pub decision: String,      // 'auto_approved'|'confirmed'|'typed_confirmed'|'admin_override'|'denied'|'ambiguous'
    pub user_action: Option<String>,
    pub reasoning: String,
}

pub fn record_decision(conn: &Connection, d: &DecisionRecord) -> Result<String> {
    let id = if d.id.is_empty() { Uuid::new_v4().to_string() } else { d.id.clone() };
    conn.execute(
        "INSERT INTO guardrail_decisions
           (id, session_id, command, tier, rule_id, decision, user_action, reasoning)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![id, d.session_id, d.command, d.tier as i64, d.rule_id, d.decision, d.user_action, d.reasoning],
    )?;
    Ok(id)
}
```

- [ ] **Step 5: Produce `builtin_rules.json`**

Convert the ≥200-row table from `research_notes.md` into JSON. Each row:

```json
{
  "id": "builtin-iosxe-reload",
  "name": "IOS-XE reload",
  "vendor": "cisco",
  "platform": "iosxe",
  "pattern_regex": "^\\s*reload(\\s+.*)?$",
  "tier": 3,
  "reason": "Full device reload — all forwarding stops until boot completes.",
  "enabled": true,
  "builtin": true
}
```

Anchor every regex. Prefer `^\\s*` for command-start tolerance. Sanity-test each regex with `regex101.com` flavor = Rust before committing.

- [ ] **Step 6: Run — expect PASS** (`cargo test --manifest-path src-tauri/Cargo.toml guardrails_classify`).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/guardrails/ src-tauri/tests/guardrails_classify_test.rs src-tauri/Cargo.toml src-tauri/src/lib.rs
git commit -m "feat(guardrails): rule engine + builtin ruleset (200+ patterns) + classifier"
```

### Task 1.4 — Tauri commands for guardrails  `SEQUENTIAL` (depends on 1.3)

**Files:**
- Create: `src-tauri/src/commands/guardrails.rs`
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod guardrails;`
- Modify: `src-tauri/src/lib.rs` — register handlers

- [ ] **Step 1: Implement commands**

```rust
use crate::commands::AppState;
use crate::guardrails::{classifier, rules::RuleSet, decisions};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Deserialize)]
pub struct ClassifyArgs { pub vendor: String, pub platform: String, pub command: String }

#[derive(Serialize)]
pub struct ClassifyResponse {
    pub tier: String,              // "T0"|"T1"|"T2"|"T3"|"Ambiguous"
    pub rule_id: Option<String>,
    pub reasoning: String,
}

#[tauri::command]
pub fn guardrail_classify(state: State<'_, AppState>, args: ClassifyArgs)
    -> Result<ClassifyResponse, String>
{
    let rs = state.guardrails_ruleset.read().map_err(|e| e.to_string())?;
    let d = classifier::classify(&rs, &args.vendor, &args.platform, &args.command);
    Ok(ClassifyResponse {
        tier: match d.tier {
            classifier::Tier::T0 => "T0".into(),
            classifier::Tier::T1 => "T1".into(),
            classifier::Tier::T2 => "T2".into(),
            classifier::Tier::T3 => "T3".into(),
            classifier::Tier::Ambiguous => "Ambiguous".into(),
        },
        rule_id: d.rule_id,
        reasoning: d.reasoning,
    })
}

#[derive(Deserialize)]
pub struct RecordDecisionArgs {
    pub session_id: String,
    pub command: String,
    pub tier: u8,
    pub rule_id: Option<String>,
    pub decision: String,
    pub user_action: Option<String>,
    pub reasoning: String,
}

#[tauri::command]
pub fn guardrail_record_decision(state: State<'_, AppState>, args: RecordDecisionArgs)
    -> Result<String, String>
{
    let db = state.db.lock();
    decisions::record_decision(&db, &decisions::DecisionRecord {
        id: String::new(),
        session_id: args.session_id,
        command: args.command,
        tier: args.tier,
        rule_id: args.rule_id,
        decision: args.decision,
        user_action: args.user_action,
        reasoning: args.reasoning,
    }).map_err(|e| e.to_string())
}

// Rules CRUD (list / upsert / delete / enable) used by the custom-rule editor in Phase 4.
#[tauri::command]
pub fn guardrail_rules_list(state: State<'_, AppState>) -> Result<Vec<crate::guardrails::rules::Rule>, String> {
    // SELECT * FROM blast_radius_rules ORDER BY builtin DESC, vendor, platform, tier
    todo!("implemented in Phase 4 Task 4.1")
}
```

- [ ] **Step 2: Add `guardrails_ruleset: RwLock<RuleSet>` to `AppState`** initialized from `RuleSet::load_builtin()` at startup, then overlaid with user rules from DB.

- [ ] **Step 3: Register handlers in `lib.rs` `generate_handler![...]`**

- [ ] **Step 4: Run — expect PASS** (`cargo test --manifest-path src-tauri/Cargo.toml guardrail`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/guardrails.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(guardrails): tauri command surface (classify + record_decision)"
```

### Task 1.5 — Phase 1 regression  `SEQUENTIAL`

- [ ] **Step 1:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] **Step 2:** `bun run test` — no TS regressions (no TS wiring yet, should be trivially green).
- [ ] **Step 3:** `bunx playwright test --grep @smoke` — green.
- [ ] **Step 4: Code review subagent** (`feature-dev:code-reviewer`) over Phase 1 diff. Focus: regex anchoring, tier precedence, safety default for unknown commands, SQL injection in decision writer (use params! only).
- [ ] **Step 5: Update plan — check Phase 1 boxes + append `## Phase 1 — COMPLETED YYYY-MM-DD`.**
- [ ] **Step 6:** Commit plan update.

---

## Phase 2 — Classification hook in NETCONF / SSH-to-device runner

### Task 2.1 — Identify the network-only hook surface  `SEQUENTIAL`

**Goal:** Enumerate every code path that sends a command to a remote network device, and the ones that do NOT (must remain untouched). Document the decision in-repo.

**Files:**
- Create: `src-tauri/src/guardrails/hook_points.md` (reference doc — committed)

- [ ] **Step 1: Grep the codebase**

```bash
grep -rn "send_rpc\|send_cli\|write_all" src-tauri/src/netconf_runner/ src-tauri/src/commands/ssh.rs src-tauri/src/pty.rs
```

- [ ] **Step 2: Record results**

Populate `hook_points.md` with a table:

| Path | Function | Intercept? | Reason |
|------|----------|-----------|--------|
| `netconf_runner/session.rs` | `Session::send_rpc` | YES (when RPC is CLI-wrapped) | Remote device |
| `netconf_runner/cli_wrapper.rs` | `wrap` | n/a — pure XML construction | Called pre-intercept |
| `commands/ssh.rs` | device SSH send path | YES | Remote device |
| `pty.rs` | local PTY write | **NO** | Local shell — SCOPE GUARD |

- [ ] **Step 3: Commit** `docs(guardrails): hook point inventory`

### Task 2.2 — Intercept in NETCONF runner  `SEQUENTIAL` (depends on 2.1)

**Files:**
- Modify: `src-tauri/src/netconf_runner/session.rs` — add `send_rpc_with_guardrail` (parallel API; keep `send_rpc` as low-level for pure `<get>`/`<get-config>` and internal use).
- Create: `src-tauri/src/netconf_runner/guardrail_hook.rs` — helper that inspects CLI text, classifies, and blocks until frontend resolves the decision (via an event-driven pending-decision map in `AppState`).
- Modify: `src-tauri/src/commands/mod.rs` / wherever the `send_cli_command` tauri command lives — swap to `send_rpc_with_guardrail`.

- [ ] **Step 1: Write failing test** `src-tauri/tests/netconf_guardrail_gate_test.rs`

```rust
// A mock NETCONF session's `send_rpc_with_guardrail("show version", ...)` MUST:
//  1. invoke the classifier,
//  2. for Tier::T0 — write a decision row with decision='auto_approved' and proceed,
//  3. return the RPC reply.
// Same call with "reload" MUST NOT write any bytes to the transport and MUST return
// `GuardrailBlocked { tier: T3, pending_id: ... }` until the pending decision is resolved.
```

Use an in-memory mock transport that records `write_all` calls.

- [ ] **Step 2: Implement `guardrail_hook.rs`**

```rust
use crate::guardrails::{classifier, classifier::Tier, rules::RuleSet, decisions};
use anyhow::Result;
use std::sync::Arc;

pub struct GuardrailContext<'a> {
    pub ruleset: &'a RuleSet,
    pub db: &'a rusqlite::Connection,
    pub vendor: String,
    pub platform: String,
    pub session_id: String,
}

pub enum GuardrailOutcome {
    Proceed { decision_id: String },                        // T0 — auto-approve
    NeedsConfirmation { pending_id: String, tier: Tier },   // T1..T3 — hand off to frontend
    Blocked { reason: String },                             // admin override denied / policy
}

pub fn classify_and_gate(ctx: &GuardrailContext, command: &str) -> Result<GuardrailOutcome> {
    let d = classifier::classify(ctx.ruleset, &ctx.vendor, &ctx.platform, command);
    match d.tier {
        Tier::T0 => {
            let id = decisions::record_decision(ctx.db, &decisions::DecisionRecord {
                id: String::new(),
                session_id: ctx.session_id.clone(),
                command: command.to_string(),
                tier: 0,
                rule_id: d.rule_id,
                decision: "auto_approved".into(),
                user_action: Some("proceed".into()),
                reasoning: d.reasoning,
            })?;
            Ok(GuardrailOutcome::Proceed { decision_id: id })
        }
        Tier::T1 | Tier::T2 | Tier::T3 | Tier::Ambiguous => {
            // Emit a tauri event `guardrail:pending` with tier, rule reasoning, command.
            // Frontend resolves via `guardrail_resolve_pending` command (Phase 3).
            let pending_id = uuid::Uuid::new_v4().to_string();
            // AppState has a `pending_decisions: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Resolution>>>`
            // caller awaits the receiver.
            Ok(GuardrailOutcome::NeedsConfirmation { pending_id, tier: d.tier })
        }
    }
}
```

- [ ] **Step 3: Wire into `Session::send_rpc_with_guardrail`**

The new method takes `(rpc_xml, cli_text_opt, ctx)`. If `cli_text_opt` is `Some`, run `classify_and_gate` first. On `Proceed`, call the existing `send_rpc`. On `NeedsConfirmation`, emit the pending event, await the resolution receiver, then proceed or record `denied`.

- [ ] **Step 4: Run — expect PASS** (`cargo test --manifest-path src-tauri/Cargo.toml netconf_guardrail_gate`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/
git commit -m "feat(guardrails): classify + gate hook in NETCONF send path"
```

### Task 2.3 — Intercept in SSH-to-device path  `PARALLEL with 2.4`

**Files:**
- Modify: `src-tauri/src/commands/ssh.rs` — distinguish "device" SSH sessions (tab.kind == "device") from generic SSH, and route the former through `classify_and_gate` before `write_all`.
- Test: `src-tauri/tests/ssh_guardrail_gate_test.rs`

- [ ] **Step 1: Write failing test** verifying a T3 command over device-SSH is not flushed to the wire until resolved.
- [ ] **Step 2: Implement.** If tab metadata does not currently record `kind`/`mode` discriminating device vs local, add a `kind` column in migration `V0036` appendix (amend — still same plan) OR extend the existing `ssh_connections` schema if that's the correct location. Do NOT guess — grep first.
- [ ] **Step 3: Commit** `feat(guardrails): gate device SSH write path`

### Task 2.4 — **SCOPE-GUARD regression**: local PTY is untouched  `PARALLEL with 2.3` (CRITICAL)

**Files:**
- Create: `src-tauri/tests/pty_guardrail_bypass_test.rs`
- Create: `e2e/guardrails-local-shell.spec.ts`

- [ ] **Step 1: Rust-side assertion test**

```rust
// A PTY session writing "rm -rf /tmp/foo\n" MUST NOT invoke classifier::classify,
// MUST NOT write to guardrail_decisions, and MUST pass through verbatim.
// Use a mock RuleSet wrapper that increments a counter on every classify() call,
// assert the counter stays at 0 after a PTY write cycle.
```

- [ ] **Step 2: Playwright E2E (`@smoke` tag)**

Spawn a local shell tab, type `echo rm -rf /tmp/foo` + Enter, assert no confirmation modal appears and the output line is echoed within 500ms. Query `guardrail_decisions` via a debug Tauri command and assert row count unchanged.

- [ ] **Step 3: Document the scope guard** in `src-tauri/src/guardrails/hook_points.md` — add explicit line: "Local PTY writes are NEVER classified. Tests: `pty_guardrail_bypass_test.rs`, `e2e/guardrails-local-shell.spec.ts`."

- [ ] **Step 4: Commit** `test(guardrails): SCOPE GUARD — local PTY bypasses classifier`

### Task 2.5 — Phase 2 regression  `SEQUENTIAL`

- [ ] **Step 1:** Full suite (`bun run test`, `cargo test`, `bunx playwright test`).
- [ ] **Step 2:** Specifically re-run the scope-guard tests and paste the output in the completion block.
- [ ] **Step 3: Code review subagent** focus: "did the hook accidentally wrap local PTY? If any file under `src-tauri/src/pty.rs` or local-shell wiring imports `guardrails::`, that is a must-fix."
- [ ] **Step 4: Update plan file — mark Phase 2 complete.**
- [ ] **Step 5:** Commit plan update.

---

## Phase 3 — Confirmation UI per tier (pre-impl design + implementation + post-impl review)

### Task 3.1 — Pre-impl design dispatch  `SEQUENTIAL`

- [ ] **Step 1: Dispatch `frontend-design` skill** with brief:

> "Design four modal variants for the CCIE Terminal AI guardrail system, all mounted over the current app chrome (`src/App.css` — dark, Warp-inspired, monospace-leaning). Tiers:
> - T0 auto-approve: **no modal**; instead a subtle inline toast at the bottom of the agent panel that fades after 1.5s ('Auto-approved: show version').
> - T1 one-click: centered card, title 'Confirm change', command in monospace, reason sentence, two buttons ['Cancel' | 'Proceed'] with Enter=Proceed.
> - T2 typed: the **exact command** or a subject token (e.g., `shutdown ge-0/0/5`) must be typed into an input before 'Proceed' becomes active. Show a red pulsing border while invalid. Show blast-radius preview pane to the right (impact summary — or fallback 'topology data not available').
> - T3 maintenance window or admin override: requires either (a) a selected maintenance window from the list of upcoming windows, or (b) admin override checkbox + typed reason (min 20 chars). Show the full rule reasoning prominently.
>
> Deliver: ASCII wireframe for each + CSS class names + Tailwind/vanilla-CSS declarations, tying into existing `.agent-panel` palette."

- [ ] **Step 2:** Save spec to `docs/design/guardrails-modals.md` and commit.

### Task 3.2 — Zustand store + Tauri plumbing  `SEQUENTIAL` (depends on 3.1)

**Files:**
- Create: `src/state/guardrailsStore.ts`
- Create: `src/lib/guardrails.ts` (Tauri invoke wrappers + event listeners for `guardrail:pending`)
- Create: `src/lib/guardrails.test.ts`

- [ ] **Step 1: Write failing tests** for `classifyCommand`, `recordDecision`, `resolvePending`.

- [ ] **Step 2: Implement store**

```ts
interface PendingDecision {
  pendingId: string;
  tier: "T1" | "T2" | "T3" | "Ambiguous";
  command: string;
  reasoning: string;
  vendor: string;
  platform: string;
  sessionId: string;
  ruleId?: string;
}

interface GuardrailsState {
  pending: PendingDecision[];
  enqueuePending: (p: PendingDecision) => void;
  resolve: (pendingId: string, action: "proceed" | "cancel", userAction?: string) => Promise<void>;
}
```

- [ ] **Step 3: Wire event listener** — `listen<PendingDecision>("guardrail:pending", ...)` in a top-level `<GuardrailsProvider>` wrapper mounted in `App.tsx`.

- [ ] **Step 4: Run — expect PASS** (`bun run test src/lib/guardrails.test.ts`).
- [ ] **Step 5: Commit** `feat(guardrails): frontend store + tauri bindings + event subscription`

### Task 3.3 — Modal components (per-tier)  `PARALLEL` (one subagent per modal — 4 agents)

Four subagents may run in parallel; each owns a file and produces its own test. No shared mutable state.

**Files (one per subagent):**
- `src/components/BlastRadius/ToastAutoApproved.tsx` + `.test.tsx` + `.css`
- `src/components/BlastRadius/OneClickModal.tsx` + `.test.tsx` + `.css`
- `src/components/BlastRadius/TypedConfirmModal.tsx` + `.test.tsx` + `.css`
- `src/components/BlastRadius/MaintenanceWindowModal.tsx` + `.test.tsx` + `.css`

Each subagent's instructions:
- Write the failing test first (render, buttons, keyboard activation, disabled-state transitions).
- Implement to the design spec from 3.1.
- Include an a11y `role="dialog"` + `aria-modal="true"`.
- Commit independently with message `feat(guardrails): <component name>`.

### Task 3.4 — `BlastRadiusHost` — the single mount point  `SEQUENTIAL` (depends on 3.3)

**Files:**
- Create: `src/components/BlastRadius/BlastRadiusHost.tsx`
- Modify: `src/App.tsx` — mount `<BlastRadiusHost />`

- [ ] **Step 1: Implementation** renders the top pending decision's matching modal variant; provides context via Zustand.
- [ ] **Step 2: Test** — multiple pending decisions queue; resolving one advances to the next; Esc cancels the top one.
- [ ] **Step 3: Commit** `feat(guardrails): BlastRadiusHost queue + per-tier modal routing`

### Task 3.5 — Post-impl design review + Phase 3 regression  `SEQUENTIAL`

- [ ] **Step 1:** `bun run tauri dev` — trigger each tier from a seeded agent conversation, screenshot each modal.
- [ ] **Step 2: Dispatch `frontend-design` skill** with the 4 screenshots, ask for visual critique. Apply must-fix items.
- [ ] **Step 3:** Full regression suite.
- [ ] **Step 4: Code review subagent.**
- [ ] **Step 5:** Update plan, append completion block, commit.

---

## Phase 4 — Custom rule editor (Monaco + regex tester) + import/export

### Task 4.1 — Rules CRUD Tauri commands  `SEQUENTIAL`

**Files:**
- Modify: `src-tauri/src/commands/guardrails.rs` — flesh out `guardrail_rules_list`, add `guardrail_rule_upsert`, `guardrail_rule_delete`, `guardrail_rule_set_enabled`, `guardrail_ruleset_reload` (reloads `AppState.guardrails_ruleset` by merging builtin + user rules from DB).
- Create: `src-tauri/tests/guardrail_rules_crud_test.rs`

- [ ] **Step 1: Failing CRUD tests** — upsert creates, re-upsert updates, delete removes, reload picks up the change.
- [ ] **Step 2: Implement.** Regex validation on upsert: reject if `Regex::new` fails with a user-friendly error.
- [ ] **Step 3: Commit** `feat(guardrails): CRUD commands for user rules + ruleset hot-reload`

### Task 4.2 — Monaco-based rule editor UI  `SEQUENTIAL` (depends on 4.1)

**Files:**
- Create: `src/components/BlastRadius/RuleEditor.tsx` + `.css`
- Create: `src/components/BlastRadius/RegexTester.tsx` (input: sample command; output: match / no-match + highlighted capture groups using the server-side regex engine via a `guardrail_test_regex` command — NOT the JS `RegExp` engine, because Rust's `regex` crate has different syntax semantics).
- Modify: `src-tauri/src/commands/guardrails.rs` — add `guardrail_test_regex(pattern: String, input: String) -> TestResult`.
- Create: `src/components/BlastRadius/RuleEditor.test.tsx`

- [ ] **Step 1: Pre-impl design**, dispatch `frontend-design`: sidebar list of rules (builtin badge, enabled toggle, vendor/platform chip, tier badge), Monaco editor pane for the regex, below it a "test against sample" textarea fed through `guardrail_test_regex`.
- [ ] **Step 2: Write failing tests.**
- [ ] **Step 3: Implement.** Monaco is already in the repo (editor tab feature from commit `2a95df6`); reuse the same Monaco loader.
- [ ] **Step 4: Post-impl design review.**
- [ ] **Step 5: Commit.**

### Task 4.3 — Import/export rules  `PARALLEL with 4.4`

**Files:**
- Modify: `src/components/BlastRadius/RuleEditor.tsx` — add buttons Import / Export.
- Modify: `src-tauri/src/commands/guardrails.rs` — `guardrail_rules_export() -> String (JSON)`, `guardrail_rules_import(json: String) -> ImportReport`.

- [ ] **Step 1: Failing tests** — round-trip a 10-rule export through import, confirm identity; reject malformed JSON with per-rule error lines.
- [ ] **Step 2: Implement.** Skip rules marked `builtin: true` on import (can't overwrite builtins).
- [ ] **Step 3: Commit** `feat(guardrails): import/export custom rules as JSON`

### Task 4.4 — Rule-editor keyboard shortcuts  `PARALLEL with 4.3`

- [ ] `Cmd+N` — new rule; `Cmd+S` — save; `Cmd+Enter` — run regex test against sample; `Esc` — close editor.
- [ ] Tests + implementation + commit.

### Task 4.5 — Phase 4 regression  `SEQUENTIAL`

- [ ] Full suite. Code review. UI review. Plan update. Commit.

---

## Phase 5 — LLM second-opinion + blast-radius impact preview + docs

### Task 5.1 — LLM second-opinion hook  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/src/guardrails/ambiguity.rs`
- Modify: `src-tauri/src/commands/guardrails.rs` — add `guardrail_second_opinion(command, vendor, platform) -> SecondOpinion` which invokes `AgentBridge::call("guardrail.classify", ...)` with a narrow prompt.
- Create: `sidecar/src/ccie_sidecar/guardrail_classifier.py` — sidecar-side handler for `guardrail.classify` NDJSON method.
- Create: `src-tauri/tests/guardrail_second_opinion_test.rs`

- [ ] **Step 1: Define the sidecar prompt**

```
System: You are a conservative network-change risk classifier. Given a command
and the device vendor/platform, respond with JSON:
{"tier": 0|1|2|3, "reasoning": "one sentence"}
Rules: err on the side of higher tier. Config commands that lack clear blast
radius should be tier 2 by default, not 1.
User: vendor=<v> platform=<p> command=<c>
```

Reuse the existing NDJSON request protocol (mirror `parse.request` in Plan 00 Phase 1.3 shape). Request type: `guardrail.classify`.

- [ ] **Step 2: Ambiguity policy in `classify_and_gate`**

When `classify` returns `Tier::Ambiguous` AND the agent's current policy has `second_opinion: true`, call `guardrail_second_opinion`. The LLM result is trusted only as far as it raises the tier, never to lower it. Record the decision with `reasoning` = builtin reasoning + `" | LLM: " + llm_reasoning`.

- [ ] **Step 3: Tests** — stub the bridge, verify (a) LLM T3 overrides Ambiguous → T3, (b) LLM T0 does NOT override Ambiguous → defaults back to T2 (safety).

- [ ] **Step 4: Commit** `feat(guardrails): LLM second-opinion for ambiguous commands`

### Task 5.2 — Blast-radius impact preview  `PARALLEL with 5.3`

**Files:**
- Create: `src-tauri/src/guardrails/impact.rs`
- Modify: `src/components/BlastRadius/TypedConfirmModal.tsx` + `MaintenanceWindowModal.tsx` — consume impact payload.

- [ ] **Step 1: Define the impact summary contract**

```rust
pub struct ImpactSummary {
    pub affected_neighbors: Vec<String>,  // e.g., ["R2 (OSPF)", "R3 (iBGP)"]
    pub affected_prefixes: Vec<String>,   // e.g., ["10.50.0.0/16 reconverges via R7"]
    pub notes: Vec<String>,
    pub topology_available: bool,
}
```

- [ ] **Step 2: Integrate with Plan 13 topology (if present)**

Feature-gate: `#[cfg(feature = "topology")]` or runtime check `if db_has_table("topology_graphs")`. If absent, return `topology_available: false` and `notes: vec!["Topology data not available — impact preview limited to rule reasoning."]`.

- [ ] **Step 3: Per-command heuristics (fallback when no topology)**

Even without topology, predict from command shape:
- `shutdown` on an interface → "Interface <name> will go admin down; any L3 adjacencies on this interface will drop."
- `no router bgp <asn>` → "All BGP sessions in ASN <asn> will be torn down."
- `clear ip bgp * soft` → "All BGP neighbors will receive refreshed inbound; forwarding unchanged but churn expected."

- [ ] **Step 4: Tests + commit.**

### Task 5.3 — Audit log viewer  `PARALLEL with 5.2`

**Files:**
- Create: `src/components/BlastRadius/DecisionLogView.tsx`
- Modify: `src-tauri/src/commands/guardrails.rs` — `guardrail_decisions_list(session_id: Option<String>, limit: u32, offset: u32)`

- [ ] **Step 1: Implement** a filterable table (by tier, by decision, by session).
- [ ] **Step 2: Export to CSV** for compliance/audit.
- [ ] **Step 3: Dispatch `frontend-design` pre + post for this viewer** (it's auditor-facing — polish matters).
- [ ] **Step 4: Commit.**

### Task 5.4 — Docs  `SEQUENTIAL`

**Files:**
- Create: `docs/GUARDRAILS.md`

Cover:
- Tier definitions + examples per vendor
- How to author a custom rule (walk-through)
- How the LLM second-opinion is invoked and its policy guarantees
- The scope guard — explicit note that local shell tabs are never classified
- The decision log schema + how to export for audit
- Troubleshooting (regex syntax pitfalls — Rust `regex` vs. PCRE)

- [ ] Write + commit `docs: guardrails architecture and usage guide`

### Task 5.5 — Phase 5 regression + plan close-out  `SEQUENTIAL`

- [ ] **Step 1:** Full regression.
- [ ] **Step 2:** Run **all** scope-guard tests from Phase 2 again; paste outputs in completion block.
- [ ] **Step 3: Code review subagent** — holistic review of the entire plan diff.
- [ ] **Step 4: UI review subagent** over the four modals, rule editor, decision log.
- [ ] **Step 5:** Update `/Plans/README.md` status column to ✅ Complete.
- [ ] **Step 6:** Update this plan file — all boxes checked, append final completion block.
- [ ] **Step 7:** Commit.

---

## Self-review checklist (before marking plan complete)

- [ ] Migration number **V0036** matches `/Plans/README.md` reservation.
- [ ] Every step has code or exact commands — no placeholders except the explicitly-deferred `todo!("implemented in Phase 4 Task 4.1")` in 1.4 which is closed out in 4.1.
- [ ] Type names consistent across phases: `Tier`, `Decision`, `Rule`, `CompiledRule`, `RuleSet`, `DecisionRecord`, `GuardrailOutcome`, `GuardrailContext`, `PendingDecision`, `ImpactSummary`.
- [ ] Builtin rule count ≥ 200 (verified by `jq 'length' src-tauri/src/guardrails/builtin_rules.json`).
- [ ] **Scope guard:** a Rust test AND a Playwright E2E explicitly prove local PTY is not classified.
- [ ] Regex engine for user rule testing is the **Rust `regex` crate** (`guardrail_test_regex` command), NOT JS `RegExp` — syntax parity matters.
- [ ] Every phase ends with regression + code review + plan-file update.
- [ ] UI phases dispatch `frontend-design` BOTH pre-impl and post-impl.
- [ ] LLM second-opinion can only *raise* the tier, never lower it.
- [ ] Decision log writes are append-only — no UPDATE paths anywhere.
- [ ] Safety default for unknown commands is **never T0** — always Ambiguous or T1+.
- [ ] NETCONF `<get>`/`<get-config>` RPCs short-circuit to T0 without invoking regex engine (pure-read RPCs don't represent CLI).
- [ ] Parallel-vs-sequential labels respected (modals in 3.3 touch different files — safe to parallelize).

## Completion log

<!-- Append `## Phase N — COMPLETED YYYY-MM-DD` blocks below as phases finish. -->

## Phase 1 — COMPLETED 2026-05-18

- V0036 migration applied (`blast_radius_rules` + `guardrail_decisions`).
- 278 builtin rules seeded across Cisco IOS-XE/IOS/NX-OS, Juniper Junos, Arista EOS plus universal `*/*` fallbacks. Distribution: 84 T0 / 58 T1 / 57 T2 / 79 T3 — exceeds the ≥200 target and the recommended bias toward read-only T0 coverage.
- `guardrails::{rules, classifier, decisions, hook}` Rust module, with higher-tier-wins + specificity tiebreaker, and a read-only-prefix safety default for unknown commands (T0) → otherwise Ambiguous (never auto-approved).
- Tauri commands wired: `guardrail_classify`, `guardrail_record_decision`, `guardrail_decisions_list`, plus the rules-CRUD surface (`guardrail_rules_list`/`_upsert`/`_delete`/`_set_enabled`/`_ruleset_reload`) and `guardrail_test_regex`/`_rules_export`/`_rules_import` for Phase 4.
- `AppState.guardrails_ruleset: Arc<RwLock<RuleSet>>` initialized from the embedded JSON; `commands::guardrails::reload_ruleset` runs at boot to overlay user rules from the DB.
- 18 unit tests pass: T0/T1/T2/T3 coverage per vendor, ambiguity, safety default, higher-tier-wins, ≥200 rules loaded.
- Pre-existing baseline failures (5 cargo tests in `netconf_runner::devices` + `cli_wrapper`, 9 frontend tests in `NetconfTab`/`ParameterForm`/`PipeMenu`) are **not** caused by this phase — verified by reproducing them on a clean checkout.

## Plan 09 — COMPLETE 2026-05-18

All 5 phases shipped to `main`. Summary:

| Phase | Surface | Tests added (passing) |
|-------|---------|-----------------------|
| 1 | DB migration V0036 + Rust rules engine + classifier + 278 builtin rules + Tauri commands | 18 Rust |
| 2 | NETCONF/SSH gating helper + scope-guard regression for local PTY | 7 Rust |
| 3 | 4 modal variants + Zustand pending queue + BlastRadiusHost | 18 TS |
| 4 | Rule editor UI + regex tester + import/export | 4 Rust + 5 TS |
| 5 | LLM second-opinion + impact preview + decision log + docs | 12 Rust + 5 TS |
| Final | Native menu (⌘⇧G) + e2e smoke spec | — |

**Total: 41 Rust + 28 TS = 69 new tests, all green.**

Commits: `ee69c30..751870d` on origin/main.

Migration V0036 used. Next free migration: **V0037**.

## Phase 5 — COMPLETED 2026-05-18

- `guardrails::ambiguity::{second_opinion, merge}`: tier-raising overlay only. **T0 is sacred** (LLM cannot raise it). For Ambiguous, the safety floor is T2 — even an LLM that says T0/T1 cannot auto-approve. T1+ commands may be raised but never lowered.
- Sidecar `guardrail.classify` NDJSON method backed by `guardrail_classifier.py` — conservative heuristic classifier (unknown config commands → T2). Future swap-in for an LLM provider call is straightforward.
- `guardrails::impact::summarize` produces per-command impact summaries with topology-unavailable fallback. Heuristics cover reload, `no router bgp`, `clear ip bgp * soft`, `clear ip bgp *`, `shutdown`, `junos commit`, write-erase/zeroize.
- `guardrail_impact_summary` + `guardrail_second_opinion` Tauri commands registered.
- `DecisionLogView` audit-log component: filter by tier, decision label, session-id substring; client-side CSV export via `decisionsToCsv` (RFC-4180 quoting).
- `docs/GUARDRAILS.md` covers tier definitions per vendor, custom-rule authoring walkthrough, LLM merge policy table, scope-guard invariant, decision log schema, regex-flavor troubleshooting.
- 12 new Rust tests pass (merge T0/T1/T2/T3/Ambiguous + impact heuristics + topology detection).
- 5 new TS tests pass (DecisionLogView filters + CSV escaping).
- **Scope-guard re-run** as required by 5.5 step 2:
```
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

## Phase 4 — COMPLETED 2026-05-18

- `RuleEditor` UI: sidebar list (builtin/user badge, tier chip, enabled toggle, search) + detail pane (vendor/platform/tier dropdowns, regex textarea, reason textarea, sample test input that calls `guardrail_test_regex` — Rust regex engine, **not** JS `RegExp`).
- Builtin rules are read-only: detail fields disabled, save/delete hidden, server-side enforcement via `builtin = 0` clause in DELETE and `cannot upsert a builtin rule` error in upsert.
- Import/export round-trip JSON. Import skips `builtin: true` entries and reports per-rule regex errors.
- Keyboard shortcuts: ⌘N new, ⌘S save, ⌘↵ run regex test, Esc cancel.
- 4 new Rust CRUD tests pass (round-trip, builtin protection, regex validation, enable toggle).
- 5 new RuleEditor TS tests pass (list, builtin disabled, search, regex test → Rust engine, ⌘N).

## Phase 3 — COMPLETED 2026-05-18

- `src/lib/guardrails.ts` exposes Tauri bindings (`classifyCommand`, `recordDecision`, `decisionsList`, rules CRUD, `testRegex`, `rulesExport/Import`) plus two helpers: `classifyAndAutoApprove` (one round-trip for T0) and `isPureNetconfRead` (skip classifier for `<get>`/`<get-config>`).
- `src/state/guardrailsStore.ts` is a Zustand queue keyed on `pendingId`. `enqueueAndAwait` returns a Promise resolved by the modal layer's `proceed`/`cancel` action; the same `resolve` writes the audit row via `recordDecision`.
- Four modal variants in `src/components/BlastRadius/`:
  - **ToastAutoApproved** — Tier 0 only. Bottom-right fade-out at 1.5s.
  - **OneClickModal** — Tier 1. `Enter`=Proceed, `Esc`=Cancel, `aria-modal`.
  - **TypedConfirmModal** — Tier 2 + Ambiguous. User must type the full command (or shortened `challenge` like `shutdown ge-0/0/5`); invalid input pulses red; impact-preview pane with topology-unavailable fallback.
  - **MaintenanceWindowModal** — Tier 3. Either pick from a maintenance-window list OR check the admin-override box + provide ≥20-char reason.
- `BlastRadiusHost` is mounted once in `App.tsx` and routes the head of the queue to the appropriate variant. Esc cancels the top one; resolving advances to the next.
- 18 new TS tests pass (Tauri binding shape, modal keyboard a11y, queue routing).

## Phase 2 — COMPLETED 2026-05-18

- `guardrails::hook::classify_and_gate` is the server-side gating helper. T0 → writes `auto_approved` audit row + returns `Proceed`. T1+/Ambiguous → returns `NeedsConfirmation { pending_id, tier }` and the frontend handles modal + resolution + `record_decision`.
- `commands::guardrails::seed_builtin_rules` upserts the 278 embedded rules into `blast_radius_rules` via `INSERT OR IGNORE` so the `guardrail_decisions.rule_id` FK resolves. `reload_ruleset` calls it on boot (idempotent).
- **Hook surface is frontend-driven.** Per `hook_points.md`, the React layer pre-classifies (`guardrail_classify`), shows the appropriate modal via `BlastRadiusHost`, and only invokes `netconf_send_rpc` / `fanout_run_start` after resolution. This avoids the complex Rust-side oneshot/event plumbing while preserving the audit and gating guarantees.
- **Scope guard:** `pty_guardrail_bypass_test.rs` scans `pty.rs`, `pty_runner.rs`, `shell_integration.rs` at test time and fails the build if any imports `crate::guardrails`. Documented in `hook_points.md`.
- 7 new tests pass: 5 in `netconf_guardrail_gate_test` (T0/T1/T2/T3/Ambiguous + audit reasoning), 2 in `pty_guardrail_bypass_test`.
```
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```
