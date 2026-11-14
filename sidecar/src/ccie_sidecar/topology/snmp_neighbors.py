"""Offline CDP/LLDP normalization over decoded, complete MIB table projections.

No network, credentials, RPC or persistence. ``interfaces`` joins IF-MIB ifTable
and ifXTable by ifIndex; the other table/column names follow LLDP-MIB and
CISCO-CDP-MIB. The standalone worker establishes completeness before ingest.
Unresolved observations are NOT an empty successful capture and must not mark
historical graph observations absent. Only explicitly decoded advertised IPs are
retained; reported names and opaque IDs never become dial targets.
"""
from collections import Counter
from dataclasses import dataclass, field
from ipaddress import ip_address

from ccie_sidecar.topology.neighbors import NeighborRecord


class SnmpTableError(ValueError):
    """A missing, incomplete or invalid table, without raw agent error text."""


@dataclass
class SnmpTable:
    status: str
    rows: list[dict] = field(default_factory=list)


@dataclass
class SnmpObservation:
    index: tuple[int, ...]
    neighbor_name: str
    local_port_id: str
    local_port_description: str
    remote_port_id: str
    remote_port_description: str
    remote_port_subtype: int | None
    local_ifindex: int | None
    mapping: str | None
    reason: str | None
    record: NeighborRecord | None
    management_addresses: list[str] = field(default_factory=list)
    management_indexes: list[tuple[int, ...]] = field(default_factory=list)


@dataclass
class SnmpNormalization:
    observations: list[SnmpObservation]

    @property
    def records(self) -> list[dict]:
        return [o.record.to_dict() for o in self.observations if o.record is not None]


class SnmpNeighborNormalizer:
    def __init__(self, tables: dict[str, SnmpTable]):
        self.tables = tables

    def _rows(self, table: str, keys: tuple[str, ...]) -> dict[tuple[int, ...], dict]:
        capture = self.tables.get(table)
        status = capture.status if isinstance(capture, SnmpTable) else "missing"
        if status != "completed":
            safe_status = status if status in ("missing", "denied", "timeout", "incomplete", "unsupported") else "invalid_status"
            raise SnmpTableError(f"SNMP table {table}: {safe_status}")
        if not isinstance(capture.rows, list) or len(capture.rows) > 2000:
            raise SnmpTableError(f"SNMP table {table}: row_limit")
        indexed = {}
        for row in capture.rows:
            if not isinstance(row, dict):
                raise SnmpTableError(f"SNMP table {table}: invalid_row")
            index = tuple(row.get(key) for key in keys)
            for key, value in zip(keys, index):
                minimum = 0 if key in ("lldpRemTimeMark", "cdpCacheIfIndex") else 1
                maximum = 2**32 - 1 if key == "lldpRemTimeMark" else 2**31 - 1
                if type(value) is not int or not minimum <= value <= maximum:
                    raise SnmpTableError(f"SNMP table {table}: invalid_index")
            if index in indexed:
                raise SnmpTableError(f"SNMP table {table}: duplicate_index")
            indexed[index] = row
        return indexed

    @staticmethod
    def _text(row: dict, key: str) -> str:
        value = row.get(key, "")
        if not isinstance(value, str) or len(value) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise SnmpTableError("SNMP table: invalid_text")
        return value.strip()

    @staticmethod
    def _subtype(row: dict, key: str) -> int | None:
        value = row.get(key)
        if value is None:
            return None
        if type(value) is not int or not 1 <= value <= 7:
            raise SnmpTableError("SNMP table: invalid_port_subtype")
        return value

    def _local_interface(self, port: dict, interfaces: list[dict]) -> tuple[dict | None, str | None]:
        subtype = self._subtype(port, "lldpLocPortIdSubtype")
        identifier = self._text(port, "lldpLocPortId")
        description = self._text(port, "lldpLocPortDesc")
        field_name = {1: "ifAlias", 5: "ifName"}.get(subtype)
        if field_name:
            matches = [i for i in interfaces if identifier and not port.get("opaque_lldpLocPortId") and i[field_name] == identifier]
        else:
            field_name = "ifDescr"
            matches = [i for i in interfaces if description and i["ifDescr"] == description]
        if len(matches) != 1:
            return None, None
        candidate = matches[0]
        # A description identifying another interface conflicts with the typed ID.
        described = [i for i in interfaces if description and i["ifDescr"] == description]
        if any(i["ifIndex"] != candidate["ifIndex"] for i in described):
            return None, None
        return candidate, field_name

    def normalize(self, protocol: str) -> SnmpNormalization:
        if protocol not in ("cdp", "lldp"):
            raise ValueError("SNMP normalization supports CDP or LLDP only")
        interfaces = []
        for (index,), row in self._rows("interfaces", ("ifIndex",)).items():
            interfaces.append({"ifIndex": index, **{
                key: self._text(row, key) for key in ("ifName", "ifDescr", "ifAlias")
            }})
        by_index = {i["ifIndex"]: i for i in interfaces}
        name_counts = Counter(i["ifName"] for i in interfaces)
        local_ports = {}
        if protocol == "lldp":
            # ponytail: scans are bounded to 2,000 rows/table; pre-index if that cap grows.
            for index, port in self._rows("lldpLocPortTable", ("lldpLocPortNum",)).items():
                local_ports[index] = (port, *self._local_interface(port, interfaces))
            remotes = self._rows("lldpRemTable", ("lldpRemTimeMark", "lldpRemLocalPortNum", "lldpRemIndex"))
        else:
            remotes = self._rows("cdpCacheTable", ("cdpCacheIfIndex", "cdpCacheDeviceIndex"))
        observations = []
        for index, row in remotes.items():
            if protocol == "lldp":
                port, interface, mapping = local_ports.get((index[1],), ({}, None, None))
                name = self._text(row, "lldpRemSysName")
                remote_id = self._text(row, "lldpRemPortId")
                remote_description = self._text(row, "lldpRemPortDesc")
                subtype = self._subtype(row, "lldpRemPortIdSubtype")
            else:
                port = {}
                interface = by_index.get(index[0])
                mapping = "cdpCacheIfIndex" if interface else None
                name = self._text(row, "cdpCacheDeviceId")
                remote_id = self._text(row, "cdpCacheDevicePort")
                remote_description, subtype = "", None
            reason = None
            if interface is None or not interface["ifName"] or name_counts[interface["ifName"]] != 1:
                reason = "unresolved_local_port"
            elif not name or not remote_id:
                reason = "missing_neighbor_identity"
            elif protocol == "lldp" and (subtype != 5 or row.get("opaque_lldpRemPortId")):
                reason = "remote_port_not_ifName"
            addresses = row.get("management_addresses", [])
            indexes = row.get("management_indexes", [])
            if not isinstance(addresses, list) or not isinstance(indexes, list) or len(addresses) != len(indexes) or len(addresses) > 2000 or any(not isinstance(address, str) for address in addresses):
                raise SnmpTableError("SNMP invalid management evidence")
            try:
                addresses = [str(ip_address(address)) for address in addresses]
            except ValueError:
                raise SnmpTableError("SNMP invalid management address") from None
            if any(not isinstance(index, (list, tuple)) or not 1 <= len(index) <= 128 or
                   any(type(n) is not int or not 0 <= n < 2**32 for n in index) for index in indexes):
                raise SnmpTableError("SNMP invalid management index")
            record = None if reason else NeighborRecord(
                protocol=protocol, local_port=interface["ifName"],
                neighbor_name=name, neighbor_port=remote_id,
                neighbor_mgmt_ip=addresses[0] if len(set(addresses)) == 1 else None,
            )
            observations.append(SnmpObservation(
                index=index, neighbor_name=name,
                local_port_id=self._text(port, "lldpLocPortId"),
                local_port_description=self._text(port, "lldpLocPortDesc"),
                remote_port_id=remote_id, remote_port_description=remote_description,
                remote_port_subtype=subtype,
                local_ifindex=interface["ifIndex"] if interface else None,
                mapping=mapping, reason=reason, record=record,
                management_addresses=addresses, management_indexes=[tuple(i) for i in indexes],
            ))
        return SnmpNormalization(observations)
