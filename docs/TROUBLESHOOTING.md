# Troubleshooting Tree — User & Authoring Guide

**Plan 15** ships an AI-orchestrated, YAML-authored decision-tree
troubleshooting engine. You enter a symptom; a matcher picks (or you
hand-pick) a playbook; the engine walks the tree, runs only Tier-0
read-only diagnostics from the [guardrails](GUARDRAILS.md) classifier,
parses the output via Plan 05's structured pipeline, branches on parsed
state, and narrates progress in a side panel with citations from
Plan 12's RAG.

If you've used the [Notebooks](NOTEBOOKS.md) feature, the executor
shares structural DNA with `cell_run` — same `RunStatus` enum, same
streaming event channel.

---

## Quick start

1. Press the **+ Troubleshoot** button in the tab bar (or fire
   `menu:troubleshoot_open` from the macOS menu).
2. Type a symptom into the picker textarea —
   *BGP session to 10.0.0.5 stuck in Idle (Admin)*.
3. Wait 300ms. The matcher returns the top-5 playbooks ranked by
   BM25 + embedding similarity. Click a suggestion to select it (it
   does **not** auto-start the run).
4. Optionally fill the **Vars (JSON)** field — e.g.
   `{"neighbor": "10.0.0.5"}`. Variables are substituted into
   commands before classification (see *Variables* below).
5. Press **Start run ▸**. The tree canvas populates with one node
   per step; the narration panel scrolls explanations as the engine
   walks the tree.
6. When the engine reaches a `branch` step it follows the matching
   `case`. When it hits a `user_prompt` it pauses; you answer in the
   modal, then explicitly press **Resume** to continue.
7. Run terminates with a conclusion banner showing
   `root_cause` + `confidence` + `suggested_fix` + `evidence[]`.

If no playbook scores ≥ 0.35 (the `MATCH_THRESHOLD`), the picker
shows a "no good match" panel with two fallbacks: **Start a blank
run** and **Generate with AI** (the latter is deferred — the button
is disabled).

---

## What is a playbook

A playbook is a YAML document that declares:

- An `id` (slug; lowercase letters/digits/dashes only).
- A human `name`.
- An array of `symptom_keywords` for the BM25 matcher.
- A `vendor` and `platform` scope (or `*` for any).
- An ordered `steps:` array.

### Schema reference

```yaml
id: bgp-wont-peer                 # required — matches ^[a-z0-9-]+$
name: BGP session will not peer   # required
description: BGP neighbor is stuck in Idle/Active and won't transition.
vendor: cisco                     # required — cisco | juniper | arista | *
platform: iosxe                   # required — iosxe | nxos | junos | eos | *
symptom_keywords:                 # required — non-empty
  - bgp
  - neighbor
  - peer
  - idle
steps:                            # required — non-empty
  - id: step-1
    type: command                 # one of: command | assertion | branch
                                  # | narration | user_prompt
    command: show ip bgp summary
  - id: step-2
    type: assertion
    expression: "tables[0].rows[?neighbor=='{{neighbor}}'] | [0].state"
    expects: Established
    on_pass: step-3-ok
    on_fail: step-3-investigate
  # ... etc
```

The full schema lives at
[`src/features/troubleshoot/playbook-schema.json`](../src/features/troubleshoot/playbook-schema.json)
and is mirrored in
[`sidecar/src/ccie_sidecar/troubleshoot/schema.json`](../sidecar/src/ccie_sidecar/troubleshoot/schema.json).
The Monaco editor validates against this schema as you type.

### Step types

| Type | Required fields | Optional | Behaviour |
| --- | --- | --- | --- |
| `command` | `command` | — | Runs a Tier-0 show command on the active tab's session. Re-classified post-substitution. Anything above Tier-0 pauses the run. |
| `assertion` | `expression`, `expects` | `on_pass`, `on_fail` | Evaluates a JMESPath expression against the previous parsed output. Jumps to `on_pass` if equal, `on_fail` otherwise. |
| `branch` | `cases[]` (each with `when` + `next`) | — | First matching `when` wins. `when` may be string, number, boolean, or null. |
| `narration` | `text` | — | One-or-two-sentence explanation. The narrator may rewrite it with RAG context if the sidecar is up. |
| `user_prompt` | `prompt` | — | Pauses the run. `answer_prompt` captures the response into the run context as a variable. |

---

## Worked example: how I wrote `dhcp-no-lease`

A user reported "the access-layer port lights up but the laptop never
gets an IP". I wrote `dhcp-no-lease.yaml` from scratch in the editor.

### 1. Symptom and keywords

The matcher relies on BM25 over `symptom_keywords` plus the
embedding cosine. I picked words a tired engineer would actually type
at 02:00:

```yaml
symptom_keywords:
  - dhcp
  - lease
  - no ip
  - apipa
  - 169.254
  - dora
```

### 2. First command

Where does the failure live? Three plausible places:

1. The client never sends DISCOVER.
2. The relay drops it.
3. The server doesn't reply (scope exhaustion, policy block).

The fastest one-liner that splits (1) from (2)+(3) is
`show ip dhcp snooping binding` — if the client sent a DISCOVER but
the lease never came back, snooping has a partial entry. So:

```yaml
steps:
  - id: snoop-binding
    type: command
    command: show ip dhcp snooping binding interface {{port}}
```

`{{port}}` is a substitution variable. The picker accepts JSON vars,
so the operator types `{"port": "Gi1/0/12"}` and the engine
substitutes before classification.

### 3. Assertion + branch

```yaml
  - id: assert-snoop-empty
    type: assertion
    expression: "rows | length(@)"
    expects: 0
    on_pass: client-not-discover     # no entry: client never sent DISCOVER
    on_fail: server-not-replying     # entry exists: server side problem
```

Plan 05 turns the snooping table into structured rows; the JMESPath
counts them.

### 4. Narration + user prompt

For each branch tip I added a `narration` step that summarises the
finding for the operator and a `user_prompt` step that asks whether
they want to dig further:

```yaml
  - id: client-not-discover
    type: narration
    text: |
      Snooping has no entry — the client never sent a DISCOVER.
      Check the host NIC, switch port forwarding state, and any
      port-security violations.
  - id: ask-investigate-port
    type: user_prompt
    prompt: Want me to pull port-security and STP state? (yes/no)
```

The narrator can rewrite this text with RAG citations when the
sidecar is up; if not, the literal text is shown.

### 5. Save and test

I saved through the editor (Save button is disabled until the
schema, parse, and cross-references all pass). The picker
immediately surfaced `dhcp-no-lease` for the symptom *"laptop got
169.254 instead of an IP"* — keyword + embedding match.

---

## Variables and substitution

Playbooks reference variables with double-braces: `{{name}}`.
Variables come from three sources:

1. **The picker's Vars JSON** — the operator types a JSON object
   into the picker.
2. **`user_prompt` answers** — when a user responds to a prompt step,
   the answer is captured under the prompt step's id and is available
   to subsequent steps via `{{<step_id>}}`.
3. **Future**: structured-output captures (Plan 05) are an open
   roadmap item — currently only the JMESPath result is held in run
   state, not bound to a variable.

### Substitution rules

- `{{name}}` is substituted *before* the engine classifies the
  command. This is mandatory: if substitution happened after
  classification, an attacker could hide
  `reload` inside `{{neighbor}}` and bypass the Tier-0 gate.
- A missing variable is a **hard failure**: the run fails with status
  `failed` *before any command executes*. We don't fall back to
  empty string — that would silently change command semantics.
- The engine re-runs guardrail classification on the substituted
  command (see *Security: variable substitution + guardrails* below).

### Example

```yaml
- id: ping-neighbor
  type: command
  command: ping {{neighbor}} repeat 3
```

with vars `{"neighbor": "10.0.0.5"}` becomes `ping 10.0.0.5 repeat 3`,
classifies as Tier-0, and runs.

With vars `{"neighbor": "10.0.0.5; reload"}` the substituted text
contains a `;` — the engine splits on shell metacharacters
(`;`, `&&`, `||`, `&`, backticks) and classifies each chunk
separately. The `reload` chunk classifies as **Tier-3**, the run
pauses with a `GuardrailRejection`, and the operator must explicitly
acknowledge the pause via the awaiting-user modal. **No Tier-1+
command can reach the SSH transport without explicit user
confirmation.**

---

## Assertion and branch semantics

### JMESPath cheat sheet

The seed playbooks use this slice of JMESPath:

| Pattern | Meaning |
| --- | --- |
| `tables[0].rows` | First parsed table from Plan 05's structured output. |
| `rows[?neighbor=='10.0.0.5']` | Filter — rows where `neighbor` equals the given value. |
| `rows[?starts_with(neighbor, '10.0.0')]` | Filter using a built-in. |
| `rows[?neighbor=='{{neighbor}}'] \| [0].state` | Pipe into `[0].state` — first match's `state` field. |
| `length(@)` | Count of items in the current node. |
| `keys(@)` | Field names on a mapping. |
| `not_null(field, fallback)` | Built-in for default-when-missing. |

JMESPath spec: <https://jmespath.org/specification.html>. The runtime
uses Rust's `jmespath@0.5`.

### Branch matching

```yaml
- id: bgp-state-branch
  type: branch
  cases:
    - when: Established
      next: established-narrate
    - when: Idle
      next: idle-investigate
    - when: Active
      next: active-investigate
    - when: null
      next: not-configured
```

The engine matches `when` against the **last assertion result** in
JSON-typed form — strings, numbers, booleans, and null all work. The
first matching `when` wins. If nothing matches, the branch step
itself transitions to `failed` and the run terminates.

---

## How guardrails protect you

The engine's safety story is layered on top of
[GUARDRAILS.md](GUARDRAILS.md).

### Tier-0 only auto-runs

Every `command` step is classified through
`crate::guardrails::classifier::Tier::{T0, T1, T2, T3, Ambiguous}`.
Only `T0` (read-only / observational) auto-executes. Anything above
T0 — including `Ambiguous` — pauses the run with status
`awaiting_user` and surfaces the rejection in the awaiting-user
modal:

> The next step is *Tier-2 — Forwarding-affecting*. Type "interface
> Gi1/0/1 shutdown" exactly to confirm, or press Skip.

### Variable substitution + guardrails

Substitution happens **before** classification (see *Variables*
above). The engine then **splits on shell metacharacters** (`;`,
`&&`, `||`, `&`, backticks) and classifies each chunk separately;
the maximum tier across all chunks wins. This is the load-bearing
defence against
`{"neighbor": "10.0.0.5; reload"}` style attacks.

The live executor (`LiveStepExecutor::run_command`) does belt-and-
braces re-classification — even if a caller bypassed the engine, the
executor itself refuses anything that isn't `Tier::T0`.

### `user_prompt` vs Tier-1+ pause

Both pause the run, but they're different in a critical way:

- **`user_prompt`** captures the answer into run state and continues
  on `answer_prompt`. The next step still has to pass classification.
- **Tier-1+ pause** holds the run until the operator explicitly
  presses **Resume** on the control bar. `answer_prompt` does NOT
  auto-resume a Tier-1+ pause. This keeps the safety invariant
  crystal-clear: clicking past a modal cannot unpause a Tier-1+ run.

### Builtin playbooks are read-only

The six seed playbooks ship as `builtin=1` rows. The editor flags
them read-only client-side; the backend `upsert_playbook` and
`delete_playbook` commands reject writes server-side. To customise a
builtin, click **Duplicate** in the editor — it forks the YAML into a
fresh user playbook (id is `<original>-copy`), and you save that as
your own.

---

## Authoring playbooks

Open the editor: **Edit Playbooks** button on the troubleshoot tab,
or `menu:troubleshoot_editor`.

### Editor surface

- **Toolbar**: Playbook dropdown · New · Save · Duplicate (only when
  a builtin is selected) · Import · Export · Delete.
- **Left pane**: Monaco YAML with inline schema validation (squiggles
  + hover messages from `monaco-yaml`).
- **Right pane**: live `<TreeCanvas>` preview with all steps in
  status `pending`. Updates 300ms after the last edit.
- **Diagnostics panel** (bottom): collapsible. Shows YAML parse
  errors, schema violations, and cross-reference errors (e.g.
  `next: nonexistent-step`). Click a row to jump the cursor to the
  offending line.

Save is disabled until **all three** layers pass:

1. YAML parses.
2. Schema passes.
3. Cross-references resolve (`next`, `on_pass`, `on_fail`,
   `cases[].next` all point to real step ids; no duplicate ids).

### Sharing: export and import

- **Export** writes `<id>.yaml` to disk via the system save dialog.
- **Import** reads a `.yaml` / `.yml` from disk, validates it
  client-side against the schema, and opens it in the editor with a
  fresh slug if the imported `id` would collide with an existing
  playbook (builtin or user). You can rename back before saving but
  the default is to never overwrite.

> **Warp-Drive cloud sharing is deferred.** The current sharing
> story is file-based: export the YAML, send it to your team, they
> import. A future plan may wire shared playbooks through Warp-Drive
> or a private S3 bucket; the YAML format is forward-compatible.

---

## Troubleshooting the troubleshooting tree

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Save button stays disabled with "0 errors" | The buffer hasn't been edited (`isDirty=false`). | Save is no-op without changes. Edit at least one character. |
| Status row shows "Save failed: builtin" | You tried to save under a builtin id. | Click **Duplicate** to fork into a user playbook. |
| Run status flips to `failed` immediately with "variable unresolved" | `{{name}}` not in the picker's Vars JSON. | Add the variable to Vars JSON before pressing Start run. |
| Awaiting-user modal appears on the first command step | The substituted command classified as Tier-1+. | Either edit the playbook to use a Tier-0 command, or acknowledge the pause and Resume. |
| Narration panel shows "sidecar unavailable" | The sidecar process isn't running. | Run `cargo tauri dev` from a clean shell; check `target/debug/python/` is not a stale bundled venv. |
| No matches surface for a symptom | All scores below 0.35. | Pick a playbook from the manual list, or **Start a blank run**. |

See also: [GUARDRAILS.md](GUARDRAILS.md), [PARSING.md](PARSING.md),
[NOTEBOOKS.md](NOTEBOOKS.md), [ARCHITECTURE.md](ARCHITECTURE.md).
