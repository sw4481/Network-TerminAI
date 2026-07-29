import pytest
from ccie_sidecar.parsers import genie_adapter
from ccie_sidecar.parsers.dispatcher import parse_show
from ccie_sidecar.parsers.errors import NoParserError

# Genie/pyATS ships no Windows wheels, so the Windows build omits it and Cisco
# parsing falls through to TextFSM (which has no template for these commands).
# Skip the genie-specific expectations there; the fallback is exercised by the
# arista textfsm test, which runs everywhere.
requires_genie = pytest.mark.skipif(
    genie_adapter._GENIE_IMPORT_ERROR is not None,
    reason="genie/pyats not installed (e.g. Windows build)",
)


@requires_genie
def test_genie_parses_ios_xe_show_version():
    raw = (
        "Cisco IOS XE Software, Version 17.09.04\n"
        "cisco CSR1000V (VXE) processor\n"
    )
    result = parse_show("cisco", "iosxe", "show version", raw)
    assert result["parser"] == "genie"
    assert "version" in result["data"]

def test_textfsm_fallback_for_arista():
    raw = (
        "Interface              IP Address        Status       Protocol   MTU\n"
        "Ethernet1              10.0.0.1/24       up           up         1500\n"
    )
    result = parse_show("arista", "eos", "show ip interface brief", raw)
    assert result["parser"] == "textfsm"
    assert isinstance(result["data"], list)
    assert len(result["data"]) == 1

def test_no_parser_raises():
    with pytest.raises(NoParserError):
        parse_show("vendor_unknown", "os_unknown", "show foo", "...")
