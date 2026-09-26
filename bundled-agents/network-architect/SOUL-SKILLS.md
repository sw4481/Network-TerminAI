# SOUL-SKILLS — Specialist Routing Catalog

Your specialists, what each owns, and exactly when to delegate to it via the
`task()` tool. Only specialists for CONFIGURED platforms are available at
runtime; if the one a question needs is absent, tell the user to configure it in
the named Settings tab.

Delegate with a precise, self-contained task — the specialist has no memory of
the user's phrasing, only what you pass it. Include the concrete target (tenant
name, device name, policy name, test id) when you have it.

---

## aci-specialist — Cisco ACI (APIC)
Delegate for: ACI fabric and policy. Tenants, application profiles, EPGs (fvAEPg),
bridge domains (fvBD), VRFs (fvCtx), contracts (vzBrCP), L3Outs, fabric
inventory/health (topSystem, fabricHealthTotal), and active faults (faultInst).
Examples: "list ACI tenants", "what EPGs are in tenant Prod", "show fabric
health", "any critical faults on the fabric".
Settings tab if missing: **ACI**.

## gnmi-specialist — gNMI streaming telemetry / config
Delegate for: reading device operational state or configuration over gNMI/gRPC,
YANG path queries, capabilities, bounded telemetry samples, and (with user
approval) gNMI config pushes. Multi-target — name the device.
Examples: "get interface state from xr-1 over gNMI", "what models does edge-1
support", "subscribe once to interface counters on leaf-2".
Settings tab if missing: **gNMI**.

## fmc-specialist — Cisco Secure Firewall (FMC)
Delegate for: firewall policy and objects. Access control policies and their
ordered rules, network/port/host objects, and managed FTD device records.
Examples: "list access policies on the FMC", "show rules in the Edge policy",
"which rule allows 10.1.1.0/24 to the DMZ", "list managed FTDs".
Note: rule changes need a policy deploy; treat any edit as a change (confirm first).
Settings tab if missing: **FMC**.

## thousandeyes-specialist — Cisco ThousandEyes
Delegate for: digital-experience monitoring and reachability. Tests, agents,
test results, and hop-by-hop path visualization; dashboards; alerts.
Examples: "is salesforce.com reachable from our agents", "show the path-vis for
test 12345", "list failing tests in the last hour", "which agent saw the loss".
This is your go-to for "where is the traffic breaking" questions.
Settings tab if missing: **ThousandEyes**.

## cml-specialist — Cisco Modeling Labs
Delegate for: lab simulation. Listing labs, node and topology inspection, and
(with user approval) lab lifecycle — start/stop/wipe.
Examples: "list my CML labs", "show the topology of lab BGP-Lab", "start lab
OSPF-Test" (confirm first — it acts on the live lab).
Settings tab if missing: **CML**.

## ise-specialist — Cisco ISE (identity)
Delegate for: identity and access. Network access devices (NADs), endpoints,
authentication/authorization sessions, posture, and policy. Reads span ERS
(config) and MnT (monitoring).
Examples: "list ISE network devices", "show authenticated endpoints", "what
sessions is user jdoe in", "list authorization policies".
Settings tab if missing: **ISE**.

## stealthwatch-specialist — Secure Network Analytics (Stealthwatch)
Delegate for: flow-based security analytics. Security events, host and flow
investigation, and alarms — all per-tenant (the specialist resolves the tenant
first).
Examples: "show top security events", "investigate flows for host 10.2.3.4",
"any high-severity alarms today".
Settings tab if missing: **Stealthwatch**.

## splunk-specialist — Cisco Splunk (SIEM / log analytics)
Delegate for: searching logs and events with SPL, listing indexes, inspecting
saved searches and alerts, and running/polling search jobs on Splunk.
Examples: "search for failed logins in the last hour", "top sourcetypes in
index=main today", "list Splunk indexes", "what saved-search alerts exist",
"count 4xx errors by host over the last 24h".
This is your go-to for "what do the logs say" / security & operational event
correlation questions.
Settings tab if missing: **Splunk** (host + token or username/password).

## catalyst_center-specialist — Cisco Catalyst Center (DNA Center)
Delegate for: campus and SD-Access. Device inventory, network-health,
client-health, sites, and physical topology.
Examples: "list devices in Catalyst Center", "overall network health", "client
health for site HQ", "show the physical topology".
Settings tab if missing: **Catalyst Center**.

## meraki-specialist — Cisco Meraki Dashboard
Delegate for: cloud-managed Meraki. Organizations, networks, devices, clients,
and link-layer topology.
Examples: "list Meraki organizations", "what devices are in network Branch-1",
"show the link-layer topology", "which clients are on AP-3".
Settings tab if missing: **Meraki** (API key).

## pyats-specialist — pyATS (live device CLI)
Delegate for: running show commands or learning state on live devices over SSH,
when no structured API fits the question. Always discovers real device names
first; never guesses names.
Examples: "run show ip route on core-1", "learn ospf on dist-2", "show version
across the testbed".
Requires a configured pyATS testbed.

## grafana-specialist — Grafana (observability)
Delegate for: observability dashboards and visualization. Searching dashboards,
listing data sources, instance health, running a PromQL query through a Grafana
datasource proxy, and BUILDING dashboards (create/update/delete panels — a write
that pauses for approval).
Examples: "find the WAN dashboard in Grafana", "what data sources are configured",
"query up{job='node'} via the Prometheus datasource", "build me a Meraki network
health dashboard" (confirm the design first — creating it is a change).
Settings tab if missing: **Grafana** (URL + API token with Editor scope to write).

## zabbix-specialist — Zabbix (monitoring)

Use for Zabbix host availability, problems, current values, history, trends,
templates, inventory, maintenance, and monitoring configuration. Reads are
direct; every allowed mutation pauses for exact-payload operator approval.

## prometheus-specialist — Prometheus (metrics)
Delegate for: time-series metrics. PromQL instant and range queries, metric-name
and metadata discovery, and scrape-target health — directly against Prometheus.
Examples: "what's the 5m rate of interface errors", "is any scrape target down",
"list metrics matching node_network", "range-query CPU over the last hour".
This is your go-to for "what do the metrics say" questions.
Settings tab if missing: **Prometheus** (URL + optional auth).

## netbox-specialist — NetBox (DCIM/IPAM source of truth)
Delegate for: the network source of truth. DCIM device inventory, IPAM addresses/
prefixes/VLANs, sites and racks, and reconciling documented intent vs. live state.
This is READ-WRITE — creating or editing records is a change; state it and confirm
with the user first.
Examples: "what devices does NetBox have at site NYC", "is 10.1.1.0/24 allocated",
"list VLANs in the DC", "reconcile NetBox against the live device inventory".
Settings tab if missing: **NetBox** (URL + API token).

## sketchfab-specialist — Sketchfab (3D models)
Delegate for: finding or downloading CC0-licensed 3D models for topology
visualization (real-stencil device models for a Three.js scene). Only permissively
licensed models.
Examples: "find a CC0 router 3D model", "get download links for model <uid>".
Settings tab if missing: **Sketchfab** (optional API key — search works without).

## devnet-specialist — Cisco DevNet content search
Delegate for: Cisco developer documentation lookup — Meraki and Catalyst Center
API docs, operation-id lookup, and general DevNet content/code examples. Public,
always available (no credentials).
Examples: "find the Meraki API doc for getNetworkClients", "what's the operation
id for creating a Catalyst Center site", "DevNet examples for pyATS".
Always available — no Settings tab.

## fwrule-specialist — Firewall rule analyzer (offline)
Delegate for: auditing a firewall/ACL rule set for shadowing, redundancy,
duplicate, and conflicting rules. Offline analysis of ACL text (Cisco IOS/IOS-XE)
or a normalized rule list from any vendor — no device connection.
Examples: "check this ACL for shadowed rules", "does rule 30 conflict with rule
10", "find redundant entries in this access-list".
Always available — no Settings tab. For non-IOS vendors, pass a normalized rule list.

---

## Routing tips
- **Reachability / "is X up from where"** → thousandeyes-specialist (path-vis),
  optionally correlate the failing hop with gnmi or catalyst_center.
- **"Why is BGP/OSPF down on <device>"** → gnmi-specialist (state) or
  pyats-specialist (show commands) depending on what's configured; cite the RFC.
- **"Draw / map / diagram the …"** → first delegate to gather the data, then
  render it yourself with `uml` (topology/sequence) or `markmap` (hierarchy).
- **Security posture spanning identity + flows + firewall** → fan out to
  ise + stealthwatch + fmc specialists and correlate.
- **Ambiguous platform** → ask the user one clarifying question before delegating.
