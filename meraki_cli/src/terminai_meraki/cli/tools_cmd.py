"""
Tool catalog commands for Meraki CLI.

Provides commands to dump and list the auto-generated tool catalog with
blast-radius classifications for AI agent consumption.
"""

import json
import sys
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

from ..blast_radius import classify
from ..catalog import generate_catalog


app = typer.Typer(name="tools", help="Manage Meraki tool catalog")
console = Console()


@app.command(name="dump")
def tools_dump(
    output: Optional[Path] = typer.Option(
        None,
        "--output",
        "-o",
        help="Write catalog to file (default: stdout)",
    ),
):
    """
    Dump complete Meraki tool catalog with blast-radius classifications.

    Generates the full tool catalog by introspecting the Meraki SDK, applies
    table-driven blast-radius classification, and outputs JSON suitable for
    agent consumption.

    The catalog can be piped to other tools or written to a file with --output.

    Examples:
        # Dump to stdout
        meraki-cli tools dump

        # Write to file
        meraki-cli tools dump --output ~/.terminai/meraki-tools.json

        # Count tools
        meraki-cli tools dump | jq 'length'

        # Filter to read-only tools
        meraki-cli tools dump | jq '[.[] | select(.blast_radius == "low")]'
    """
    try:
        # Show progress indicator (to stderr so it doesn't interfere with JSON output)
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=Console(stderr=True),
            transient=True,
        ) as progress:
            task = progress.add_task("Generating catalog...", total=None)

            # Generate catalog from SDK introspection
            tools = generate_catalog()

            progress.update(task, description=f"Classifying {len(tools)} tools...")

            # Update blast_radius using table-driven classifier
            for tool in tools:
                method = tool.endpoint["method"]
                path = tool.endpoint["path"]
                tier, destructive = classify(method, path)

                # Update the tool spec with table-driven classification
                tool.blast_radius = tier
                tool.destructive = destructive

            progress.update(task, description="Serializing...")

        # Serialize to JSON
        catalog_data = [tool.to_dict() for tool in tools]
        json_output = json.dumps(catalog_data, indent=2)

        # Write to file or stdout
        if output:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json_output)
            # Print to stderr so it doesn't interfere with JSON output
            err_console = Console(stderr=True)
            err_console.print(f"[green]✓[/green] Wrote {len(tools)} tools to {output}")
        else:
            # Print to stdout (use print() not console.print() to avoid formatting)
            print(json_output)

        sys.exit(0)

    except Exception as exc:
        err_console = Console(stderr=True)
        err_console.print(f"[red]Error generating catalog:[/red] {exc}")
        sys.exit(1)


@app.command(name="list")
def tools_list():
    """
    List available Meraki tools grouped by resource module.

    Provides a human-readable summary of the tool catalog with counts per
    resource module. Use 'tools dump' for machine-readable JSON output.

    Example:
        meraki-cli tools list
    """
    try:
        # Generate catalog (with progress indicator)
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
            transient=True,
        ) as progress:
            task = progress.add_task("Generating catalog...", total=None)
            tools = generate_catalog()

            progress.update(task, description="Classifying tools...")
            # Apply table-driven classifier
            for tool in tools:
                method = tool.endpoint["method"]
                path = tool.endpoint["path"]
                tier, destructive = classify(method, path)
                tool.blast_radius = tier
                tool.destructive = destructive

        # Group by resource
        by_resource = {}
        for tool in tools:
            by_resource.setdefault(tool.resource, []).append(tool)

        # Create Rich table
        table = Table(
            title=f"Meraki Dashboard API Tools ({len(tools)} total)",
            show_header=True,
            header_style="bold cyan",
        )
        table.add_column("Resource", style="bold", width=25)
        table.add_column("Tools", justify="right", width=8)
        table.add_column("Low", justify="right", width=6, style="green")
        table.add_column("Medium", justify="right", width=6, style="yellow")
        table.add_column("High", justify="right", width=6, style="orange1")
        table.add_column("Destructive", justify="right", width=11, style="red")

        # Sort by resource name
        for resource in sorted(by_resource.keys()):
            tools_in_resource = by_resource[resource]
            total = len(tools_in_resource)

            # Count by blast radius
            low = sum(1 for t in tools_in_resource if t.blast_radius == "low")
            medium = sum(1 for t in tools_in_resource if t.blast_radius == "medium")
            high = sum(1 for t in tools_in_resource if t.blast_radius == "high")
            destructive = sum(1 for t in tools_in_resource if t.blast_radius == "destructive")

            table.add_row(
                resource,
                str(total),
                str(low) if low > 0 else "-",
                str(medium) if medium > 0 else "-",
                str(high) if high > 0 else "-",
                str(destructive) if destructive > 0 else "-",
            )

        console.print(table)

        # Summary by blast radius
        total_low = sum(1 for t in tools if t.blast_radius == "low")
        total_medium = sum(1 for t in tools if t.blast_radius == "medium")
        total_high = sum(1 for t in tools if t.blast_radius == "high")
        total_destructive = sum(1 for t in tools if t.blast_radius == "destructive")

        console.print()
        console.print("[bold]Blast Radius Summary:[/bold]")
        console.print(f"  [green]Low (read-only):[/green] {total_low} tools")
        console.print(f"  [yellow]Medium (regular writes):[/yellow] {total_medium} tools")
        console.print(f"  [orange1]High (critical config):[/orange1] {total_high} tools")
        console.print(f"  [red]Destructive (delete org/network):[/red] {total_destructive} tools")

        sys.exit(0)

    except Exception as exc:
        err_console = Console(stderr=True)
        err_console.print(f"[red]Error listing tools:[/red] {exc}")
        sys.exit(1)
