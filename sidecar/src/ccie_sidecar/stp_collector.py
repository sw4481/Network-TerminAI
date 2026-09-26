"""Collect and normalize read-only STP evidence from one pyATS device."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .stp.normalization import (
    StpObservation,
    has_parsable_stp,
    normalize_stp_observation,
    normalized_stp_evidence,
)


class STPCollector:
    """Connect once and collect the four parsed evidence families in order."""

    _COMMANDS = {
        "iosxe": ("show spanning-tree", "show cdp neighbors detail", "show lldp neighbors detail", "show etherchannel summary"),
        "nxos": ("show spanning-tree detail", "show cdp neighbors detail", "show lldp neighbors detail", "show port-channel summary"),
    }
    _SOURCES = ("spanning_tree", "cdp", "lldp", "bundle")
    _FIELD_ALIASES = {
        "bridge_address", "bridge_id", "bridge_priority", "cost", "device_id", "interface",
        "local_interface", "members", "mode", "name", "mst_id", "path_cost", "port_id",
        "port_state", "priority", "protocol", "role", "root_bridge", "root_id", "root_port",
        "state", "status", "vlan", "vlan_id", "instance", "bundle_id", "bidirectional",
        "topology_changes", "topology_change_count", "mst_region", "region",
        "explicit_evidence", "inconsistency_reason", "broken_reason", "diagnostic",
        "inconsistent", "broken", "channel_group", "port_channel",
    }
    _BLOCKED_FIELDS = {"password", "secret", "token", "credential", "username", "raw", "command", "output", "cli"}

    def __init__(self, device_name: str, platform: str):
        self.device_name = device_name
        self.platform = platform.lower()

    def collect(self, device: Any) -> dict[str, Any]:
        """Return normalized evidence, retaining only fixed safe fields."""
        evidence: dict[str, Any] = {
            "device": self.device_name,
            "platform": self.platform,
            "stp": {"instances": [], "ports": []},
            "neighbors": {"cdp": [], "lldp": []},
            "bundle": [],
            "gaps": [],
        }

        try:
            self._ensure_connected(device)
        except Exception:
            evidence["status"] = "failed"
            evidence["gaps"].append({"source": "connection", "code": "connection_failed"})
            return evidence

        parsed: dict[str, Any] = {}
        commands = self._COMMANDS.get(self.platform, ())
        for source, command in zip(self._SOURCES, commands):
            try:
                value = device.parse(command)
                if isinstance(value, Mapping) and "error" in value:
                    raise ValueError("parser_error")
                parsed[source] = value
            except Exception:
                evidence["gaps"].append({"source": source, "code": "parse_failed"})

        evidence["stp"] = self._normalize_stp(parsed.get("spanning_tree"))
        evidence["neighbors"]["cdp"] = self._normalize_records(parsed.get("cdp"), "cdp")
        evidence["neighbors"]["lldp"] = self._normalize_records(parsed.get("lldp"), "lldp")
        evidence["bundle"] = self._normalize_bundle_records(parsed.get("bundle"))
        if not has_parsable_stp(evidence["stp"]):
            evidence["gaps"].append({"source": "spanning_tree", "code": "no_parsable_stp_state"})
        has_stp = has_parsable_stp(evidence["stp"])
        evidence["status"] = "complete" if has_stp else "failed"
        return evidence

    @staticmethod
    def _ensure_connected(device: Any) -> None:
        """Use the shared pyATS connection policy when the wrapper is present."""
        try:
            from terminai_pyats.connect import ensure_connected
        except ModuleNotFoundError as exc:
            if exc.name != "terminai_pyats":
                raise
            device.connect(
                log_stdout=False,
                learn_hostname=True,
                connection_timeout=60,
            )
            return
        ensure_connected(device)

    def _normalize_stp(self, payload: Any) -> dict[str, Any]:
        parsed = payload if isinstance(payload, Mapping) else {}
        observation = StpObservation(self.device_name, self.platform, parsed)
        return normalized_stp_evidence(normalize_stp_observation(observation))

    def _normalize_bundle_records(self, payload: Any) -> list[dict[str, Any]]:
        data = self._root_mapping(payload, "bundle")
        interfaces = data.get("interfaces") if isinstance(data, Mapping) else None
        if not isinstance(interfaces, Mapping):
            return self._normalize_records(payload, "bundle")
        records: list[dict[str, Any]] = []
        for interface, value in interfaces.items():
            if not isinstance(value, Mapping):
                continue
            record: dict[str, Any] = {"id": str(interface), "name": str(interface)}
            for field in ("bundle_id", "protocol"):
                safe = self._safe_value(value.get(field), field)
                if safe is not None:
                    record[field] = safe
            members = value.get("members")
            if isinstance(members, Mapping):
                record["members"] = [str(member) for member in members]
            elif isinstance(members, list):
                record["members"] = [str(member) for member in members if isinstance(member, (str, int, float))]
            records.append(record)
        return records

    def _normalize_records(self, payload: Any, root_key: str) -> list[dict[str, Any]]:
        data = self._root_mapping(payload, root_key)
        if not data:
            return []
        if isinstance(data.get("entries"), list):
            return [self._normalize_record(item, str(index)) for index, item in enumerate(data["entries"])]
        if root_key == "cdp" and isinstance(data.get("index"), Mapping):
            return [
                self._normalize_record(item, str(index))
                for index, item in data["index"].items()
                if isinstance(item, Mapping)
            ]
        if root_key == "lldp" and isinstance(data.get("interfaces"), Mapping):
            return self._normalize_lldp_records(data["interfaces"])
        records: list[dict[str, Any]] = []
        for key, value in data.items():
            if isinstance(value, Mapping):
                records.append(self._normalize_record(value, str(key)))
        return records

    def _normalize_lldp_records(self, interfaces: Mapping[str, Any]) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        for local_interface, interface_data in interfaces.items():
            if not isinstance(interface_data, Mapping):
                continue
            port_ids = interface_data.get("port_id")
            if not isinstance(port_ids, Mapping):
                continue
            for port_id, port_data in port_ids.items():
                if not isinstance(port_data, Mapping):
                    continue
                neighbors = port_data.get("neighbors")
                if not isinstance(neighbors, Mapping):
                    continue
                for neighbor_id, neighbor_data in neighbors.items():
                    if not isinstance(neighbor_data, Mapping):
                        continue
                    record = self._normalize_record(neighbor_data, str(neighbor_id))
                    record["local_interface"] = str(local_interface)
                    record["port_id"] = str(port_id)
                    system_name = self._safe_value(neighbor_data.get("system_name"), "name")
                    if system_name is not None:
                        record["name"] = system_name
                    records.append(record)
        return records

    def _normalize_record(self, value: Any, record_id: str) -> dict[str, Any]:
        record: dict[str, Any] = {"id": record_id}
        if not isinstance(value, Mapping):
            return record
        for key, item in value.items():
            field = str(key).lower().replace("-", "_").replace(" ", "_")
            if field not in self._FIELD_ALIASES or any(blocked in field for blocked in self._BLOCKED_FIELDS):
                continue
            safe = self._safe_value(item, field)
            if safe is not None:
                record[field] = safe
        return record

    def _root_mapping(self, payload: Any, key: str) -> Mapping[str, Any]:
        if not isinstance(payload, Mapping):
            return {}
        nested = payload.get(key)
        if key == "bundle":
            nested = payload.get("etherchannel", payload.get("port_channel", nested))
        return nested if isinstance(nested, Mapping) else payload

    def _safe_value(self, value: Any, field: str) -> Any:
        if any(blocked in field.lower() for blocked in self._BLOCKED_FIELDS):
            return None
        if isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, list):
            return [item for item in (self._safe_value(item, field) for item in value) if item is not None]
        if isinstance(value, Mapping):
            return {
                str(key): safe
                for key, item in value.items()
                if (safe := self._safe_value(item, str(key))) is not None
                and str(key).lower().replace("-", "_").replace(" ", "_") in self._FIELD_ALIASES
            }
        return None
