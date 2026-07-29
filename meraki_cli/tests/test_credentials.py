"""
Unit tests for credentials resolver.

Tests credential resolution priority:
1. Explicit token (highest priority)
2. Vault entry (if sidecar context available)
3. Environment variable
4. Error when all sources absent
"""

import os
import pytest
from unittest.mock import patch

from terminai_meraki.credentials import resolve_api_key, AuthError


class TestResolveApiKey:
    """Test suite for resolve_api_key function."""

    def test_explicit_token_highest_priority(self, monkeypatch):
        """Explicit token should be used when provided, ignoring other sources."""
        explicit = "explicit-token-123"
        monkeypatch.setenv("MERAKI_API_KEY", "env-token-456")
        monkeypatch.setenv("CCIE_SIDECAR_CONTEXT", "1")

        result = resolve_api_key(
            vault_entry="test_vault",
            explicit_token=explicit
        )

        assert result == explicit

    def test_env_var_fallback(self, monkeypatch):
        """Environment variable should be used when no explicit token."""
        env_token = "env-token-789"
        monkeypatch.setenv("MERAKI_API_KEY", env_token)

        result = resolve_api_key()

        assert result == env_token

    def test_custom_env_var(self, monkeypatch):
        """Should support custom environment variable name."""
        custom_token = "custom-token-abc"
        monkeypatch.setenv("CUSTOM_MERAKI_KEY", custom_token)

        result = resolve_api_key(env_var="CUSTOM_MERAKI_KEY")

        assert result == custom_token

    def test_error_when_all_sources_absent(self, monkeypatch):
        """Should raise AuthError with helpful hint when no sources available."""
        # Ensure no env var is set
        monkeypatch.delenv("MERAKI_API_KEY", raising=False)
        monkeypatch.delenv("CCIE_SIDECAR_CONTEXT", raising=False)

        with pytest.raises(AuthError) as exc_info:
            resolve_api_key()

        error_message = str(exc_info.value)
        assert "MERAKI_API_KEY" in error_message
        assert "--api-key" in error_message
        assert "vault entry" in error_message

    def test_sidecar_context_detection_present(self, monkeypatch):
        """Should detect sidecar context when env var is set."""
        monkeypatch.setenv("CCIE_SIDECAR_CONTEXT", "1")

        from terminai_meraki.credentials import _is_sidecar_context
        assert _is_sidecar_context() is True

    def test_sidecar_context_detection_absent(self, monkeypatch):
        """Should detect absence of sidecar context."""
        monkeypatch.delenv("CCIE_SIDECAR_CONTEXT", raising=False)

        from terminai_meraki.credentials import _is_sidecar_context
        assert _is_sidecar_context() is False

    def test_vault_resolution_stub_returns_none(self, monkeypatch):
        """Vault resolution stub should return None in Phase 1."""
        monkeypatch.setenv("CCIE_SIDECAR_CONTEXT", "1")

        from terminai_meraki.credentials import _resolve_from_vault
        result = _resolve_from_vault("test_vault")

        assert result is None

    def test_vault_fallthrough_to_env(self, monkeypatch):
        """When vault returns None, should fall through to env var."""
        env_token = "env-fallback-token"
        monkeypatch.setenv("CCIE_SIDECAR_CONTEXT", "1")
        monkeypatch.setenv("MERAKI_API_KEY", env_token)

        # Even with vault_entry specified, since vault stub returns None,
        # it should fall through to env var
        result = resolve_api_key(vault_entry="test_vault")

        assert result == env_token

    def test_priority_explicit_over_env(self, monkeypatch):
        """Explicit token should override environment variable."""
        explicit = "explicit-wins"
        env_token = "env-loses"
        monkeypatch.setenv("MERAKI_API_KEY", env_token)

        result = resolve_api_key(explicit_token=explicit)

        assert result == explicit
        # Verify env var was not used
        assert result != env_token


class TestAuthError:
    """Test suite for AuthError exception."""

    def test_auth_error_is_exception(self):
        """AuthError should be an Exception subclass."""
        error = AuthError("test error")
        assert isinstance(error, Exception)

    def test_auth_error_message(self):
        """AuthError should preserve error message."""
        message = "Authentication failed"
        error = AuthError(message)
        assert str(error) == message
