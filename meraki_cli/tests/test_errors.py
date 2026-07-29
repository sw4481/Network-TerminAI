"""Unit tests for error envelope structure."""

import pytest
from terminai_meraki.errors import (
    AuthError,
    CCIEError,
    NetworkError,
    NotFoundError,
    RateLimitError,
    ValidationError,
    to_envelope,
)


class TestCCIEError:
    """Test the base CCIEError exception class."""

    def test_init_with_message_only(self):
        """Test CCIEError initialization with just a message."""
        exc = CCIEError("Something went wrong")
        assert exc.message == "Something went wrong"
        assert exc.hint == ""
        assert str(exc) == "Something went wrong"

    def test_init_with_message_and_hint(self):
        """Test CCIEError initialization with message and hint."""
        exc = CCIEError("Something went wrong", "Try this fix")
        assert exc.message == "Something went wrong"
        assert exc.hint == "Try this fix"
        assert str(exc) == "Something went wrong"

    def test_is_exception(self):
        """Test that CCIEError is a proper Exception."""
        exc = CCIEError("test")
        assert isinstance(exc, Exception)


class TestAuthError:
    """Test AuthError exception class."""

    def test_default_hint(self):
        """Test AuthError provides default helpful hint."""
        exc = AuthError("Invalid API key")
        assert exc.message == "Invalid API key"
        assert "Vault" in exc.hint
        assert "MERAKI_API_KEY" in exc.hint
        assert "permissions" in exc.hint.lower()

    def test_custom_hint(self):
        """Test AuthError accepts custom hint."""
        exc = AuthError("Invalid API key", hint="Custom hint here")
        assert exc.message == "Invalid API key"
        assert exc.hint == "Custom hint here"

    def test_is_ccie_error(self):
        """Test AuthError is a CCIEError."""
        exc = AuthError("test")
        assert isinstance(exc, CCIEError)


class TestNotFoundError:
    """Test NotFoundError exception class."""

    def test_default_hint(self):
        """Test NotFoundError provides default helpful hint."""
        exc = NotFoundError("Network not found")
        assert exc.message == "Network not found"
        assert "not found" in exc.hint.lower()
        assert "list commands" in exc.hint.lower()

    def test_with_resource_type(self):
        """Test NotFoundError with specific resource type."""
        exc = NotFoundError("N_123 not found", resource_type="network")
        assert exc.message == "N_123 not found"
        assert "network" in exc.hint.lower()

    def test_custom_hint(self):
        """Test NotFoundError accepts custom hint."""
        exc = NotFoundError("Not found", hint="Use meraki-cli networks list")
        assert exc.hint == "Use meraki-cli networks list"


class TestRateLimitError:
    """Test RateLimitError exception class."""

    def test_default_hint(self):
        """Test RateLimitError provides default helpful hint."""
        exc = RateLimitError("Rate limit exceeded")
        assert exc.message == "Rate limit exceeded"
        assert "rate limit" in exc.hint.lower()
        assert "retry" in exc.hint.lower()
        assert "exponential backoff" in exc.hint.lower()

    def test_with_retry_after(self):
        """Test RateLimitError with retry_after value."""
        exc = RateLimitError("Rate limit exceeded", retry_after=60)
        assert exc.message == "Rate limit exceeded"
        assert "60 seconds" in exc.hint

    def test_custom_hint(self):
        """Test RateLimitError accepts custom hint."""
        exc = RateLimitError("Too many requests", hint="Wait 5 minutes")
        assert exc.hint == "Wait 5 minutes"


class TestNetworkError:
    """Test NetworkError exception class."""

    def test_default_hint(self):
        """Test NetworkError provides default helpful hint."""
        exc = NetworkError("Connection timeout")
        assert exc.message == "Connection timeout"
        assert "connection" in exc.hint.lower()
        assert "dashboard.meraki.com" in exc.hint
        assert "proxy" in exc.hint.lower()

    def test_custom_hint(self):
        """Test NetworkError accepts custom hint."""
        exc = NetworkError("Timeout", hint="Check firewall settings")
        assert exc.hint == "Check firewall settings"


class TestValidationError:
    """Test ValidationError exception class."""

    def test_default_hint(self):
        """Test ValidationError provides default helpful hint."""
        exc = ValidationError("Invalid network_id format")
        assert exc.message == "Invalid network_id format"
        assert "validation" in exc.hint.lower()
        assert "parameters" in exc.hint.lower()

    def test_with_param(self):
        """Test ValidationError with specific parameter."""
        exc = ValidationError("Invalid format", param="network_id")
        assert exc.message == "Invalid format"
        assert "network_id" in exc.hint

    def test_custom_hint(self):
        """Test ValidationError accepts custom hint."""
        exc = ValidationError("Bad input", hint="Must be a valid UUID")
        assert exc.hint == "Must be a valid UUID"


class TestToEnvelope:
    """Test the to_envelope() converter function."""

    def test_auth_error_conversion(self):
        """Test converting AuthError to envelope."""
        exc = AuthError("Invalid API key")
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "auth_error"
        assert envelope["error"]["message"] == "Invalid API key"
        assert "Vault" in envelope["error"]["hint"]

    def test_not_found_error_conversion(self):
        """Test converting NotFoundError to envelope."""
        exc = NotFoundError("Network N_123 not found", resource_type="network")
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "not_found_error"
        assert envelope["error"]["message"] == "Network N_123 not found"
        assert "network" in envelope["error"]["hint"].lower()

    def test_rate_limit_error_conversion(self):
        """Test converting RateLimitError to envelope."""
        exc = RateLimitError("Too many requests", retry_after=30)
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "rate_limit_error"
        assert envelope["error"]["message"] == "Too many requests"
        assert "30 seconds" in envelope["error"]["hint"]

    def test_network_error_conversion(self):
        """Test converting NetworkError to envelope."""
        exc = NetworkError("Connection timeout")
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "network_error"
        assert envelope["error"]["message"] == "Connection timeout"

    def test_validation_error_conversion(self):
        """Test converting ValidationError to envelope."""
        exc = ValidationError("Missing required field", param="org_id")
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "validation_error"
        assert envelope["error"]["message"] == "Missing required field"
        assert "org_id" in envelope["error"]["hint"]

    def test_generic_value_error_conversion(self):
        """Test converting generic ValueError to envelope."""
        exc = ValueError("Invalid value provided")
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "validation_error"
        assert "Invalid value provided" in envelope["error"]["message"]
        assert len(envelope["error"]["hint"]) > 0

    def test_generic_key_error_conversion(self):
        """Test converting KeyError to envelope."""
        exc = KeyError("network_id")
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "validation_error"
        assert "network_id" in envelope["error"]["hint"]

    def test_connection_error_conversion(self):
        """Test converting ConnectionError to envelope."""
        exc = ConnectionError("Failed to connect")
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "network_error"
        assert "connection" in envelope["error"]["hint"].lower()

    def test_timeout_error_conversion(self):
        """Test converting TimeoutError to envelope."""
        exc = TimeoutError("Request timed out")
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "network_error"
        assert "timed out" in envelope["error"]["hint"].lower() or "slow" in envelope["error"]["hint"].lower()

    def test_unknown_error_conversion(self):
        """Test converting unknown exception type to envelope."""
        exc = RuntimeError("Something unexpected happened")
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "unknown_error"
        assert "Something unexpected happened" in envelope["error"]["message"]

    def test_sdk_api_error_401_conversion(self):
        """Test converting Meraki SDK 401 error to envelope."""
        # Create a mock API error with status code
        class MockAPIError(Exception):
            def __init__(self, message, status):
                self.status = status
                super().__init__(message)

        exc = MockAPIError("Unauthorized", 401)
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "auth_error"
        assert "permissions" in envelope["error"]["hint"].lower()

    def test_sdk_api_error_404_conversion(self):
        """Test converting Meraki SDK 404 error to envelope."""
        class MockAPIError(Exception):
            def __init__(self, message, status):
                self.status = status
                super().__init__(message)

        exc = MockAPIError("Not found", 404)
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "not_found_error"
        assert "not found" in envelope["error"]["hint"].lower()

    def test_sdk_api_error_429_conversion(self):
        """Test converting Meraki SDK 429 error to envelope."""
        class MockAPIError(Exception):
            def __init__(self, message, status):
                self.status_code = status  # Test alternate attribute name
                super().__init__(message)

        exc = MockAPIError("Rate limit exceeded", 429)
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "rate_limit_error"
        assert "rate limit" in envelope["error"]["hint"].lower()

    def test_sdk_api_error_500_conversion(self):
        """Test converting Meraki SDK 500 error to envelope."""
        class MockAPIError(Exception):
            def __init__(self, message, status):
                self.status = status
                super().__init__(message)

        exc = MockAPIError("Internal server error", 500)
        envelope = to_envelope(exc)

        assert envelope["ok"] is False
        assert envelope["error"]["code"] == "network_error"
        assert "experiencing issues" in envelope["error"]["hint"].lower()


class TestHintActionability:
    """Test that error hints are actionable and helpful."""

    def test_auth_error_hint_is_actionable(self):
        """Test AuthError hint provides clear next steps."""
        exc = AuthError("Invalid API key")
        assert "Vault" in exc.hint or "MERAKI_API_KEY" in exc.hint
        # Should mention where to fix the problem
        assert "Settings" in exc.hint or "environment variable" in exc.hint

    def test_not_found_error_hint_is_actionable(self):
        """Test NotFoundError hint provides clear next steps."""
        exc = NotFoundError("Network not found", resource_type="network")
        # Should tell user how to find valid IDs
        assert "list" in exc.hint.lower()

    def test_rate_limit_error_hint_is_actionable(self):
        """Test RateLimitError hint provides clear next steps."""
        exc = RateLimitError("Too many requests")
        # Should explain automatic retry behavior
        assert "retry" in exc.hint.lower() or "backoff" in exc.hint.lower()

    def test_network_error_hint_is_actionable(self):
        """Test NetworkError hint provides clear next steps."""
        exc = NetworkError("Connection failed")
        # Should mention connectivity troubleshooting
        assert "connection" in exc.hint.lower() or "dashboard.meraki.com" in exc.hint

    def test_validation_error_hint_is_actionable(self):
        """Test ValidationError hint provides clear next steps."""
        exc = ValidationError("Invalid input", param="network_id")
        # Should mention parameter requirements
        assert "parameters" in exc.hint.lower() or "network_id" in exc.hint
