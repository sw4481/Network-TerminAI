"""CLI entry point for terminai-pyats using Typer.

Static command registration for the 6 Phase 1 read verbs.
Phase 2 will add the remaining 9 verbs.
"""

import os
import sys
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console

from .. import __version__
from ..catalog import VERBS, get_verb_spec
from ..client import PyatsClient
from ..errors import to_envelope
from ..output import render_json, render_table, render_yaml


app = typer.Typer(
    name="pyats-cli",
    help="Cisco pyATS/Genie CLI - network device automation with typed envelopes",
    no_args_is_help=True,
)
console = Console()


def default_testbed_path() -> str:
    """Return the default testbed path (~/.ccie-terminal/pyats/testbed.yaml)."""
    return str(Path.home() / ".ccie-terminal" / "pyats" / "testbed.yaml")


def get_client(testbed: Optional[str] = None) -> PyatsClient:
    """Load and return a PyatsClient.

    Args:
        testbed: Path to testbed.yaml (uses default if None)

    Returns:
        PyatsClient instance

    Raises:
        typer.Exit: If testbed cannot be loaded
    """
    testbed_path = testbed or default_testbed_path()

    try:
        return PyatsClient.from_testbed(testbed_path)
    except Exception as exc:
        envelope = to_envelope(exc)
        console.print(render_table(envelope))
        raise typer.Exit(1)


def render_output(envelope: dict, format: str):
    """Render envelope and print to stdout.

    Args:
        envelope: Response envelope
        format: Output format (json, table, yaml)
    """
    if format == "json":
        output = render_json(envelope)
        print(output)
    elif format == "yaml":
        output = render_yaml(envelope)
        print(output)
    else:
        output = render_table(envelope)
        console.print(output)

    # Exit with 1 if envelope indicates failure
    if not envelope.get("ok", False):
        raise typer.Exit(1)


# === Phase 1+2: 15 verbs ===

@app.command()
def list_devices(
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """List all devices in the testbed."""
    client = get_client(testbed)
    envelope = client.call("list-devices")
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def search_devices(
    query: str = typer.Argument(..., help="Search pattern (case-insensitive)"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Search devices by name pattern."""
    client = get_client(testbed)
    envelope = client.call("search-devices", query=query)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def run_show_command(
    device: str = typer.Option(..., help="Device name from testbed"),
    command: str = typer.Option(..., help="Show command to execute"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Run a show command on a device (Genie-parsed when available)."""
    client = get_client(testbed)
    envelope = client.call("run-show-command", device=device, command=command)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def learn(
    device: str = typer.Option(..., help="Device name from testbed"),
    feature: str = typer.Option(..., help="Genie feature (e.g., ospf, bgp, interface)"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Learn structured feature state using Genie."""
    client = get_client(testbed)
    envelope = client.call("learn", device=device, feature=feature)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def device_health(
    device: str = typer.Option(..., help="Device name from testbed"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Get device health snapshot (platform, interfaces, routing summary)."""
    client = get_client(testbed)
    envelope = client.call("device-health", device=device)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def get_neighbors(
    device: str = typer.Option(..., help="Device name from testbed"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Get CDP and LLDP neighbors for a device."""
    client = get_client(testbed)
    envelope = client.call("get-neighbors", device=device)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def run_show_command_multi(
    devices: str = typer.Option(..., help="Comma-separated device names"),
    command: str = typer.Option(..., help="Show command to execute"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Run a show command on multiple devices in parallel."""
    client = get_client(testbed)
    device_list = [d.strip() for d in devices.split(",")]
    envelope = client.call("run-show-command-multi", devices=device_list, command=command)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def find_interface_by_ip(
    device: str = typer.Option(..., help="Device name from testbed"),
    ip: str = typer.Option(..., help="IP address to search for"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Find which interface has a given IP address."""
    client = get_client(testbed)
    envelope = client.call("find-interface-by-ip", device=device, ip=ip)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def ping(
    device: str = typer.Option(..., help="Device name from testbed"),
    destination: str = typer.Option(..., help="Destination IP or hostname"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Ping a destination from a device."""
    client = get_client(testbed)
    envelope = client.call("ping", device=device, destination=destination)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def run_linux_command(
    device: str = typer.Option(..., help="Device name from testbed"),
    command: str = typer.Option(..., help="Linux command to execute"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Run a Linux command on a host/server device (medium blast radius)."""
    client = get_client(testbed)
    envelope = client.call("run-linux-command", device=device, command=command)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def configure(
    device: str = typer.Option(..., help="Device name from testbed"),
    config: str = typer.Option(..., help="Configuration commands (one per line)"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Apply configuration commands to a device (high blast radius)."""
    client = get_client(testbed)
    envelope = client.call("configure", device=device, config=config)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def configure_multi(
    devices: str = typer.Option(..., help="Comma-separated device names"),
    config: str = typer.Option(..., help="Configuration commands (one per line)"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Apply configuration to multiple devices in parallel (high blast radius)."""
    client = get_client(testbed)
    device_list = [d.strip() for d in devices.split(",")]
    envelope = client.call("configure-multi", devices=device_list, config=config)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def configure_with_diff(
    device: str = typer.Option(..., help="Device name from testbed"),
    config: str = typer.Option(..., help="Configuration commands (one per line)"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Apply configuration and return before/after diff (snapshots saved for rollback)."""
    client = get_client(testbed)
    envelope = client.call("configure-with-diff", device=device, config=config)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def rollback_config(
    device: str = typer.Option(..., help="Device name from testbed"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Rollback to the last configure-with-diff snapshot (high blast radius)."""
    client = get_client(testbed)
    envelope = client.call("rollback-config", device=device)
    client.disconnect_all()
    render_output(envelope, format)


@app.command()
def run_pyats_code(
    code: str = typer.Option(..., help="Python code to execute (testbed pre-bound)"),
    testbed: Optional[str] = typer.Option(None, help="Path to testbed.yaml"),
    format: str = typer.Option("json", help="Output format (json, table, yaml)"),
):
    """Execute raw pyATS Python code (computed blast radius based on code content)."""
    client = get_client(testbed)
    envelope = client.call("run-pyats-code", code=code)
    client.disconnect_all()
    render_output(envelope, format)


# === Tools subcommand ===

tools_app = typer.Typer(help="Catalog tools (list, dump)")
app.add_typer(tools_app, name="tools")


@tools_app.command("list")
def tools_list(
    format: str = typer.Option("table", help="Output format (json, table, yaml)"),
):
    """List all available verbs in the catalog."""
    from ..catalog import VERBS

    if format == "json":
        import json
        catalog = [v.to_dict() for v in VERBS]
        print(json.dumps(catalog, indent=2))
    elif format == "yaml":
        import yaml
        catalog = [v.to_dict() for v in VERBS]
        print(yaml.dump(catalog, default_flow_style=False))
    else:
        from rich.table import Table

        table = Table(title=f"pyATS CLI Verbs ({len(VERBS)} total)")
        table.add_column("Verb", style="cyan", no_wrap=True)
        table.add_column("Blast", style="yellow")
        table.add_column("Description", style="white")

        for verb in VERBS:
            blast_color = {
                "low": "green",
                "medium": "yellow",
                "high": "orange1",
                "destructive": "red"
            }.get(verb.blast_radius, "white")

            table.add_row(
                verb.name,
                f"[{blast_color}]{verb.blast_radius}[/{blast_color}]",
                verb.description
            )

        console.print(table)


@tools_app.command("dump")
def tools_dump(
    output: str = typer.Option("tools.json", help="Output file path"),
):
    """Dump catalog to JSON (for bundled agent tools.json)."""
    import json
    from ..catalog import VERBS

    catalog = [v.to_dict() for v in VERBS]
    with open(output, "w") as f:
        json.dump(catalog, f, indent=2)

    console.print(f"[green]✓[/green] Wrote {len(catalog)} verbs to {output}")


@app.command()
def version():
    """Show version information."""
    console.print(f"pyats-cli version {__version__}")


if __name__ == "__main__":
    app()
