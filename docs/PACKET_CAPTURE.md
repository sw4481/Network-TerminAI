# Packet Capture (Plan 11)

CCIE Terminal can drive a remote packet capture, pull the resulting pcap
back over SFTP, and render the result inline as a "pcap block" — packet
list, protocol hierarchy, hex view, follow-stream modal, and a Wireshark-
style display-filter bar.

## Architecture

```
PcapTemplateLibrary  ─┐
PcapQuickCaptureWizard├─►  pcap_start_capture (Tauri)
PcapAdvancedForm     ─┘             │
                                    ▼
                       pcap::orchestrator::run
                           ├── ssh_exec  (russh)
                           ├── pcap::sftp::pull_file (russh-sftp)
                           └── repo state-machine
                                    │
                                    ▼
                            sidecar: pcap.summarize
                            sidecar: pcap.packet_bytes
                            sidecar: pcap.follow_stream
                                    │
                                    ▼
                                PcapBlock UI
```

The orchestrator transitions a row in `pcap_captures` through:

```
setup → capturing → pulling → ready
            └────────►   failed
```

Cleanup commands run on success **and** failure (best-effort) so a
partially-armed device doesn't keep capturing if the orchestrator dies.

## Vendor support matrix

| Vendor      | Platform | Flow                                   | Limitations                              |
|-------------|----------|----------------------------------------|------------------------------------------|
| Cisco       | IOS-XE 17.x  | `monitor capture` (EPC)            | 16.x and earlier need advanced raw mode |
| Cisco       | NX-OS    | `ethanalyzer local interface …`        | Capture-filter accepts BPF only          |
| Juniper     | Junos    | `monitor traffic write-file`           | Snaplen 65535, frame count 2000          |
| Arista      | EOS      | `bash timeout … sudo tcpdump -U -w …`  | Requires bash + tcpdump priv             |

The exact command strings live in `src-tauri/src/pcap/builder.rs` and are
documented (with authoritative URLs) in
`docs/packet-capture/ios-xe-flow.md`.

## Templates

Built-in templates live in `pcap_templates` (seeded by migration V0038):

- `tpl-iosxe-wan` — IOS-XE WAN any-any (placeholder interface `<WAN_IF>`).
- `tpl-iosxe-cp`  — IOS-XE control-plane.
- `tpl-nxos-mgmt` — NX-OS mgmt0 ethanalyzer.
- `tpl-junos-ge`  — Junos monitor traffic on ge-0/0/0.

User templates can be created via `pcap_create_template`. Built-in
templates are read-only — `update_template` and `delete_template` reject
them with "builtin templates are read-only".

To add another built-in template, append a row to
`migrations/V0038__pcap_captures.sql` (or write a follow-on migration if
V0038 has shipped) with `builtin = 1`.

## Display filter cheat sheet

The display filter bar uses Wireshark display-filter syntax — the same
expressions you'd type into Wireshark's top filter bar. A few starters:

- `tcp.port == 443`
- `icmp`
- `dns`
- `ip.src == 10.0.0.1 && tcp.flags.syn == 1`

See the [Wireshark Display Filter
Reference](https://www.wireshark.org/docs/dfref/) for the full syntax.

Invalid filters produce an `invalid_filter` error from the sidecar; the
filter input shows a red outline and the prior summary stays in place
until you fix the expression.

## Size threshold

Captures > 100 MB emit a `pcap://size_warning` event during the pull
phase; the UI shows a banner. The threshold is centralized as
`PCAP_SIZE_WARN_BYTES` in `src-tauri/src/pcap/mod.rs`.

For very large captures, prefer:

1. A shorter capture duration.
2. A narrower BPF / ACL filter at capture time.
3. Exporting the raw pcap and inspecting it externally (tshark / Wireshark).

## Troubleshooting

**"command 'monitor capture …' exited 1"** — typically a vendor-version
mismatch (IOS-XE 16.x using a 17.x flow). Switch the device to the
advanced raw form, or upgrade.

**SFTP open fails on `flash:CAP.pcap`** — check the device's vty/SSH config
allows SFTP subsystem. On IOS-XE: `ip ssh server algorithm authentication
publickey password keyboard-interactive` and `ip ssh version 2`.

**`flash:` is full** — the export step writes the full pcap to on-device
storage before the SFTP pull. Trim historical pcaps or pick a smaller
buffer.

**`tshark` not found in sidecar** — install Wireshark / tshark on the host;
pyshark requires the `tshark` binary on `$PATH`. See the project README
for the bundled vs system path.

## Related files

- `src-tauri/src/pcap/` — backend (builder, orchestrator, sftp, ssh_exec).
- `src-tauri/src/commands/pcap.rs` — Tauri command surface.
- `src/components/Pcap*.tsx` — frontend components.
- `sidecar/src/ccie_sidecar/parsers/pcap.py` — sidecar pcap helpers.
- `docs/packet-capture/ios-xe-flow.md` — vendor command reference.
