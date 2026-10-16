from ccie_sidecar.parsers import textfsm_adapter

RAW = """Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0     10.0.0.1        YES manual up                    up
GigabitEthernet0/1     unassigned      YES unset  administratively down down
"""


def test_iosxe_parses_with_textfsm():
    result = textfsm_adapter.parse("cisco", "iosxe", "show ip interface brief", RAW)
    assert result["parser"] == "textfsm"
    assert len(result["data"]) == 2
