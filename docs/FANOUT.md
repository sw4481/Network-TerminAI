# Multi-Device Fan-Out

Run one read-only command across up to 50 SSH/NETCONF devices in parallel and
get a merged view that highlights the one device with a different result.

## When to use it

- Pre-change posture: "Are all 47 cores running the same image?"
- Outage triage: "Which BGP neighbor is down on which devices?"
- Compliance: "Show me the running NTP servers across the site."
- Anything where typing the same command into 50 sessions one-by-one wastes
  20 minutes and produces a wall of text you have to diff by eye.

Fan-out is **read-only** by design. Configuration push is gated on the
guardrails work in Plan 09 and is intentionally out of scope here.

## Building a group

1. Open **Fan-Out → Manage Device Groups...** (or the menu shortcut).
2. **+ New** in the left pane creates an empty group.
3. **Add Devices** opens the picker. The picker shows every saved SSH
   connection and NETCONF device in one filterable list with a kind badge.
   Use **Select all filtered** for "every device matching `core-`".
4. **CSV import** accepts a two-column CSV — see
   [`fanout-csv-format.md`](./fanout-csv-format.md). Identifiers can be
   either the saved-connection name or its id (case-insensitive).

The 50-device cap is enforced both at the picker (banner appears past 50)
and again server-side in `fanout_run_start` — overflow returns an error.

## Running a fan-out

1. Open **Fan-Out → Open Fan-Out Panel** (`⌘⇧F`).
2. Pick a group from the dropdown.
3. Type a command — e.g. `show ip int br`.
4. Optional: tune the per-device timeout (default 30 000 ms).
5. **Run**.

The progress lane shows one strip per device:

```
[ running  ]  r3-atl-core    ████░░░░░░  3.2s   ×
[ success  ]  r4-atl-core    ██████████  1.8s
[ timeout  ]  r5-atl-core    ██████████  30.0s  ↻
[ failed   ]  r6-atl-core    ██████████  0.4s   ↻
```

- `×` cancels a single in-flight device.
- `↻` retries a single failed/timed-out device (creates a new attempt — the
  old attempt row is preserved so you can diff retry vs. original).

The **Merged** tab shows a per-device summary table; per-device tabs render
the raw stdout for that device.

## Outlier banner

When the fan-out output parses cleanly into a tabular shape (e.g. `show ip
bgp summary`), the panel computes minority-value outliers: a column where
≥75% of devices share a value and ≤10% don't. The minority devices appear in
a banner above the merged view — click one to focus that device's tab.

The detection rule is intentionally conservative: a 50/50 column does not
flag, and a 60/40 column does not flag. The goal is "1 of 50 is wrong",
not "split brain".

## Cancel / retry / export

| Action | Hotkey | Description |
|---|---|---|
| Open panel | `⌘⇧F` | Toggle the fan-out window |
| Cancel run | `⌘.`  | Stops every in-flight device on the active run |
| Retry failed | `⌘R` | Spawns a new attempt for every `failed` / `timeout` device |
| Export zip | `⌘E` | Downloads the merged report (see below) |

Cancellation propagates within ~250ms via per-device tokio `CancellationToken`s.

## Export bundle

`Export Zip` writes a zip with this layout:

```
report.md            — markdown summary + per-device status table
manifest.json        — machine-readable run metadata
devices/<kind>_<sanitized-name>.txt — raw stdout per successful device
```

`manifest.json` includes the run id, command, status, and per-device entries
(status, error, duration). The markdown report embeds a status table you can
paste straight into a change ticket.

## History

The bottom drawer of the panel lists the last 50 runs. Clicking a row
re-hydrates that historical run as if it were active — the merged view, the
per-device tabs, and the export button all work against the persisted data.

## Resume after crash

If the app crashes mid-fan-out, the next launch sweeps any `running` run
rows: every `pending`/`running` per-device result is marked `failed` with
`interrupted: app restart`, and the run as a whole becomes `failed`. Use
`⌘R` to retry the affected devices.

## Architecture (one screen)

```
                        ┌─────────────────────────────────────┐
                        │          FanoutPanel.tsx            │
                        │ command bar │ progress │ merged │   │
                        └────┬─────────────────┬──────────────┘
                             │ invoke           ▲ events
                             ▼                  │
                ┌─────────────────────┐    fanout://event
                │ Tauri commands       │         │
                │ fanout_run_start ... │         │
                └────────┬─────────────┘         │
                         ▼                        │
            ┌────────────────────────────┐        │
            │ fanout::executor::Executor │────────┘
            │  Semaphore<50>             │
            │  CancellationToken tree    │
            │  DeviceWorker per member   │
            └──┬─────────────┬───────────┘
               │             │
       ┌───────▼──┐    ┌─────▼────────┐
       │ Mock     │    │ LiveFactory  │
       │ Worker   │    │  russh exec  │
       │ (tests)  │    │  netconf stub│
       └──────────┘    └──────────────┘
```

Persistence: `fanout_groups`, `fanout_group_members`, `fanout_runs`,
`fanout_run_results` (V0034). Per-device output is stored as a regular
`command_blocks` row tagged `fanout:<run_id>` (Plan 01) so the existing
block tools work — search, copy-as-markdown, share — without special cases.
