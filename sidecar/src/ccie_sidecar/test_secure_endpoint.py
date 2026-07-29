import json
import sys
from unittest.mock import MagicMock, Mock, patch

from ccie_sidecar.secure_endpoint import (
    SecureEndpointClient,
    _blast_radius,
    _region_host,
    install_secure_endpoint,
)


def test_region_host_mapping():
    assert _region_host("nam") == "api.amp.cisco.com"
    assert _region_host("eu") == "api.eu.amp.cisco.com"
    assert _region_host("apjc") == "api.apjc.amp.cisco.com"
    # Unknown / empty falls back to NAM.
    assert _region_host("") == "api.amp.cisco.com"
    assert _region_host("zzz") == "api.amp.cisco.com"


def test_blast_radius_by_method():
    assert _blast_radius("GET", "/v1/computers") == "low"
    assert _blast_radius("POST", "/v1/file_lists/x/files/y") == "medium"
    assert _blast_radius("PUT", "/v1/computers/g/isolation") == "medium"
    assert _blast_radius("PATCH", "/v1/computers/g") == "medium"
    assert _blast_radius("DELETE", "/v1/computers/g/isolation") == "destructive"


def test_call_unconfigured_returns_error_envelope():
    client = SecureEndpointClient({})
    out = client.call("GET", "/v1/version")
    assert out["status_code"] == 0
    assert out["error"]
    assert out["blast_radius"] == "low"
    assert out["data"] is None


def test_v1_basic_auth_and_url_construction():
    client = SecureEndpointClient({
        "region": "eu",
        "auth_mode": "v1_basic",
        "client_id": "cid",
        "api_key": "key",
        "verify_ssl": True,
    })
    fake = MagicMock()
    fake.status_code = 200
    fake.json.return_value = {"version": "v1.2.3"}
    with patch("requests.Session.request", return_value=fake) as req:
        out = client.call("GET", "/v1/version")
    assert out["status_code"] == 200
    assert out["data"] == {"version": "v1.2.3"}
    assert out["error"] is None
    # Built the EU host URL.
    _, kwargs = req.call_args
    assert kwargs["url"] == "https://api.eu.amp.cisco.com/v1/version"
    # Basic auth set on the session.
    assert client._session.auth == ("cid", "key")


def test_install_binds_helper():
    # Mock the config module that doesn't exist yet (Task 2).
    mock_config_module = Mock()
    mock_config_module.get_secure_endpoint_config = Mock(return_value=None)
    sys.modules['ccie_sidecar.secure_endpoint_config'] = mock_config_module

    try:
        g = {}
        install_secure_endpoint(g)
        assert "secure_endpoint_api_call" in g
        assert callable(g["secure_endpoint_api_call"])
        # Helper returns a JSON string (unconfigured -> error envelope).
        s = g["secure_endpoint_api_call"]("GET", "/v1/version")
        parsed = json.loads(s)
        assert parsed["status_code"] == 0
    finally:
        # Clean up the mock module
        sys.modules.pop('ccie_sidecar.secure_endpoint_config', None)


def test_config_from_env(monkeypatch):
    from ccie_sidecar import secure_endpoint_config as cfgmod
    # Force the DB path to a nonexistent file so it falls back to env.
    monkeypatch.setattr(cfgmod, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/se.db"))
    monkeypatch.setenv("SECURE_ENDPOINT_REGION", "eu")
    monkeypatch.setenv("SECURE_ENDPOINT_AUTH_MODE", "v1_basic")
    monkeypatch.setenv("SECURE_ENDPOINT_CLIENT_ID", "cid")
    monkeypatch.setenv("SECURE_ENDPOINT_API_KEY", "key")
    monkeypatch.setenv("SECURE_ENDPOINT_VERIFY_SSL", "1")
    cfg = cfgmod.get_secure_endpoint_config()
    assert cfg == {
        "region": "eu", "auth_mode": "v1_basic",
        "client_id": "cid", "api_key": "key", "verify_ssl": True,
    }


def test_config_none_when_unset(monkeypatch):
    from ccie_sidecar import secure_endpoint_config as cfgmod
    monkeypatch.setattr(cfgmod, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/se.db"))
    monkeypatch.delenv("SECURE_ENDPOINT_CLIENT_ID", raising=False)
    monkeypatch.delenv("SECURE_ENDPOINT_REGION", raising=False)
    assert cfgmod.get_secure_endpoint_config() is None
