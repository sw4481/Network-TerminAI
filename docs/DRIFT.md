# Configuration Intent + Drift Detection

Declare the *intended* configuration for each device, then detect when the
live config drifts from intent — on-demand or on a schedule.

## When to use it

- Audit "is every core switch still running my golden config?"
- Catch a 3am unauthorized change before it propagates
- Generate a remediation patch automatically when drift is found
- Run drift checks nightly without leaving the terminal open

## Concepts

| Term | Meaning |
|---|---|
| **Intent template** | What the device *should* look like. Either a `golden` (raw running-config) or `jinja` (template + YAML vars). |
| **Selector** | Which devices this intent applies to. Either explicit `kind:id` tokens (`ssh:abc123`) or `tags` matched against the Plan 01 block-tag vocabulary. |
| **Drift report** | One row per (template, device, run). Status is `in_sync`, `drift`, or `error`. Severity is `none`, `additive` (intent has lines device doesn't), `destructive` (device has lines intent doesn't, OR a value differs), or `error`. |
| **Schedule** | A cron expression (6 fields: `sec min hour day month weekday`) tied to a template. The scheduler runs the template's drift check at every cron tick. |

## Workflow

1. **Open Drift → Manage Intent Templates...** (or use the menu).
2. **+ New** creates an empty intent. Pick `golden` (paste a known-good
   running-config) or `jinja` (template body + YAML vars).
3. Set the **Selector** — tag-based for tag-driven groups, or explicit
   device IDs (prefix `ssh:` or `netconf:`).
4. **Drift → Open Drift Sidebar** (`⌘⇧D`). Pick the intent from the dropdown.
5. **Run Now** dispatches `show running-config` to every device the
   selector resolves to via the Plan 07 fan-out executor, normalizes both
   sides, diffs, and persists one drift report per device.
6. **Schedule** opens a cron editor with presets (every 15min, hourly,
   nightly at 2am, weekdays at 8am). The cron job runs in the background
   and emits `drift://schedule_run` events.
7. Click any **drift** report to see the per-block diff. Click **Remediate**
   to open a Monaco editor with an auto-generated config patch — additions
   are passed through verbatim, deletions become `no <command>`. The push
   button is gated until you check the approval box; actually pushing
   config waits on Plan 09 (AI Guardrails).

## Vendor support

The normalizer ships rules for:

- **Cisco IOS-XE / IOS / IOS-XR**: drops `Building configuration`,
  `Current configuration : N bytes`, `Last configuration change`, `NVRAM
  config last updated`, `!Time:` banners. Redacts type-5/7/9 secrets and
  type-7 passwords, SNMP communities, TACACS/RADIUS keys, pre-shared keys.
- **Cisco NX-OS**: same as IOS-XE plus NX-OS's `snmp-server community
  <name> group ...` form.
- **Arista EOS**: same set as IOS-XE.
- **Juniper Junos**: drops `## Last commit:` / `## Last changed:`. Redacts
  `encrypted-password "..."`, `ssh-rsa "..."`, `ssh-ed25519 "..."`,
  `secret "..."`.
- **Generic**: pass-through with trailing-whitespace trim only.

Unrecognized vendor/platform pairs fall through to **Generic**.

## Diff engine

Built on the [`similar`](https://crates.io/crates/similar) crate's
`TextDiff::from_lines + grouped_ops(2)`. Each contiguous group of changes
is annotated with the nearest IOS-like block header (`interface ...`,
`router bgp ...`, `ip access-list ...`, etc.) or Junos curly-brace stanza.
Severity is computed per-group:

- Only insertions (intent has, device doesn't) → **Additive**
- Any deletion (device has, intent doesn't) → **Destructive**
- No changes → **None**

Run-level severity is the worst of any block.

## Hotkeys

| Hotkey | Action |
|---|---|
| `⌘⇧D` | Open drift sidebar |

(All actions are also reachable via the **Drift** menu — no hotkey-only
features.)

## Storage

Migration **V0035** adds:

- `intent_templates` (id, name, vendor, platform, kind, body, vars_yaml,
  selector_json)
- `intent_assignments` (template_id, device_id, override_vars_yaml) —
  scaffolded for per-device variable overrides; not yet wired in the UI
- `drift_reports` (id, template_id, device_id, status, severity,
  diff_patch, error_msg, captured_at) — `diff_patch` stored as JSON of
  `DriftPatch`
- `drift_schedules` (id, template_id, cron_expr, enabled, last_run_at)

`intent_templates → drift_reports` cascades on delete.
