"""Typed, deterministic STP normalization and baseline findings."""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Literal, Mapping, Sequence

ScopeType = Literal["vlan", "instance"]


@dataclass(frozen=True)
class StpObservation:
    device_id: str
    platform: str
    parsed: Mapping[str, Any]
    adjacency_evidence: tuple[Mapping[str, Any], ...] = ()
    complete: bool = True
    collection_gaps: tuple[str, ...] = ()
    bundle_evidence: tuple[Mapping[str, Any], ...] = ()

    @classmethod
    def from_collector_record(cls, record: Mapping[str, Any]) -> StpObservation:
        stp = record.get("stp") if isinstance(record.get("stp"), Mapping) else {}
        neighbors = record.get("neighbors") if isinstance(record.get("neighbors"), Mapping) else {}
        adjacency_evidence: list[Mapping[str, Any]] = []
        for family in ("cdp", "lldp"):
            values = neighbors.get(family)
            if not isinstance(values, (list, tuple)):
                continue
            adjacency_evidence.extend(
                normalized
                for item in values
                if isinstance(item, Mapping)
                if (normalized := _neighbor_evidence(item)) is not None
            )
        bundles = record.get("bundle")
        bundle_evidence = tuple(
            item for item in bundles if isinstance(item, Mapping)
        ) if isinstance(bundles, (list, tuple)) else ()
        gaps = record.get("gaps")
        collection_gaps = tuple(
            f"{source}:{code}"
            for item in gaps
            if isinstance(item, Mapping)
            if (source := _text(item.get("source"))) is not None
            if (code := _text(item.get("code"))) is not None
        ) if isinstance(gaps, (list, tuple)) else ()
        return cls(
            device_id=_text(record.get("device")) or "",
            platform=_text(record.get("platform")) or "",
            parsed=stp,
            adjacency_evidence=tuple(adjacency_evidence),
            complete=has_parsable_stp(stp),
            collection_gaps=collection_gaps,
            bundle_evidence=bundle_evidence,
        )


@dataclass(frozen=True)
class StpTimers:
    hello_time: float | None = None
    max_age: float | None = None
    forward_delay: float | None = None


@dataclass(frozen=True)
class StpPort:
    interface: str
    normalized_interface: str
    role: str | None = None
    state: str | None = None
    cost: int | None = None
    bundle_id: str | None = None
    explicit_evidence: str | None = None

    @property
    def inconsistent_or_broken(self) -> bool:
        return self.explicit_evidence is not None


@dataclass(frozen=True)
class StpScope:
    scope_type: ScopeType
    scope_id: str
    vlan_ids: tuple[int, ...]
    bridge_id: str | None
    normalized_bridge_id: str | None
    root_id: str | None
    normalized_root_id: str | None
    bridge_priority: int | None
    root_priority: int | None
    root_cost: int | None
    root_port: str | None
    normalized_root_port: str | None
    timers: StpTimers
    topology_change_count: int | None
    ports: tuple[StpPort, ...]
    mst_region: tuple[str, int, str] | None = None


@dataclass(frozen=True)
class NormalizedDeviceStp:
    device_id: str
    normalized_device_id: str
    platform: str
    mode: str | None
    scopes: tuple[StpScope, ...]
    complete: bool
    collection_gaps: tuple[str, ...]


@dataclass(frozen=True)
class StpAdjacency:
    local_device_id: str
    remote_device_id: str
    local_interface: str
    remote_interface: str
    confidence: Literal["confirmed", "provisional"]
    member_interfaces: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class StpFinding:
    code: str
    severity: Literal["warning", "informational"]
    message: str
    device_id: str | None = None
    scope_type: ScopeType | None = None
    scope_id: str | None = None
    interface: str | None = None


@dataclass(frozen=True)
class NormalizedStpSnapshot:
    devices: tuple[NormalizedDeviceStp, ...]
    adjacencies: tuple[StpAdjacency, ...]
    complete: bool
    collection_gaps: tuple[str, ...]
    findings: tuple[StpFinding, ...] = ()


def normalize_identifier(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().casefold())


def normalize_interface(value: Any) -> str:
    value = normalize_identifier(value)
    for source, target in (
        ("tengigabitethernet", "te"),
        ("gigabitethernet", "gi"),
        ("fastethernet", "fa"),
        ("port-channel", "po"),
        ("portchannel", "po"),
        ("ethernet", "eth"),
        ("bundle-ether", "be"),
        ("loopback", "lo"),
    ):
        if value.startswith(source):
            return target + value[len(source) :]
    return value


def normalize_stp_observation(observation: StpObservation) -> NormalizedDeviceStp:
    parsed = observation.parsed if isinstance(observation.parsed, Mapping) else {}
    nested = parsed.get("stp")
    if isinstance(nested, Mapping):
        parsed = nested
    mode = _text(_first(parsed, "mode", "spanning_tree_mode"))
    if mode is None:
        mode = next((name for name in ("rapid_pvst", "pvst", "mstp", "mst") if isinstance(parsed.get(name), Mapping)), None)
    region = _region(parsed)
    scopes: list[StpScope] = []

    pvst = parsed.get("pvst") if isinstance(parsed.get("pvst"), Mapping) else parsed.get("rapid_pvst")
    if isinstance(pvst, Mapping):
        vlan_entries = pvst.get("vlans") if isinstance(pvst.get("vlans"), Mapping) else pvst
        for raw_id, entry in vlan_entries.items():
            if isinstance(entry, Mapping):
                scope_id = _numeric_scope_id(raw_id)
                if scope_id is None:
                    continue
                vlan = int(scope_id)
                scope = _scope("vlan", scope_id, (vlan,), entry, region)
                if _scope_has_evidence(scope):
                    scopes.append(scope)

    mst = parsed.get("mstp") if isinstance(parsed.get("mstp"), Mapping) else parsed.get("mst")
    instances = _first(mst, "mst_instances", "instance") if isinstance(mst, Mapping) else None
    if isinstance(instances, Mapping):
        for raw_id, entry in instances.items():
            if isinstance(entry, Mapping):
                instance = _scope_number(raw_id)
                vlans = _vlan_list(_first(entry, "vlans", "vlans_mapped", "vlan_mapping", "vlan_ids"))
                scope = _scope("instance", instance, vlans, entry, region)
                if _scope_has_evidence(scope):
                    scopes.append(scope)

    collected_instances = parsed.get("instances")
    if isinstance(collected_instances, Mapping):
        collected_instances = [
            dict(entry, id=raw_id)
            for raw_id, entry in collected_instances.items()
            if isinstance(entry, Mapping)
        ]
    if isinstance(collected_instances, (list, tuple)):
        for entry in collected_instances:
            if not isinstance(entry, Mapping):
                continue
            kind = _collector_scope_type(entry, mode)
            raw_id = _first(entry, "id", "vlan_id", "vlan", "mst_id", "instance")
            if raw_id is None:
                continue
            scope_id = _scope_number(raw_id)
            if kind is None:
                continue
            if kind == "vlan" and not scope_id.isdigit():
                continue
            normalized_entry = dict(entry)
            interfaces = entry.get("interfaces", entry.get("ports"))
            if isinstance(interfaces, (list, tuple)):
                normalized_entry["interfaces"] = {
                    str(interface): item
                    for item in interfaces
                    if isinstance(item, Mapping)
                    if (interface := _first(item, "interface", "name")) is not None
                }
            vlans = (int(scope_id),) if kind == "vlan" else _vlan_list(_first(entry, "vlan_ids", "vlans", "vlan_mapping"))
            scope = _scope(kind, scope_id, vlans, normalized_entry, region)
            if _scope_has_evidence(scope):
                scopes.append(scope)

    if not scopes:
        raw_ports = parsed.get("ports")
        if not raw_ports:
            raw_ports = parsed.get("interfaces")
        if isinstance(raw_ports, (list, tuple)):
            raw_ports = {
                str(interface): item
                for item in raw_ports
                if isinstance(item, Mapping)
                if (interface := _first(item, "interface", "name")) is not None
            }
        if isinstance(raw_ports, Mapping):
            scope = _scope("instance", "unknown", (), {"interfaces": raw_ports}, region)
            if _scope_has_evidence(scope):
                scopes.append(scope)

    scopes = list({(item.scope_type, item.scope_id): item for item in scopes}.values())
    scopes.sort(key=lambda item: (item.scope_type, _natural_id(item.scope_id)))
    return NormalizedDeviceStp(
        observation.device_id,
        normalize_identifier(observation.device_id),
        normalize_identifier(observation.platform),
        mode,
        tuple(scopes),
        observation.complete,
        _unique(observation.collection_gaps),
    )


def normalized_stp_evidence(device: NormalizedDeviceStp) -> dict[str, Any]:
    """Serialize only the canonical STP fields consumed outside this module."""
    instances: list[dict[str, Any]] = []
    ports: list[dict[str, Any]] = []
    for scope in device.scopes:
        scope_ports = [_port_evidence(port) for port in scope.ports]
        record = _without_none({
            "id": scope.scope_id,
            "scope_type": scope.scope_type,
            "vlan_id": scope.scope_id if scope.scope_type == "vlan" else None,
            "mst_id": scope.scope_id if scope.scope_type == "instance" else None,
            "vlan_ids": list(scope.vlan_ids),
            "bridge_address": scope.bridge_id,
            "bridge_id": scope.bridge_id,
            "root_id": scope.root_id,
            "bridge_priority": scope.bridge_priority,
            "root_priority": scope.root_priority,
            "root_cost": scope.root_cost,
            "root_port": scope.root_port,
            "topology_change_count": scope.topology_change_count,
            "mst_region": "/".join(str(part) for part in scope.mst_region) if scope.mst_region else None,
            "interfaces": scope_ports,
        })
        timers = _without_none({
            "hello_time": scope.timers.hello_time,
            "max_age": scope.timers.max_age,
            "forward_delay": scope.timers.forward_delay,
        })
        if timers:
            record["timers"] = timers
        instances.append(record)
        ports.extend(scope_ports)
    result: dict[str, Any] = {"instances": instances, "ports": ports}
    if device.mode is not None:
        result["mode"] = device.mode
    return result


def has_parsable_stp(stp: Any) -> bool:
    """Reject structural placeholders while accepting observed scope or port state."""
    if not isinstance(stp, Mapping):
        return False
    device = normalize_stp_observation(StpObservation("", "", stp))
    if device.scopes:
        return True
    ports = stp.get("ports")
    if not isinstance(ports, (list, tuple)):
        return False
    return any(
        isinstance(port, Mapping)
        and any(port.get(field) is not None for field in (
            "role", "port_role", "state", "port_state", "status", "cost", "path_cost",
        ))
        for port in ports
    )


def adjacency_evidence(snapshot: NormalizedStpSnapshot) -> list[dict[str, Any]]:
    return [
        {
            "local_device_id": edge.local_device_id,
            "remote_device_id": edge.remote_device_id,
            "local_interface": edge.local_interface,
            "remote_interface": edge.remote_interface,
            "confidence": edge.confidence,
            "member_interfaces": [list(pair) for pair in edge.member_interfaces],
        }
        for edge in snapshot.adjacencies
    ]


def finding_evidence(findings: Sequence[StpFinding]) -> list[dict[str, Any]]:
    return [
        _without_none({
            "code": finding.code,
            "severity": finding.severity,
            "message": finding.message,
            "device_id": finding.device_id,
            "scope_type": finding.scope_type,
            "scope_id": finding.scope_id,
            "interface": finding.interface,
        })
        for finding in findings
    ]


def build_stp_snapshot(observations: Sequence[StpObservation]) -> NormalizedStpSnapshot:
    devices = tuple(normalize_stp_observation(item) for item in observations)
    by_id = {item.normalized_device_id: item for item in devices}
    gaps = _unique(gap for item in devices for gap in item.collection_gaps)
    return NormalizedStpSnapshot(
        devices,
        tuple(_adjacencies(observations, by_id)),
        bool(devices) and all(item.complete for item in devices),
        gaps,
    )


def compare_stp_snapshots(
    current: NormalizedStpSnapshot,
    previous_complete_baseline: NormalizedStpSnapshot | None,
) -> tuple[StpFinding, ...]:
    if not current.complete or previous_complete_baseline is None or not previous_complete_baseline.complete:
        return ()
    findings = _root_disagreements(current) + _region_disagreements(current)
    previous = _scope_index(previous_complete_baseline)
    for device in current.devices:
        for scope in device.scopes:
            old = previous.get((device.normalized_device_id, scope.scope_type, scope.scope_id))
            if old is None:
                continue
            if old.normalized_root_id and scope.normalized_root_id and old.normalized_root_id != scope.normalized_root_id:
                findings.append(StpFinding("ROOT_CHANGED", "warning", "root changed", device.device_id, scope.scope_type, scope.scope_id))
            if old.mst_region != scope.mst_region and scope.scope_type == "instance":
                findings.append(StpFinding("MST_REGION_MISMATCH", "warning", "MST region changed", device.device_id, scope.scope_type, scope.scope_id))
            findings.extend(_counter_findings(device, scope, old))
            old_ports = {port.normalized_interface: port for port in old.ports}
            for port in scope.ports:
                old_port = old_ports.get(port.normalized_interface)
                if old_port and (old_port.role, old_port.state) != (port.role, port.state):
                    findings.append(StpFinding("PORT_STATE_CHANGED", "informational", "port role/state changed", device.device_id, scope.scope_type, scope.scope_id, port.interface))
                if port.inconsistent_or_broken:
                    findings.append(StpFinding("PORT_INCONSISTENT_OR_BROKEN", "warning", "explicit port inconsistency evidence", device.device_id, scope.scope_type, scope.scope_id, port.interface))
    return tuple(findings)


def _scope(kind: ScopeType, scope_id: str, vlans: tuple[int, ...], entry: Mapping[str, Any], region: tuple[str, int, str] | None) -> StpScope:
    region = _region(entry) or region
    bridge = entry.get("bridge") if isinstance(entry.get("bridge"), Mapping) else {}
    root = entry.get("root") if isinstance(entry.get("root"), Mapping) else {}
    timers = entry.get("timers") if isinstance(entry.get("timers"), Mapping) else entry.get("times") if isinstance(entry.get("times"), Mapping) else {}
    designated_root_id, designated_root_priority = _designated_root(entry)
    bridge_id = _identifier(_coalesce(_first(entry, "bridge_id", "bridge_identifier", "bridge_address"), _first(bridge, "id", "bridge_id", "address")))
    root_id = _identifier(_coalesce(_first(entry, "root_id", "root_identifier", "root_address", "root_bridge"), _first(root, "id", "root_id", "address"), designated_root_id))
    root_port = _text(_coalesce(_first(entry, "root_port"), _first(root, "interface", "root_port", "port")))
    statistics = entry.get("statistics") if isinstance(entry.get("statistics"), Mapping) else {}
    topology = _coalesce(_first(entry, "topology_changes", "topology_change_count"), _first(statistics, "topology_changes", "topology_change_count"))
    return StpScope(
        kind,
        scope_id,
        vlans,
        bridge_id,
        _stp_id(bridge_id),
        root_id,
        _stp_id(root_id),
        _integer(_coalesce(_first(entry, "bridge_priority", "priority"), _first(bridge, "priority"))),
        _integer(_coalesce(_first(entry, "root_priority"), _first(root, "priority"), designated_root_priority)),
        _integer(_coalesce(_first(entry, "root_cost", "cost"), _first(root, "cost"))),
        root_port,
        normalize_interface(root_port) if root_port else None,
        StpTimers(
            _number(_coalesce(_first(timers, "hello", "hello_time"), _first(root, "hello", "hello_time"), _first(bridge, "hello", "hello_time"))),
            _number(_coalesce(_first(timers, "max_age"), _first(root, "max_age"), _first(bridge, "max_age"))),
            _number(_coalesce(_first(timers, "forward_delay", "forwarding_delay"), _first(root, "forward_delay", "forwarding_delay"), _first(bridge, "forward_delay", "forwarding_delay"))),
        ),
        _integer(topology),
        _ports(_first(entry, "interfaces", "ports")),
        region,
    )


def _designated_root(entry: Mapping[str, Any]) -> tuple[str | None, int | None]:
    if entry.get("root_of_the_spanning_tree") is True:
        return (
            _identifier(_first(entry, "bridge_id", "bridge_identifier", "bridge_address")),
            _integer(_first(entry, "bridge_priority", "priority")),
        )
    interfaces = _first(entry, "interfaces", "ports")
    if not isinstance(interfaces, Mapping):
        return None, None
    addresses = {
        address
        for value in interfaces.values()
        if isinstance(value, Mapping)
        if (address := _identifier(value.get("designated_root_address"))) is not None
    }
    if len(addresses) != 1:
        return None, None
    priorities = {
        priority
        for value in interfaces.values()
        if isinstance(value, Mapping)
        if (priority := _integer(value.get("designated_root_priority"))) is not None
    }
    return next(iter(addresses)), next(iter(priorities)) if len(priorities) == 1 else None


def _ports(raw: Any) -> tuple[StpPort, ...]:
    if not isinstance(raw, Mapping):
        return ()
    roles = {
        "root": "root", "designated": "designated", "desg": "designated", "dsgn": "designated",
        "alternate": "alternate", "altn": "alternate", "alt": "alternate",
        "backup": "backup", "bkp": "backup", "master": "master", "disabled": "disabled",
    }
    states = {
        "fwd": "forwarding", "forwarding": "forwarding", "blk": "blocking", "blocking": "blocking",
        "disc": "discarding", "discarding": "discarding", "down": "down", "learning": "learning",
        "lrn": "learning", "broken": "broken",
    }
    result: list[StpPort] = []
    for interface, value in raw.items():
        if not isinstance(value, Mapping):
            continue
        raw_role = _text(_first(value, "role", "port_role"))
        raw_state = _text(_first(value, "state", "port_state"))
        status_role, status_state = _port_status(_first(value, "status"), roles, states)
        raw_role = raw_role or status_role
        raw_state = raw_state or status_state
        evidence = _first(value, "explicit_evidence", "inconsistency_reason", "broken_reason", "diagnostic")
        if not evidence and any(value.get(field) is True for field in (
            "inconsistent", "bridge_assurance_inconsistent", "vpc_peer_link_inconsistent",
        )):
            evidence = "parsed inconsistent state"
        if not evidence and (value.get("broken") is True or (raw_state or "").casefold() == "broken"):
            evidence = "parsed broken state"
        bundle = normalize_interface(_first(value, "bundle_id", "channel_group", "port_channel")) or None
        role = roles.get((raw_role or "").casefold(), (raw_role or "").casefold() or None)
        state = states.get((raw_state or "").casefold(), (raw_state or "").casefold() or None)
        cost = _integer(_first(value, "cost", "path_cost"))
        if not any(item is not None for item in (role, state, cost, bundle, evidence)):
            continue
        result.append(StpPort(
            str(interface),
            normalize_interface(interface),
            role,
            state,
            cost,
            bundle,
            str(evidence) if evidence else None,
        ))
    result.sort(key=lambda item: item.normalized_interface)
    return tuple(result)


def _adjacencies(observations: Sequence[StpObservation], devices: Mapping[str, NormalizedDeviceStp]) -> list[StpAdjacency]:
    directed: dict[tuple[str, str, str, str], list[tuple[str | None, str | None]]] = {}
    bundled_members = _bundled_members(observations)
    for observation in observations:
        local_device = normalize_identifier(observation.device_id)
        for item in observation.adjacency_evidence:
            if not isinstance(item, Mapping):
                continue
            remote = normalize_identifier(_first(item, "remote_device", "neighbor_device"))
            local_interface = normalize_interface(_first(item, "local_interface", "interface"))
            remote_interface = normalize_interface(_first(item, "remote_interface", "neighbor_interface"))
            if not all((local_device, remote, local_interface, remote_interface)):
                continue
            local_bundle = normalize_interface(_first(item, "local_bundle", "bundle_id", "channel_group")) or _port_bundle(devices.get(local_device), local_interface)
            remote_bundle = normalize_interface(_first(item, "remote_bundle", "neighbor_bundle")) or None
            directed.setdefault((local_device, local_interface, remote, remote_interface), []).append((local_bundle, remote_bundle))

    physical: dict[tuple[tuple[str, str], tuple[str, str]], tuple[str, str, str, str]] = {}
    for key in directed:
        local, local_if, remote, remote_if = key
        physical.setdefault(tuple(sorted(((local, local_if), (remote, remote_if)))), key)
    edges: list[StpAdjacency] = []
    for key in physical.values():
        local, local_if, remote, remote_if = key
        reverse = (remote, remote_if, local, local_if) in directed
        edges.append(StpAdjacency(local, remote, local_if, remote_if, "confirmed" if reverse else "provisional"))

    groups: dict[tuple[str, str], list[StpAdjacency]] = {}
    for edge in edges:
        groups.setdefault(tuple(sorted((edge.local_device_id, edge.remote_device_id))), []).append(edge)
    collapsed: list[StpAdjacency] = []
    consumed: set[tuple[str, str, str, str]] = set()
    for group in groups.values():
        if len(group) < 2:
            continue
        member_mappings: list[tuple[str, str]] = []
        for edge in group:
            forward = directed.get((edge.local_device_id, edge.local_interface, edge.remote_device_id, edge.remote_interface), [])
            reverse = directed.get((edge.remote_device_id, edge.remote_interface, edge.local_device_id, edge.local_interface), [])
            local_candidates = {left for left, _ in forward if left}
            local_candidates.update(right for _, right in reverse if right)
            remote_candidates = {right for _, right in forward if right}
            remote_candidates.update(left for left, _ in reverse if left)
            complete_mapping = any(left and right for left, right in forward + reverse)
            if edge.confidence == "confirmed":
                local_inventory = bundled_members.get((edge.local_device_id, edge.local_interface))
                remote_inventory = bundled_members.get((edge.remote_device_id, edge.remote_interface))
                if local_inventory and remote_inventory:
                    local_candidates.add(local_inventory)
                    remote_candidates.add(remote_inventory)
                    complete_mapping = True
            if not complete_mapping or len(local_candidates) != 1 or len(remote_candidates) != 1:
                break
            member_mappings.append((next(iter(local_candidates)), next(iter(remote_candidates))))
        if len(member_mappings) != len(group) or len(set(member_mappings)) != 1:
            continue
        first = group[0]
        local_bundle, remote_bundle = member_mappings[0]
        collapsed.append(StpAdjacency(
            first.local_device_id,
            first.remote_device_id,
            local_bundle,
            remote_bundle,
            "confirmed" if all(edge.confidence == "confirmed" for edge in group) else "provisional",
            tuple((edge.local_interface, edge.remote_interface) for edge in group),
        ))
        consumed.update((edge.local_device_id, edge.local_interface, edge.remote_device_id, edge.remote_interface) for edge in group)
    result = [edge for edge in edges if (edge.local_device_id, edge.local_interface, edge.remote_device_id, edge.remote_interface) not in consumed]
    result.extend(collapsed)
    result.sort(key=lambda edge: (edge.local_device_id, edge.local_interface, edge.remote_device_id, edge.remote_interface))
    return result


def _root_disagreements(snapshot: NormalizedStpSnapshot) -> list[StpFinding]:
    findings: list[StpFinding] = []
    for component in _components(snapshot):
        grouped: dict[tuple[ScopeType, str], set[str]] = {}
        for device in snapshot.devices:
            if device.normalized_device_id not in component:
                continue
            for scope in device.scopes:
                if scope.normalized_root_id:
                    grouped.setdefault((scope.scope_type, scope.scope_id), set()).add(scope.normalized_root_id)
        for (kind, scope_id), roots in grouped.items():
            if len(roots) > 1:
                findings.append(StpFinding("ROOT_DISAGREEMENT", "warning", "conflicting roots", scope_type=kind, scope_id=scope_id))
    return findings


def _region_disagreements(snapshot: NormalizedStpSnapshot) -> list[StpFinding]:
    findings: list[StpFinding] = []
    for component in _components(snapshot):
        regions = {scope.mst_region for device in snapshot.devices if device.normalized_device_id in component for scope in device.scopes if scope.scope_type == "instance" and scope.mst_region}
        if len(regions) > 1:
            findings.append(StpFinding("MST_REGION_MISMATCH", "warning", "MST regions differ", scope_type="instance"))
    return findings


def _counter_findings(device: NormalizedDeviceStp, current: StpScope, old: StpScope) -> list[StpFinding]:
    if current.topology_change_count is None or old.topology_change_count is None or current.topology_change_count == old.topology_change_count:
        return []
    code = "TOPOLOGY_CHANGE_INCREMENT" if current.topology_change_count > old.topology_change_count else "COUNTER_RESET"
    return [StpFinding(code, "informational", "topology-change counter changed", device.device_id, current.scope_type, current.scope_id)]


def _components(snapshot: NormalizedStpSnapshot) -> list[set[str]]:
    graph = {device.normalized_device_id: set() for device in snapshot.devices}
    for edge in snapshot.adjacencies:
        if edge.confidence == "confirmed":
            graph.setdefault(edge.local_device_id, set()).add(edge.remote_device_id)
            graph.setdefault(edge.remote_device_id, set()).add(edge.local_device_id)
    unseen = set(graph)
    result: list[set[str]] = []
    while unseen:
        start = min(unseen)
        unseen.remove(start)
        component = {start}
        pending = [start]
        while pending:
            current = pending.pop()
            for neighbor in graph[current]:
                if neighbor in unseen:
                    unseen.remove(neighbor)
                    component.add(neighbor)
                    pending.append(neighbor)
        result.append(component)
    return result


def _scope_index(snapshot: NormalizedStpSnapshot) -> dict[tuple[str, ScopeType, str], StpScope]:
    return {(device.normalized_device_id, scope.scope_type, scope.scope_id): scope for device in snapshot.devices for scope in device.scopes}


def _port_bundle(device: NormalizedDeviceStp | None, interface: str) -> str | None:
    if device is None:
        return None
    for scope in device.scopes:
        for port in scope.ports:
            if port.normalized_interface == interface and port.bundle_id:
                return port.bundle_id
    return None


def _bundled_members(observations: Sequence[StpObservation]) -> dict[tuple[str, str], str]:
    candidates: dict[tuple[str, str], set[str]] = {}
    for observation in observations:
        device_id = normalize_identifier(observation.device_id)
        for record in observation.bundle_evidence:
            bundle = normalize_interface(_first(record, "name", "interface", "id"))
            if not bundle or bundle.isdigit():
                continue
            members = _first(record, "members", "member_interfaces")
            if isinstance(members, Mapping):
                values = members.keys()
            elif isinstance(members, (list, tuple, set)):
                values = members
            else:
                continue
            for member in values:
                interface = normalize_interface(member)
                if interface:
                    candidates.setdefault((device_id, interface), set()).add(bundle)
    return {
        key: next(iter(values))
        for key, values in candidates.items()
        if len(values) == 1
    }


def _neighbor_evidence(item: Mapping[str, Any]) -> Mapping[str, Any] | None:
    remote_device = _text(_first(item, "remote_device", "neighbor_device", "device_id", "name"))
    local_interface = _text(_first(item, "local_interface", "interface"))
    remote_interface = _text(_first(item, "remote_interface", "neighbor_interface", "port_id"))
    if not all((remote_device, local_interface, remote_interface)):
        return None
    result = {
        "remote_device": remote_device,
        "local_interface": local_interface,
        "remote_interface": remote_interface,
    }
    for source, target in (("local_bundle", "local_bundle"), ("remote_bundle", "remote_bundle"), ("neighbor_bundle", "remote_bundle")):
        value = _text(item.get(source))
        if value is not None:
            result[target] = value
    return result


def _collector_scope_type(entry: Mapping[str, Any], mode: str | None) -> ScopeType | None:
    explicit = _text(entry.get("scope_type"))
    if explicit in {"vlan", "instance"}:
        return explicit  # type: ignore[return-value]
    normalized_mode = (mode or "").casefold().replace("-", "_")
    if "mst" in normalized_mode or _first(entry, "mst_id") is not None:
        return "instance"
    if "pvst" in normalized_mode or _first(entry, "vlan", "vlan_id") is not None:
        return "vlan"
    return None


def _numeric_scope_id(value: Any) -> str | None:
    scope_id = _scope_number(value)
    return scope_id if scope_id.isdigit() else None


def _scope_has_evidence(scope: StpScope) -> bool:
    return bool(scope.ports) or any(value is not None for value in (
        scope.bridge_id,
        scope.root_id,
        scope.bridge_priority,
        scope.root_priority,
        scope.root_cost,
        scope.root_port,
        scope.timers.hello_time,
        scope.timers.max_age,
        scope.timers.forward_delay,
        scope.topology_change_count,
    ))


def _port_status(value: Any, roles: Mapping[str, str], states: Mapping[str, str]) -> tuple[str | None, str | None]:
    status = _text(value)
    if status is None:
        return None, None
    tokens = re.findall(r"[a-z]+", status.casefold())
    role = next((roles[token] for token in tokens if token in roles), None)
    state = next((states[token] for token in tokens if token in states), None)
    return role, state


def _port_evidence(port: StpPort) -> dict[str, Any]:
    return _without_none({
        "interface": port.interface,
        "role": port.role,
        "state": port.state,
        "cost": port.cost,
        "bundle_id": port.bundle_id,
        "inconsistent": True if port.inconsistent_or_broken else None,
    })


def _without_none(values: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


def _region(parsed: Mapping[str, Any]) -> tuple[str, int, str] | None:
    value = parsed.get("mst_region") or parsed.get("region")
    if isinstance(value, str):
        parts = value.split("/", 2)
        revision = _integer(parts[1]) if len(parts) == 3 else None
        if parts[0] and revision is not None and parts[2]:
            return parts[0], revision, parts[2]
        return None
    if not isinstance(value, Mapping):
        return None
    name, revision, digest = _text(_first(value, "name", "region_name")), _integer(_first(value, "revision", "revision_number")), _text(_first(value, "digest", "configuration_digest"))
    return (name, revision, digest) if name is not None and revision is not None and digest is not None else None


def _first(value: Any, *keys: str) -> Any:
    if not isinstance(value, Mapping):
        return None
    for key in keys:
        if value.get(key) is not None:
            return value[key]
    return None


def _coalesce(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def _identifier(value: Any) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    return _text(value)


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _integer(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _stp_id(value: Any) -> str | None:
    text = _text(value)
    return re.sub(r"[^0-9a-z]", "", text.casefold()) if text else None


def _scope_number(value: Any) -> str:
    match = re.search(r"\d+", str(value))
    return str(int(match.group(0))) if match else str(value).strip()


def _vlan_list(value: Any) -> tuple[int, ...]:
    if value is None:
        return ()
    values = value if isinstance(value, (list, tuple, set)) else str(value).split(",")
    result: set[int] = set()
    for item in values:
        text = str(item).strip()
        if "-" in text:
            left, right = (part.strip() for part in text.split("-", 1))
            if left.isdigit() and right.isdigit():
                result.update(range(int(left), int(right) + 1))
        elif text.isdigit():
            result.add(int(text))
    return tuple(sorted(result))


def _unique(values: Sequence[Any] | Any) -> tuple[str, ...]:
    if isinstance(values, str):
        values = (values,)
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = str(value).strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return tuple(result)


def _natural_id(value: str) -> tuple[int, str]:
    return (int(value), value) if value.isdigit() else (2**31, value)
