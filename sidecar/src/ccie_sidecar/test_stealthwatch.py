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

    with patch("ccie_sidecar.stealthwatch.requests.post") as mock_post:
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"tenantId": 123}
        mock_post.return_value = mock_response

        result = run_test_connection(config)

        assert result["ok"] is True
        assert "123" in result["message"]
        assert mock_post.call_count == 1
        assert "smc.test.local" in mock_post.call_args[0][0]


def test_test_connection_auth_failure():
    """Test authentication failure returns error."""
    config = {
        "host": "smc.test.local",
        "username": "wrong",
        "password": "wrong",
        "verify_ssl": True,
    }

    with patch("ccie_sidecar.stealthwatch.requests.post") as mock_post:
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

    with patch("ccie_sidecar.stealthwatch.requests.post") as mock_post:
        mock_post.side_effect = Exception("Connection refused")

        result = run_test_connection(config)

        assert result["ok"] is False
        assert "Connection refused" in result["message"]
