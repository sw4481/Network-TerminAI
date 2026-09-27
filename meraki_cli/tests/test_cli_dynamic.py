"""
Integration tests for dynamic CLI command registration.

Tests that all 933 commands are registered and work correctly with
parameter handling, help text, and error cases.
"""

import json
import pytest
from click.testing import CliRunner

from terminai_meraki.cli.main import cli, get_catalog, get_tool_spec
from terminai_meraki.catalog import generate_catalog


class TestDynamicCommandRegistration:
    """Test dynamic command registration from catalog."""

    def test_catalog_loads_successfully(self):
        """Test that catalog can be loaded and has expected size."""
        catalog = get_catalog()
        assert catalog is not None
        assert len(catalog) == 933, f"Expected 933 tools, got {len(catalog)}"

    def test_all_commands_registered(self):
        """Test that all catalog tools are accessible as commands."""
        catalog = get_catalog()

        # Sample a few commands to verify they're accessible
        sample_commands = [
            "organizations-list-organizations",
            "networks-list-clients",
            "devices-get-lldp-cdp",
            "wireless-get-network-wireless-ssid",  # Fixed: actual wireless command
        ]

        for cmd_name in sample_commands:
            tool_spec = get_tool_spec(cmd_name)
            assert tool_spec is not None, f"Command {cmd_name} not found in catalog"

    def test_command_help_text(self):
        """Test that commands have proper help text."""
        runner = CliRunner()

        # Test a simple command
        result = runner.invoke(cli, ["organizations-list-organizations", "--help"])
        assert result.exit_code == 0
        assert "List the organizations" in result.output
        assert "Endpoint: GET /organizations" in result.output
        assert "Blast radius: low" in result.output

    def test_command_with_required_params(self):
        """Test that commands with required params show them in help."""
        runner = CliRunner()

        result = runner.invoke(cli, ["networks-list-clients", "--help"])
        assert result.exit_code == 0
        # Parameters should be shown in kebab-case
        assert "Required: network-id" in result.output
        assert "[required]" in result.output

    def test_destructive_command_warning(self):
        """Test that destructive commands show warning in help."""
        catalog = get_catalog()

        # Find a destructive command
        destructive = [t for t in catalog if t.destructive]
        if destructive:
            cmd_name = f"{destructive[0].resource}-{destructive[0].action}"
            runner = CliRunner()
            result = runner.invoke(cli, [cmd_name, "--help"])
            assert result.exit_code == 0
            assert "DESTRUCTIVE" in result.output

    def test_list_commands_shows_all(self):
        """Test that list-commands shows all 933 commands."""
        runner = CliRunner()
        # Global flags must come before subcommand
        result = runner.invoke(cli, ["--format", "json", "list-commands"])
        assert result.exit_code == 0

        data = json.loads(result.output)
        assert len(data) == 933

    def test_list_commands_table_format(self):
        """Test that list-commands works with table format."""
        runner = CliRunner()
        # Global flags must come before subcommand
        result = runner.invoke(cli, ["--format", "table", "list-commands"])
        assert result.exit_code == 0
        assert "Meraki API Commands" in result.output
        assert "933 total" in result.output

    def test_parameter_conversion_kebab_to_snake(self):
        """Test that parameter names are converted from kebab-case to snake_case."""
        # This is implicitly tested by the CLI working, but we can verify
        # the conversion functions
        from terminai_meraki.cli.main import kebab_to_snake, snake_to_kebab

        assert kebab_to_snake("network-id") == "network_id"
        assert kebab_to_snake("organization-id") == "organization_id"
        assert snake_to_kebab("network_id") == "network-id"
        assert snake_to_kebab("organization_id") == "organization-id"

    def test_unknown_command_error(self):
        """Test that unknown commands produce helpful error."""
        runner = CliRunner()
        result = runner.invoke(cli, ["nonexistent-command"])
        assert result.exit_code == 2  # Click's error code
        assert "No such command" in result.output

    def test_resource_filtering(self):
        """Test filtering commands by resource."""
        catalog = get_catalog()

        # Count organizations commands
        org_commands = [t for t in catalog if t.resource == "organizations"]
        assert len(org_commands) > 0

        # Count networks commands
        net_commands = [t for t in catalog if t.resource == "networks"]
        assert len(net_commands) > 0

    def test_blast_radius_classification(self):
        """Test that all commands have blast_radius assigned."""
        catalog = get_catalog()

        valid_tiers = ["low", "medium", "high", "destructive"]
        for tool in catalog:
            assert tool.blast_radius in valid_tiers, \
                f"Invalid blast_radius '{tool.blast_radius}' for {tool.name}"

    def test_get_commands_are_low_blast_radius(self):
        """Test that all GET commands have low blast radius."""
        catalog = get_catalog()

        get_commands = [t for t in catalog if t.endpoint["method"] == "GET"]
        for tool in get_commands:
            assert tool.blast_radius == "low", \
                f"GET command {tool.name} should have low blast radius, got {tool.blast_radius}"

    def test_delete_org_network_are_destructive(self):
        """Test that DELETE on orgs/networks are destructive."""
        catalog = get_catalog()

        # Find DELETE commands on top-level resources
        for tool in catalog:
            if tool.endpoint["method"] == "DELETE":
                path = tool.endpoint["path"]
                segments = [s for s in path.split('/') if s]

                # Top-level DELETE (only 2 segments like /organizations/{id})
                if segments[0] in ["organizations", "networks"] and len(segments) == 2:
                    assert tool.blast_radius == "destructive", \
                        f"DELETE on {path} should be destructive, got {tool.blast_radius}"

    def test_command_has_proper_params(self):
        """Test that a sample command has proper parameter definitions."""
        tool_spec = get_tool_spec("networks-list-clients")
        assert tool_spec is not None

        # Check required params
        assert "networkId" in tool_spec.required

        # Check args schema
        assert "networkId" in tool_spec.args
        assert tool_spec.args["networkId"]["type"] == "string"

    def test_params_json_flag_available(self):
        """Test that --params global flag is available."""
        runner = CliRunner()
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "--params" in result.output

    def test_format_flag_available(self):
        """Test that --format global flag is available."""
        runner = CliRunner()
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "--format" in result.output
        assert "json|table|yaml" in result.output

    def test_verbose_flag_available(self):
        """Test that --verbose global flag is available."""
        runner = CliRunner()
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "--verbose" in result.output or "-v" in result.output


class TestCatalogConsistency:
    """Test catalog data consistency and quality."""

    def test_all_tools_have_descriptions(self):
        """Test that all tools have non-empty descriptions."""
        catalog = get_catalog()

        for tool in catalog:
            assert tool.description, f"Tool {tool.name} has empty description"
            assert len(tool.description) > 5, f"Tool {tool.name} has too short description"

    def test_all_tools_have_endpoints(self):
        """Test that all tools have valid endpoint definitions."""
        catalog = get_catalog()

        valid_methods = ["GET", "POST", "PUT", "DELETE"]

        for tool in catalog:
            assert "method" in tool.endpoint
            assert "path" in tool.endpoint
            assert tool.endpoint["method"] in valid_methods
            assert tool.endpoint["path"].startswith("/")

    def test_no_duplicate_commands(self):
        """Test that there are no duplicate command names."""
        catalog = get_catalog()

        command_names = [f"{t.resource}-{t.action}" for t in catalog]
        duplicates = [name for name in command_names if command_names.count(name) > 1]

        assert len(duplicates) == 0, f"Found duplicate commands: {set(duplicates)}"

    def test_sdk_method_names_valid(self):
        """Test that all tools have valid SDK method names."""
        catalog = get_catalog()

        for tool in catalog:
            assert tool.sdk_method, f"Tool {tool.name} has empty sdk_method"
            # SDK methods should be camelCase
            assert tool.sdk_method[0].islower(), \
                f"SDK method {tool.sdk_method} should start with lowercase"


class TestPerformance:
    """Test performance characteristics of dynamic CLI."""

    def test_catalog_caching(self):
        """Test that catalog is cached and not regenerated."""
        # First call
        catalog1 = get_catalog()

        # Second call should return same object (cached)
        catalog2 = get_catalog()

        assert catalog1 is catalog2, "Catalog should be cached"

    def test_help_is_fast(self):
        """Test that --help is reasonably fast even with 933 commands."""
        import time

        runner = CliRunner()
        start = time.time()
        result = runner.invoke(cli, ["--help"])
        duration = time.time() - start

        assert result.exit_code == 0
        assert duration < 5.0, f"--help took {duration}s, should be < 5s"

    def test_command_help_is_fast(self):
        """Test that individual command --help is fast."""
        import time

        runner = CliRunner()
        start = time.time()
        result = runner.invoke(cli, ["organizations-list-organizations", "--help"])
        duration = time.time() - start

        assert result.exit_code == 0
        assert duration < 3.0, f"Command --help took {duration}s, should be < 3s"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
