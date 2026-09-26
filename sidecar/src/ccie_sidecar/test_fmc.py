"""Tests for the Cisco FMC client + sandbox helper."""
import json
from unittest.mock import Mock, MagicMock, patch


def test_blast_radius_read_low_write_medium():
    from ccie_sidecar.fmc import _blast_radius
    assert _blast_radius("GET", "/api/fmc_config/v1/domain/x/policy/accesspolicies") == "low"
    assert _blast_radius("POST", "/api/fmc_config/v1/domain/x/policy/accesspolicies") == "medium"
    assert _blast_radius("DELETE", "/api/fmc_config/v1/domain/x/object/networks/1") == "medium"


def test_unconfigured_call_returns_error():
    from ccie_sidecar.fmc import FmcClient
    out = FmcClient({}).call("GET", "/api/fmc_platform/v1/info/domain")
    assert out["status_code"] == 0
    assert "not configured" in out["error"]


def test_auth_reads_token_and_domain_then_fills_path():
    from ccie_sidecar.fmc import FmcClient

    with patch("ccie_sidecar.fmc.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        auth = Mock(status_code=204)
        auth.headers = {"X-auth-access-token": "TOK", "DOMAIN_UUID": "dom-123"}
        data = Mock(status_code=200)
        data.json.return_value = {"items": []}
        mock_session.request.side_effect = [auth, data]
        mock_session_cls.return_value = mock_session

        client = FmcClient({"host": "fmc.local", "username": "u",
                            "password": "p", "verify_ssl": False})
        out = client.call("GET",
                          "/api/fmc_config/v1/domain/{domainUUID}/policy/accesspolicies")

        assert out["status_code"] == 200
        calls = mock_session.request.call_args_list
        assert calls[0].kwargs["url"].endswith("/api/fmc_platform/v1/auth/generatetoken")
        assert calls[0].kwargs["auth"] == ("u", "p")
        # Domain UUID was substituted into the data path.
        assert calls[1].kwargs["url"] == (
            "https://fmc.local/api/fmc_config/v1/domain/dom-123/policy/accesspolicies"
        )
        assert calls[1].kwargs["headers"]["X-auth-access-token"] == "TOK"


def test_config_domain_override_wins():
    from ccie_sidecar.fmc import FmcClient

    with patch("ccie_sidecar.fmc.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        auth = Mock(status_code=204)
        auth.headers = {"X-auth-access-token": "TOK", "DOMAIN_UUID": "default-dom"}
        data = Mock(status_code=200); data.json.return_value = {"items": []}
        mock_session.request.side_effect = [auth, data]
        mock_session_cls.return_value = mock_session

        client = FmcClient({"host": "fmc.local", "username": "u", "password": "p",
                            "domain_uuid": "override-dom", "verify_ssl": False})
        client.call("GET", "/api/fmc_config/v1/domain/{domainUUID}/devices/devicerecords")
        url = mock_session.request.call_args_list[1].kwargs["url"]
        assert "/domain/override-dom/" in url


def test_reauth_once_on_401():
    from ccie_sidecar.fmc import FmcClient

    with patch("ccie_sidecar.fmc.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        auth1 = Mock(status_code=204); auth1.headers = {"X-auth-access-token": "T1", "DOMAIN_UUID": "d"}
        unauth = Mock(status_code=401); unauth.json.return_value = {}
        auth2 = Mock(status_code=204); auth2.headers = {"X-auth-access-token": "T2", "DOMAIN_UUID": "d"}
        ok = Mock(status_code=200); ok.json.return_value = {"items": []}
        mock_session.request.side_effect = [auth1, unauth, auth2, ok]
        mock_session_cls.return_value = mock_session

        client = FmcClient({"host": "f", "username": "u", "password": "p", "verify_ssl": False})
        out = client.call("GET", "/api/fmc_platform/v1/info/serverversion")
        assert out["status_code"] == 200
        assert mock_session.request.call_count == 4


def test_install_fmc_binds_helper():
    from ccie_sidecar.fmc import install_fmc
    g = {}
    with patch("ccie_sidecar.fmc_config.get_fmc_config", return_value=None):
        install_fmc(g)
    assert "fmc_api_call" in g and "fmc" in g
    out = json.loads(g["fmc_api_call"]("GET", "/api/fmc_platform/v1/info/domain"))
    assert out["status_code"] == 0


def test_test_connection_requires_fields():
    from ccie_sidecar.fmc import test_connection
    res = test_connection({"host": "fmc.local"})
    assert res["ok"] is False


def test_get_fmc_config_from_env(monkeypatch):
    monkeypatch.setenv("FMC_HOST", "fmc.local")
    monkeypatch.setenv("FMC_USERNAME", "u")
    monkeypatch.setenv("FMC_PASSWORD", "p")
    import ccie_sidecar.fmc_config as cc
    monkeypatch.setattr(cc, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/x.db"))
    cfg = cc.get_fmc_config()
    assert cfg["host"] == "fmc.local" and cfg["verify_ssl"] is False
