import pytest


def _collector_api():
    try:
        from ccie_sidecar.stp_collector import STPCollector
    except (ImportError, ModuleNotFoundError) as exc:
        pytest.fail(f"STP collector is not implemented: {exc}")
    return STPCollector


class FakeDevice:
    def __init__(self, parsed):
        self.parsed = parsed
        self.calls = []
        self.connect_count = 0
        self.connect_kwargs = None

    def is_connected(self):
        return False

    def connect(self, **kwargs):
        self.connect_count += 1
        self.connect_kwargs = kwargs

    def parse(self, command):
        self.calls.append(command)
        return self.parsed[command]


def test_iosxe_collector_connects_once_and_collects_parsed_state_sequentially():
    collector = _collector_api()(device_name="CORE1", platform="iosxe")
    device = FakeDevice(
        {
            "show spanning-tree": {
                "stp": {
                    "mode": "rapid-pvst",
                    "instances": {
                        "VLAN0001": {
                            "root_bridge": True,
                            "root_id": "0011.2233.4455",
                            "root_port": "Gi1/0/1",
                        }
                    },
                }
            },
            "show cdp neighbors detail": {
                "cdp": {
                    "1": {
                        "device_id": "DIST1",
                        "local_interface": "Gi1/0/1",
                        "instance": "VLAN0001",
                        "bidirectional": True,
                    }
                }
            },
            "show lldp neighbors detail": {
                "lldp": {"1": {"device_id": "DIST1", "port_id": "Ethernet1/1"}}
            },
            "show etherchannel summary": {
                "etherchannel": {"1": {"protocol": "LACP", "members": ["Gi1/0/1"]}}
            },
        }
    )

    evidence = collector.collect(device)

    assert device.connect_count == 1
    assert device.calls == [
        "show spanning-tree",
        "show cdp neighbors detail",
        "show lldp neighbors detail",
        "show etherchannel summary",
    ]
    assert evidence["device"] == "CORE1"
    assert evidence["platform"] == "iosxe"
    assert evidence["stp"]["mode"] == "rapid-pvst"
    assert evidence["neighbors"]["cdp"][0]["device_id"] == "DIST1"
    assert evidence["neighbors"]["cdp"][0]["instance"] == "VLAN0001"
    assert evidence["neighbors"]["cdp"][0]["bidirectional"] is True
    assert evidence["bundle"][0]["protocol"] == "LACP"
    assert "raw" not in evidence


def test_collector_uses_the_shared_tolerant_connection_settings():
    collector = _collector_api()(device_name="CORE1", platform="iosxe")
    device = FakeDevice(
        {
            "show spanning-tree": {"stp": {"instances": {"1": {"bridge_id": "0011.2233.4455"}}}},
            "show cdp neighbors detail": {},
            "show lldp neighbors detail": {},
            "show etherchannel summary": {},
        }
    )

    collector.collect(device)

    assert device.connect_kwargs == {
        "log_stdout": False,
        "learn_hostname": True,
        "connection_timeout": 60,
    }


def test_nxos_collector_uses_port_channel_command():
    collector = _collector_api()(device_name="LEAF1", platform="nxos")
    device = FakeDevice(
        {
            "show spanning-tree detail": {"stp": {"mode": "mst"}},
            "show cdp neighbors detail": {"cdp": {}},
            "show lldp neighbors detail": {"lldp": {}},
            "show port-channel summary": {"port_channel": {"10": {"protocol": "LACP"}}},
        }
    )

    evidence = collector.collect(device)

    assert device.calls[0] == "show spanning-tree detail"
    assert device.calls[-1] == "show port-channel summary"
    assert evidence["bundle"][0]["id"] == "10"


@pytest.mark.parametrize(
    ("platform", "stp_command", "bundle_command", "cdp_interface", "lldp_interface"),
    (
        ("iosxe", "show spanning-tree", "show etherchannel summary", "GigabitEthernet1/0/1", "GigabitEthernet1/0/2"),
        ("nxos", "show spanning-tree detail", "show port-channel summary", "Ethernet1/1", "Ethernet1/2"),
    ),
)
def test_collector_flattens_standard_nested_genie_cdp_and_lldp_neighbors(
    platform, stp_command, bundle_command, cdp_interface, lldp_interface
):
    """Preserve explicit identifiers from Genie's indexed CDP and nested LLDP shapes."""
    collector = _collector_api()(device_name="CORE1", platform=platform)
    device = FakeDevice(
        {
            stp_command: {"stp": {"instances": {"10": {"bridge_id": "0011.2233.4455"}}}},
            "show cdp neighbors detail": {
                "index": {
                    1: {
                        "device_id": "DIST1",
                        "local_interface": cdp_interface,
                        "port_id": "Ethernet1/1",
                    }
                }
            },
            "show lldp neighbors detail": {
                "interfaces": {
                    lldp_interface: {
                        "port_id": {
                            "Ethernet1/2": {
                                "neighbors": {
                                    "0011.2233.4455": {
                                        "system_name": "LEAF1",
                                        "instance": "10",
                                        "raw": "must-not-cross-the-boundary",
                                    }
                                }
                            }
                        }
                    }
                }
            },
            bundle_command: {},
        }
    )

    evidence = collector.collect(device)

    cdp, = evidence["neighbors"]["cdp"]
    lldp, = evidence["neighbors"]["lldp"]
    assert cdp["local_interface"] == cdp_interface
    assert cdp["device_id"] == "DIST1"
    assert cdp["port_id"] == "Ethernet1/1"
    assert lldp["local_interface"] == lldp_interface
    assert lldp["name"] == "LEAF1"
    assert lldp["port_id"] == "Ethernet1/2"
    assert lldp["instance"] == "10"
    assert "bidirectional" not in cdp
    assert "bidirectional" not in lldp
    assert "raw" not in lldp


def test_collector_returns_fixed_gap_without_leaking_parser_or_credential_text():
    collector = _collector_api()(device_name="CORE1", platform="iosxe")
    device = FakeDevice({"show spanning-tree": {"error": "password=secret"}})

    evidence = collector.collect(device)

    assert evidence["gaps"][0]["source"] == "spanning_tree"
    assert "password" not in repr(evidence).lower()
    assert "secret" not in repr(evidence)


@pytest.mark.parametrize(
    ("mode", "instance_key", "instance_id"),
    (("mstp", "mst_instances", 0), ("pvst", "vlans", 10), ("rapid_pvst", "vlans", 20)),
)
def test_collector_normalizes_genie_stp_roots_and_nested_interfaces(mode, instance_key, instance_id):
    collector = _collector_api()(device_name="CORE1", platform="iosxe")
    device = FakeDevice(
        {
            "show spanning-tree": {
                mode: {
                    instance_key: {
                        instance_id: {
                            "bridge_address": "0011.2233.4455",
                            "bridge_priority": 32768,
                            "interfaces": {
                                "GigabitEthernet1/0/1": {
                                    "name": "GigabitEthernet1/0/1",
                                    "status": "designated forwarding",
                                    "cost": 4,
                                }
                            },
                        }
                    }
                }
            },
            "show cdp neighbors detail": {},
            "show lldp neighbors detail": {},
            "show etherchannel summary": {},
        }
    )

    evidence = collector.collect(device)

    assert evidence["status"] == "complete"
    assert evidence["stp"]["instances"]
    assert evidence["stp"]["instances"][0]["bridge_address"] == "0011.2233.4455"
    assert evidence["stp"]["instances"][0]["bridge_priority"] == 32768
    assert evidence["stp"]["ports"][0]["interface"] == "GigabitEthernet1/0/1"


def test_collector_normalizes_standard_genie_stp_and_bundle_shapes():
    collector = _collector_api()(device_name="CORE1", platform="iosxe")
    device = FakeDevice(
        {
            "show spanning-tree": {
                "rapid_pvst": {
                    "vlans": {
                        10: {
                            "bridge": {"address": "0011.2233.4455", "priority": 32778},
                            "root": {
                                "address": "00aa.bbcc.ddee",
                                "priority": 24586,
                                "cost": 4,
                                "interface": "Port-channel1",
                            },
                            "interfaces": {
                                "GigabitEthernet1/0/1": {
                                    "status": "designated forwarding",
                                    "cost": 4,
                                }
                            },
                        }
                    }
                }
            },
            "show cdp neighbors detail": {"index": {}},
            "show lldp neighbors detail": {"interfaces": {}},
            "show etherchannel summary": {
                "interfaces": {
                    "Port-channel1": {
                        "bundle_id": 1,
                        "protocol": "lacp",
                        "members": {
                            "GigabitEthernet1/0/1": {"interface": "GigabitEthernet1/0/1"}
                        },
                    }
                }
            },
        }
    )

    evidence = collector.collect(device)

    instance = evidence["stp"]["instances"][0]
    assert evidence["status"] == "complete"
    assert evidence["stp"]["mode"] == "rapid_pvst"
    assert (instance["id"], instance["scope_type"], instance["vlan_id"]) == ("10", "vlan", "10")
    assert (instance["bridge_id"], instance["root_id"], instance["root_port"]) == (
        "0011.2233.4455",
        "00aa.bbcc.ddee",
        "Port-channel1",
    )
    assert (instance["interfaces"][0]["role"], instance["interfaces"][0]["state"]) == (
        "designated",
        "forwarding",
    )
    assert evidence["bundle"] == [{
        "id": "Port-channel1",
        "name": "Port-channel1",
        "bundle_id": 1,
        "protocol": "lacp",
        "members": ["GigabitEthernet1/0/1"],
    }]


def test_collector_does_not_report_complete_for_empty_stp_parser_result():
    collector = _collector_api()(device_name="CORE1", platform="iosxe")
    device = FakeDevice(
        {
            "show spanning-tree": {"pvst": {"vlans": {}}},
            "show cdp neighbors detail": {},
            "show lldp neighbors detail": {},
            "show etherchannel summary": {},
        }
    )

    evidence = collector.collect(device)

    assert evidence["status"] != "complete"
    assert any(gap["code"] == "no_parsable_stp_state" for gap in evidence["gaps"])


def test_collector_does_not_treat_empty_stp_instance_as_parsable_evidence():
    collector = _collector_api()(device_name="CORE1", platform="iosxe")
    device = FakeDevice(
        {
            "show spanning-tree": {"pvst": {"vlans": {"1": {}}}},
            "show cdp neighbors detail": {"cdp": {}},
            "show lldp neighbors detail": {"lldp": {}},
            "show etherchannel summary": {"etherchannel": {}},
        }
    )

    evidence = collector.collect(device)

    assert evidence["status"] == "failed"
    assert evidence["stp"]["instances"] == []
    assert any(gap["code"] == "no_parsable_stp_state" for gap in evidence["gaps"])


@pytest.mark.parametrize("command", [
    "show cdp neighbors detail",
    "show lldp neighbors detail",
    "show etherchannel summary",
])
def test_auxiliary_parse_gap_does_not_downgrade_valid_stp(command):
    collector = _collector_api()(device_name="CORE1", platform="iosxe")
    device = FakeDevice({
        "show spanning-tree": {"stp": {"mode": "rapid_pvst", "instances": {"1": {"bridge_id": "0011.2233.4455", "interfaces": {"Gi1/0/1": {"status": "forwarding"}}}}}},
        "show cdp neighbors detail": {}, "show lldp neighbors detail": {}, "show etherchannel summary": {},
    })
    device.parsed[command] = {"error": "parser failed"}
    evidence = collector.collect(device)
    assert evidence["status"] == "complete"
    expected_source = {"show cdp neighbors detail": "cdp", "show lldp neighbors detail": "lldp", "show etherchannel summary": "bundle"}[command]
    assert any(gap["source"] == expected_source for gap in evidence["gaps"])


def test_empty_nested_interface_is_not_stp_evidence():
    collector = _collector_api()(device_name="CORE1", platform="iosxe")
    device = FakeDevice({
        "show spanning-tree": {"pvst": {"vlans": {"1": {"interfaces": {"Gi1/0/1": {}}}}}},
        "show cdp neighbors detail": {}, "show lldp neighbors detail": {}, "show etherchannel summary": {},
    })
    evidence = collector.collect(device)
    assert evidence["status"] == "failed"
    assert evidence["stp"]["ports"] == []
