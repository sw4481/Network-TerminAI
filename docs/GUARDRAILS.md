# AI Guardrails — Blast-Radius Analyzer

The guardrails subsystem classifies every CLI command bound for a network
device into one of four blast-radius tiers and gates execution
accordingly. Local shell tabs are **never** classified.

## Tier definitions

| Tier | Meaning | UX | Examples |
|------|---------|----|----------|
| **T0** | Read-only / observational | Auto-approve. Fade-out toast on the agent panel. | `show version`, `ping`, `traceroute`, NETCONF `<get>`, `<get-config>`, `commit check` |
| **T1** | Local write, non-forwarding | One-click confirmation modal. `Enter` proceeds. | `hostname R99`, `clock set`, `snmp-server community`, `logging host` |
| **T2** | Forwarding-affecting, targeted | Typed confirmation. User must type the command (or a shortened challenge). Shows blast-radius preview. | `interface ... shutdown`, `clear ip bgp <neighbor>`, `commit`, `set interfaces ge-0/0/5 disable` |
| **T3** | Service-affecting / broad blast radius | Maintenance window OR admin override + ≥20-char reason. | `reload`, `write erase`, `no router bgp <asn>`, `clear ip bgp *`, `request system reboot`, `restart routing` |

Ambiguous commands (no rule matched, command looks config-ish) are treated
as **at least T2** — the safety floor ensures unknown commands are never
auto-approved.

## Authoring custom rules

Open the rule editor (Tools → Guardrails → Rule Editor or `⌘⇧G`) and
press **New rule** (`⌘N`). Each rule has:

| Field | Purpose |
|-------|---------|
| Name | Human-readable label shown in the rule list. |
| Vendor | `cisco`, `juniper`, `arista`, or `*` for any. |
| Platform | `iosxe`, `ios`, `nxos`, `junos`, `eos`, or `*`. |
| Pattern | A **Rust regex** (NOT JS RegExp). Anchor with `^\s*` for command-start tolerance. |
| Tier | T0..T3 — see table above. |
| Reason | Sentence shown to the user when the rule fires. |

Click **Test (⌘↵)** to evaluate the regex against a sample command using
the same Rust `regex` engine the runtime classifier uses. The JS `RegExp`
syntax differs from Rust's (e.g., no lookbehinds in Rust by default), so
testing against the JS engine would give false positives.

Save with **`⌘S`**. Saved rules are merged into the in-memory ruleset and
take effect immediately (no restart required).

### Precedence

1. **Higher tier wins** on overlapping matches. A Tier 3 rule beats a
   Tier 1 rule on the same command.
2. **More specific vendor/platform wins** on tier ties. A `cisco/iosxe`
   rule beats a `*/iosxe` rule.
3. If no rule matches and the command starts with a read-only verb
   (`show `, `display `, `ping `, `traceroute `, `dir `, `more `), the
   safety default returns Tier 0.
4. Otherwise Ambiguous, which the UI gates as Tier 2 (or higher if the
   LLM second-opinion raises it).

## LLM second-opinion

When the rule engine returns Ambiguous AND the agent's policy permits
it, the runtime calls `guardrail.classify` over the existing sidecar NDJSON
bridge. The sidecar returns `{tier, reasoning}`. The Rust caller then
applies the tier as a **raising overlay only**:

| Rule engine | LLM says | Final tier |
|-------------|----------|-----------|
| T0 | T3 | **T0** (T0 is sacred — never raised) |
| T1 | T3 | T3 (raised) |
| T2 | T0 | **T2** (LLM cannot lower) |
| T3 | T0 | **T3** (LLM cannot lower) |
| Ambiguous | T0 | **T2** (safety floor) |
| Ambiguous | T1 | **T2** (safety floor) |
| Ambiguous | T2 | T2 |
| Ambiguous | T3 | T3 |

The decision row records both the rule reason and the LLM reason:
`<rule reason> | LLM: <llm reason>`.

## Scope guard — local shell tabs are never classified

A regression test (`src-tauri/tests/pty_guardrail_bypass_test.rs`)
fails the build if any of these files import `crate::guardrails`:

- `src-tauri/src/pty.rs`
- `src-tauri/src/pty_runner.rs`
- `src-tauri/src/shell_integration.rs`

If you genuinely need to call the classifier from a local-shell code
path, update `src-tauri/src/guardrails/hook_points.md` first and document
why. The default invariant is: **local PTY → no classification, no audit
row, no modal**.

## Decision log schema

`guardrail_decisions` is append-only:

```sql
CREATE TABLE guardrail_decisions (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  command     TEXT NOT NULL,
  tier        INTEGER NOT NULL CHECK (tier IN (0,1,2,3)),
  rule_id     TEXT REFERENCES blast_radius_rules(id) ON DELETE SET NULL,
  decision    TEXT NOT NULL,
  user_action TEXT,
  reasoning   TEXT NOT NULL,
  decided_at  INTEGER NOT NULL
);
```

`decision` values: `auto_approved`, `confirmed`, `typed_confirmed`,
`admin_override`, `denied`, `ambiguous`. There is no UPDATE path —
all writes go through `decisions::record_decision`.

### Exporting for audit

Open the Decision Log View, apply your filters (tier, decision label,
session id substring), and click **Export CSV**. The CSV is generated
client-side via `decisionsToCsv` (commas/newlines in fields are quoted
per RFC 4180).

## Troubleshooting

### "My regex matches in regex101 but not at runtime"

regex101 defaults to PCRE/JS flavor. The runtime uses **Rust `regex`**
which has different syntax:

- No lookbehind/lookahead by default (use the `regex` crate's `regex_lite`
  variant if you really need them — but rules don't use it).
- `\b` is supported; `\s` and `\S` are supported.
- Backslashes in JSON strings need double-escaping: `^\\s*reload\\b`.

Use the rule editor's built-in **Test** button — it calls the runtime
engine directly via `guardrail_test_regex`.

### "My new rule isn't firing"

Click **Refresh** in the rule editor (or restart the app) to force a
ruleset reload. Builtin rules can never be overwritten by user rules of
the same id; if you see stale tier values, you're looking at the builtin
not a user override.

### "The audit log is huge"

The Decision Log View pages 500 rows by default. For long-term retention,
export periodically and truncate via SQL:

```sql
DELETE FROM guardrail_decisions WHERE decided_at < strftime('%s','now') - 90 * 86400;
```
