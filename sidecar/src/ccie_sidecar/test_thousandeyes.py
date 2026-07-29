"""Tests for the Cisco ThousandEyes client + sandbox helper."""
import json
from unittest.mock import Mock, MagicMock, patch


def test_blast_radius_always_low():
    from ccie_sidecar.thousandeyes import _blast_radius
    assert _blast_radius("GET", "/v7/tests") == "low"


def test_unconfigured_call_returns_error():
    from ccie_sidecar.thousandeyes import ThousandEyesClient
    out = ThousandEyesClient({}).call("GET", "/v7/tests")
    assert out["status_code"] == 0
    assert "not configured" in out["error"]


def test_call_sends_bearer_and_default_aid():
    from ccie_sidecar.thousandeyes import ThousandEyesClient

    with patch("ccie_sidecar.thousandeyes.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        resp = Mock(status_code=200)
        resp.json.return_value = {"tests": [{"testId": 1}]}
        mock_session.request.return_value = resp
        mock_session_cls.return_value = mock_session

        client = ThousandEyesClient({"token": "TOK", "account_group_id": "ag-1"})
        out = client.call("GET", "/v7/tests")

        assert out["status_code"] == 200
        kwargs = mock_session.request.call_args.kwargs
        assert kwargs["url"] == "https://api.thousandeyes.com/v7/tests"
        assert kwargs["headers"]["Authorization"] == "Bearer TOK"
        # Configured account group applied as aid.
        assert kwargs["params"]["aid"] == "ag-1"


def test_401_surfaces_auth_error():
    from ccie_sidecar.thousandeyes import ThousandEyesClient

    with patch("ccie_sidecar.thousandeyes.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        resp = Mock(status_code=401); resp.json.return_value = {}
        mock_session.request.return_value = resp
        mock_session_cls.return_value = mock_session

        client = ThousandEyesClient({"token": "BAD"})
        out = client.call("GET", "/v7/tests")
        assert out["status_code"] == 401
        assert "Authentication failed" in out["error"]


def test_install_thousandeyes_binds_helper():
    from ccie_sidecar.thousandeyes import install_thousandeyes
    g = {}
    with patch("ccie_sidecar.thousandeyes_config.get_thousandeyes_config", return_value=None):
        install_thousandeyes(g)
    assert "thousandeyes_api_call" in g and "thousandeyes" in g
    out = json.loads(g["thousandeyes_api_call"]("GET", "/v7/tests"))
    assert out["status_code"] == 0


def test_test_connection_requires_token():
    from ccie_sidecar.thousandeyes import test_connection
    res = test_connection({"token": ""})
    assert res["ok"] is False
    assert "token" in res["message"].lower()


def test_get_te_config_from_env(monkeypatch):
    monkeypatch.setenv("THOUSANDEYES_TOKEN", "TOK")
    monkeypatch.setenv("THOUSANDEYES_ACCOUNT_GROUP_ID", "ag-9")
    import ccie_sidecar.thousandeyes_config as cc
    monkeypatch.setattr(cc, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/x.db"))
    cfg = cc.get_thousandeyes_config()
    assert cfg == {"token": "TOK", "account_group_id": "ag-9"}
