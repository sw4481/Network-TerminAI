"""Canonical neighbor record + normalizer over `parse_show` envelopes.

Plan 13 Phase 1 Task 1.2 — convert the wildly-different per-vendor parsed
shapes that pyATS Genie and ntc-templates (TextFSM) emit for `show cdp
neighbors detail` and `show lldp neighbors detail` into a single flat list
of dicts that downstream Rust + UI code can consume without caring about
the source parser.

Plan 13 Phase 5 Task 5.2 — extended to cover BGP/OSPF/IS-IS routing
adjacencies. Routing protocols don't always advertise a "local port" in
the same sense CDP/LLDP do (BGP peers are L3-only; OSPF/ISIS report an
interface but the *neighbor's* local port is unknown). To keep edge
primary keys unique across multiple peers from the same source device,
we substitute placeholder strings ``"peer:<neighbor_ip_or_name>"`` for
empty ``local_port`` and ``"peer:<source_device_ref>"`` for empty
``neighbor_port``. The placeholder rule is enforced in the Rust ingest
layer (``src-tauri/src/topology/ingest.rs``) so the sidecar emits empty
strings when the protocol genuinely lacks port information; the Rust
layer fills them in just before constructing the canonical edge.

Public API:

    NeighborRecord — dataclass; canonical schema
    normalize_neighbors(protocol, parsed_envelope) -> list[dict]

`parsed_envelope` is whatever `ccie_sidecar.parsers.dispatcher.parse_show`
returns; we look at its `parser` discriminator to pick the right helper.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, List, Literal, Optional

Protocol = Literal["cdp", "lldp", "bgp", "ospf", "isis"]
_ROUTING_PROTOCOLS: tuple[str, ...] = ("bgp", "ospf", "isis")
_ALL_PROTOCOLS: tuple[str, ...] = ("cdp", "lldp", *_ROUTING_PROTOCOLS)


@dataclass
class NeighborRecord:
    """One row of normalized neighbor information.

    Field semantics:
      * ``local_port``   — interface on the *local* device (the one we ran
        the show on). Always populated.
      * ``neighbor_name`` — best-effort short-name; FQDN suffixes and
        Cisco "(serial)" decorations are stripped.
      * ``neighbor_port`` — neighbor's port id as advertised.
      * ``neighbor_mgmt_ip`` — first management IP if any.
      * ``neighbor_platform`` — vendor-supplied platform/model string.
      * ``neighbor_vendor`` — derived from platform via a small lookup;
        ``None`` only when both platform and capabilities give no signal.
      * ``capabilities`` — lowercased single-word list (``router``,
        ``switch``, ``bridge``, ``mac_bridge``, ``host``, ``phone``…).
    """

    protocol: Protocol
    local_port: str
    neighbor_name: str
    neighbor_port: str
    neighbor_mgmt_ip: Optional[str] = None
    neighbor_platform: Optional[str] = None
    neighbor_vendor: Optional[str] = None
    capabilities: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Public dispatcher
# ---------------------------------------------------------------------------


def normalize_neighbors(protocol: Protocol, parsed_envelope: dict) -> list[dict]:
    """Convert a `parse_show` envelope into canonical neighbor dicts.

    Returns ``[]`` for an unrecognized parser discriminator so callers can
    treat "no parser" and "no neighbors" uniformly. Errors raised by the
    helpers are intentionally not swallowed — they indicate a schema
    mismatch worth surfacing.
    """
    if protocol not in _ALL_PROTOCOLS:
        raise ValueError(f"unsupported protocol: {protocol!r}")
    if not isinstance(parsed_envelope, dict):
        return []
    parser = parsed_envelope.get("parser")
    data = parsed_envelope.get("data") or {}
    if parser == "genie":
        return _from_genie(protocol, data)
    if parser == "textfsm":
        # TextFSM coverage is Phase 1 only (CDP/LLDP). Routing adjacencies
        # come exclusively from Genie for now; if Genie fails the dispatcher
        # raises NoParserError before we get here.
        if protocol in _ROUTING_PROTOCOLS:
            return []
        return _from_textfsm(protocol, data)
    return []


# ---------------------------------------------------------------------------
# Genie helpers
# ---------------------------------------------------------------------------


def _from_genie(protocol: Protocol, data: dict) -> list[dict]:
    if protocol == "cdp":
        return _from_genie_cdp(data)
    if protocol == "lldp":
        return _from_genie_lldp(data)
    if protocol == "bgp":
        return _from_genie_bgp(data)
    if protocol == "ospf":
        return _from_genie_ospf(data)
    if protocol == "isis":
        return _from_genie_isis(data)
    return []


def _from_genie_cdp(data: dict) -> list[dict]:
    """Genie CDP shape: ``data["index"][N] -> {device_id, local_interface,
    port_id, management_addresses, platform, capabilities}``."""
    out: list[dict] = []
    index = data.get("index") or {}
    if not isinstance(index, dict):
        return out
    for entry in index.values():
        if not isinstance(entry, dict):
            continue
        local_port = (entry.get("local_interface") or "").strip()
        neighbor_port = (entry.get("port_id") or "").strip()
        device_id = entry.get("device_id") or ""
        if not (local_port and neighbor_port and device_id):
            # Skip rows that lack the bare-minimum identifiers — they
            # would create an unusable graph node anyway.
            continue
        mgmt_addrs = entry.get("management_addresses") or entry.get("entry_addresses") or {}
        mgmt_ip = _first_key(mgmt_addrs)
        platform = (entry.get("platform") or "").strip() or None
        caps_raw = entry.get("capabilities") or ""
        record = NeighborRecord(
            protocol="cdp",
            local_port=local_port,
            neighbor_name=_clean_device_id(device_id),
            neighbor_port=neighbor_port,
            neighbor_mgmt_ip=mgmt_ip,
            neighbor_platform=platform,
            neighbor_vendor=_vendor_from_platform(platform),
            capabilities=_normalize_capabilities(caps_raw),
        )
        out.append(record.to_dict())
    return out


def _from_genie_lldp(data: dict) -> list[dict]:
    """Genie LLDP shape: ``data["interfaces"][<local_if>]["port_id"][<pid>]
    ["neighbors"][<chassis_or_name>] -> { system_name, management_address |
    management_address_v4, system_description, capabilities }``."""
    out: list[dict] = []
    interfaces = data.get("interfaces") or {}
    if not isinstance(interfaces, dict):
        return out
    for local_port, iface in interfaces.items():
        if not isinstance(iface, dict):
            continue
        port_id_map = iface.get("port_id") or {}
        if not isinstance(port_id_map, dict):
            continue
        for neighbor_port, port_entry in port_id_map.items():
            if not isinstance(port_entry, dict):
                continue
            neighbors = port_entry.get("neighbors") or {}
            if not isinstance(neighbors, dict):
                continue
            for nbr_key, nbr in neighbors.items():
                if not isinstance(nbr, dict):
                    continue
                system_name = nbr.get("system_name") or nbr_key or ""
                # iosxe uses 'management_address'; nxos uses
                # 'management_address_v4'. Both may be the literal string
                # "not advertised" — treat that as absent.
                mgmt_ip = (
                    nbr.get("management_address")
                    or nbr.get("management_address_v4")
                    or None
                )
                if isinstance(mgmt_ip, str) and "not advertised" in mgmt_ip.lower():
                    mgmt_ip = None
                # LLDP doesn't expose 'platform' as a Genie field, but the
                # system_description usually carries platform clues
                # (e.g. "Cisco IOS Software, C3750E ..." or "IOS-XRv 9000").
                sys_desc = nbr.get("system_description") or ""
                platform = sys_desc.strip().splitlines()[0] if sys_desc else None
                capabilities = _genie_lldp_capabilities(nbr.get("capabilities"))
                record = NeighborRecord(
                    protocol="lldp",
                    local_port=str(local_port),
                    neighbor_name=_clean_device_id(str(system_name)),
                    neighbor_port=str(neighbor_port),
                    neighbor_mgmt_ip=mgmt_ip if isinstance(mgmt_ip, str) else None,
                    neighbor_platform=platform,
                    neighbor_vendor=_vendor_from_platform(platform),
                    capabilities=capabilities,
                )
                if record.local_port and record.neighbor_name and record.neighbor_port:
                    out.append(record.to_dict())
    return out


def _genie_lldp_capabilities(caps: Any) -> list[str]:
    """Genie LLDP capabilities arrive as ``{'router': {...}, 'mac_bridge':
    {...}}``. Pull the keys, lowercase, and dedupe in a deterministic order."""
    if not isinstance(caps, dict):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for k in caps.keys():
        token = str(k).strip().lower()
        if token and token not in seen:
            seen.add(token)
            out.append(token)
    return out


# ---------------------------------------------------------------------------
# Genie helpers — routing protocols (Plan 13 Phase 5 Task 5.2)
# ---------------------------------------------------------------------------
#
# BGP/OSPF/ISIS adjacencies don't carry the same "local_port + neighbor_port"
# pair that CDP/LLDP do:
#   * BGP peers are L3-only, so neither side advertises an interface in
#     `show ip bgp summary`.
#   * OSPF reports the *local* interface but never the neighbor's port id.
#   * IS-IS reports the local interface and the neighbor's *system_id*,
#     but no neighbor port.
#
# To keep the canonical edge primary key unique across multiple peers from
# the same source device, we leave the missing fields as empty strings here
# and let the Rust ingest layer substitute placeholders
# (`peer:<neighbor_ip>` / `peer:<source_device_ref>`) just before edge
# upsert. See `src-tauri/src/topology/ingest.rs`.


def _from_genie_bgp(data: dict) -> list[dict]:
    """Genie ``show ip bgp summary`` shape::

        data["vrf"][<vrf>]["neighbor"][<peer_ip>]["address_family"][<af>]
            { as, msg_rcvd, msg_sent, up_down, state_pfxrcd, ... }

    Note the extra ``address_family`` level — collapse it by taking the
    first AF entry per peer (multi-AF sessions surface as a single edge,
    matching how a network engineer thinks of the peering).
    """
    out: list[dict] = []
    vrfs = data.get("vrf") or {}
    if not isinstance(vrfs, dict):
        return out
    for _vrf, vrf_entry in vrfs.items():
        if not isinstance(vrf_entry, dict):
            continue
        neighbors = vrf_entry.get("neighbor") or {}
        if not isinstance(neighbors, dict):
            continue
        for peer_ip, peer_entry in neighbors.items():
            if not isinstance(peer_entry, dict) or not peer_ip:
                continue
            # Some implementations expose AF-level data; others put the
            # session fields directly under the peer. Tolerate both.
            af_map = peer_entry.get("address_family")
            if isinstance(af_map, dict) and af_map:
                # First AF row carries the session counters we care about.
                _af_key, af_entry = next(iter(af_map.items()))
                session = af_entry if isinstance(af_entry, dict) else {}
            else:
                session = peer_entry
            record = NeighborRecord(
                protocol="bgp",
                # BGP has no concept of a "local interface" in the summary
                # output; ingest layer fills in `peer:<peer_ip>`.
                local_port="",
                neighbor_name=str(peer_ip),
                # Likewise, BGP doesn't expose a neighbor port.
                neighbor_port="",
                neighbor_mgmt_ip=str(peer_ip),
                neighbor_platform=None,
                neighbor_vendor=None,
                capabilities=[],
            )
            # Drop the unused ``session`` reference but keep the lookup so
            # future expansions (state, AS) can pull from it without
            # restructuring this loop.
            _ = session
            out.append(record.to_dict())
    return out


def _from_genie_ospf(data: dict) -> list[dict]:
    """Genie ``show ip ospf neighbor`` shape::

        data["interfaces"][<local_if>]["neighbors"][<router_id>]
            { address, state, dead_time, priority }
    """
    out: list[dict] = []
    interfaces = data.get("interfaces") or {}
    if not isinstance(interfaces, dict):
        return out
    for local_if, iface in interfaces.items():
        if not isinstance(iface, dict):
            continue
        nbrs = iface.get("neighbors") or {}
        if not isinstance(nbrs, dict):
            continue
        for router_id, nbr in nbrs.items():
            if not isinstance(nbr, dict) or not router_id:
                continue
            address = nbr.get("address")
            mgmt_ip = address if isinstance(address, str) and address else None
            record = NeighborRecord(
                protocol="ospf",
                local_port=str(local_if),
                neighbor_name=str(router_id),
                # OSPF doesn't expose the neighbor's port id; ingest fills
                # in `peer:<source_device_ref>`.
                neighbor_port="",
                neighbor_mgmt_ip=mgmt_ip,
                neighbor_platform=None,
                neighbor_vendor=None,
                capabilities=[],
            )
            out.append(record.to_dict())
    return out


def _from_genie_isis(data: dict) -> list[dict]:
    """Genie ``show isis neighbors`` shape::

        data["isis"][<tag>]["neighbors"][<system_id>]["type"][<L1|L2>]
            ["interfaces"][<local_if>]{ ip_address, state, holdtime, ... }

    Note the schema is rooted at ``data["isis"]`` (not ``data["tag"]``) and
    nests by adjacency *type* (L1/L2). Multi-type adjacencies on the same
    interface produce one record per type; the canonical edge key is
    `(local_port, neighbor_name, "isis")` so L1 and L2 collapse into a
    single edge in the graph — that matches how operators visualise an
    IS-IS adjacency in topology diagrams.
    """
    out: list[dict] = []
    isis_root = data.get("isis") or {}
    if not isinstance(isis_root, dict):
        return out
    seen_keys: set[tuple[str, str]] = set()
    for _tag, tag_entry in isis_root.items():
        if not isinstance(tag_entry, dict):
            continue
        nbrs = tag_entry.get("neighbors") or {}
        if not isinstance(nbrs, dict):
            continue
        for system_id, nbr in nbrs.items():
            if not isinstance(nbr, dict) or not system_id:
                continue
            type_map = nbr.get("type") or {}
            if not isinstance(type_map, dict):
                continue
            for _atype, atype_entry in type_map.items():
                if not isinstance(atype_entry, dict):
                    continue
                ifaces = atype_entry.get("interfaces") or {}
                if not isinstance(ifaces, dict):
                    continue
                for local_if, iface_entry in ifaces.items():
                    if not isinstance(iface_entry, dict) or not local_if:
                        continue
                    # Collapse L1+L2 same-interface duplicates.
                    dedup_key = (str(local_if), str(system_id))
                    if dedup_key in seen_keys:
                        continue
                    seen_keys.add(dedup_key)
                    ipv4 = iface_entry.get("ip_address")
                    mgmt_ip = ipv4 if isinstance(ipv4, str) and ipv4 else None
                    record = NeighborRecord(
                        protocol="isis",
                        local_port=str(local_if),
                        neighbor_name=str(system_id),
                        neighbor_port="",
                        neighbor_mgmt_ip=mgmt_ip,
                        neighbor_platform=None,
                        neighbor_vendor=None,
                        capabilities=[],
                    )
                    out.append(record.to_dict())
    return out


# ---------------------------------------------------------------------------
# TextFSM (ntc-templates) helpers
# ---------------------------------------------------------------------------


def _from_textfsm(protocol: Protocol, data: Any) -> list[dict]:
    """ntc-templates yields a list of row dicts. Field names vary across
    templates and platforms — try the canonical set first then fall back to
    common aliases. Rows missing all three required positional fields
    (local_port, neighbor_name, neighbor_port) are dropped."""
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        local_port = _first_nonempty(row, ["LOCAL_INTERFACE", "LOCAL_PORT"])
        neighbor_name = _first_nonempty(
            row,
            ["NEIGHBOR_NAME", "NEIGHBOR", "DESTINATION_HOST", "SYSTEM_NAME"],
        )
        neighbor_port = _first_nonempty(
            row, ["NEIGHBOR_INTERFACE", "NEIGHBOR_PORT_ID", "PORT_ID"]
        )
        if not (local_port and neighbor_name and neighbor_port):
            continue
        mgmt_ip = _first_nonempty(
            row, ["MGMT_ADDRESS", "MANAGEMENT_IP", "NEIGHBOR_MGMT_ADDRESS"]
        )
        platform = _first_nonempty(row, ["PLATFORM", "NEIGHBOR_DESCRIPTION"]) or None
        caps_raw = row.get("CAPABILITIES") or row.get("CAPABILITY") or ""
        record = NeighborRecord(
            protocol=protocol,
            local_port=local_port,
            neighbor_name=_clean_device_id(neighbor_name),
            neighbor_port=neighbor_port,
            neighbor_mgmt_ip=mgmt_ip or None,
            neighbor_platform=platform,
            neighbor_vendor=_vendor_from_platform(platform),
            capabilities=_normalize_capabilities(caps_raw),
        )
        out.append(record.to_dict())
    return out


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _first_key(d: Any) -> Optional[str]:
    """Return the first key of a dict-shaped Genie field, or ``None``."""
    if isinstance(d, dict) and d:
        return next(iter(d.keys()))
    return None


def _first_nonempty(row: dict, keys: list[str]) -> str:
    for k in keys:
        v = row.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
        if isinstance(v, list) and v:
            # Some TextFSM lists collapse to single-element capabilities;
            # join with space so caller can re-tokenize.
            joined = " ".join(str(x) for x in v if x)
            if joined.strip():
                return joined.strip()
    return ""


def _clean_device_id(raw: str) -> str:
    """Strip Cisco serial-number decorations and FQDN suffixes.

    Examples:
        ``R6(9P57K4EJ8CA)`` -> ``R6``
        ``R5.cisco.com``    -> ``R5``
        ``switch-1.example.com`` -> ``switch-1``
    """
    if not raw:
        return ""
    name = raw.strip()
    # ``foo(serial)`` → ``foo``
    if "(" in name:
        name = name.split("(", 1)[0]
    # FQDN
    if "." in name:
        name = name.split(".", 1)[0]
    return name.strip()


def _normalize_capabilities(raw: Any) -> list[str]:
    """Tokenize a capabilities string/list into a deduped lowercase list.

    Genie CDP returns a single string like ``"Router Switch IGMP"``;
    ntc-templates may return a list or a comma/space-separated string.
    """
    if not raw:
        return []
    if isinstance(raw, list):
        tokens = []
        for item in raw:
            tokens.extend(str(item).replace(",", " ").split())
    else:
        tokens = str(raw).replace(",", " ").split()
    seen: set[str] = set()
    out: list[str] = []
    for tok in tokens:
        t = tok.strip().lower()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _vendor_from_platform(platform: Optional[str]) -> Optional[str]:
    """Best-effort vendor lookup from a free-form platform string.

    Plan 13 deems this advisory, not authoritative. We bias toward Cisco
    when the string is ambiguous (Cisco "MX" management vs. Meraki "MX"
    appliance overlap) since the upstream sidecar primarily deals with
    Cisco gear today.
    """
    if not platform:
        return None
    lo = platform.lower()
    cisco_markers = (
        "cisco", "nexus", "catalyst", "csr", "isr", "iosxr", "ios-xr",
        "iosxe", "ios xe", "ios-xe",
        "n9k", "n7k", "n5k", "n3k", "n2k",
        "ws-c", "c93", "c92", "c91", "c81", "c82", "c88", "asr",
    )
    juniper_substring_markers = ("juniper", "junos", "vmx")
    juniper_token_markers = (" mx", " ex", " qfx", " srx")
    arista_markers = ("arista", "dcs-", "7050", "7280", "7060")
    meraki_markers = ("meraki", " ms ", " mr ")
    padded_lo = f" {lo} "
    if any(m in lo for m in cisco_markers):
        return "cisco"
    # Meraki check uses padded markers so it doesn't fire on words like
    # "primary" or "amsterdam"; intentional.
    if any(m in padded_lo for m in meraki_markers):
        return "meraki"
    # Juniper model-token markers (mx/ex/qfx/srx) use the same padded match
    # the Meraki branch uses so they only fire on token-prefixed model
    # numbers (e.g. "MX480") rather than substring matches that would miss
    # standalone "MX480" or fire on every word starting with " mx".
    if any(m in lo for m in juniper_substring_markers) or any(
        m in padded_lo for m in juniper_token_markers
    ):
        return "juniper"
    if any(m in lo for m in arista_markers):
        return "arista"
    return "unknown"
