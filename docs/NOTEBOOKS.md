# Runnable Notebooks (MOPs)

CCIE Terminal's notebook engine turns network change procedures (MOPs) into
executable, audit-grade artefacts. A notebook is a markdown file with YAML
frontmatter and a typed cell graph; the runtime walks the cells against a
live PTY, gates on approvals, and validates show-output via JSONPath
assertions.

## What is a runnable notebook?

A `.mop.md` file looks like this:

```markdown
---
title: BGP Peer Bringup
description: Bring up a new IBGP peer.
vendor: cisco
platform: iosxe
parameters:
  - name: peer_ip
    prompt: Neighbor IP
    default: 10.0.0.2
---

# Pre-check

​```command
show ip bgp summary
​```

# Configure

​```approval
Review the configuration, then click Continue to apply.
​```

​```command
configure terminal
router bgp 65001
 neighbor {{peer_ip}} remote-as 65001
end
​```

# Validate

​```assertion
{"command": "show ip bgp summary", "jsonpath": "$.vrf.default.neighbor['{{peer_ip}}'].session_state", "op": "equals", "expected": "Established"}
​```
```

Frontmatter is optional but recommended. The body is parsed for
`​```command`, `​```approval`, `​```assertion`, and `​```parameter` fenced
blocks — anything else (prose, headings, `​```bash` snippets) is treated
as Markdown and rendered as such.

## Cell types

| Type        | Effect                                                                                                          |
|-------------|-----------------------------------------------------------------------------------------------------------------|
| `markdown`  | Rendered as prose. Skipped at run time.                                                                         |
| `command`   | Body is sent to the active tab's PTY. Run is marked failed if the command exits non-zero.                       |
| `approval`  | Run pauses; the UI shows a Continue / Cancel card. Continue resumes; Cancel stops the run with status `cancelled`. |
| `assertion` | Body is JSON: `{command, jsonpath, op, expected}`. The runner runs `command`, parses via the Plan 00 sidecar, applies `jsonpath`, then compares to `expected` using `op`. |
| `parameter` | Synthesised from the `parameters:` frontmatter list; defines `{{var}}` substitutions.                            |

## Writing an assertion

```json
{
  "command": "show ip ospf neighbor",
  "jsonpath": "$..state",
  "op": "contains",
  "expected": "FULL"
}
```

`op` accepts: `equals`, `not_equals`, `contains`, `greater_than`,
`less_than`, `exists`. The `jsonpath` runs against the **parsed** output
returned by the sidecar's `parse.request` (Genie/TextFSM); for the generic
vendor (`vendor: generic`) the runner falls back to `{"stdout": "<raw output>"}`
so smoke MOPs run without a parser.

A failure where the predicate does not hold marks the cell `failed` and
stops the run. A failure where the parser/sidecar errored marks the cell
`failed` with a different surface (infrastructure error vs predicate
mismatch).

## Parameters and substitution

Parameters are declared in frontmatter and substituted in any `command` or
`assertion` cell using `{{name}}` syntax. Required parameters (those
without a `default`) must be supplied at run start or the run fails before
any PTY interaction. Defaults are applied for any unset parameter at run
start.

## Resume from failure

A failed run can be resumed from the failed cell. The run row is mutated
(status returns to `running`) rather than spawning a fresh run id, so the
audit trail reflects a single attempt that ultimately succeeded after
retry. The `notebook_run_resume` command computes `start_at_idx` from the
lowest `cell_idx` whose status is `failed`.

## Seed MOPs

Ten canonical seeds ship with the app and are imported on first run
(idempotent — gated by the `notebooks.runnable.seeded.v1` flag in
`app_flags`):

* `bgp_peer_bringup` — IBGP peer with parameter substitution + assertion.
* `ospf_neighbor_add` — enable OSPF on an interface; verify FULL state.
* `isis_neighbor_add` — IS-IS L2 adjacency; verify Up state.
* `interface_mtu_change_validation` — set jumbo MTU; verify with `show interfaces`.
* `vlan_trunk_add` — add a VLAN to a trunk allowed list.
* `hsrp_failover_test` — force then revert HSRP failover.
* `bfd_single_hop_enable` — BFD on an interface for fast failure detection.
* `acl_apply_with_rollback` — apply ACL with explicit rollback approval.
* `ntp_server_change` — replace an NTP server; verify sync.
* `snmpv3_user_add` — add SNMPv3 user with auth+priv.

Each ships in `src-tauri/notebooks/seeds/` and is `include_str!`'d into
the binary.

## Authoring workflow

1. Author a `.mop.md` file in your editor of choice.
2. Open the Notebook Library (Cmd+Shift+N) → Import from file.
3. Click Open on the row to load it into the right-side panel.
4. Fill in any required parameters in the form at the top of the panel.
5. Click Run. Approve when prompted; the runner stops at the first
   failure or the first `Cancel`.
6. Click Resume to retry from the failed cell once you've fixed the
   underlying issue.

`body_markdown` is stored verbatim, so Export from the library returns the
exact bytes you imported. (If you edit cells in-UI, the re-rendered form
is a *lossy projection* — round-trip-stable as a cell graph but not
necessarily byte-stable.)
