"""Tests for natural language to command translation."""
import os
import pytest
from unittest.mock import patch
from ccie_sidecar.agent import nl_to_command


def test_nl_to_command_requires_api_key():
    """Test that nl_to_command raises error when API key is not set."""
    # Ensure API key is not set
    with patch.dict(os.environ, {}, clear=True):
        with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
            nl_to_command("list files", shell="bash", cwd="/tmp")


def test_nl_to_command_with_mock_key():
    """Test nl_to_command with a mock API key (will fail at API call)."""
    # Use patch.dict to ensure cleanup
    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "mock-key"}):
        # This will fail at the API call level, but tests the function structure
        with pytest.raises(Exception):  # Will be an Anthropic auth error
            nl_to_command("list files", shell="bash", cwd="/tmp")


@pytest.mark.skipif(
    "ANTHROPIC_API_KEY" not in os.environ,
    reason="Requires ANTHROPIC_API_KEY environment variable"
)
def test_nl_to_command_integration():
    """Integration test with real API key (skipped if key not available)."""
    command = nl_to_command("list files", shell="bash", cwd="/tmp")

    # Basic validation - should be a non-empty string
    assert isinstance(command, str)
    assert len(command) > 0

    # Should not contain explanation text or markdown
    assert not command.startswith("#")
    assert not command.startswith("```")

    # Should likely be an ls command
    assert "ls" in command.lower()
