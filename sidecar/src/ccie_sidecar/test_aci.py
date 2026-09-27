"""Tests for the Cisco ACI (APIC) client + sandbox helper."""
import json
from unittest.mock import Mock, MagicMock, patch


def test_blast_radius_read_low_write_medium():
    from ccie_sidecar.aci import _blast_radius
    assert _blast_radius("GET", "/api/node/class/fvTenant.json") == "low"
    assert _blast_radius("POST", "/api/node/mo/uni/tn-x.json") == "medium"
    assert _blast_radius("DELETE", "/api/node/mo/uni/tn-x.json") == "medium"


def test_unconfigured_call_returns_error():
    from ccie_sidecar.aci import AciClient
    out = AciClient({}).call("GET", "/api/node/class/fvTenant.json")
    assert out["status_code"] == 0
    assert "not configured" in out["error"]


def test_call_authenticates_with_cookie_then_queries():
    from ccie_sidecar.aci import AciClient

    with patch("ccie_sidecar.aci.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        auth = Mock(status_code=200)
        # APIC sets the cookie on success.
        mock_session.cookies = MagicMock()
        mock_session.cookies.get.return_value = "the-cookie"
        data = Mock(status_code=200)
        data.json.return_value = {"imdata": [], "totalCount": "0"}
        mock_session.request.side_effect = [auth, data]
        mock_session_cls.return_value = mock_session

        client = AciClient({"host": "apic.local", "username": "admin",
                            "password": "pw", "verify_ssl": False})
        out = client.call("GET", "/api/node/class/fvTenant.json")

        assert out["status_code"] == 200
        assert out["blast_radius"] == "low"
        calls = mock_session.request.call_args_list
        assert calls[0].kwargs["url"] == "https://apic.local/api/aaaLogin.json"
        assert calls[0].kwargs["json"] == {
            "aaaUser": {"attributes": {"name": "admin", "pwd": "pw"}}
        }
        assert calls[1].kwargs["url"] == "https://apic.local/api/node/class/fvTenant.json"


def test_reauth_once_on_403():
    from ccie_sidecar.aci import AciClient

    with patch("ccie_sidecar.aci.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        mock_session.cookies = MagicMock()
        mock_session.cookies.get.return_value = "cookie"
        auth1 = Mock(status_code=200)
        forbidden = Mock(status_code=403); forbidden.json.return_value = {}
        auth2 = Mock(status_code=200)
        ok = Mock(status_code=200); ok.json.return_value = {"imdata": []}
        mock_session.request.side_effect = [auth1, forbidden, auth2, ok]
        mock_session_cls.return_value = mock_session

        client = AciClient({"host": "a", "username": "u", "password": "p", "verify_ssl": False})
        out = client.call("GET", "/api/node/class/fvTenant.json")
        assert out["status_code"] == 200
        assert mock_session.request.call_count == 4


def test_install_aci_binds_helper():
    from ccie_sidecar.aci import install_aci
    g = {}
    with patch("ccie_sidecar.aci_config.get_aci_config", return_value=None):
        install_aci(g)
    assert "aci_api_call" in g and "aci" in g
    out = json.loads(g["aci_api_call"]("GET", "/api/node/class/fvTenant.json"))
    assert out["status_code"] == 0


def test_test_connection_requires_fields():
    from ccie_sidecar.aci import test_connection
    res = test_connection({"host": "apic.local"})
    assert res["ok"] is False
    assert "required" in res["message"].lower()


def test_get_aci_config_from_env(monkeypatch):
    monkeypatch.setenv("ACI_HOST", "apic.local")
    monkeypatch.setenv("ACI_USERNAME", "admin")
    monkeypatch.setenv("ACI_PASSWORD", "pw")
    monkeypatch.setenv("ACI_VERIFY_SSL", "0")
    import ccie_sidecar.aci_config as cc
    monkeypatch.setattr(cc, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/x.db"))
    cfg = cc.get_aci_config()
    assert cfg == {"host": "apic.local", "username": "admin", "password": "pw", "verify_ssl": False}


def test_react_code_client_section_points_at_aci_not_proxmox():
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    from ccie_sidecar.agents.react_code import _build_client_section

    g = _build_sandbox_globals("aci", {}, emit=lambda e: None)
    assert "proxmox" in g and "aci_api_call" in g
    section = _build_client_section("aci", g, False)
    assert "aci_api_call" in section
    assert "imdata" in section
    assert "ONLY way to reach Proxmox" not in section
