import json
import sys
from unittest.mock import MagicMock, Mock, patch

from ccie_sidecar.cisco_xdr import (
    CiscoXdrClient,
    _blast_radius,
    _host_for_path,
    _iroh_host,
    install_cisco_xdr,
)


def test_iroh_host_mapping():
    assert _iroh_host("nam") == "visibility.amp.cisco.com"
    assert _iroh_host("eu") == "visibility.eu.amp.cisco.com"
    assert _iroh_host("apjc") == "visibility.apjc.amp.cisco.com"
    # Unknown / empty falls back to NAM.
    assert _iroh_host("") == "visibility.amp.cisco.com"
    assert _iroh_host("zzz") == "visibility.amp.cisco.com"


def test_host_for_path_prefix_routing():
    # Path prefix selects the regional host family.
    assert _host_for_path("/iroh/iroh-enrich/observe/observables", "nam") == "visibility.amp.cisco.com"
    assert _host_for_path("/ctia/incident/x/summary", "nam") == "private.intel.amp.cisco.com"
    assert _host_for_path("/v2/incident", "nam") == "conure.us.security.cisco.com"
    assert _host_for_path("/api/v1/workflows", "nam") == "automate.us.security.cisco.com"
    # EU/APJC infixes differ per family.
    assert _host_for_path("/ctia/incident", "eu") == "private.intel.eu.amp.cisco.com"
    assert _host_for_path("/v2/incident", "apjc") == "conure.apjc.security.cisco.com"
    assert _host_for_path("/api/v1/workflows", "eu") == "automate.eu.security.cisco.com"
    # Unknown prefix defaults to the IROH platform host.
    assert _host_for_path("/something/else", "nam") == "visibility.amp.cisco.com"
    # Leading slash is optional.
    assert _host_for_path("v2/incident", "nam") == "conure.us.security.cisco.com"


def test_blast_radius_by_method():
    assert _blast_radius("GET", "/v2/incident") == "low"
    assert _blast_radius("POST", "/iroh/iroh-enrich/observe/observables") == "medium"
    assert _blast_radius("PUT", "/v2/incident/x") == "medium"
    assert _blast_radius("PATCH", "/v2/incident/x") == "medium"
    assert _blast_radius("DELETE", "/v2/incident/x") == "destructive"


def test_call_unconfigured_returns_error_envelope():
    client = CiscoXdrClient({})
    out = client.call("GET", "/v2/incident")
    assert out["status_code"] == 0
    assert out["error"]
    assert out["blast_radius"] == "low"
    assert out["data"] is None


def test_call_routes_host_and_uses_bearer():
    client = CiscoXdrClient({
        "region": "eu",
        "client_id": "cid",
        "client_password": "secret",
        "verify_ssl": True,
    })
    # Pre-seed the bearer so call() skips the token exchange.
    client._bearer = "tok-123"
    fake = MagicMock()
    fake.status_code = 200
    fake.json.return_value = {"data": []}
    with patch("requests.request", return_value=fake) as req:
        out = client.call("POST", "/v2/incident/search/count")
    assert out["status_code"] == 200
    assert out["data"] == {"data": []}
    assert out["error"] is None
    _, kwargs = req.call_args
    # Conure host for /v2 in EU, with the bearer attached.
    assert kwargs["url"] == "https://conure.eu.security.cisco.com/v2/incident/search/count"
    assert kwargs["headers"]["Authorization"] == "Bearer tok-123"


def test_call_remints_bearer_once_on_401():
    client = CiscoXdrClient({
        "region": "nam",
        "client_id": "cid",
        "client_password": "secret",
        "verify_ssl": False,
    })
    client._bearer = "stale"
    first = MagicMock(); first.status_code = 401; first.json.return_value = {}
    second = MagicMock(); second.status_code = 200; second.json.return_value = {"ok": True}
    with patch("requests.request", side_effect=[first, second]) as req, \
         patch.object(CiscoXdrClient, "_ensure_bearer", return_value="fresh") as mint:
        out = client.call("GET", "/iroh/iroh-enrich/observe/observables")
    assert out["status_code"] == 200
    assert req.call_count == 2
    # Forced re-mint happened after the 401.
    assert mint.called


def test_install_binds_helper():
    mock_config_module = Mock()
    mock_config_module.get_cisco_xdr_config = Mock(return_value=None)
    sys.modules['ccie_sidecar.cisco_xdr_config'] = mock_config_module
    try:
        g = {}
        install_cisco_xdr(g)
        assert "cisco_xdr_api_call" in g
        assert callable(g["cisco_xdr_api_call"])
        s = g["cisco_xdr_api_call"]("GET", "/v2/incident")
        parsed = json.loads(s)
        assert parsed["status_code"] == 0
    finally:
        sys.modules.pop('ccie_sidecar.cisco_xdr_config', None)


def test_config_from_env(monkeypatch):
    from ccie_sidecar import cisco_xdr_config as cfgmod
    monkeypatch.setattr(cfgmod, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/xdr.db"))
    monkeypatch.setenv("CISCO_XDR_REGION", "eu")
    monkeypatch.setenv("CISCO_XDR_CLIENT_ID", "cid")
    monkeypatch.setenv("CISCO_XDR_CLIENT_PASSWORD", "secret")
    monkeypatch.setenv("CISCO_XDR_VERIFY_SSL", "1")
    cfg = cfgmod.get_cisco_xdr_config()
    assert cfg == {
        "region": "eu", "client_id": "cid",
        "client_password": "secret", "verify_ssl": True,
    }


def test_config_none_when_unset(monkeypatch):
    from ccie_sidecar import cisco_xdr_config as cfgmod
    monkeypatch.setattr(cfgmod, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/xdr.db"))
    monkeypatch.delenv("CISCO_XDR_CLIENT_ID", raising=False)
    monkeypatch.delenv("CISCO_XDR_REGION", raising=False)
    assert cfgmod.get_cisco_xdr_config() is None
