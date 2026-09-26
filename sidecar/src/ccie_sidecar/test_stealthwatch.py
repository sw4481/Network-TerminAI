import pytest
from unittest.mock import Mock, patch
# Import under an alias so pytest doesn't try to collect the production function
# `test_connection` as a test case (its `config` arg looks like a fixture).
from .stealthwatch import test_connection as run_test_connection


def test_test_connection_success():
    """Test successful connection returns tenant info."""
    config = {
        "host": "smc.test.local",
        "username": "admin",
        "password": "secret",
        "verify_ssl": True,
    }

    def fake_post(session, url, **_kwargs):
        session.cookies.set("XSRF-TOKEN", "token")
        response = Mock()
        response.status_code = 200
        response.json.return_value = {}
        return response

    def fake_request(_session, *_args, **_kwargs):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {"data": [{"id": 123}]}
        return response

    with patch("requests.Session.post", fake_post), patch("requests.Session.request", fake_request):
        result = run_test_connection(config)

    assert result["ok"] is True
    assert "123" in result["message"]


def test_test_connection_auth_failure():
    """Test authentication failure returns error."""
    config = {
        "host": "smc.test.local",
        "username": "wrong",
        "password": "wrong",
        "verify_ssl": True,
    }

    with patch("requests.Session.post") as mock_post:
        mock_response = Mock()
        mock_response.status_code = 401
        mock_post.return_value = mock_response

        result = run_test_connection(config)

        assert result["ok"] is False
        assert "Authentication failed" in result["message"]


def test_test_connection_network_error():
    """Test network error returns descriptive message."""
    config = {
        "host": "unreachable.local",
        "username": "admin",
        "password": "secret",
        "verify_ssl": True,
    }

    with patch("requests.Session.post") as mock_post:
        mock_post.side_effect = Exception("Connection refused")

        result = run_test_connection(config)

        assert result["ok"] is False
        assert "Connection refused" in result["message"]


def test_disabled_tls_verification_uses_transport_independent_of_system_truststore():
    """Global truststore injection must not re-enable checks when Verify SSL is off."""
    import ssl

    from ccie_sidecar.stealthwatch import StealthwatchClient

    client = StealthwatchClient({
        "host": "smc.test.local",
        "username": "admin",
        "password": "secret",
        "verify_ssl": False,
    })

    def fake_post(session, *_args, **_kwargs):
        session.cookies.set("XSRF-TOKEN", "token")
        response = Mock()
        response.status_code = 200
        return response

    with patch("requests.Session.post", fake_post):
        assert client._authenticate() is True

    adapter = client._session.get_adapter("https://smc.test.local")
    context = adapter.poolmanager.connection_pool_kw.get("ssl_context")

    assert context is not None
    assert context.check_hostname is False
    assert context.verify_mode == ssl.CERT_NONE


def test_test_connection_disabled_tls_uses_unverified_session_adapter():
    """The Settings test button path must honor Verify SSL off after truststore injection."""
    import ssl

    seen = {}

    def fake_post(session, *_args, **_kwargs):
        adapter = session.get_adapter("https://smc.test.local")
        seen["context"] = adapter.poolmanager.connection_pool_kw.get("ssl_context")
        session.cookies.set("XSRF-TOKEN", "token")
        response = Mock()
        response.status_code = 200
        response.json.return_value = {}
        return response

    def fake_request(_session, *_args, **_kwargs):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {"data": [{"id": 123}]}
        return response

    with patch("requests.Session.post", fake_post), patch("requests.Session.request", fake_request):
        result = run_test_connection({
            "host": "smc.test.local",
            "username": "admin",
            "password": "secret",
            "verify_ssl": False,
        })

    assert result["ok"] is True
    assert seen["context"] is not None
    assert seen["context"].check_hostname is False
    assert seen["context"].verify_mode == ssl.CERT_NONE


def test_test_connection_fetches_tenant_id_from_tenants_endpoint():
    """Auth responses may omit tenantId; Settings should pull it from tenants API."""

    def fake_post(session, *_args, **_kwargs):
        session.cookies.set("XSRF-TOKEN", "token")
        response = Mock()
        response.status_code = 200
        response.json.return_value = {}
        return response

    def fake_request(_session, *_args, **kwargs):
        assert kwargs["url"].endswith("/sw-reporting/v1/tenants")
        response = Mock()
        response.status_code = 200
        response.json.return_value = {"data": [{"id": "tenant-42"}]}
        return response

    with patch("requests.Session.post", fake_post), patch("requests.Session.request", fake_request):
        result = run_test_connection({
            "host": "smc.test.local",
            "username": "admin",
            "password": "secret",
            "verify_ssl": False,
        })

    assert result["ok"] is True
    assert "tenant-42" in result["message"]
