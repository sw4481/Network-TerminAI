# SOUL-EXPERTISE — CCIE Protocol & Platform Reference

Deep technical knowledge for explaining behavior and interpreting specialist
results. This is scoped to the platforms this agent can actually reach plus the
vendor-neutral protocols behind them. Cite the referenced RFCs via the `rfc`
helper when you explain protocol behavior.

## Routing protocols

### BGP (RFC 4271)
- Path selection order (apply in sequence, first decisive wins):
  1. Highest Weight (Cisco-local)
  2. Highest Local Preference
  3. Locally originated (network/redistribute/aggregate)
  4. Shortest AS_PATH
  5. Lowest Origin (IGP < EGP < Incomplete)
  6. Lowest MED
  7. eBGP over iBGP
  8. Lowest IGP metric to next hop
  9. Oldest eBGP route (stability)
  10. Lowest Router ID
  11. Lowest neighbor IP
- FSM states: Idle → Connect → Active → OpenSent → OpenConfirm → Established.
- A flapping session sticking in Active usually means TCP/179 reachability or
  an ACL, not BGP config.

### OSPF (RFC 2328)
- Area types: backbone (0), standard, stub, totally-stubby, NSSA.
- LSA types: 1 Router, 2 Network (DR-originated), 3 Summary (ABR), 4 ASBR-Summary,
  5 External, 7 NSSA-External (translated to 5 at the NSSA ABR).
- DR/BDR election: highest OSPF priority, then highest Router ID; priority 0 =
  never DR. Adjacency stuck in EXSTART/EXCHANGE → MTU mismatch.

### IS-IS (RFC 1195)
- Levels: L1 (intra-area), L2 (inter-area backbone), L1/L2.
- Adjacency requires matching level and (for L1) area; metric is narrow (≤63) or
  wide (≤16M) — mismatched styles break SPF.

### EIGRP
- DUAL: Feasible Distance (FD) and Reported Distance (RD). Feasibility condition:
  a neighbor is a feasible successor when RD < FD (loop-free guarantee).
- "Stuck in Active" = no reply to a query; investigate the queried path.

## Switching & overlay
- STP: root = lowest bridge ID (priority + MAC). RSTP roles: root/designated/
  alternate/backup. Watch for unexpected root changes after a link event.
- VXLAN/EVPN: VNI maps L2 segments over an L3 underlay; the control plane is
  MP-BGP EVPN. ACI is a VXLAN fabric with an EVPN-like control plane managed by
  the APIC (see ACI below).
- FHRP: HSRP/VRRP/GLBP — active/standby gateway redundancy; check priority and
  preempt.

## IP addressing
- IPv4: CIDR, RFC 1918 private space, summarization at boundaries.
- IPv6 (RFC 4291): link-local fe80::/10, GUA 2000::/3, SLAAC vs DHCPv6.

## Cisco platform specifics (what the specialists drive)

### ACI / APIC
- Object model: everything is a Managed Object (MO) with a Distinguished Name
  (DN). Class queries (`/api/node/class/<class>.json`) list all of a type; MO
  queries (`/api/node/mo/<dn>.json`) fetch one. Key classes: fvTenant, fvAEPg
  (EPG), fvBD (bridge domain), fvCtx (VRF), vzBrCP (contract), l3extOut.
- Health: faultInst (active faults), fabricHealthTotal. The fabric is a
  spine-leaf VXLAN underlay; policy is intent (contracts between EPGs).

### gNMI / streaming telemetry
- gNMI (gRPC) RPCs: Capabilities, Get, Set, Subscribe. Encodings: JSON, JSON_IETF,
  PROTO. YANG paths use origin:path form (openconfig-* or vendor models).
- Port defaults: IOS-XR/Nokia 57400, Juniper 32767, Arista 6030.
- Prefer model-driven telemetry over SNMP polling for state at scale.

### ISE (identity)
- Surfaces: ERS (config, :9060), OpenAPI (config, :443), MnT (monitoring, :443,
  read-only). NADs = network access devices; endpoints, auth/authz sessions,
  posture. TrustSec SGTs carry policy by tag rather than IP.

### Secure Firewall / FMC
- FMC manages FTD devices. Config lives under
  /api/fmc_config/v1/domain/{domainUUID}/...; access control policies contain
  ordered access rules; reusable network/port/host objects. Rule changes need a
  policy deploy to take effect on the FTD.

### ThousandEyes (DEM)
- Tests (network/http-server/page-load/dns/bgp), Cloud + Enterprise agents,
  results, and path visualization (hop-by-hop). The path-vis is the go-to for
  "where does the traffic break" reachability questions.

### Catalyst Center (DNA Center)
- Campus + SD-Access. Intent API under /dna/intent/api/v1: network-device
  inventory, network-health, client-health, site, physical-topology. Many writes
  are async (poll a taskId).

### CML (Modeling Labs)
- /api/v0: labs, nodes, topology, node/image definitions, lab lifecycle
  (start/stop/wipe). Lifecycle actions hit the live lab immediately.

### Stealthwatch (Secure Network Analytics)
- Flow-based analytics. Everything is per-tenant: get the tenantId first, then
  query hosts/flows/security-events under it. Security-event queries are async
  (submit a query, poll for results).

## Diagnostics & severity
- Syslog severity 0–7: 0 emergency … 7 debug. Treat 0–2 as page-worthy.
- CVSS bands: 0.1–3.9 low, 4.0–6.9 medium, 7.0–8.9 high, 9.0–10.0 critical.
- Interface triage: down/down = physical/L1; up/down = L2/encap/keepalive;
  rising CRC/input errors = cabling/duplex; output drops = congestion/QoS.
