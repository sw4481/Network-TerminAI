# Packet Capture — Vendor Command Reference

> **Authoritative reference for Plan 11.** Any change in vendor syntax in
> `src-tauri/src/pcap/builder.rs` MUST update this document in the same commit.

This document records the canonical packet-capture flow for each vendor we
support. Plan 11's `builder.rs` emits these exact command strings.

---

## Cisco IOS-XE 17.x — Embedded Packet Capture (EPC)

IOS-XE 17.x uses a single `monitor capture` namespace (no separate
"capture point" / "capture buffer" objects like classic IOS 15.x).

```cisco
! 1. Define the capture
monitor capture CAP interface GigabitEthernet0/0/1 both
monitor capture CAP match any                     ! all L2/L3; or: match access-list <ACL>
monitor capture CAP buffer circular size 10
monitor capture CAP limit duration 30

! 2. Start
monitor capture CAP start

! 3. Wait for completion
!    The `limit duration` set above auto-stops the capture, so the orchestrator
!    waits duration + slack (no polling) then issues an explicit stop.
monitor capture CAP stop

! 4. Export to on-box storage (17.x supports direct pcap export)
!    NOTE the `location` keyword — required on Catalyst 9000 / IOS-XE 17.x.
monitor capture CAP export location flash:CAP.pcap

! 5. Cleanup
no monitor capture CAP
```

**Capture-name rules:** `[A-Z0-9_]{1,15}`. Builder sanitizes user input.

**File transfer:** the pcap is pulled off-box with **SCP**, not SFTP. Catalyst
9000 / IOS-XE switches enable an SCP server (`ip scp server enable`) but expose
no SFTP subsystem, so a russh-sftp handshake times out. The orchestrator uses
the system `scp` client (`-O`, via `sshpass`) and requests the **basename**
(`CAP.pcap`) — the device's SCP server resolves it against flash:; a
`flash:CAP.pcap` / `/flash/CAP.pcap` request is rejected. See
`src-tauri/src/pcap/scp.rs`.

**Verified:** the full flow (setup → start → auto-stop → `export location` →
SCP pull) was validated end-to-end against a live Catalyst 9000 (IOS-XE 17.19)
by the `pcap_live_test` integration test.

**Gotchas:**
- **Use `match any`, not `match ipv4 any any`.** On Catalyst 9000, the IPv4
  core filter only captures IPv4 transit — a link carrying ARP/STP/PTP/non-IP
  frames (or no IPv4 in the capture window) yields an empty/near-empty file
  (the "0 packets" symptom). `match any` captures all L2/L3 traffic. Verified
  live: same interface/window gave 0–4 KB with `match ipv4 any any` vs 11 KB
  (103 packets) with `match any`.
- The device's `show monitor capture CAP buffer` decode may report "Wireshark
  operation failure" on some images even when the capture is working — trust
  the **exported file** (size / packet count), not the on-box buffer display.
- **`control-plane` is not a valid capture interface on Catalyst 9000 switches**
  — `monitor capture ... interface ?` lists only physical/SVI interfaces
  (`GigabitEthernet`, `Vlan`, `Port-channel`, …). The "IOS-XE control-plane"
  built-in template targets routers (ISR/ASR), not switches.
- IOS-XE 16.6 and earlier (and classic IOS 15.x) require the older
  capture-point + capture-buffer + associate flow. Plan 11 default path is 17.x.

**Source:**
- Cisco IOS XE Bengaluru 17.x Configuration Guide — *Network Management
  Configuration Guide → Configuring Packet Capture*
  https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/epc/configuration/xe-17/epc-xe-17-book.html

---

## Cisco NX-OS — `ethanalyzer`

NX-OS uses `ethanalyzer` — a single command, blocks until the autostop
duration or frame limit is reached. No setup/cleanup phase.

```nxos
ethanalyzer local interface mgmt0 limit-captured-frames 0 autostop duration 30 write bootflash:CAP.pcap

! Optional capture filter (BPF syntax)
ethanalyzer local interface mgmt0 capture-filter "host 10.1.1.1" limit-captured-frames 0 autostop duration 30 write bootflash:CAP.pcap
```

**Notes:**
- `limit-captured-frames 0` = no frame cap (use duration only).
- The command blocks; orchestrator simply waits `duration_s + 5s` slack.
- Capture is written to `bootflash:CAP.pcap`. SFTP path is `/bootflash/CAP.pcap`.

**Source:**
- NX-OS Troubleshooting Guide (9.3+) — *Configuring Ethanalyzer*
  https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/103x/troubleshooting/cisco-nexus-9000-series-nx-os-troubleshooting-guide-103x.html

---

## Juniper Junos — `monitor traffic write-file`

Junos `monitor traffic` is the operational-mode wrapper around tcpdump.

```junos
monitor traffic interface ge-0/0/0 write-file /var/tmp/CAP.pcap size 65535 count 2000 no-resolve
```

**Notes:**
- `count` is an upper bound on captured frames; `size` is snaplen.
- `no-resolve` skips DNS PTR (faster).
- On hardware that lacks the operational interface, fall back to
  `start shell` + `tcpdump -i <intf> -w /var/tmp/CAP.pcap`.
- The command blocks; orchestrator waits `duration_s + 5s`.
- Pcap path is `/var/tmp/CAP.pcap`; SFTP is direct (no prefix mapping).

**Source:**
- Junos OS CLI Reference — *monitor traffic*
  https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/command/monitor-traffic.html

---

## Arista EOS — bash + tcpdump pass-through

EOS exposes a Linux shell via `bash`; we use a timeout-bounded tcpdump.

```eos
bash timeout 30 sudo tcpdump -i Ethernet1 -U -w /mnt/flash/CAP.pcap
```

**Notes:**
- `-U` flushes per-packet so partial captures survive a timeout.
- `timeout 30` enforces capture duration; tcpdump exits cleanly.
- Pcap is written under `/mnt/flash/CAP.pcap`; SFTP is direct.

**Source:**
- Arista EOS User Manual — *CLI Bash and Linux Pass-through*
  https://www.arista.com/en/um-eos/eos-section-6-2-bash

---

## Path-prefix normalization for SFTP

`russh-sftp` operates on POSIX paths. On-device pcap targets use vendor
prefixes that must be stripped or rewritten before SFTP open:

| Vendor   | On-device path        | SFTP path             |
|----------|-----------------------|-----------------------|
| IOS-XE   | `flash:CAP.pcap`      | `/flash/CAP.pcap`     |
| NX-OS    | `bootflash:CAP.pcap`  | `/bootflash/CAP.pcap` |
| Junos    | `/var/tmp/CAP.pcap`   | `/var/tmp/CAP.pcap`   |
| EOS      | `/mnt/flash/CAP.pcap` | `/mnt/flash/CAP.pcap` |

This logic lives in `src-tauri/src/pcap/sftp.rs::normalize_remote_path`.

---

## Validation guardrails (enforced in `builder::build`)

- `interface` must be non-empty after trim.
- `duration_s` must be `> 0` and `<= 3600`.
- `capture_name` is sanitized to `[A-Z0-9_]{1,15}`; if empty after
  sanitization, return error.
- `buffer_mb` defaults to 10 (IOS-XE only; ignored elsewhere).
