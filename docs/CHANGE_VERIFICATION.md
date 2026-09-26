# Change Verification

Pre/post change verification for network operations. Capture a baseline snapshot of structured device state before a change, make the change, then re-snapshot and receive a severity-classified diff report. Changes that match pre-approved deltas are automatically filtered; unexpected deltas are surfaced for operator review.

## Quick Start

### Opening the Change Window

- **Keyboard shortcut:** `Cmd+Shift+V` (macOS) / `Ctrl+Shift+V` (Windows/Linux)
- **Menu path:** `View > Show Change Window`

The change-verification workflow is anchored to a specific SSH tab. Select the tab you want to verify changes on, then open the change window.

### The 4-Stage Workflow

1. **Select Bundle:** Pick or create a check bundle (a named list of show commands).
2. **Pre-Check:** Run the bundle's commands and persist the parsed output as a "pre" snapshot.
3. **Make Change:** Apply your configuration change via the terminal. The window displays a checklist of expected actions (optional notes field).
4. **Post-Check:** Re-run the same bundle and diff the outputs. Deltas are classified by severity (red/yellow/green) and matched against approved-delta rules (if any). A persistent report is generated.
5. **Review:** Inspect the report. Click a delta to retroactively approve it (adds the approval to the report and re-classifies).

## Check Bundles

A **check bundle** is a reusable collection of show commands scoped to a vendor/platform pair. Bundles are stored in the local SQLite database and appear in the bundle picker filtered by the active tab's vendor/platform.

### Seeded Bundles

Four canonical bundles are seeded on first boot (idempotent via `app_flags`):

1. **Cisco IOS-XE routing baseline** — `show ip interface brief`, `show ip route summary`, `show ip bgp summary`, `show ip ospf neighbor`, `show cdp neighbor`
2. **Cisco IOS-XE switching baseline** — `show interfaces status`, `show vlan brief`, `show spanning-tree summary`, `show cdp neighbor`, `show mac address-table count`
3. **NX-OS fabric baseline** — `show interface brief`, `show ip route summary`, `show bgp l2vpn evpn summary`, `show nve peers`, `show vpc`
4. **Junos routing baseline** — `show interfaces terse`, `show route summary`, `show bgp summary`, `show ospf neighbor`, `show lldp neighbors`

### Creating Custom Bundles

Click **Create New Bundle** in the bundle picker. Supply a name, optional description, vendor, platform, and a newline-delimited list of commands. The bundle is persisted immediately and available for future change windows.

**Editing:** Click the pencil icon next to a bundle in the picker to rename, change commands, or delete.

## Severity Rules

Deltas are classified by command family. Rules are implemented in `src-tauri/src/change_verify/classifier.rs`. If you modify the classifier, update this table accordingly.

| Command Family | Triggers (command substring) | Red | Yellow | Green |
|---|---|---|---|---|
| **interface-status** | `ip interface brief`, `interfaces status` | oper_status → `down` or `admin-down` | Any other interface metadata change | (none) |
| **bgp-neighbor** | `bgp` + `summary` | Row removed (neighbor disappeared) OR `state`/`session_state` → non-Established value (e.g., `Active`, `Idle`) | Any other counter/field change | (none) |
| **ospf-neighbor** | `ospf` + `neighbor` | Row removed (adjacency lost) OR `state` → not FULL | Any other state change | (none) |
| **route-summary** | `route` + `summary` | Route count change >= 20% (2x yellow threshold) | Route count change >= 10% OR routes appeared from zero baseline | Count change < 10% |
| **cdp-neighbor** / **lldp-neighbor** | `cdp neighbor`, `lldp neighbor` | Row removed (neighbor lost) | Row added (new neighbor) OR attribute changed | (none) |
| **unknown** | (anything else) | (never red) | Any delta | (none) |

### Counter Noise Filter

BGP and OSPF commands produce mechanical counters that tick every poll and carry no semantic signal for change verification. These columns are **filtered out before classification**:

- **BGP:** `msgrcvd`, `msgsent`, `msg_received`, `msg_sent`, `tblver`, `tbl_ver`, `table_version`, `uptime`, `up_down`, `up/down`, `inq`, `outq`, `in_q`, `out_q`
- **OSPF:** `dead_time`, `deadtime`, `hello_timer`, `uptime`

Filtering is implemented in `classifier.rs:is_ignorable_counter`. Adjust as needed for your environment.

## Approvals

**Approved deltas** are path-substring patterns you declare in advance (or retroactively) to whitelist expected changes. Approvals are segment-based: each path is split on `/`, and the substring is matched against each segment independently.

### Path Structure

A delta path has the form `/row_key/column` (for list-of-dicts diffs) or `/nested/key` (for nested-dict diffs). Examples:

- `/10.0.0.5/state` — BGP neighbor `10.0.0.5`, `state` column changed
- `/GigabitEthernet0/1/oper_status` — interface `GigabitEthernet0/1`, `oper_status` changed
- `/ospf/default/area/0.0.0.0/neighbor_count` — nested-dict route summary delta

### Matching Rules

An approval is defined by:

1. **command_substring** (min 3 chars) — must appear in the delta's command.
2. **path_substring** (min 3 chars) — must match one **complete segment** in the delta's path.
3. **note** — freeform text explaining why this delta is expected.

The path substring is matched per-segment, so `"10.0.0.5"` will match `/10.0.0.5/state` but NOT `/10.0.0.50/state` (segment boundaries prevent substring collision).

### Lifecycle

**Declared in advance (pre-approved):** Pass an `approvedDeltas` array to the post-check Tauri command or store them in the report's metadata before post-check. The classifier will mark matching deltas as approved and downgrade their severity to green.

**Retroactive (from the UI):** Click the "Approve" button next to a delta in the report. The UI extracts a reasonable default approval (last two path segments, first 40 chars of command) and appends it to the report. The report is re-classified and the delta disappears from the red/yellow lists.

## Markdown Export

### From the UI

- **Button:** In the report stage, click **Export Markdown**.
- **Menu:** `File > Export Report as Markdown` (only enabled when a report is open).

Both flows open a save dialog defaulting to `change-report-<report-id-prefix>.md`. The exported file contains:

- Severity counts (red/yellow/green)
- Pre/post snapshot IDs
- Optional change notes
- Approved deltas section (if any)
- Per-command delta tables with Before/After values and messages

### Format

The Markdown file is a single document with H2/H3 headings. Deltas are rendered in tables with pipe-delimited columns. Pipes inside cell content are escaped (`\|`). Newlines are collapsed to spaces. Before/After JSON is truncated at 60 chars for readability.

**Sample snippet:**

```markdown
## Deltas by command

### `show ip bgp summary`

| Severity | Path | Before | After | Message |
|---|---|---|---|---|
| RED | `/10.0.0.2/state` | `"Established"` | `"Active"` | BGP neighbor 10.0.0.2 state is now Active |
```

## PDF Export

**DEFERRED.** PDF export is planned for a future release. Until then, export Markdown and convert via your tooling of choice:

- **pandoc:** `pandoc -f markdown -t pdf -o report.pdf report.md`
- **Marked 2 (macOS):** Open the `.md` file and export as PDF from the app menu.
- **VS Code:** Install the "Markdown PDF" extension.

The deferral is due to webview API constraints (Tauri 1.x → 2.x print API is version-specific) and the weight of embedding a full chromium-based PDF renderer. Both are research-heavy and out of scope for this initial release.

## Troubleshooting

### Bundle picker is empty

The picker filters bundles by the active tab's `vendor` and `platform` fields. If you created a bundle for `cisco`/`iosxe` but the active tab is `juniper`/`junos`, it won't appear. Solution: create a bundle with the correct vendor/platform for the tab, or switch tabs.

### Pre-check output doesn't parse

The structured parser (Plan 05) requires TTP templates or ntc-templates. If a command's output is not recognized, the parser stores raw text. The diff engine will compare raw strings (shallow diff, often noisy). To fix: ensure the command is in the template library for that vendor/platform.

### Post-check diff is empty (no deltas)

Either:

1. The change had no effect on the commands in the bundle (expand the bundle with more commands).
2. The only changes were ignorable counters (filtered out). Check the classifier's counter list.
3. The raw text output matched byte-for-byte (no structural parse occurred). In this case the differ is falling back to full-text comparison, which is brittle.

### Approved delta still shows as red/yellow

Approval matching is substring-based. Check that your `path_substring` and `command_substring` are both at least 3 chars and that the path substring matches a complete segment. If the delta path is `/10.0.0.50/state` and your approval is `"10.0.0.5"`, it won't match (segment boundary). Use a longer unique substring like `"10.0.0.50"`.

### Report export path contains spaces

The save dialog will quote the path correctly on all platforms. If you're scripting the export via the Tauri command API, ensure you pass `path` as a properly escaped string to the OS.

## Architecture Notes

- **Snapshot storage:** Parsed outputs are stored in `parsed_outputs` table (Plan 05's structured-tab infrastructure). Snapshots reference these by `parsed_output_id`.
- **Diff engine:** Plan 05's `diff_snapshots` public API (frozen at V0032). Produces per-command `CellDiff` lists (Unchanged/Added/Removed/Modified).
- **Classifier:** `change_verify::classifier` wraps the diff list with severity rules and filters out noise.
- **Report persistence:** Reports are JSON blobs in `change_reports` table. Linked to pre/post snapshot IDs. Approvals are stored as JSON arrays in `change_report_approvals`.
- **UI state:** `changeVerifyStore` (Zustand) manages the 4-stage workflow. `ChangeWindowPanel` renders the stage-specific UI. `ChangeReportView` groups deltas by command and allows in-report approval.

## Version History

- **V0033** (Plan 06) — Initial release. Pre/post workflow, severity classifier, Markdown export, 4 seeded bundles, retroactive approvals.
- **V0032** (Plan 05) — Structured tab + diff engine. Change-verify builds on Plan 05's `diff_snapshots` API.
