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
    normalize_neighbors(protocol, parsed_envelope, *, include_evidence=False) -> list[dict]

`parsed_envelope` is whatever `ccie_sidecar.parsers.dispatcher.parse_show`
returns; we look at its `parser` discriminator to pick the right helper.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from ipaddress import ip_address
import re
from typing import Any, List, Literal, Optional

Protocol = Literal["cdp", "lldp", "bgp", "ospf", "isis", "eigrp"]
_ROUTING_PROTOCOLS: tuple[str, ...] = ("bgp", "ospf", "isis", "eigrp")
_ALL_PROTOCOLS: tuple[str, ...] = ("cdp", "lldp", *_ROUTING_PROTOCOLS)


@dataclass
class RoutingEvidence:
    """A logical routing observation, not proof of a physical cable."""

    state: str
    established: bool
    peer_address: Optional[str]
    vrf: Optional[str]
    address_family: Optional[str]
    instance: Optional[str] = None
    level: Optional[str] = None
    scope_supported: bool = False


@dataclass
class NeighborRecord:
    """One row of normalized neighbor information.

    Field semantics:
      * ``local_port``   — reported interface on the *local* device, empty
        when unknown (including BGP summary observations).
      * ``neighbor_name`` — legacy best-effort short-name; opt-in evidence
        preserves full advertised L2 names instead.
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

    def to_dict(self, *, routing: Optional[RoutingEvidence] = None) -> dict:
        record = asdict(self)
        if routing is not None:
            record["routing"] = asdict(routing)
        return record


# ---------------------------------------------------------------------------
# Public dispatcher
# ---------------------------------------------------------------------------


def normalize_neighbors(
    protocol: Protocol, parsed_envelope: dict, *, include_evidence: bool = False
) -> list[dict]:
    """Convert a `parse_show` envelope into canonical neighbor dicts.

    Evidence mode adds routing scope/state without treating peer addresses
    as management IPs; legacy records keep their original shape and semantics.
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
        return _from_genie(protocol, data, include_evidence=include_evidence)
    if parser == "textfsm":
        # TextFSM coverage is Phase 1 only (CDP/LLDP). Routing adjacencies
        # come exclusively from Genie for now; if Genie fails the dispatcher
        # raises NoParserError before we get here.
        if protocol in _ROUTING_PROTOCOLS:
            return []
        return _from_textfsm(protocol, data, include_evidence=include_evidence)
    return []


def normalize_neighbor_capture(protocol: Protocol, parsed_envelope: dict, raw: str) -> dict:
    """Opt-in collection contract; do not change legacy normalization semantics.

    Genie cli() may return {} for both valid zero CDP and arbitrary junk. Only
    explicit zero summaries establish empty success for manual L2 collection.
    """
    parser = parsed_envelope.get("parser") if isinstance(parsed_envelope, dict) else None
    if parser not in ("genie", "textfsm") or (parser == "textfsm" and protocol in _ROUTING_PROTOCOLS):
        return {"status": "unsupported", "records": []}
    records = normalize_neighbors(protocol, parsed_envelope, include_evidence=True)
    if protocol == "eigrp":
        if re.search(r"^\s*%", raw, re.MULTILINE):
            raise ValueError("EIGRP neighbor output contains a CLI diagnostic")
        # Genie emits {} for header-only output AND junk. Accept only a complete
        # IPv4/default-VRF empty table, optionally preceded by the exact command.
        empty_table = (
            r"(?:(?:[\w.():/-]+[>#][ \t]*)?show[ \t]+ip[ \t]+eigrp[ \t]+neighbors\s+)?"
            r"EIGRP-IPv4(?:\s+VR\(\S+\)\s+Address-Family)?\s+Neighbors\s+for\s+AS\([0-9]+\)"
            r"(?:[ \t]+VRF\(default\))?\s+"
            r"H\s+Address\s+Interface\s+Hold\s+Uptime\s+SRTT\s+RTO\s+Q\s+Seq\s+"
            r"\(sec\)\s+\(ms\)\s+Cnt\s+Num"
        )
        if not records and re.fullmatch(empty_table, raw.strip(), re.IGNORECASE):
            return {"status": "completed", "records": []}
    zero_summary = {
        "cdp": r"Total\s+cdp\s+entries\s+displayed\s*:\s*0",
        "lldp": r"Total\s+entries\s+displayed\s*:\s*0",
    }.get(protocol)
    command_echo = (
        rf"(?:(?:[\w.():/-]+[>#][ \t]*)?show[ \t]+{protocol}[ \t]+neighbors[ \t]+detail[ \t]*\r?\n[ \t\r\n]*)?"
    )
    if not records and not (zero_summary and re.fullmatch(command_echo + zero_summary, raw.strip(), re.IGNORECASE)):
        raise ValueError("neighbor output did not establish records or a supported empty capture")
    return {"status": "completed", "records": records}


# ---------------------------------------------------------------------------
# Genie helpers
# ---------------------------------------------------------------------------


def _from_genie(
    protocol: Protocol, data: dict, *, include_evidence: bool = False
) -> list[dict]:
    if protocol == "cdp":
        return _from_genie_cdp(data, include_evidence=include_evidence)
    if protocol == "lldp":
        return _from_genie_lldp(data, include_evidence=include_evidence)
    if protocol == "bgp":
        return _from_genie_bgp(data, include_evidence=include_evidence)
    if protocol == "ospf":
        return _from_genie_ospf(data, include_evidence=include_evidence)
    if protocol == "isis":
        return _from_genie_isis(data, include_evidence=include_evidence)
    if protocol == "eigrp":
        return _from_genie_eigrp(data, include_evidence=include_evidence)
    return []


def _from_genie_cdp(data: dict, *, include_evidence: bool = False) -> list[dict]:
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
            neighbor_name=device_id.strip() if include_evidence else _clean_device_id(device_id),
            neighbor_port=neighbor_port,
            neighbor_mgmt_ip=mgmt_ip,
            neighbor_platform=platform,
            neighbor_vendor=_vendor_from_platform(platform),
            capabilities=_normalize_capabilities(caps_raw),
        )
        out.append(record.to_dict())
    return out


def _from_genie_lldp(data: dict, *, include_evidence: bool = False) -> list[dict]:
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
                    neighbor_name=(str(system_name).strip() if include_evidence
                                   else _clean_device_id(str(system_name))),
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


def _from_genie_bgp(data: dict, *, include_evidence: bool = False) -> list[dict]:
    """Genie ``show ip bgp summary`` shape::

        data["vrf"][<vrf>]["neighbor"][<peer_ip>]["address_family"][<af>]
            { as, msg_rcvd, msg_sent, up_down, state_pfxrcd, ... }

    Legacy records collapse AFs per peer. Evidence mode preserves every VRF
    and AF with its session state; unsupported scope stays explicitly marked.
    """
    out: list[dict] = []
    vrfs = data.get("vrf") or {}
    if not isinstance(vrfs, dict):
        return out
    for vrf, vrf_entry in vrfs.items():
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
                sessions = af_map.items() if include_evidence else [next(iter(af_map.items()))]
            else:
                sessions = [(None, peer_entry)]
            for af, af_entry in sessions:
                session = af_entry if isinstance(af_entry, dict) else {}
                routing = None
                if include_evidence:
                    state = _routing_state(session.get("session_state", session.get("state_pfxrcd")))
                    routing = RoutingEvidence(
                        state=state,
                        established=state.lower() == "established" or (
                            "session_state" not in session
                            and re.fullmatch(r"[0-9]+", state) is not None
                        ),
                        peer_address=str(peer_ip),
                        vrf=vrf if isinstance(vrf, str) else None,
                        address_family=af if isinstance(af, str) else None,
                        scope_supported=(vrf == "default" and af == "ipv4 unicast"
                                         and _is_ipv4(str(peer_ip))),
                    )
                record = NeighborRecord(
                    protocol="bgp",
                    # Summary output does not identify either physical port.
                    local_port="",
                    neighbor_name=str(peer_ip),
                    neighbor_port="",
                    neighbor_mgmt_ip=None if include_evidence else str(peer_ip),
                    neighbor_platform=None,
                    neighbor_vendor=None,
                    capabilities=[],
                )
                out.append(record.to_dict(routing=routing))
    return out


def _from_genie_ospf(data: dict, *, include_evidence: bool = False) -> list[dict]:
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
            routing = None
            if include_evidence:
                state = _routing_state(nbr.get("state"))
                ipv4 = _is_ipv4(mgmt_ip)
                routing = RoutingEvidence(
                    state=state,
                    established=state.upper().split("/", 1)[0] == "FULL",
                    peer_address=mgmt_ip,
                    vrf="default",
                    address_family="ipv4 unicast" if ipv4 else None,
                    scope_supported=ipv4,
                )
            record = NeighborRecord(
                protocol="ospf",
                local_port=str(local_if),
                neighbor_name=str(router_id),
                # OSPF doesn't expose the neighbor's port id; ingest fills
                # in `peer:<source_device_ref>`.
                neighbor_port="",
                neighbor_mgmt_ip=None if include_evidence else mgmt_ip,
                neighbor_platform=None,
                neighbor_vendor=None,
                capabilities=[],
            )
            out.append(record.to_dict(routing=routing))
    return out


def _from_genie_eigrp(data: dict, *, include_evidence: bool = False) -> list[dict]:
    """Genie AS -> VRF -> AF -> eigrp_interface -> eigrp_nbr rows.

    A complete neighbor-table entry establishes an observed adjacency, not
    routes or a physical cable. Genie exposes no separate session-state field.
    """
    out: list[dict] = []
    instances = data.get("eigrp_instance") if isinstance(data, dict) else None
    if not isinstance(instances, dict):
        return out
    for instance, process in instances.items():
        vrfs = process.get("vrf") if isinstance(process, dict) else None
        if not isinstance(vrfs, dict):
            continue
        for vrf, context in vrfs.items():
            families = context.get("address_family") if isinstance(context, dict) else None
            if not isinstance(families, dict):
                continue
            for af, family in families.items():
                interfaces = family.get("eigrp_interface") if isinstance(family, dict) else None
                if not isinstance(interfaces, dict):
                    continue
                for local_if, interface in interfaces.items():
                    peers = interface.get("eigrp_nbr") if isinstance(interface, dict) else None
                    if not isinstance(local_if, str) or not local_if.strip() or not isinstance(peers, dict):
                        continue
                    for peer, row in peers.items():
                        if not isinstance(peer, str) or not peer or not isinstance(row, dict):
                            continue
                        try:
                            valid_peer = not (ip_address(peer).is_unspecified or ip_address(peer).is_multicast)
                        except ValueError:
                            valid_peer = False
                        # Queue/sequence values are table fields, not session states.
                        complete = valid_peer and all(
                            type(row.get(key)) is int and row[key] >= 0
                            for key in ("peer_handle", "hold", "q_cnt", "last_seq_number", "rto")
                        ) and type(row.get("srtt")) in (int, float) and row["srtt"] >= 0 and bool(
                            isinstance(row.get("uptime"), str) and row["uptime"].strip()
                        )
                        routing = None
                        if include_evidence:
                            routing = RoutingEvidence(
                                state="up" if complete else "unknown",
                                established=complete,
                                peer_address=peer,
                                vrf=vrf if isinstance(vrf, str) else None,
                                address_family=(f"{af} unicast" if af in ("ipv4", "ipv6")
                                                else af if isinstance(af, str) else None),
                                instance=str(instance) if instance is not None else None,
                                scope_supported=(valid_peer and vrf == "default" and af == "ipv4" and _is_ipv4(peer)
                                                 and re.fullmatch(r"[0-9]{1,5}", str(instance)) is not None
                                                 and 1 <= int(instance) <= 65535),
                            )
                        record = NeighborRecord(
                            protocol="eigrp", local_port=local_if.strip(), neighbor_name=peer,
                            neighbor_port="", neighbor_mgmt_ip=None,
                        )
                        out.append(record.to_dict(routing=routing))
    return out


def _from_genie_isis(data: dict, *, include_evidence: bool = False) -> list[dict]:
    """Genie ``show isis neighbors`` shape::

        data["isis"][<tag>]["neighbors"][<system_id>]["type"][<L1|L2>]
            ["interfaces"][<local_if>]{ ip_address, state, holdtime, ... }

    Note the schema is rooted at ``data["isis"]`` (not ``data["tag"]``) and
    nests by adjacency *type* (L1/L2). Legacy normalization collapses the
    same system/interface across types and tags. Evidence mode retains each
    instance and level separately; only the fixture-backed default ``null``
    tag, known levels and IPv4 addresses establish supported scope.
    """
    out: list[dict] = []
    isis_root = data.get("isis") or {}
    if not isinstance(isis_root, dict):
        return out
    seen_keys: set[tuple[str, str]] = set()
    for tag, tag_entry in isis_root.items():
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
            for atype, atype_entry in type_map.items():
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
                    if not include_evidence and dedup_key in seen_keys:
                        continue
                    seen_keys.add(dedup_key)
                    ipv4 = iface_entry.get("ip_address")
                    mgmt_ip = ipv4 if isinstance(ipv4, str) and ipv4 else None
                    routing = None
                    if include_evidence:
                        state = _routing_state(iface_entry.get("state"))
                        address_is_ipv4 = _is_ipv4(mgmt_ip)
                        routing = RoutingEvidence(
                            state=state,
                            established=state.upper() == "UP",
                            peer_address=mgmt_ip,
                            vrf="default" if tag == "null" else None,
                            address_family="ipv4 unicast" if address_is_ipv4 else None,
                            instance=str(tag) if tag is not None else None,
                            level=str(atype),
                            scope_supported=(tag == "null" and atype in ("L1", "L2")
                                             and address_is_ipv4),
                        )
                    record = NeighborRecord(
                        protocol="isis",
                        local_port=str(local_if),
                        neighbor_name=str(system_id),
                        neighbor_port="",
                        neighbor_mgmt_ip=None if include_evidence else mgmt_ip,
                        neighbor_platform=None,
                        neighbor_vendor=None,
                        capabilities=[],
                    )
                    out.append(record.to_dict(routing=routing))
    return out


# ---------------------------------------------------------------------------
# TextFSM (ntc-templates) helpers
# ---------------------------------------------------------------------------


def _from_textfsm(
    protocol: Protocol, data: Any, *, include_evidence: bool = False
) -> list[dict]:
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
            neighbor_name=neighbor_name if include_evidence else _clean_device_id(neighbor_name),
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


def _routing_state(value: Any) -> str:
    if isinstance(value, str):
        return value.strip() or "unknown"
    if type(value) is int:
        return str(value)
    return "unknown"


def _is_ipv4(value: Optional[str]) -> bool:
    if not value:
        return False
    try:
        return ip_address(value).version == 4
    except ValueError:
        return False


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
