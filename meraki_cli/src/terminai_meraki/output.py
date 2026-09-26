"""Output renderers for Meraki CLI envelope format.

Provides JSON, table, and YAML rendering options for the standardized envelope structure.
"""

import json
from typing import Any

import yaml
from rich.console import Console
from rich.table import Table


def render_json(envelope: dict[str, Any]) -> str:
    """Render envelope as pretty-printed JSON.

    Args:
        envelope: Response envelope with 'ok', 'data'/'error', and optional 'meta'

    Returns:
        Formatted JSON string with 2-space indentation
    """
    return json.dumps(envelope, indent=2, default=str)


def render_table(envelope: dict[str, Any]) -> str:
    """Render envelope as human-friendly table using Rich.

    Args:
        envelope: Response envelope with 'ok', 'data'/'error', and optional 'meta'

    Returns:
        Rich table rendered as string
    """
    console = Console()

    if not envelope.get("ok", False):
        # Error envelope - format error nicely with red
        error = envelope.get("error", {})
        table = Table(title="[bold red]Error[/bold red]", show_header=False, border_style="red")
        table.add_column("Field", style="bold")
        table.add_column("Value")

        if "code" in error:
            table.add_row("Code", f"[red]{error['code']}[/red]")
        if "message" in error:
            table.add_row("Message", error["message"])
        if "hint" in error:
            table.add_row("Hint", f"[dim]{error['hint']}[/dim]")

        # Capture table output as string
        with console.capture() as capture:
            console.print(table)
        return capture.get()

    # Success envelope
    data = envelope.get("data")

    if data is None:
        # No data
        table = Table(title="[bold green]Success[/bold green]", show_header=False)
        table.add_column("Status")
        table.add_row("[green]OK[/green]")

        with console.capture() as capture:
            console.print(table)
        return capture.get()

    if isinstance(data, list):
        if len(data) == 0:
            # Empty list
            table = Table(title="[bold]Results[/bold]", show_header=False)
            table.add_column("Status")
            table.add_row("[dim]No results[/dim]")

            with console.capture() as capture:
                console.print(table)
            return capture.get()

        # List of items - create table with columns from first item
        first_item = data[0]
        if isinstance(first_item, dict):
            table = Table(title="[bold]Results[/bold]", show_header=True)

            # Add columns from first item keys
            for key in first_item.keys():
                table.add_column(key, overflow="fold")

            # Add rows
            for item in data:
                if isinstance(item, dict):
                    row_values = [str(item.get(key, "")) for key in first_item.keys()]
                    table.add_row(*row_values)

            with console.capture() as capture:
                console.print(table)
            return capture.get()
        else:
            # List of non-dict items
            table = Table(title="[bold]Results[/bold]", show_header=True)
            table.add_column("Value")

            for item in data:
                table.add_row(str(item))

            with console.capture() as capture:
                console.print(table)
            return capture.get()

    if isinstance(data, dict):
        # Single object - create key-value table
        table = Table(title="[bold]Result[/bold]", show_header=False)
        table.add_column("Key", style="bold")
        table.add_column("Value", overflow="fold")

        for key, value in data.items():
            # Format value based on type
            if isinstance(value, (dict, list)):
                value_str = json.dumps(value, indent=2, default=str)
            else:
                value_str = str(value)
            table.add_row(key, value_str)

        with console.capture() as capture:
            console.print(table)
        return capture.get()

    # Scalar value
    table = Table(title="[bold]Result[/bold]", show_header=False)
    table.add_column("Value")
    table.add_row(str(data))

    with console.capture() as capture:
        console.print(table)
    return capture.get()


def render_yaml(envelope: dict[str, Any]) -> str:
    """Render envelope as clean YAML.

    Args:
        envelope: Response envelope with 'ok', 'data'/'error', and optional 'meta'

    Returns:
        Formatted YAML string
    """
    return yaml.dump(envelope, default_flow_style=False, sort_keys=False, allow_unicode=True)
