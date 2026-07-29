"""Tests for the Cisco Modeling Labs (CML) client + sandbox helper."""
import json
from unittest.mock import Mock, MagicMock, patch


def test_blast_radius_always_low():
    from ccie_sidecar.cml import _blast_radius
    # No gating: every method/path is low so mutations auto-approve.
    assert _blast_radius("GET", "/labs") == "low"
    assert _blast_radius("POST", "/labs") == "low"
    assert _blast_radius("PUT", "/labs/abc/wipe") == "low"
    assert _blast_radius("DELETE", "/labs/abc") == "low"


def test_unconfigured_call_returns_error():
    from ccie_sidecar.cml import CmlClient
    client = CmlClient({})
    out = client.call("GET", "/labs")
    assert out["status_code"] == 0
    assert "not configured" in out["error"]
    assert out["blast_radius"] == "low"


def test_call_authenticates_then_uses_bearer():
    from ccie_sidecar.cml import CmlClient

    with patch("ccie_sidecar.cml.requests.Session") as mock_session_cls:
        mock_session = MagicMock()

        # First request = POST /authenticate -> JWT string; second = GET /labs.
        auth_resp = Mock()
        auth_resp.status_code = 200
        auth_resp.json.return_value = "JWT.TOKEN.HERE"
        labs_resp = Mock()
        labs_resp.status_code = 200
        labs_resp.json.return_value = ["lab-1", "lab-2"]
        mock_session.request.side_effect = [auth_resp, labs_resp]
        mock_session.headers = {}
        mock_session_cls.return_value = mock_session

        client = CmlClient({
            "host": "cml.local", "username": "admin",
            "password": "pw", "verify_ssl": False,
        })
        out = client.call("GET", "/labs")

        assert out["status_code"] == 200
        assert out["data"] == ["lab-1", "lab-2"]
        assert out["blast_radius"] == "low"

        calls = mock_session.request.call_args_list
        # First call authenticates.
        assert calls[0].kwargs["url"] == "https://cml.local/api/v0/authenticate"
        assert calls[0].kwargs["json"] == {"username": "admin", "password": "pw"}
        # Second call carries the bearer token and hits the data path.
        assert calls[1].kwargs["url"] == "https://cml.local/api/v0/labs"
        assert calls[1].kwargs["headers"]["Authorization"] == "Bearer JWT.TOKEN.HERE"
        assert calls[1].kwargs["verify"] is False


def test_reauth_once_on_401():
    from ccie_sidecar.cml import CmlClient

    with patch("ccie_sidecar.cml.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        auth1 = Mock(status_code=200); auth1.json.return_value = "TOK1"
        # First data call 401s (expired token); we re-auth then retry OK.
        unauth = Mock(status_code=401); unauth.json.return_value = {"description": "expired"}
        auth2 = Mock(status_code=200); auth2.json.return_value = "TOK2"
        ok = Mock(status_code=200); ok.json.return_value = {"state": "STARTED"}
        mock_session.request.side_effect = [auth1, unauth, auth2, ok]
        mock_session.headers = {}
        mock_session_cls.return_value = mock_session

        client = CmlClient({"host": "c", "username": "u", "password": "p", "verify_ssl": False})
        out = client.call("GET", "/labs/x/state")

        assert out["status_code"] == 200
        assert out["data"] == {"state": "STARTED"}
        # 4 requests total: auth, data(401), re-auth, data(retry).
        assert mock_session.request.call_count == 4


def test_install_cml_binds_helper():
    from ccie_sidecar.cml import install_cml

    g = {}
    with patch("ccie_sidecar.cml_config.get_cml_config", return_value=None):
        install_cml(g)

    assert "cml_api_call" in g
    assert "cml" in g
    out = json.loads(g["cml_api_call"]("GET", "/labs"))
    assert out["status_code"] == 0  # unconfigured -> JSON string error


def test_test_connection_requires_fields():
    from ccie_sidecar.cml import test_connection
    res = test_connection({"host": "cml.local"})
    assert res["ok"] is False
    assert "required" in res["message"].lower()


def test_get_cml_config_from_env(monkeypatch):
    monkeypatch.setenv("CML_HOST", "cml.local")
    monkeypatch.setenv("CML_USERNAME", "admin")
    monkeypatch.setenv("CML_PASSWORD", "pw")
    monkeypatch.setenv("CML_VERIFY_SSL", "0")
    # Force the DB path to a nonexistent file so we hit the env fallback.
    import ccie_sidecar.cml_config as cc
    monkeypatch.setattr(cc, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/x.db"))
    cfg = cc.get_cml_config()
    assert cfg == {"host": "cml.local", "username": "admin", "password": "pw", "verify_ssl": False}


def test_react_code_client_section_points_at_cml_not_proxmox():
    """The cml agent's client section must steer the model to cml_api_call, NOT
    fall through to the proxmox fallback (proxmox is injected into every sandbox)."""
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    from ccie_sidecar.agents.react_code import _build_client_section

    g = _build_sandbox_globals("cml", {}, emit=lambda e: None)
    assert "proxmox" in g  # proxmox is always injected — the trap we must avoid
    assert "cml_api_call" in g  # the cml branch bound the helper
    section = _build_client_section("cml", g, False)
    assert "cml_api_call" in section
    assert "/labs" in section
    assert "ONLY way to reach Proxmox" not in section


def test_call_timeout_exception():
    """Test that Timeout exceptions return status_code 0 with timeout message."""
    from ccie_sidecar.cml import CmlClient
    import requests.exceptions

    with patch("ccie_sidecar.cml.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        auth_resp = Mock()
        auth_resp.status_code = 200
        auth_resp.json.return_value = "JWT.TOKEN.HERE"
        mock_session.request.side_effect = [auth_resp, requests.exceptions.Timeout("Request timeout")]
        mock_session.headers = {}
        mock_session_cls.return_value = mock_session

        client = CmlClient({
            "host": "cml.local", "username": "admin",
            "password": "pw", "verify_ssl": False,
        })
        out = client.call("GET", "/labs")

        assert out["status_code"] == 0
        assert "timed out after 30 seconds" in out["error"]
        assert out["blast_radius"] == "low"


def test_call_ssl_error_exception():
    """Test that SSLError exceptions return status_code 0 with SSL error message."""
    from ccie_sidecar.cml import CmlClient
    import requests.exceptions

    with patch("ccie_sidecar.cml.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        auth_resp = Mock()
        auth_resp.status_code = 200
        auth_resp.json.return_value = "JWT.TOKEN.HERE"
        mock_session.request.side_effect = [auth_resp, requests.exceptions.SSLError("Certificate verify failed")]
        mock_session.headers = {}
        mock_session_cls.return_value = mock_session

        client = CmlClient({
            "host": "cml.local", "username": "admin",
            "password": "pw", "verify_ssl": True,
        })
        out = client.call("GET", "/labs")

        assert out["status_code"] == 0
        assert "SSL certificate verification failed" in out["error"]
        assert "Verify SSL" in out["error"]
        assert out["blast_radius"] == "low"


def test_call_generic_exception():
    """Test that generic exceptions return status_code 0 with stringified error."""
    from ccie_sidecar.cml import CmlClient

    with patch("ccie_sidecar.cml.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        auth_resp = Mock()
        auth_resp.status_code = 200
        auth_resp.json.return_value = "JWT.TOKEN.HERE"
        test_error = ValueError("Custom error message")
        mock_session.request.side_effect = [auth_resp, test_error]
        mock_session.headers = {}
        mock_session_cls.return_value = mock_session

        client = CmlClient({
            "host": "cml.local", "username": "admin",
            "password": "pw", "verify_ssl": False,
        })
        out = client.call("GET", "/labs")

        assert out["status_code"] == 0
        assert "Custom error message" in out["error"]
        assert out["blast_radius"] == "low"
