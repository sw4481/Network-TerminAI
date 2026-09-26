"""Integration tests for CLI entry point."""

import json
import pytest
from pathlib import Path
from typer.testing import CliRunner
from terminai_pyats.cli.main import app


runner = CliRunner()


@pytest.fixture
def test_testbed(tmp_path):
    """Create a test testbed for CLI integration tests."""
    testbed_yaml = tmp_path / "testbed.yaml"
    env_file = tmp_path / ".env"

    testbed_yaml.write_text("""devices:
  CLI_TEST:
    os: iosxe
    credentials:
      default:
        username: "%ENV{CLI_TEST_USER}"
        password: "%ENV{CLI_TEST_PASS}"
    connections:
      cli:
        protocol: ssh
        ip: "%ENV{CLI_TEST_IP}"
""")

    env_file.write_text("""CLI_TEST_IP=10.0.0.1
CLI_TEST_USER=admin
CLI_TEST_PASS=secret
""")

    return str(testbed_yaml)


def test_cli_version():
    """Test version command."""
    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert "pyats-cli version" in result.stdout


def test_cli_list_devices(test_testbed):
    """Test list-devices command with JSON output."""
    result = runner.invoke(app, ["list-devices", "--testbed", test_testbed, "--format", "json"])

    assert result.exit_code == 0
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is True
    assert len(envelope["data"]) == 1
    assert envelope["data"][0]["name"] == "CLI_TEST"


def test_cli_search_devices(test_testbed):
    """Test search-devices command."""
    result = runner.invoke(app, ["search-devices", "CLI", "--testbed", test_testbed, "--format", "json"])

    assert result.exit_code == 0
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is True
    assert len(envelope["data"]) == 1


def test_cli_search_devices_no_match(test_testbed):
    """Test search-devices with no matches."""
    result = runner.invoke(app, ["search-devices", "NOMATCH", "--testbed", test_testbed, "--format", "json"])

    assert result.exit_code == 0
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is True
    assert len(envelope["data"]) == 0


def test_cli_missing_testbed():
    """Test that missing testbed produces error."""
    result = runner.invoke(app, ["list-devices", "--testbed", "/nonexistent/testbed.yaml"])

    assert result.exit_code == 1
    assert "not found" in result.stdout.lower() or "error" in result.stdout.lower()


def test_cli_tools_list():
    """Test tools list command."""
    result = runner.invoke(app, ["tools", "list", "--format", "json"])

    assert result.exit_code == 0
    catalog = json.loads(result.stdout)
    assert len(catalog) == 15  # Phase 1+2 has 15 verbs
    assert any(v["name"] == "list-devices" for v in catalog)
    assert any(v["name"] == "configure" for v in catalog)


def test_cli_tools_dump(tmp_path):
    """Test tools dump command."""
    output_path = tmp_path / "catalog.json"
    result = runner.invoke(app, ["tools", "dump", "--output", str(output_path)])

    assert result.exit_code == 0
    assert output_path.exists()

    catalog = json.loads(output_path.read_text())
    assert len(catalog) == 15
    # Should have multiple blast radius tiers
    tiers = set(v["blast_radius"] for v in catalog)
    assert "low" in tiers
    assert "high" in tiers


def test_cli_help():
    """Test that --help works."""
    result = runner.invoke(app, ["--help"])

    assert result.exit_code == 0
    assert "pyats-cli" in result.stdout.lower()
    assert "list-devices" in result.stdout


def test_cli_verb_help():
    """Test that verb-level --help works."""
    result = runner.invoke(app, ["run-show-command", "--help"])

    assert result.exit_code == 0
    assert "device" in result.stdout.lower()
    assert "command" in result.stdout.lower()
