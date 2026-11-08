"""Numeric IF-MIB/LLDP-MIB/CISCO-CDP-MIB projections; no downloaded MIBs.

Definitions: github.com/cisco/cisco-mibs/blob/main/v2/{LLDP-MIB.my,
CISCO-CDP-MIB.my,CISCO-TC.my}. CDP uses CiscoNetworkProtocol (IPv6=20),
NOT InetAddressType; its address type is column 3, primary management 19/20.
LLDP management addresses are length-prefixed OCTET STRING indexes (RFC 2578).
"""
from ipaddress import ip_address

from pysnmp.proto import rfc1902

from ccie_sidecar.topology.snmp_neighbors import SnmpTable, SnmpTableError


def _oid(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in text.split("."))


class SnmpMib:
    ROOTS = {
        "ifDescr": _oid("1.3.6.1.2.1.2.2.1.2"),
        "ifName": _oid("1.3.6.1.2.1.31.1.1.1.1"),
        "ifAlias": _oid("1.3.6.1.2.1.31.1.1.1.18"),
        "cdpCacheTable": _oid("1.3.6.1.4.1.9.9.23.1.2.1.1"),
        "lldpLocPortTable": _oid("1.0.8802.1.1.2.1.3.7.1"),
        "lldpRemTable": _oid("1.0.8802.1.1.2.1.4.1.1"),
        "lldpRemManAddrTable": _oid("1.0.8802.1.1.2.1.4.2.1"),
    }
    INDEX_KEYS = {
        "cdpCacheTable": ("cdpCacheIfIndex", "cdpCacheDeviceIndex"),
        "lldpLocPortTable": ("lldpLocPortNum",),
        "lldpRemTable": ("lldpRemTimeMark", "lldpRemLocalPortNum", "lldpRemIndex"),
    }
    COLUMNS = {
        "cdpCacheTable": {3: "cdpCacheAddressType", 4: "cdpCacheAddress", 6: "cdpCacheDeviceId",
            7: "cdpCacheDevicePort", 19: "cdpCachePrimaryMgmtAddrType", 20: "cdpCachePrimaryMgmtAddr",
            21: "cdpCacheSecondaryMgmtAddrType", 22: "cdpCacheSecondaryMgmtAddr"},
        "lldpLocPortTable": {2: "lldpLocPortIdSubtype", 3: "lldpLocPortId", 4: "lldpLocPortDesc"},
        "lldpRemTable": {6: "lldpRemPortIdSubtype", 7: "lldpRemPortId", 8: "lldpRemPortDesc", 9: "lldpRemSysName"},
    }
    INTEGER_FIELDS = {"cdpCacheAddressType", "cdpCachePrimaryMgmtAddrType", "cdpCacheSecondaryMgmtAddrType",
        "lldpLocPortIdSubtype", "lldpRemPortIdSubtype"}
    ADDRESS_FIELDS = {"cdpCacheAddress", "cdpCachePrimaryMgmtAddr", "cdpCacheSecondaryMgmtAddr"}

    @staticmethod
    def numeric_oid(value) -> tuple[int, ...]:
        if not isinstance(value, (rfc1902.ObjectName, rfc1902.ObjectIdentifier)):
            raise SnmpTableError("SNMP invalid OID")
        result = tuple(value)
        if not 2 <= len(result) <= 128 or any(type(n) is not int or not 0 <= n < 2**32 for n in result):
            raise SnmpTableError("SNMP invalid OID")
        if result[0] > 2 or (result[0] < 2 and result[1] > 39):
            raise SnmpTableError("SNMP invalid OID")
        return result

    @classmethod
    def index(cls, name: str, suffix: tuple[int, ...]) -> tuple[int, ...]:
        index = suffix if name.startswith("if") else suffix[1:]
        length = 1 if name.startswith("if") else len(cls.INDEX_KEYS.get(name, ()))
        if name == "lldpRemManAddrTable":
            if len(index) < 6 or not 1 <= index[4] <= 31 or len(index) != 5 + index[4]:
                raise SnmpTableError("SNMP invalid management index")
            if not 1 <= index[3] <= 65535 or any(n > 255 for n in index[5:]):
                raise SnmpTableError("SNMP invalid management index")
            length = len(index)
        if len(index) != length:
            raise SnmpTableError("SNMP invalid table index")
        for position, number in enumerate(index[:3] if name == "lldpRemManAddrTable" else index):
            time_mark = name.startswith("lldpRem") and position == 0
            minimum = 0 if time_mark or (name == "cdpCacheTable" and position == 0) else 1
            if not minimum <= number <= (2**32 - 1 if time_mark else 2**31 - 1):
                raise SnmpTableError("SNMP invalid table index")
        return index

    @staticmethod
    def _value(field: str, value, row: dict):
        if field in SnmpMib.INTEGER_FIELDS:
            if not isinstance(value, (rfc1902.Integer32, rfc1902.Unsigned32)):
                raise SnmpTableError("SNMP invalid integer")
            return int(value)
        if not isinstance(value, rfc1902.OctetString):
            raise SnmpTableError("SNMP invalid octets")
        octets = value.asOctets()
        if len(octets) > 1024:
            raise SnmpTableError("SNMP text limit")
        if field in SnmpMib.ADDRESS_FIELDS:
            return octets
        try:
            text = octets.decode("utf-8")
        except UnicodeDecodeError:
            text = ""
        if (not text and octets) or any(ord(c) < 32 or ord(c) == 127 for c in text):
            if field in ("lldpLocPortId", "lldpRemPortId"):
                row["opaque_" + field] = True
                return "hex:" + octets.hex()
            raise SnmpTableError("SNMP invalid text")
        return text

    @classmethod
    def decode(cls, name: str, cells: list, status: str) -> SnmpTable:
        rows = {}
        root = cls.ROOTS[name]
        for raw_oid, value in cells:
            numeric = cls.numeric_oid(raw_oid)
            if numeric[:len(root)] != root:
                raise SnmpTableError("SNMP invalid subtree")
            suffix = numeric[len(root):]
            index = cls.index(name, suffix)
            keys = () if name == "lldpRemManAddrTable" else cls.INDEX_KEYS.get(name, ("ifIndex",))
            row = rows.setdefault(index, dict(zip(keys, index)))
            if len(rows) > 2000:
                raise SnmpTableError("SNMP row limit")
            if name == "lldpRemManAddrTable":
                # Only readable columns 3..5 demonstrate an advertised address row.
                if suffix[0] not in (3, 4, 5):
                    raise SnmpTableError("SNMP invalid management column")
                if suffix[0] == 5:
                    cls.numeric_oid(value)
                elif not isinstance(value, rfc1902.Integer32) or not (
                    1 <= int(value) <= 3 if suffix[0] == 3 else 0 <= int(value) < 2**31
                ):
                    raise SnmpTableError("SNMP invalid management value")
                family, size, *octets = index[3:]
                expected = {1: 4, 2: 16}.get(family)  # IANA AddressFamilyNumbers, not CDP.
                if expected is not None and size != expected:
                    raise SnmpTableError("SNMP invalid management address")
                row["index"] = index
                row["address"] = str(ip_address(bytes(octets))) if expected else None
                continue
            field = name if name.startswith("if") else cls.COLUMNS[name].get(suffix[0])
            if field is not None:
                if field in row:
                    raise SnmpTableError("SNMP duplicate cell")
                row[field] = cls._value(field, value, row)
        if name == "cdpCacheTable":
            for index, row in rows.items():
                addresses, indexes = [], []
                for prefix in ("cdpCache", "cdpCachePrimaryMgmt", "cdpCacheSecondaryMgmt"):
                    address_key = prefix + ("Address" if prefix == "cdpCache" else "Addr")
                    kind = row.pop(address_key + "Type", None)
                    octets = row.pop(address_key, None)
                    expected = {1: 4, 20: 16}.get(kind)
                    if expected and octets:
                        if len(octets) != expected:
                            raise SnmpTableError("SNMP invalid CDP address")
                        addresses.append(str(ip_address(octets)))
                        indexes.append(index)
                row["management_addresses"], row["management_indexes"] = addresses, indexes
        return SnmpTable(status, list(rows.values()))

    @staticmethod
    def interfaces(tables: dict[str, SnmpTable]) -> SnmpTable:
        rows = {}
        complete = True
        for name in ("ifName", "ifDescr", "ifAlias"):
            table = tables.get(name, SnmpTable("incomplete"))
            complete &= table.status == "completed"
            for row in table.rows:
                rows.setdefault(row["ifIndex"], {"ifIndex": row["ifIndex"]}).update(row)
        if len(rows) > 2000:
            return SnmpTable("incomplete")
        return SnmpTable("completed" if complete else "incomplete", list(rows.values()))

    @staticmethod
    def join_management(tables: dict[str, SnmpTable]) -> None:
        by_index = {}
        for row in tables.get("lldpRemManAddrTable", SnmpTable("incomplete")).rows:
            by_index.setdefault(row["index"][:3], []).append(row)
        for row in tables.get("lldpRemTable", SnmpTable("incomplete")).rows:
            index = tuple(row[k] for k in SnmpMib.INDEX_KEYS["lldpRemTable"])
            management = by_index.get(index, [])
            row["management_addresses"] = [m["address"] for m in management if m["address"]]
            row["management_indexes"] = [m["index"] for m in management if m["address"]]
