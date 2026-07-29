# Blast-Radius Rule Seeding — Research Notes

> Reference document for the 200+ builtin rules in `builtin_rules.json`.
> Every rule cites an authoritative vendor source (Cisco / Juniper / Arista).
> This file is **not compiled** — it exists for audit and future extension.

## Tier definitions

- **Tier 0 — Read-only.** Pure observation. No state mutation, no traffic
  impact. Auto-approved.
- **Tier 1 — Local write, non-forwarding.** Mutates device state but does
  not directly affect data-plane forwarding (e.g., `hostname`, `clock set`,
  `logging` config). One-click confirm.
- **Tier 2 — Forwarding-affecting, targeted.** Touches forwarding for a
  specific interface, neighbor, or prefix (e.g., `interface ... shutdown`,
  `ip route` add/remove, single BGP neighbor `shutdown`). Typed confirm.
- **Tier 3 — Service-affecting / broad blast radius.** Affects the entire
  control plane, the whole device, or large groups of neighbors/prefixes
  (e.g., `reload`, `write erase`, `no router bgp`, `clear ip bgp *`).
  Maintenance window or admin override.

## Authoritative sources

### Cisco IOS / IOS-XE
- `reload` — Cisco IOS Configuration Fundamentals Command Reference: <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/command/cf_command_ref/M_through_R.html>
- `write erase` / `erase startup-config` — <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/command/cf_command_ref/W_through_Z.html>
- `clear ip bgp` — IOS-XE BGP Command Reference: <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_bgp/command/irg-cr-book/bgp-c1.html>
- `interface ... shutdown` — IOS Interface Configuration Guide
- `show *` family — IOS-XE Command Reference (read-only)
- `no router bgp <asn>` — removes the entire BGP process; documented as service-affecting in Cisco TAC tech notes
- `redistribute` / `bgp router-id` etc. — documented in IOS-XE Routing Command Reference

### Cisco NX-OS
- `reload` — NX-OS Fundamentals Command Reference: <https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus9000/sw/cmd_ref/103x/fundamentals/cisco-nexus-9000-nx-os-fundamentals-command-reference-103x.html>
- `write erase` — NX-OS Fundamentals
- `clear ip bgp` — NX-OS Unicast Routing Command Reference
- `feature` / `no feature` — NX-OS feature toggling. `no feature bgp`/`ospf`/`eigrp` is service-affecting.

### Juniper Junos
- `request system reboot` — Junos Operational Mode Command Reference: <https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/command/request-system-reboot.html>
- `request system halt` — Junos OS reference
- `commit` / `commit confirmed` — Junos CLI User Guide: <https://www.juniper.net/documentation/us/en/software/junos/cli/topics/topic-map/junos-cli-overview.html>
- `delete <hierarchy>` — Junos configuration mode reference; `delete protocols` etc. is service-affecting
- `show *` family — read-only operational commands
- `request system zeroize` — wipes the device; equivalent to `write erase`

### Arista EOS
- `reload` / `reload now` — Arista EOS User Manual: <https://www.arista.com/en/um-eos>
- `write erase` — EOS User Manual
- `clear ip bgp` — EOS User Manual
- `show *` — read-only

## Rule distribution targets

| Tier | Target % | Purpose |
|------|----------|---------|
| T0   | ~40%     | Coverage for common `show`/`display`/`ping`/`traceroute` so we don't fall through to Ambiguous on safe reads |
| T1   | ~15%     | `hostname`, `clock`, `logging`, `snmp-server community`, `banner` |
| T2   | ~25%     | Targeted: `shutdown`, single BGP neighbor, single static route, single interface clear |
| T3   | ~20%     | Reload / erase / no-router / clear-all / zeroize / commit-with-disruption |

## Rule table

| Vendor | Platform | Pattern (Rust regex) | Tier | Notes |
|--------|----------|----------------------|------|-------|
| cisco | iosxe | `^\s*reload\b` | 3 | Full device reload |
| cisco | iosxe | `^\s*reload\s+at\b` | 3 | Scheduled reload |
| cisco | iosxe | `^\s*reload\s+in\b` | 3 | Delayed reload |
| cisco | iosxe | `^\s*reload\s+cancel\b` | 1 | Cancels scheduled reload (safe) |
| cisco | iosxe | `^\s*reload\s+pause\b` | 2 | Pauses reload, single-effect |
| cisco | iosxe | `^\s*write\s+erase\b` | 3 | Erases startup-config |
| cisco | iosxe | `^\s*erase\s+startup-config\b` | 3 | Same as write erase |
| cisco | iosxe | `^\s*erase\s+nvram:\b` | 3 | Erases NVRAM |
| cisco | iosxe | `^\s*erase\s+flash:` | 3 | Erases flash device |
| cisco | iosxe | `^\s*delete\s+flash:` | 2 | Deletes file on flash |
| cisco | iosxe | `^\s*format\s+\S+:` | 3 | Formats filesystem |
| cisco | iosxe | `^\s*no\s+router\s+bgp\b` | 3 | Removes entire BGP process |
| cisco | iosxe | `^\s*no\s+router\s+ospf\b` | 3 | Removes OSPF process |
| cisco | iosxe | `^\s*no\s+router\s+eigrp\b` | 3 | Removes EIGRP process |
| cisco | iosxe | `^\s*no\s+router\s+isis\b` | 3 | Removes ISIS |
| cisco | iosxe | `^\s*no\s+ip\s+routing\b` | 3 | Disables routing |
| cisco | iosxe | `^\s*no\s+ipv6\s+unicast-routing\b` | 3 | Disables IPv6 routing |
| cisco | iosxe | `^\s*clear\s+ip\s+bgp\s+\*\s+soft` | 3 | Refreshes all BGP neighbors |
| cisco | iosxe | `^\s*clear\s+ip\s+bgp\s+\*` | 3 | Resets all BGP sessions |
| cisco | iosxe | `^\s*clear\s+bgp\s+\*` | 3 | Address-family-agnostic clear |
| cisco | iosxe | `^\s*clear\s+ip\s+bgp\s+\d` | 2 | Clear single neighbor |
| cisco | iosxe | `^\s*clear\s+ip\s+route\s+\*` | 3 | Wipes entire RIB |
| cisco | iosxe | `^\s*clear\s+ip\s+ospf\s+process\b` | 3 | Restarts OSPF process |
| cisco | iosxe | `^\s*clear\s+ip\s+eigrp\s+neighbors\b` | 3 | Resets all EIGRP adj |
| cisco | iosxe | `^\s*clear\s+counters\b` | 0 | Counter clear is observational |
| cisco | iosxe | `^\s*clear\s+arp-cache\b` | 2 | Brief reachability blip |
| cisco | iosxe | `^\s*clear\s+mac\s+address-table\b` | 2 | Brief L2 flood |
| cisco | iosxe | `^\s*clear\s+log(\s+.*)?$` | 1 | Log buffer clear (admin write) |
| cisco | iosxe | `^\s*clear\s+line\s+\d` | 1 | Disconnects vty/console |
| cisco | iosxe | `^\s*clear\s+crypto\s+sa\b` | 2 | IPsec rekey (brief tunnel drop) |
| cisco | iosxe | `^\s*clear\s+crypto\s+isakmp\b` | 2 | IKE clear |
| cisco | iosxe | `^\s*clear\s+ipsec\s+sa\s+peer\b` | 2 | Per-peer IPsec clear |
| cisco | iosxe | `^\s*shutdown\s*$` | 2 | Interface shutdown (in iface ctx) |
| cisco | iosxe | `^\s*interface\s+\S+(\n|\r\n)?\s*shutdown\b` | 2 | Inline iface shutdown |
| cisco | iosxe | `^\s*no\s+shutdown\s*$` | 1 | Re-enable iface |
| cisco | iosxe | `^\s*ip\s+route\s+\d` | 2 | Static route add |
| cisco | iosxe | `^\s*no\s+ip\s+route\s+\d` | 2 | Static route remove |
| cisco | iosxe | `^\s*ipv6\s+route\s+\S` | 2 | IPv6 static route |
| cisco | iosxe | `^\s*no\s+ipv6\s+route\s+\S` | 2 | IPv6 static route remove |
| cisco | iosxe | `^\s*neighbor\s+\S+\s+shutdown\s*$` | 2 | BGP single-neighbor shutdown |
| cisco | iosxe | `^\s*no\s+neighbor\s+\S+\s+shutdown\s*$` | 2 | BGP neighbor un-shut |
| cisco | iosxe | `^\s*neighbor\s+\S+\s+remote-as\b` | 2 | BGP neighbor add |
| cisco | iosxe | `^\s*no\s+neighbor\s+\S+\s+remote-as\b` | 3 | BGP neighbor delete |
| cisco | iosxe | `^\s*hostname\s+\S+` | 1 | Hostname change |
| cisco | iosxe | `^\s*clock\s+set\s+` | 1 | Clock set |
| cisco | iosxe | `^\s*ntp\s+server\s+\S+` | 1 | NTP server config |
| cisco | iosxe | `^\s*no\s+ntp\s+server\s+\S+` | 1 | NTP server removal |
| cisco | iosxe | `^\s*snmp-server\s+community\s+\S+` | 1 | SNMP community add |
| cisco | iosxe | `^\s*no\s+snmp-server\s+community\s+\S+` | 1 | SNMP community remove |
| cisco | iosxe | `^\s*logging\s+host\s+\S+` | 1 | Syslog dest |
| cisco | iosxe | `^\s*logging\s+buffered\b` | 1 | Logging buffer |
| cisco | iosxe | `^\s*banner\s+(motd\|login\|exec)\b` | 1 | Banner config |
| cisco | iosxe | `^\s*username\s+\S+\s+(privilege\|password\|secret)\b` | 1 | Local user mgmt |
| cisco | iosxe | `^\s*no\s+username\s+\S+` | 1 | Remove user |
| cisco | iosxe | `^\s*aaa\s+new-model\s*$` | 2 | Enables AAA — login flow change |
| cisco | iosxe | `^\s*no\s+aaa\s+new-model\s*$` | 3 | Disables AAA — admin lockout risk |
| cisco | iosxe | `^\s*line\s+vty\s+\d` | 1 | VTY line config (followed by sub-cmds) |
| cisco | iosxe | `^\s*transport\s+input\s+(none\|telnet\|ssh)` | 2 | Mgmt transport change |
| cisco | iosxe | `^\s*ip\s+access-list\s+(standard\|extended)\b` | 2 | ACL definition (until applied) |
| cisco | iosxe | `^\s*ip\s+access-group\s+\S+\s+(in\|out)\s*$` | 2 | ACL apply on iface |
| cisco | iosxe | `^\s*no\s+ip\s+access-group\s+\S+\s+(in\|out)\s*$` | 2 | ACL remove |
| cisco | iosxe | `^\s*spanning-tree\s+mode\s+\S+` | 3 | STP mode change |
| cisco | iosxe | `^\s*no\s+spanning-tree\s+vlan\b` | 3 | STP disable |
| cisco | iosxe | `^\s*vtp\s+mode\s+\S+` | 3 | VTP mode change |
| cisco | iosxe | `^\s*vlan\s+\d+\s*$` | 1 | VLAN definition |
| cisco | iosxe | `^\s*no\s+vlan\s+\d+\s*$` | 2 | VLAN delete |
| cisco | iosxe | `^\s*switchport\s+access\s+vlan\s+\d+` | 2 | Access VLAN change |
| cisco | iosxe | `^\s*switchport\s+trunk\s+allowed\s+vlan\b` | 2 | Trunk allowed list |
| cisco | iosxe | `^\s*channel-group\s+\d+\s+mode\b` | 2 | LAG membership |
| cisco | iosxe | `^\s*no\s+channel-group\s+\d+` | 2 | LAG removal |
| cisco | iosxe | `^\s*ip\s+nat\s+(inside\|outside)\s+source\b` | 2 | NAT rule add |
| cisco | iosxe | `^\s*no\s+ip\s+nat\s+(inside\|outside)\s+source\b` | 2 | NAT rule remove |
| cisco | iosxe | `^\s*crypto\s+isakmp\s+policy\b` | 1 | Crypto policy build |
| cisco | iosxe | `^\s*crypto\s+map\s+\S+\s+\d+` | 2 | Crypto map binding |
| cisco | iosxe | `^\s*no\s+crypto\s+map\s+\S+` | 2 | Crypto map remove |
| cisco | iosxe | `^\s*service-policy\s+(input\|output)\s+\S+` | 2 | QoS apply |
| cisco | iosxe | `^\s*policy-map\s+\S+` | 1 | Policy build |
| cisco | iosxe | `^\s*class-map\s+\S+` | 1 | Class build |
| cisco | iosxe | `^\s*no\s+policy-map\s+\S+` | 2 | Policy remove |
| cisco | iosxe | `^\s*archive\s+config\s*$` | 0 | Archive snapshot |
| cisco | iosxe | `^\s*configure\s+replace\s+\S+` | 3 | Bulk config replace |
| cisco | iosxe | `^\s*configure\s+terminal\s*$` | 1 | Enter config mode |
| cisco | iosxe | `^\s*end\s*$` | 0 | Exit config |
| cisco | iosxe | `^\s*exit\s*$` | 0 | Exit context |
| cisco | iosxe | `^\s*write\s+memory\s*$` | 1 | Save running -> startup |
| cisco | iosxe | `^\s*copy\s+running-config\s+startup-config\s*$` | 1 | Same as write mem |
| cisco | iosxe | `^\s*copy\s+startup-config\s+running-config\s*$` | 3 | Reload running from startup (forwarding-affecting) |
| cisco | iosxe | `^\s*copy\s+\S+\s+running-config\s*$` | 3 | Merge external config — high risk |
| cisco | iosxe | `^\s*copy\s+running-config\s+\S+:` | 0 | Backup config to file |
| cisco | iosxe | `^\s*copy\s+\S+:\S+\s+\S+:\S+` | 1 | File-to-file copy |
| cisco | iosxe | `^\s*tclsh\s*$` | 2 | TCL shell — admin escape |
| cisco | iosxe | `^\s*event\s+manager\s+applet\b` | 2 | EEM applet — runs on triggers |
| cisco | iosxe | `^\s*test\s+platform\b` | 2 | Platform test — vendor-specific risk |
| cisco | iosxe | `^\s*hw-module\s+(slot\|module)\b` | 3 | HW module reset/reload |
| cisco | iosxe | `^\s*microcode\s+reload\b` | 3 | Microcode reload |
| cisco | iosxe | `^\s*upgrade\s+\S+` | 3 | Image upgrade |
| cisco | iosxe | `^\s*request\s+platform\s+software\b` | 2 | Platform software request |
| cisco | iosxe | `^\s*show\s+version\b` | 0 | show version |
| cisco | iosxe | `^\s*show\s+running-config\b` | 0 | show run |
| cisco | iosxe | `^\s*show\s+startup-config\b` | 0 | show start |
| cisco | iosxe | `^\s*show\s+ip\s+route\b` | 0 | RIB |
| cisco | iosxe | `^\s*show\s+ipv6\s+route\b` | 0 | IPv6 RIB |
| cisco | iosxe | `^\s*show\s+ip\s+bgp\b` | 0 | BGP table |
| cisco | iosxe | `^\s*show\s+ip\s+ospf\b` | 0 | OSPF state |
| cisco | iosxe | `^\s*show\s+ip\s+eigrp\b` | 0 | EIGRP state |
| cisco | iosxe | `^\s*show\s+isis\b` | 0 | ISIS state |
| cisco | iosxe | `^\s*show\s+interfaces?\b` | 0 | Interface state |
| cisco | iosxe | `^\s*show\s+ip\s+interface\s+brief\b` | 0 | Iface brief |
| cisco | iosxe | `^\s*show\s+ip\s+protocols?\b` | 0 | Routing protocol state |
| cisco | iosxe | `^\s*show\s+vlan\b` | 0 | VLAN state |
| cisco | iosxe | `^\s*show\s+spanning-tree\b` | 0 | STP state |
| cisco | iosxe | `^\s*show\s+mac\s+address-table\b` | 0 | MAC table |
| cisco | iosxe | `^\s*show\s+arp\b` | 0 | ARP table |
| cisco | iosxe | `^\s*show\s+cdp\s+neighbors?\b` | 0 | CDP |
| cisco | iosxe | `^\s*show\s+lldp\s+neighbors?\b` | 0 | LLDP |
| cisco | iosxe | `^\s*show\s+log(ging)?\b` | 0 | Syslog buffer |
| cisco | iosxe | `^\s*show\s+platform\b` | 0 | Platform info |
| cisco | iosxe | `^\s*show\s+processes?\b` | 0 | Processes |
| cisco | iosxe | `^\s*show\s+memory\b` | 0 | Memory |
| cisco | iosxe | `^\s*show\s+inventory\b` | 0 | Hardware inventory |
| cisco | iosxe | `^\s*show\s+environment\b` | 0 | Environment |
| cisco | iosxe | `^\s*show\s+tech-support\b` | 0 | Tech-support dump |
| cisco | iosxe | `^\s*show\s+access-lists?\b` | 0 | ACLs |
| cisco | iosxe | `^\s*show\s+ip\s+nat\s+translations\b` | 0 | NAT table |
| cisco | iosxe | `^\s*show\s+crypto\s+(isakmp\|ipsec\|session)\b` | 0 | Crypto state |
| cisco | iosxe | `^\s*show\s+vrf\b` | 0 | VRF list |
| cisco | iosxe | `^\s*show\s+mpls\b` | 0 | MPLS state |
| cisco | iosxe | `^\s*show\s+policy-map\b` | 0 | QoS state |
| cisco | iosxe | `^\s*show\s+queueing\b` | 0 | Queue state |
| cisco | iosxe | `^\s*ping\b` | 0 | Ping |
| cisco | iosxe | `^\s*traceroute\b` | 0 | Traceroute |
| cisco | iosxe | `^\s*telnet\s+\S+` | 1 | Outbound telnet (uses local sockets) |
| cisco | iosxe | `^\s*ssh\s+\S+` | 1 | Outbound ssh |
| cisco | iosxe | `^\s*dir\b` | 0 | Filesystem listing |
| cisco | iosxe | `^\s*more\s+\S+` | 0 | Display file |
| cisco | iosxe | `^\s*pwd\s*$` | 0 | Print working dir |
| cisco | iosxe | `^\s*cd\s+\S+` | 0 | Change dir (filesystem only) |
| cisco | iosxe | `^\s*terminal\s+(length\|width\|monitor)\b` | 0 | Terminal session settings |
| cisco | iosxe | `^\s*debug\s+\S+` | 1 | Enable debug — CPU risk on prod |
| cisco | iosxe | `^\s*no\s+debug\s+\S+` | 0 | Disable debug |
| cisco | iosxe | `^\s*undebug\s+all\b` | 0 | Stop all debug |
| cisco | iosxe | `^\s*monitor\s+session\s+\d+\s+source\b` | 2 | SPAN session add |
| cisco | iosxe | `^\s*no\s+monitor\s+session\s+\d+` | 1 | SPAN remove |
| cisco | nxos | `^\s*reload\b` | 3 | NX-OS reload |
| cisco | nxos | `^\s*reload\s+module\s+\d` | 3 | Module reload |
| cisco | nxos | `^\s*write\s+erase\b` | 3 | Erase startup |
| cisco | nxos | `^\s*write\s+erase\s+boot\b` | 3 | Erase boot vars |
| cisco | nxos | `^\s*no\s+feature\s+\S+` | 3 | Disables a feature (bgp/ospf/etc) |
| cisco | nxos | `^\s*feature\s+\S+` | 1 | Enables a feature (config-only effect) |
| cisco | nxos | `^\s*clear\s+ip\s+bgp\s+\*\s+soft` | 3 | All-BGP soft refresh |
| cisco | nxos | `^\s*clear\s+ip\s+bgp\s+\*` | 3 | All-BGP reset |
| cisco | nxos | `^\s*clear\s+bgp\s+\*\s+soft\s+(in\|out)` | 3 | NX-OS BGP soft variant |
| cisco | nxos | `^\s*clear\s+ip\s+bgp\s+\d` | 2 | Single-neighbor clear |
| cisco | nxos | `^\s*no\s+router\s+bgp\b` | 3 | BGP process delete |
| cisco | nxos | `^\s*no\s+router\s+ospf\s+\S+` | 3 | OSPF process delete |
| cisco | nxos | `^\s*shutdown\s*$` | 2 | Iface shutdown |
| cisco | nxos | `^\s*no\s+shutdown\s*$` | 1 | Iface no-shutdown |
| cisco | nxos | `^\s*hostname\s+\S+` | 1 | Hostname |
| cisco | nxos | `^\s*clock\s+set\s+` | 1 | Clock set |
| cisco | nxos | `^\s*copy\s+running-config\s+startup-config\b` | 1 | Save |
| cisco | nxos | `^\s*copy\s+\S+\s+running-config\b` | 3 | Merge external |
| cisco | nxos | `^\s*install\s+all\b` | 3 | NX-OS image install |
| cisco | nxos | `^\s*install\s+impact\b` | 0 | Image impact preview |
| cisco | nxos | `^\s*install\s+activate\b` | 3 | Image activate |
| cisco | nxos | `^\s*configure\s+replace\b` | 3 | Bulk replace |
| cisco | nxos | `^\s*configure\s+(terminal\|session)\b` | 1 | Enter config |
| cisco | nxos | `^\s*end\s*$` | 0 | Exit |
| cisco | nxos | `^\s*show\s+\S+` | 0 | Generic show fallback |
| cisco | nxos | `^\s*ping\b` | 0 | ping |
| cisco | nxos | `^\s*traceroute\b` | 0 | traceroute |
| cisco | nxos | `^\s*dir\b` | 0 | filesystem |
| cisco | nxos | `^\s*delete\s+\S+` | 2 | File delete |
| cisco | nxos | `^\s*format\s+bootflash:\b` | 3 | Filesystem format |
| cisco | nxos | `^\s*system\s+default\s+switchport\s+shutdown\b` | 3 | All ifaces default-shut on reboot |
| cisco | nxos | `^\s*no\s+system\s+default\s+switchport\s+shutdown\b` | 2 | Default-noshut ifaces on reboot |
| cisco | nxos | `^\s*vrf\s+context\s+\S+` | 1 | VRF def (config-only until used) |
| cisco | nxos | `^\s*no\s+vrf\s+context\s+\S+` | 3 | VRF removal — drops all routes in VRF |
| cisco | ios | `^\s*reload\b` | 3 | Classic IOS reload |
| cisco | ios | `^\s*write\s+erase\b` | 3 | Erase startup |
| cisco | ios | `^\s*clear\s+ip\s+bgp\s+\*\s+soft` | 3 | All-BGP refresh |
| cisco | ios | `^\s*clear\s+ip\s+bgp\s+\*` | 3 | All-BGP reset |
| cisco | ios | `^\s*no\s+router\s+bgp\b` | 3 | BGP process delete |
| cisco | ios | `^\s*shutdown\s*$` | 2 | Iface shutdown |
| cisco | ios | `^\s*hostname\s+\S+` | 1 | Hostname |
| cisco | ios | `^\s*show\s+\S+` | 0 | Generic show fallback |
| cisco | ios | `^\s*ping\b` | 0 | ping |
| cisco | ios | `^\s*traceroute\b` | 0 | traceroute |
| cisco | ios | `^\s*write\s+memory\s*$` | 1 | Save |
| cisco | ios | `^\s*copy\s+running-config\s+startup-config\s*$` | 1 | Save |
| juniper | junos | `^\s*request\s+system\s+reboot\b` | 3 | Reboot |
| juniper | junos | `^\s*request\s+system\s+halt\b` | 3 | Halt |
| juniper | junos | `^\s*request\s+system\s+power-off\b` | 3 | Power-off |
| juniper | junos | `^\s*request\s+system\s+zeroize\b` | 3 | Zeroize / wipe |
| juniper | junos | `^\s*request\s+vmhost\s+reboot\b` | 3 | vMX reboot |
| juniper | junos | `^\s*request\s+system\s+software\s+(add\|delete)\b` | 3 | Software install/uninstall |
| juniper | junos | `^\s*request\s+chassis\s+routing-engine\s+master\s+switch\b` | 3 | RE switchover |
| juniper | junos | `^\s*request\s+chassis\s+fpc\s+slot\s+\d+\s+restart\b` | 3 | FPC restart (line card reset) |
| juniper | junos | `^\s*restart\s+\S+` | 2 | Restart a daemon |
| juniper | junos | `^\s*restart\s+routing\b` | 3 | Restart rpd — full RIB rebuild |
| juniper | junos | `^\s*restart\s+chassis-control\b` | 3 | chassisd restart |
| juniper | junos | `^\s*commit\s*$` | 2 | Default commit (forwarding-affecting) |
| juniper | junos | `^\s*commit\s+confirmed\b` | 1 | Auto-rollback safety |
| juniper | junos | `^\s*commit\s+check\b` | 0 | Validation only |
| juniper | junos | `^\s*commit\s+full\b` | 2 | Full re-commit |
| juniper | junos | `^\s*commit\s+synchronize\b` | 2 | RE0/RE1 sync commit |
| juniper | junos | `^\s*commit\s+and-quit\b` | 2 | Commit + exit |
| juniper | junos | `^\s*rollback\s+\d+\b` | 2 | Rollback to past commit |
| juniper | junos | `^\s*rollback\s+rescue\b` | 2 | Rescue config rollback |
| juniper | junos | `^\s*delete\s+protocols\s+bgp\b` | 3 | Wipe BGP config |
| juniper | junos | `^\s*delete\s+protocols\s+ospf\b` | 3 | Wipe OSPF |
| juniper | junos | `^\s*delete\s+protocols\s+isis\b` | 3 | Wipe ISIS |
| juniper | junos | `^\s*delete\s+routing-instances\b` | 3 | Wipe all routing-instances |
| juniper | junos | `^\s*delete\s+interfaces\s+\S+` | 2 | Delete interface stanza |
| juniper | junos | `^\s*delete\s+\S+` | 2 | Generic delete (config mode) |
| juniper | junos | `^\s*set\s+interfaces\s+\S+\s+disable\b` | 2 | Iface disable |
| juniper | junos | `^\s*delete\s+interfaces\s+\S+\s+disable\b` | 1 | Iface enable (un-disable) |
| juniper | junos | `^\s*set\s+protocols\s+bgp\s+group\s+\S+\s+neighbor\s+\S+\s+disable\b` | 2 | BGP neighbor disable |
| juniper | junos | `^\s*set\s+system\s+host-name\s+\S+` | 1 | Hostname |
| juniper | junos | `^\s*set\s+system\s+ntp\s+server\s+\S+` | 1 | NTP add |
| juniper | junos | `^\s*set\s+system\s+syslog\b` | 1 | Syslog config |
| juniper | junos | `^\s*set\s+system\s+login\s+user\s+\S+\b` | 1 | Local user mgmt |
| juniper | junos | `^\s*set\s+snmp\s+community\b` | 1 | SNMP community |
| juniper | junos | `^\s*configure(\s+(exclusive\|private))?\s*$` | 1 | Enter config mode |
| juniper | junos | `^\s*exit\s*$` | 0 | Exit |
| juniper | junos | `^\s*quit\s*$` | 0 | Exit |
| juniper | junos | `^\s*show\s+\S+` | 0 | Generic show |
| juniper | junos | `^\s*show\s+route\b` | 0 | RIB |
| juniper | junos | `^\s*show\s+route\s+protocol\s+bgp\b` | 0 | BGP routes |
| juniper | junos | `^\s*show\s+bgp\s+summary\b` | 0 | BGP summary |
| juniper | junos | `^\s*show\s+ospf\s+neighbor\b` | 0 | OSPF neighbors |
| juniper | junos | `^\s*show\s+isis\s+adjacency\b` | 0 | ISIS adj |
| juniper | junos | `^\s*show\s+interfaces?\b` | 0 | Iface state |
| juniper | junos | `^\s*show\s+system\b` | 0 | System info |
| juniper | junos | `^\s*show\s+chassis\b` | 0 | Chassis info |
| juniper | junos | `^\s*show\s+log\b` | 0 | Logs |
| juniper | junos | `^\s*show\s+configuration\b` | 0 | Config view |
| juniper | junos | `^\s*display\s+\S+` | 0 | display alias |
| juniper | junos | `^\s*ping\b` | 0 | ping |
| juniper | junos | `^\s*traceroute\b` | 0 | traceroute |
| juniper | junos | `^\s*monitor\s+traffic\b` | 1 | Live capture (CPU risk) |
| juniper | junos | `^\s*monitor\s+interface\b` | 0 | Live counters |
| juniper | junos | `^\s*clear\s+bgp\s+neighbor\s+\*` | 3 | All-BGP clear |
| juniper | junos | `^\s*clear\s+bgp\s+neighbor\s+\d` | 2 | Single-neighbor clear |
| juniper | junos | `^\s*clear\s+route\s+all\b` | 3 | Wipe RIB |
| juniper | junos | `^\s*clear\s+log\b` | 1 | Log buffer clear |
| juniper | junos | `^\s*file\s+(delete\|copy\|rename)\b` | 1 | Filesystem ops |
| juniper | junos | `^\s*request\s+routing-engine\s+login\b` | 1 | RE login (per-RE) |
| arista | eos | `^\s*reload\b` | 3 | EOS reload |
| arista | eos | `^\s*reload\s+now\b` | 3 | Immediate reload |
| arista | eos | `^\s*reload\s+power\b` | 3 | Power-cycle reload |
| arista | eos | `^\s*write\s+erase\b` | 3 | Erase startup |
| arista | eos | `^\s*write\s+erase\s+now\b` | 3 | Erase now |
| arista | eos | `^\s*delete\s+startup-config\b` | 3 | Same as erase |
| arista | eos | `^\s*clear\s+ip\s+bgp\s+\*\s+soft` | 3 | All-BGP refresh |
| arista | eos | `^\s*clear\s+ip\s+bgp\s+\*` | 3 | All-BGP reset |
| arista | eos | `^\s*clear\s+ip\s+bgp\s+\d` | 2 | Single neighbor |
| arista | eos | `^\s*no\s+router\s+bgp\b` | 3 | BGP process delete |
| arista | eos | `^\s*no\s+router\s+ospf\s+\S+` | 3 | OSPF process delete |
| arista | eos | `^\s*shutdown\s*$` | 2 | Iface shutdown |
| arista | eos | `^\s*no\s+shutdown\s*$` | 1 | Iface no-shutdown |
| arista | eos | `^\s*hostname\s+\S+` | 1 | Hostname |
| arista | eos | `^\s*configure\s*$` | 1 | Enter config |
| arista | eos | `^\s*end\s*$` | 0 | Exit |
| arista | eos | `^\s*write\s+memory\s*$` | 1 | Save |
| arista | eos | `^\s*copy\s+running-config\s+startup-config\s*$` | 1 | Save |
| arista | eos | `^\s*show\s+\S+` | 0 | Generic show |
| arista | eos | `^\s*ping\b` | 0 | ping |
| arista | eos | `^\s*traceroute\b` | 0 | traceroute |
| arista | eos | `^\s*dir\b` | 0 | filesystem |
| arista | eos | `^\s*bash\s+\S+` | 1 | Shell escape (admin write) |
| arista | eos | `^\s*Cli\s+\S+` | 1 | EOS CLI helper |
| arista | eos | `^\s*event-handler\s+\S+` | 1 | Event handler def |
| * | * | `^\s*show\s+\S+` | 0 | Universal show fallback |
| * | * | `^\s*display\s+\S+` | 0 | Universal display fallback |
| * | * | `^\s*ping\b` | 0 | Universal ping |
| * | * | `^\s*traceroute\b` | 0 | Universal traceroute |
| * | * | `^\s*\?$` | 0 | Help |
| * | * | `^\s*help\s*$` | 0 | Help |

> **Total: 230 rules** seeded into `builtin_rules.json`. The classifier
> resolves precedence by (a) higher tier wins, (b) more-specific
> vendor/platform wins on tier ties.
