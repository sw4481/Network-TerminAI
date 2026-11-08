"""Synthetic decoded MIB rows, not SNMP packets or device acceptance."""
from copy import deepcopy

import pytest

from ccie_sidecar.topology.snmp_neighbors import SnmpNeighborNormalizer, SnmpTable, SnmpTableError


@pytest.fixture
def tables():
    return {
        "interfaces": SnmpTable("completed", [
            {"ifIndex": 101, "ifName": "Gi1/0/1", "ifDescr": "GigabitEthernet1/0/1", "ifAlias": "uplink"},
            {"ifIndex": 7, "ifName": "Gi1/0/7", "ifDescr": "GigabitEthernet1/0/7", "ifAlias": ""},
        ]),
        "lldpLocPortTable": SnmpTable("completed", [
            {"lldpLocPortNum": 7, "lldpLocPortIdSubtype": 5,
             "lldpLocPortId": "Gi1/0/1", "lldpLocPortDesc": "GigabitEthernet1/0/1"},
        ]),
        "lldpRemTable": SnmpTable("completed", [
            {"lldpRemTimeMark": 42, "lldpRemLocalPortNum": 7, "lldpRemIndex": 1,
             "lldpRemSysName": "dist-1.example.test", "lldpRemPortIdSubtype": 5,
             "lldpRemPortId": "Gi0/2", "lldpRemPortDesc": "GigabitEthernet0/2"},
        ]),
        "cdpCacheTable": SnmpTable("completed", [
            {"cdpCacheIfIndex": 101, "cdpCacheDeviceIndex": 1,
             "cdpCacheDeviceId": "dist-1.example.test", "cdpCacheDevicePort": "Gi0/2"},
        ]),
    }


def normalize(tables, protocol="lldp"):
    return SnmpNeighborNormalizer(tables).normalize(protocol)


def test_lldp_local_port_number_is_not_ifindex(tables):
    result = normalize(tables)
    assert result.records == [{
        "protocol": "lldp", "local_port": "Gi1/0/1",
        "neighbor_name": "dist-1.example.test", "neighbor_port": "Gi0/2",
        "neighbor_mgmt_ip": None, "neighbor_platform": None,
        "neighbor_vendor": None, "capabilities": [],
    }]
    observation = result.observations[0]
    assert observation.index == (42, 7, 1)
    assert observation.local_ifindex == 101
    assert observation.mapping == "ifName"
    assert observation.local_port_id == "Gi1/0/1"
    assert observation.remote_port_description == "GigabitEthernet0/2"
    assert observation.reason is None


def test_unique_local_interface_alias_is_supported(tables):
    tables["lldpLocPortTable"].rows[0].update(lldpLocPortIdSubtype=1, lldpLocPortId="uplink")
    assert normalize(tables).observations[0].mapping == "ifAlias"
    assert normalize(tables).records[0]["local_port"] == "Gi1/0/1"


def test_unique_description_can_resolve_opaque_local_id(tables):
    tables["lldpLocPortTable"].rows[0].update(lldpLocPortIdSubtype=7, lldpLocPortId="opaque-7")
    result = normalize(tables)
    assert result.records[0]["local_port"] == "Gi1/0/1"
    assert result.observations[0].mapping == "ifDescr"
    assert result.observations[0].local_port_id == "opaque-7"


@pytest.mark.parametrize("change", ["no-local-row", "no-matching-id", "duplicate-name", "conflicting-description", "ambiguous-description"])
def test_unresolved_local_mapping_retains_evidence_without_link(tables, change):
    if change == "no-local-row":
        tables["lldpLocPortTable"].rows.clear()
    elif change == "no-matching-id":
        tables["lldpLocPortTable"].rows[0]["lldpLocPortId"] = "Gi9/9/9"
    elif change == "duplicate-name":
        tables["interfaces"].rows[1]["ifName"] = "Gi1/0/1"
    elif change == "conflicting-description":
        tables["lldpLocPortTable"].rows[0]["lldpLocPortDesc"] = "GigabitEthernet1/0/7"
    else:
        tables["lldpLocPortTable"].rows[0].update(lldpLocPortIdSubtype=7, lldpLocPortId="7")
        tables["interfaces"].rows[1]["ifDescr"] = "GigabitEthernet1/0/1"
    result = normalize(tables)
    assert result.records == []
    assert len(result.observations) == 1
    assert result.observations[0].neighbor_name == "dist-1.example.test"
    assert result.observations[0].remote_port_id == "Gi0/2"
    assert result.observations[0].reason is not None


@pytest.mark.parametrize("subtype", [1, 2, 3, 4, 6, 7])
def test_remote_non_ifname_id_is_not_guessed_from_port_description(tables, subtype):
    tables["lldpRemTable"].rows[0].update(lldpRemPortIdSubtype=subtype, lldpRemPortId="opaque")
    result = normalize(tables)
    assert result.records == []
    assert result.observations[0].remote_port_id == "opaque"
    assert result.observations[0].remote_port_subtype == subtype
    assert result.observations[0].reason == "remote_port_not_ifName"


def test_parallel_ports_and_full_indexes_remain_distinct(tables):
    tables["lldpLocPortTable"].rows.append({
        "lldpLocPortNum": 8, "lldpLocPortIdSubtype": 5,
        "lldpLocPortId": "Gi1/0/7", "lldpLocPortDesc": "GigabitEthernet1/0/7",
    })
    row = deepcopy(tables["lldpRemTable"].rows[0])
    row.update(lldpRemLocalPortNum=8, lldpRemPortId="Gi0/3")
    tables["lldpRemTable"].rows.append(row)
    result = normalize(tables)
    assert [(r["local_port"], r["neighbor_port"]) for r in result.records] == [
        ("Gi1/0/1", "Gi0/2"), ("Gi1/0/7", "Gi0/3"),
    ]
    assert [o.index for o in result.observations] == [(42, 7, 1), (42, 8, 1)]


def test_empty_completed_remote_table_is_not_missing_table(tables):
    tables["lldpRemTable"].rows.clear()
    result = normalize(tables)
    assert result.records == []
    assert result.observations == []


@pytest.mark.parametrize("table", ["interfaces", "lldpLocPortTable", "lldpRemTable"])
@pytest.mark.parametrize("status", ["missing", "denied", "timeout", "incomplete", "unsupported"])
def test_missing_or_failed_table_never_becomes_empty_success(tables, table, status):
    if status == "missing":
        del tables[table]
    else:
        tables[table].status = status
    with pytest.raises(SnmpTableError) as error:
        normalize(tables)
    assert str(error.value) == f"SNMP table {table}: {status}"


def test_cdp_uses_ifindex_but_does_not_guess_unknown_repeater_port(tables):
    result = normalize(tables, "cdp")
    assert result.records[0]["local_port"] == "Gi1/0/1"
    assert result.observations[0].mapping == "cdpCacheIfIndex"
    assert result.observations[0].index == (101, 1)
    tables["cdpCacheTable"].rows[0]["cdpCacheIfIndex"] = 9999
    assert normalize(tables, "cdp").records == []
    assert normalize(tables, "cdp").observations[0].reason == "unresolved_local_port"


@pytest.mark.parametrize("protocol,table", [("lldp", "lldpRemTable"), ("cdp", "cdpCacheTable")])
def test_missing_advertised_identity_retains_observation(tables, protocol, table):
    key = "lldpRemSysName" if protocol == "lldp" else "cdpCacheDeviceId"
    tables[table].rows[0][key] = ""
    result = normalize(tables, protocol)
    assert result.records == []
    assert result.observations[0].reason == "missing_neighbor_identity"


@pytest.mark.parametrize("table", ["interfaces", "lldpLocPortTable", "lldpRemTable", "cdpCacheTable"])
def test_duplicate_indexes_fail_closed(tables, table):
    tables[table].rows.append(deepcopy(tables[table].rows[0]))
    with pytest.raises(SnmpTableError, match="duplicate_index"):
        normalize(tables, "cdp" if table == "cdpCacheTable" else "lldp")


@pytest.mark.parametrize("bad", [True, -1, "7", None, 2**32])
def test_malformed_index_is_rejected(tables, bad):
    tables["lldpRemTable"].rows[0]["lldpRemLocalPortNum"] = bad
    with pytest.raises(SnmpTableError, match="invalid_index"):
        normalize(tables)


def test_rows_and_text_are_bounded_without_silent_truncation(tables):
    tables["lldpRemTable"].rows[0]["lldpRemSysName"] = "x" * 1025
    with pytest.raises(SnmpTableError, match="invalid_text"):
        normalize(tables)
    tables["lldpRemTable"].rows = [{}] * 2001
    with pytest.raises(SnmpTableError, match="row_limit"):
        normalize(tables)


def test_input_tables_are_not_mutated_and_unrelated_data_is_not_copied(tables):
    tables["lldpRemTable"].rows[0]["unrelated"] = "must-not-be-exported"
    before = deepcopy(tables)
    result = normalize(tables)
    assert tables == before
    assert "must-not-be-exported" not in repr(result)
    assert result.records[0]["neighbor_mgmt_ip"] is None


def test_routing_is_not_a_snmp_l2_protocol(tables):
    with pytest.raises(ValueError, match="CDP or LLDP"):
        normalize(tables, "bgp")


@pytest.mark.parametrize("mode", ["cdp", "lldp-alias", "lldp-description"])
def test_unique_index_alias_or_description_cannot_hide_duplicate_ifname(tables, mode):
    tables["interfaces"].rows[1]["ifName"] = "Gi1/0/1"
    if mode == "lldp-alias":
        tables["lldpLocPortTable"].rows[0].update(lldpLocPortIdSubtype=1, lldpLocPortId="uplink")
    elif mode == "lldp-description":
        tables["lldpLocPortTable"].rows[0].update(lldpLocPortIdSubtype=7, lldpLocPortId="opaque-7")
    result = normalize(tables, "cdp" if mode == "cdp" else "lldp")
    assert result.records == []
    assert result.observations[0].local_ifindex == 101
    assert result.observations[0].reason == "unresolved_local_port"


@pytest.mark.parametrize("addresses", [["192.0.2.20", "192.0.2.10"], ["192.0.2.10", "192.0.2.10"]])
def test_management_address_and_index_pairs_preserve_order_and_duplicates(tables, addresses):
    indexes = [(42, 7, 1, 1, 4, 192, 0, 2, 20), (42, 7, 1, 1, 4, 192, 0, 2, 10)]
    tables["lldpRemTable"].rows[0].update(management_addresses=addresses, management_indexes=indexes)
    result = normalize(tables)
    assert result.observations[0].management_addresses == addresses
    assert result.observations[0].management_indexes == indexes
    assert result.records[0]["neighbor_mgmt_ip"] == (addresses[0] if len(set(addresses)) == 1 else None)
