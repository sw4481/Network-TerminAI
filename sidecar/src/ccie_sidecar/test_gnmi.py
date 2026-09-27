"""Tests for the gNMI multi-target helper + config."""
from unittest.mock import MagicMock, patch


def test_port_defaults_by_vendor():
    from ccie_sidecar.gnmi import _resolve_port
    assert _resolve_port({"vendor": "cisco-iosxr"}) == 57400
    assert _resolve_port({"vendor": "juniper"}) == 32767
    assert _resolve_port({"vendor": "arista"}) == 6030
    assert _resolve_port({"vendor": "unknown"}) == 57400
    # explicit port wins
    assert _resolve_port({"vendor": "arista", "port": 9339}) == 9339


def test_targets_lists_without_passwords():
    from ccie_sidecar.gnmi import GnmiHelper
    h = GnmiHelper([{"name": "xr-1", "host": "10.0.0.1", "vendor": "cisco-iosxr",
                     "username": "u", "password": "secret"}])
    targets = h.targets()
    assert targets == [{"name": "xr-1", "host": "10.0.0.1", "port": 57400, "vendor": "cisco-iosxr"}]
    assert "password" not in targets[0]


def test_unknown_target_errors():
    from ccie_sidecar.gnmi import GnmiHelper
    h = GnmiHelper([])
    out = h.capabilities("nope")
    assert out["ok"] is False
    assert "Unknown target" in out["error"]


def test_set_blast_medium_on_unknown_target():
    from ccie_sidecar.gnmi import GnmiHelper
    out = GnmiHelper([]).set("nope", update=[("p", "v")])
    assert out["blast_radius"] == "medium"
    assert out["ok"] is False


def test_capabilities_opens_client_for_known_target():
    from ccie_sidecar.gnmi import GnmiHelper

    fake_client = MagicMock()
    fake_ctx = MagicMock()
    fake_ctx.capabilities.return_value = {"gnmi_version": "0.7.0"}
    fake_client.__enter__.return_value = fake_ctx
    fake_client.__exit__.return_value = False

    h = GnmiHelper([{"name": "xr-1", "host": "10.0.0.1", "vendor": "cisco-iosxr",
                     "username": "u", "password": "p"}])
    with patch.object(h, "_connect", return_value=fake_client):
        out = h.capabilities("xr-1")
    assert out["ok"] is True
    assert out["data"]["gnmi_version"] == "0.7.0"
    assert out["blast_radius"] == "low"


def test_subscribe_rejects_streaming_mode():
    from ccie_sidecar.gnmi import GnmiHelper
    h = GnmiHelper([{"name": "x", "host": "1", "username": "u", "password": "p"}])
    out = h.subscribe("x", ["p"], mode="stream")
    assert out["ok"] is False
    assert "only mode='once'" in out["error"].lower()


def test_install_gnmi_binds_helper():
    from ccie_sidecar.gnmi import install_gnmi
    g = {}
    with patch("ccie_sidecar.gnmi_config.get_gnmi_config", return_value={"targets": []}):
        install_gnmi(g)
    assert "gnmi" in g
    assert g["gnmi"].targets() == []


def test_test_connection_no_targets():
    from ccie_sidecar.gnmi import test_connection
    res = test_connection({"targets": []})
    assert res["ok"] is False


def test_get_gnmi_config_from_env(monkeypatch):
    monkeypatch.setenv("GNMI_TARGETS", '[{"name":"a","host":"1.1.1.1","username":"u","password":"p"}]')
    import ccie_sidecar.gnmi_config as cc
    monkeypatch.setattr(cc, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/x.db"))
    cfg = cc.get_gnmi_config()
    assert cfg["targets"][0]["name"] == "a"
