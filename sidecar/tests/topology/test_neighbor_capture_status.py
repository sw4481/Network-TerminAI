"""Opt-in discovery outcomes; legacy normalization remains unchanged."""
import pytest

from ccie_sidecar import server
from ccie_sidecar.parsers import dispatcher, genie_adapter
from ccie_sidecar.parsers.errors import NoParserError


def request(raw="synthetic", protocol="cdp", include_status=True):
    return server.handle_request({
        "id": "synthetic-capture", "method": "topology.neighbors",
        "params": {"protocol": protocol, "vendor": "cisco", "platform": "iosxe",
                   "command": f"show {protocol} neighbors detail", "raw": raw,
                   "include_status": include_status},
    })


@pytest.mark.parametrize("envelope,protocol", [
    ({"parser": "unknown", "data": {}}, "cdp"),
    ({"parser": "textfsm", "data": []}, "ospf"),
])
def test_unsupported_normalizer_is_not_completed(monkeypatch, envelope, protocol):
    monkeypatch.setattr(dispatcher, "parse_show", lambda *args: envelope)
    result = request(protocol=protocol)
    assert result["type"] == "done"
    assert result["result"] == {"status": "unsupported", "records": []}


def test_no_parser_is_unsupported_only_for_opt_in(monkeypatch):
    def missing(*args):
        raise NoParserError("synthetic unavailable parser")
    monkeypatch.setattr(dispatcher, "parse_show", missing)
    assert request()["result"] == {"status": "unsupported", "records": []}
    assert request(include_status=False)["type"] == "error"


@pytest.mark.skipif(genie_adapter._GENIE_IMPORT_ERROR is not None, reason="Genie not installed")
@pytest.mark.parametrize("protocol,raw", [
    ("cdp", "Total cdp entries displayed : 0\n"),
    ("lldp", "Total entries displayed: 0\n"),
])
def test_real_supported_zero_capture_completes(protocol, raw):
    assert request(raw=raw, protocol=protocol)["result"] == {"status": "completed", "records": []}


@pytest.mark.skipif(genie_adapter._GENIE_IMPORT_ERROR is not None, reason="Genie not installed")
@pytest.mark.parametrize("protocol,raw", [
    ("cdp", "Device# show cdp neighbors detail\nTotal cdp entries displayed : 0\n"),
    ("lldp", "switch-1.example.test>show lldp neighbors detail\r\nTotal entries displayed: 0\r\n"),
    ("cdp", "show cdp neighbors detail\nTotal cdp entries displayed : 0\n"),
])
def test_real_zero_capture_with_matching_command_echo_completes(protocol, raw):
    response = request(raw=raw, protocol=protocol)
    assert response["type"] == "done", response
    assert response["result"] == {"status": "completed", "records": []}


@pytest.mark.skipif(genie_adapter._GENIE_IMPORT_ERROR is not None, reason="Genie not installed")
@pytest.mark.parametrize("raw", [
    "arbitrary junk\nTotal cdp entries displayed : 0\n",
    "Device# show lldp neighbors detail\nTotal cdp entries displayed : 0\n",
    "Device# show cdp neighbors detail\narbitrary junk\nTotal cdp entries displayed : 0\n",
    "Device# show cdp neighbors detail\nTotal cdp entries displayed : 0\narbitrary junk\n",
    "% Invalid input detected\nTotal cdp entries displayed : 0\n",
])
def test_real_zero_summary_does_not_hide_invalid_capture_text(raw):
    assert request(raw=raw)["type"] == "error"


@pytest.mark.skipif(genie_adapter._GENIE_IMPORT_ERROR is not None, reason="Genie not installed")
def test_real_unparseable_output_is_not_empty_success():
    assert request(raw="this is arbitrary unparseable text\n")["type"] == "error"


def test_parser_exception_is_not_completed(monkeypatch):
    def broken(*args):
        raise ValueError("synthetic parser error")
    monkeypatch.setattr(dispatcher, "parse_show", broken)
    assert request()["type"] == "error"


def test_legacy_response_keeps_original_shape(monkeypatch):
    monkeypatch.setattr(dispatcher, "parse_show", lambda *args: {"parser": "unknown", "data": {}})
    assert request(include_status=False)["result"] == {"records": []}
