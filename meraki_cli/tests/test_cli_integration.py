"""
Integration tests for CLI entry point.

Uses click.testing.CliRunner to invoke commands and validate outputs.
"""

import json
from unittest.mock import MagicMock, patch

import pytest
import yaml
from click.testing import CliRunner

from terminai_meraki.cli.main import cli
from terminai_meraki.client import MerakiClient


# Test fixtures
@pytest.fixture
def runner():
    """Create CliRunner instance."""
    return CliRunner()


@pytest.fixture
def mock_client():
    """Create mock MerakiClient."""
    with patch.object(MerakiClient, "from_token") as mock_from_token:
        mock_instance = MagicMock(spec=MerakiClient)
        mock_from_token.return_value = mock_instance
        yield mock_instance


@pytest.fixture
def sample_orgs_response():
    """Sample organizations list response."""
    return {
        "ok": True,
        "data": [
            {"id": "123", "name": "Test Org 1"},
            {"id": "456", "name": "Test Org 2"},
        ],
        "meta": {
            "endpoint": {"method": "GET", "path": "/organizations"},
            "blast_radius": "low"
        }
    }


@pytest.fixture
def sample_error_response():
    """Sample error response."""
    return {
        "ok": False,
        "error": {
            "code": "auth_error",
            "message": "Invalid API key",
            "hint": "Verify your API key is valid and has the required permissions."
        }
    }


# Test organizations-list command
class TestOrganizationsList:
    """Tests for organizations-list command."""

    def test_organizations_list_json_format(self, runner, mock_client, sample_orgs_response):
        """Test organizations-list with default JSON format."""
        mock_client.call.return_value = sample_orgs_response

        result = runner.invoke(cli, ["--api-key", "test-key", "organizations-list-organizations"])

        assert result.exit_code == 0
        output = json.loads(result.stdout)
        assert output["ok"] is True
        assert len(output["data"]) == 2
        assert output["data"][0]["id"] == "123"
        mock_client.call.assert_called_once_with("organizations", "list-organizations")

    def test_organizations_list_table_format(self, runner, mock_client, sample_orgs_response):
        """Test organizations-list with table format."""
        mock_client.call.return_value = sample_orgs_response

        result = runner.invoke(
            app,
            ["--api-key", "test-key", "--format", "table", "organizations-list-organizations"]
        )

        assert result.exit_code == 0
        # Table output should contain the org IDs and names
        assert "123" in result.stdout
        assert "456" in result.stdout
        assert "Test Org 1" in result.stdout
        assert "Test Org 2" in result.stdout

    def test_organizations_list_yaml_format(self, runner, mock_client, sample_orgs_response):
        """Test organizations-list with YAML format."""
        mock_client.call.return_value = sample_orgs_response

        result = runner.invoke(
            app,
            ["--api-key", "test-key", "--format", "yaml", "organizations-list-organizations"]
        )

        assert result.exit_code == 0
        output = yaml.safe_load(result.stdout)
        assert output["ok"] is True
        assert len(output["data"]) == 2

    def test_organizations_list_verbose_flag(self, runner, mock_client, sample_orgs_response):
        """Test organizations-list with verbose flag."""
        mock_client.call.return_value = sample_orgs_response

        result = runner.invoke(
            app,
            ["--api-key", "test-key", "--verbose", "organizations-list-organizations"]
        )

        assert result.exit_code == 0
        # Verbose output should include version and format
        assert "Version:" in result.stdout
        assert "Format:" in result.stdout


# Test error handling
class TestErrorHandling:
    """Tests for error handling."""

    def test_missing_api_key_error(self, runner):
        """Test error when no API key is provided."""
        with patch("terminai_meraki.cli.main.resolve_api_key") as mock_resolve:
            from terminai_meraki.errors import AuthError
            mock_resolve.side_effect = AuthError(
                "No API key found",
                "Set MERAKI_API_KEY env var or use --api-key flag."
            )

            result = runner.invoke(cli, ["organizations-list-organizations"])

            assert result.exit_code == 1
            # Error envelope should be in stdout (structured output)
            output = json.loads(result.stdout)
            assert output["ok"] is False
            assert "auth_error" in output["error"]["code"]

    def test_api_error_response(self, runner, mock_client, sample_error_response):
        """Test handling of API error response."""
        mock_client.call.return_value = sample_error_response

        result = runner.invoke(cli, ["--api-key", "test-key", "organizations-list-organizations"])

        assert result.exit_code == 1
        output = json.loads(result.stdout)
        assert output["ok"] is False
        assert output["error"]["code"] == "auth_error"

    def test_unexpected_exception(self, runner, mock_client):
        """Test handling of unexpected exception."""
        mock_client.call.side_effect = ValueError("Unexpected error")

        result = runner.invoke(cli, ["--api-key", "test-key", "organizations-list-organizations"])

        assert result.exit_code == 1
        output = json.loads(result.stdout)
        assert output["ok"] is False
        assert "validation_error" in output["error"]["code"]


# Test version command
class TestVersionCommand:
    """Tests for version command."""

    def test_version_command(self, runner):
        """Test version command output."""
        result = runner.invoke(cli, ["version"])

        assert result.exit_code == 0
        assert "terminai-meraki version" in result.stdout
        assert "0.1.0" in result.stdout


# Test global flags
class TestGlobalFlags:
    """Tests for global flags."""

    def test_help_flag(self, runner):
        """Test --help flag."""
        result = runner.invoke(cli, ["--help"])

        assert result.exit_code == 0
        assert "Meraki Dashboard API CLI" in result.stdout

    def test_format_flag_short(self, runner, mock_client, sample_orgs_response):
        """Test -f short flag for format."""
        mock_client.call.return_value = sample_orgs_response

        result = runner.invoke(
            app,
            ["--api-key", "test-key", "-f", "table", "organizations-list-organizations"]
        )

        assert result.exit_code == 0

    def test_verbose_flag_short(self, runner, mock_client, sample_orgs_response):
        """Test -v short flag for verbose."""
        mock_client.call.return_value = sample_orgs_response

        result = runner.invoke(
            app,
            ["--api-key", "test-key", "-v", "organizations-list-organizations"]
        )

        assert result.exit_code == 0
        assert "Version:" in result.stdout


# Test environment variable integration
class TestEnvironmentVariables:
    """Tests for environment variable integration."""

    def test_api_key_from_env(self, runner, mock_client, sample_orgs_response, monkeypatch):
        """Test API key from MERAKI_API_KEY environment variable."""
        monkeypatch.setenv("MERAKI_API_KEY", "env-key")
        mock_client.call.return_value = sample_orgs_response

        with patch("terminai_meraki.cli.main.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = "env-key"

            result = runner.invoke(cli, ["organizations-list-organizations"])

            assert result.exit_code == 0
            mock_resolve.assert_called_once()

    def test_explicit_api_key_overrides_env(self, runner, mock_client, sample_orgs_response, monkeypatch):
        """Test that --api-key flag overrides environment variable."""
        monkeypatch.setenv("MERAKI_API_KEY", "env-key")
        mock_client.call.return_value = sample_orgs_response

        with patch("terminai_meraki.cli.main.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = "explicit-key"

            result = runner.invoke(cli, ["--api-key", "explicit-key", "organizations-list-organizations"])

            assert result.exit_code == 0
            # Should be called with explicit token
            mock_resolve.assert_called_once_with(
                vault_entry=None,
                explicit_token="explicit-key"
            )


# Test vault entry integration
class TestVaultEntryIntegration:
    """Tests for vault entry integration."""

    def test_vault_entry_flag(self, runner, mock_client, sample_orgs_response):
        """Test --vault-entry flag."""
        mock_client.call.return_value = sample_orgs_response

        with patch("terminai_meraki.cli.main.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = "vault-key"

            result = runner.invoke(
                app,
                ["--vault-entry", "custom_entry", "organizations-list-organizations"]
            )

            assert result.exit_code == 0
            # Should be called with custom vault entry
            mock_resolve.assert_called_once_with(
                vault_entry="custom_entry",
                explicit_token=None
            )

    def test_default_vault_entry(self, runner, mock_client, sample_orgs_response):
        """Test default vault entry (meraki_default)."""
        mock_client.call.return_value = sample_orgs_response

        with patch("terminai_meraki.cli.main.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = "vault-key"

            result = runner.invoke(cli, ["organizations-list-organizations"])

            assert result.exit_code == 0
            # Should be called with default vault entry
            mock_resolve.assert_called_once_with(
                vault_entry="meraki_default",
                explicit_token=None
            )


# Test tools commands
class TestToolsCommands:
    """Tests for tools dump and list commands."""

    def test_tools_dump_to_stdout(self, runner):
        """Test tools dump outputs valid JSON to stdout."""
        result = runner.invoke(cli, ["tools", "dump"])

        assert result.exit_code == 0
        # Should be valid JSON
        catalog = json.loads(result.stdout)
        assert isinstance(catalog, list)
        # Should have substantial number of tools (~933 expected)
        assert len(catalog) > 500

        # Verify structure of first tool
        tool = catalog[0]
        assert "name" in tool
        assert "description" in tool
        assert "resource" in tool
        assert "action" in tool
        assert "endpoint" in tool
        assert "args" in tool
        assert "required" in tool
        assert "blast_radius" in tool
        assert "destructive" in tool
        assert "sdk_method" in tool

        # Verify endpoint structure
        assert "method" in tool["endpoint"]
        assert "path" in tool["endpoint"]

    def test_tools_dump_output_file(self, runner, tmp_path):
        """Test tools dump writes to file."""
        output_file = tmp_path / "meraki-tools.json"

        result = runner.invoke(cli, ["tools", "dump", "--output", str(output_file)])

        assert result.exit_code == 0
        # File should exist
        assert output_file.exists()
        # Should be valid JSON
        catalog = json.loads(output_file.read_text())
        assert isinstance(catalog, list)
        assert len(catalog) > 500

        # stderr should have success message (not stdout)
        assert "Wrote" in result.stderr or "Wrote" in result.stdout

    def test_tools_dump_blast_radius_classified(self, runner):
        """Test that all tools have blast_radius classified."""
        result = runner.invoke(cli, ["tools", "dump"])

        assert result.exit_code == 0
        catalog = json.loads(result.stdout)

        # All tools should have valid blast_radius
        valid_tiers = {"low", "medium", "high", "destructive"}
        for tool in catalog:
            assert tool["blast_radius"] in valid_tiers
            # destructive flag should be True only for "destructive" tier
            if tool["blast_radius"] == "destructive":
                assert tool["destructive"] is True
            else:
                assert tool["destructive"] is False

    def test_tools_dump_catalog_count(self, runner):
        """Test catalog count is approximately correct (~933 tools)."""
        result = runner.invoke(cli, ["tools", "dump"])

        assert result.exit_code == 0
        catalog = json.loads(result.stdout)

        # Allow some flexibility in count (SDK versions may vary slightly)
        assert 900 <= len(catalog) <= 1000, f"Expected ~933 tools, got {len(catalog)}"

    def test_tools_dump_get_methods_are_low(self, runner):
        """Test that all GET methods are classified as low blast radius."""
        result = runner.invoke(cli, ["tools", "dump"])

        assert result.exit_code == 0
        catalog = json.loads(result.stdout)

        # Filter GET methods
        get_methods = [t for t in catalog if t["endpoint"]["method"] == "GET"]
        assert len(get_methods) > 0

        # All GET methods should be "low"
        for tool in get_methods:
            assert tool["blast_radius"] == "low", \
                f"GET method {tool['name']} has blast_radius={tool['blast_radius']}, expected 'low'"

    def test_tools_list_produces_table(self, runner):
        """Test tools list produces human-readable table."""
        result = runner.invoke(cli, ["tools", "list"])

        assert result.exit_code == 0
        # Should contain table headers
        assert "Resource" in result.stdout
        assert "Tools" in result.stdout
        # Should contain some known resource modules
        assert "organizations" in result.stdout
        assert "networks" in result.stdout
        assert "devices" in result.stdout
        # Should contain blast radius summary
        assert "Blast Radius Summary" in result.stdout
        assert "Low (read-only)" in result.stdout
        assert "Medium (regular writes)" in result.stdout

    def test_tools_list_counts_by_resource(self, runner):
        """Test tools list shows correct counts by resource."""
        result = runner.invoke(cli, ["tools", "list"])

        assert result.exit_code == 0
        # Should show total count in title
        # Extract the total from "Meraki Dashboard API Tools (XXX total)"
        import re
        match = re.search(r'\((\d+) total\)', result.stdout)
        assert match is not None
        total = int(match.group(1))
        assert 900 <= total <= 1000

    def test_tools_list_groups_by_resource(self, runner):
        """Test tools list groups tools by resource module."""
        result = runner.invoke(cli, ["tools", "list"])

        assert result.exit_code == 0
        # Should list multiple resources with counts
        # Each resource should appear on its own line with a count
        lines = result.stdout.split('\n')
        resource_lines = [l for l in lines if 'organizations' in l.lower() or 'networks' in l.lower()]
        assert len(resource_lines) > 0
