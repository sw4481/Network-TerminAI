"""
Unit tests for MerakiClient wrapper.

Tests cover:
- Factory methods (from_token, from_env, from_vault)
- call() method with success and error paths
- Envelope format validation
- Error handling and typing
- Blast radius classification
"""

import os
import time
from unittest.mock import MagicMock, Mock, patch

import pytest

from terminai_meraki.client import MerakiClient
from terminai_meraki.errors import (
    AuthError,
    NotFoundError,
    RateLimitError,
    NetworkError,
    ValidationError,
)


class TestMerakiClientFactoryMethods:
    """Test factory methods for creating MerakiClient instances."""

    def test_from_token_creates_client(self):
        """Test that from_token creates a client with the given API key."""
        token = "test-token"
        client = MerakiClient.from_token(token)

        assert client.api_key == token
        assert client.base_url == "https://api.meraki.com/api/v1"
        assert client.timeout == 60
        assert hasattr(client, "_dashboard")

    def test_from_token_with_custom_params(self):
        """Test from_token with custom base_url and timeout."""
        token = "test-token"
        custom_base = "https://custom.meraki.com"
        custom_timeout = 120

        client = MerakiClient.from_token(
            token,
            base_url=custom_base,
            timeout=custom_timeout
        )

        assert client.api_key == api_key
        assert client.base_url == custom_base
        assert client.timeout == custom_timeout

    @patch("terminai_meraki.client.resolve_api_key")
    def test_from_env_resolves_api_key(self, mock_resolve):
        """Test that from_env calls resolve_api_key with env_var."""
        mock_resolve.return_value = "env_api_key"

        client = MerakiClient.from_env("CUSTOM_ENV_VAR")

        mock_resolve.assert_called_once_with(env_var="CUSTOM_ENV_VAR")
        assert client.api_key == "env_api_key"

    @patch("terminai_meraki.client.resolve_api_key")
    def test_from_env_defaults_to_meraki_api_key(self, mock_resolve):
        """Test that from_env uses MERAKI_API_KEY as default."""
        mock_resolve.return_value = "env_api_key"

        client = MerakiClient.from_env()

        mock_resolve.assert_called_once_with(env_var="MERAKI_API_KEY")
        assert client.api_key == "env_api_key"

    @patch("terminai_meraki.client.resolve_api_key")
    def test_from_vault_resolves_api_key(self, mock_resolve):
        """Test that from_vault calls resolve_api_key with vault_entry."""
        mock_resolve.return_value = "vault_api_key"

        client = MerakiClient.from_vault("meraki_prod")

        mock_resolve.assert_called_once_with(vault_entry="meraki_prod")
        assert client.api_key == "vault_api_key"

    @patch("terminai_meraki.client.resolve_api_key")
    def test_from_env_raises_on_missing_key(self, mock_resolve):
        """Test that from_env raises AuthError if key not found."""
        from terminai_meraki.credentials import AuthError as CredsAuthError
        mock_resolve.side_effect = CredsAuthError("No API key found")

        with pytest.raises(CredsAuthError):
            MerakiClient.from_env()


class TestMerakiClientCallMethod:
    """Test the call() method with various scenarios."""

    @pytest.fixture
    def mock_dashboard(self):
        """Create a mock dashboard API instance."""
        dashboard = MagicMock()
        dashboard.organizations.getOrganizations.return_value = [
            {"id": "123", "name": "Org 1"},
            {"id": "456", "name": "Org 2"},
        ]
        return dashboard

    @pytest.fixture
    def client(self, mock_dashboard):
        """Create a MerakiClient with mocked dashboard."""
        with patch("terminai_meraki.client.meraki.DashboardAPI", return_value=mock_dashboard):
            client = MerakiClient.from_token("test_key")
        return client

    def test_call_organizations_list_success(self, client, mock_dashboard):
        """Test successful organizations.list call."""
        result = client.call("organizations", "list")

        # Verify envelope structure
        assert result["ok"] is True
        assert "data" in result
        assert "meta" in result

        # Verify data
        assert isinstance(result["data"], list)
        assert len(result["data"]) == 2
        assert result["data"][0]["id"] == "123"

        # Verify metadata
        meta = result["meta"]
        assert meta["endpoint"]["resource"] == "organizations"
        assert meta["endpoint"]["action"] == "list"
        assert meta["blast_radius"] == "low"
        assert "duration_ms" in meta
        assert isinstance(meta["duration_ms"], int)

        # Verify SDK method was called
        mock_dashboard.organizations.getOrganizations.assert_called_once()

    def test_call_organizations_get_success(self, client, mock_dashboard):
        """Test successful organizations.get call with parameters."""
        mock_dashboard.organizations.getOrganization.return_value = {
            "id": "123",
            "name": "Test Org"
        }

        result = client.call("organizations", "get", organization_id="123")

        assert result["ok"] is True
        assert result["data"]["id"] == "123"
        assert result["meta"]["blast_radius"] == "low"

        mock_dashboard.organizations.getOrganization.assert_called_once_with("123")

    def test_call_networks_list_success(self, client, mock_dashboard):
        """Test successful networks.list call."""
        mock_dashboard.organizations.getOrganizationNetworks.return_value = [
            {"id": "N_1", "name": "Network 1"},
            {"id": "N_2", "name": "Network 2"},
        ]

        result = client.call("networks", "list", organization_id="123")

        assert result["ok"] is True
        assert len(result["data"]) == 2
        assert result["meta"]["blast_radius"] == "low"

        mock_dashboard.organizations.getOrganizationNetworks.assert_called_once_with("123")

    def test_call_unsupported_action_returns_error(self, client):
        """Test that unsupported resource.action returns validation error."""
        result = client.call("devices", "update", serial="ABC123")

        assert result["ok"] is False
        assert "error" in result
        assert result["error"]["code"] == "validation_error"
        assert "Unsupported resource.action" in result["error"]["message"]
        assert "Phase 1 supports" in result["error"]["hint"]

    def test_call_blast_radius_classification(self, client, mock_dashboard):
        """Test that blast radius is correctly classified."""
        # Read actions should be "low"
        result = client.call("organizations", "list")
        assert result["meta"]["blast_radius"] == "low"

        result = client.call("organizations", "get", organization_id="123")
        assert result["meta"]["blast_radius"] == "low"

        # Non-read actions would be "medium" (not implemented in Phase 1)
        # This will be tested fully in Phase 2

    def test_call_timing_metadata(self, client, mock_dashboard):
        """Test that duration_ms is captured."""
        # Add a small delay to the mock to ensure non-zero duration
        def delayed_response():
            time.sleep(0.01)  # 10ms delay
            return [{"id": "123", "name": "Org"}]

        mock_dashboard.organizations.getOrganizations.side_effect = delayed_response

        result = client.call("organizations", "list")

        assert result["ok"] is True
        assert "duration_ms" in result["meta"]
        assert result["meta"]["duration_ms"] >= 10  # At least 10ms


class TestMerakiClientErrorHandling:
    """Test error handling and envelope format for various error conditions."""

    @pytest.fixture
    def client(self):
        """Create a client with mocked dashboard for error testing."""
        with patch("terminai_meraki.client.meraki.DashboardAPI"):
            client = MerakiClient.from_token("test_key")
        return client

    def _make_api_error(self, message: str, status: int, retry_after=None):
        """Helper to create a mock APIError with status code."""
        # Create a dynamic class that mimics the SDK's APIError
        class MockAPIError(Exception):
            def __init__(self, msg, status_code, retry_after_val=None):
                super().__init__(msg)
                self.status = status_code
                self.status_code = status_code
                if retry_after_val:
                    self.retry_after = retry_after_val

        MockAPIError.__name__ = "APIError"
        return MockAPIError(message, status, retry_after)

    def test_auth_error_401(self, client):
        """Test that 401 status is mapped to AuthError."""
        mock_error = self._make_api_error("Unauthorized", 401)

        client._dashboard.organizations.getOrganizations.side_effect = mock_error

        result = client.call("organizations", "list")

        assert result["ok"] is False
        assert result["error"]["code"] == "auth_error"
        assert "Authentication failed" in result["error"]["message"]
        assert "Rotate your key in the Vault" in result["error"]["hint"]

    def test_auth_error_403(self, client):
        """Test that 403 status is mapped to AuthError."""
        mock_error = self._make_api_error("Forbidden", 403)

        client._dashboard.organizations.getOrganizations.side_effect = mock_error

        result = client.call("organizations", "list")

        assert result["ok"] is False
        assert result["error"]["code"] == "auth_error"
        assert "Authentication failed" in result["error"]["message"]

    def test_not_found_error_404(self, client):
        """Test that 404 status is mapped to NotFoundError."""
        mock_error = self._make_api_error("Not Found", 404)

        client._dashboard.organizations.getOrganization.side_effect = mock_error

        result = client.call("organizations", "get", organization_id="invalid")

        assert result["ok"] is False
        assert result["error"]["code"] == "not_found_error"
        assert "Resource not found" in result["error"]["message"]
        assert "Verify the ID is correct" in result["error"]["hint"]

    def test_rate_limit_error_429(self, client):
        """Test that 429 status is mapped to RateLimitError."""
        mock_error = self._make_api_error("Too Many Requests", 429, retry_after=30)

        client._dashboard.organizations.getOrganizations.side_effect = mock_error

        result = client.call("organizations", "list")

        assert result["ok"] is False
        assert result["error"]["code"] == "rate_limit_error"
        assert "Rate limit exceeded" in result["error"]["message"]
        assert "automatic retry" in result["error"]["hint"]

    def test_server_error_500(self, client):
        """Test that 500+ status is mapped to NetworkError."""
        mock_error = self._make_api_error("Internal Server Error", 500)

        client._dashboard.organizations.getOrganizations.side_effect = mock_error

        result = client.call("organizations", "list")

        assert result["ok"] is False
        assert result["error"]["code"] == "network_error"
        assert "server error" in result["error"]["message"].lower()
        assert "status.meraki.com" in result["error"]["hint"]

    def test_connection_error(self, client):
        """Test that ConnectionError is mapped to NetworkError."""
        client._dashboard.organizations.getOrganizations.side_effect = ConnectionError(
            "Connection refused"
        )

        result = client.call("organizations", "list")

        assert result["ok"] is False
        assert result["error"]["code"] == "network_error"
        assert "Network error" in result["error"]["message"]
        assert "internet connection" in result["error"]["hint"]

    def test_timeout_error(self, client):
        """Test that TimeoutError is mapped to NetworkError."""
        client._dashboard.organizations.getOrganizations.side_effect = TimeoutError(
            "Request timeout"
        )

        result = client.call("organizations", "list")

        assert result["ok"] is False
        assert result["error"]["code"] == "network_error"
        assert "Network error" in result["error"]["message"]

    def test_validation_error_value_error(self, client):
        """Test that ValueError is mapped to ValidationError."""
        client._dashboard.organizations.getOrganization.side_effect = ValueError(
            "Invalid organization ID format"
        )

        result = client.call("organizations", "get", organization_id="bad_id")

        assert result["ok"] is False
        assert result["error"]["code"] == "validation_error"
        assert "Invalid parameters" in result["error"]["message"]

    def test_validation_error_key_error(self, client):
        """Test that KeyError is mapped to ValidationError."""
        client._dashboard.organizations.getOrganization.side_effect = KeyError(
            "organization_id"
        )

        result = client.call("organizations", "get")

        assert result["ok"] is False
        assert result["error"]["code"] == "validation_error"

    def test_error_envelope_includes_metadata(self, client):
        """Test that error envelopes include timing metadata."""
        mock_error = self._make_api_error("Test error", 500)

        client._dashboard.organizations.getOrganizations.side_effect = mock_error

        result = client.call("organizations", "list")

        assert result["ok"] is False
        assert "meta" in result
        assert "duration_ms" in result["meta"]
        assert result["meta"]["endpoint"]["resource"] == "organizations"
        assert result["meta"]["endpoint"]["action"] == "list"

    def test_unknown_error_fallback(self, client):
        """Test that unknown errors are handled gracefully."""
        client._dashboard.organizations.getOrganizations.side_effect = RuntimeError(
            "Unexpected error"
        )

        result = client.call("organizations", "list")

        assert result["ok"] is False
        assert "error" in result
        assert "message" in result["error"]
        # Should still get some kind of error envelope


class TestBlastRadiusClassifier:
    """Test the blast radius classifier."""

    @pytest.fixture
    def client(self):
        """Create a client for classifier testing."""
        with patch("terminai_meraki.client.meraki.DashboardAPI"):
            client = MerakiClient.from_token("test_key")
        return client

    def test_read_actions_are_low(self, client):
        """Test that read-like actions are classified as low."""
        assert client._classify_blast_radius("organizations", "list", {}) == "low"
        assert client._classify_blast_radius("organizations", "get", {}) == "low"
        assert client._classify_blast_radius("networks", "list", {}) == "low"
        assert client._classify_blast_radius("devices", "show", {}) == "low"
        assert client._classify_blast_radius("clients", "retrieve", {}) == "low"

    def test_write_actions_are_medium(self, client):
        """Test that non-read actions default to medium in Phase 1."""
        assert client._classify_blast_radius("organizations", "update", {}) == "medium"
        assert client._classify_blast_radius("networks", "create", {}) == "medium"
        assert client._classify_blast_radius("devices", "claim", {}) == "medium"
        assert client._classify_blast_radius("ssids", "update", {}) == "medium"


class TestIntegration:
    """Integration tests for MerakiClient (with mocked SDK)."""

    def test_full_success_flow(self):
        """Test complete flow: create client, make call, get success envelope."""
        with patch("terminai_meraki.client.meraki.DashboardAPI") as mock_api_class:
            mock_dashboard = MagicMock()
            mock_dashboard.organizations.getOrganizations.return_value = [
                {"id": "org1", "name": "Test Organization"}
            ]
            mock_api_class.return_value = mock_dashboard

            # Create client
            client = MerakiClient.from_token("test_api_key")

            # Make call
            result = client.call("organizations", "list")

            # Verify complete envelope structure
            assert result["ok"] is True
            assert isinstance(result["data"], list)
            assert len(result["data"]) == 1
            assert result["data"][0]["id"] == "org1"

            assert result["meta"]["endpoint"]["resource"] == "organizations"
            assert result["meta"]["endpoint"]["action"] == "list"
            assert result["meta"]["blast_radius"] == "low"
            assert isinstance(result["meta"]["duration_ms"], int)

    def test_full_error_flow(self):
        """Test complete flow: create client, make call, get error envelope."""
        with patch("terminai_meraki.client.meraki.DashboardAPI") as mock_api_class:
            mock_dashboard = MagicMock()

            # Simulate API error with proper class
            class MockAPIError(Exception):
                def __init__(self, msg):
                    super().__init__(msg)
                    self.status = 401
                    self.status_code = 401

            MockAPIError.__name__ = "APIError"
            api_error = MockAPIError("Invalid API key")

            mock_dashboard.organizations.getOrganizations.side_effect = api_error
            mock_api_class.return_value = mock_dashboard

            # Create client
            client = MerakiClient.from_token("bad_api_key")

            # Make call
            result = client.call("organizations", "list")

            # Verify complete error envelope structure
            assert result["ok"] is False
            assert "error" in result
            assert result["error"]["code"] == "auth_error"
            assert "Authentication failed" in result["error"]["message"]
            assert "hint" in result["error"]

            assert "meta" in result
            assert result["meta"]["endpoint"]["resource"] == "organizations"
            assert isinstance(result["meta"]["duration_ms"], int)
