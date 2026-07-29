"""
Console entry point for Meraki CLI.

Provides dynamic command routing for all 933 Meraki Dashboard API endpoints.
Uses Click's MultiCommand pattern for lazy command loading.
"""

import json
import sys
from typing import Any, Dict, List, Optional

import click
from rich.console import Console

from .. import __version__
from ..catalog import ToolSpec, generate_catalog
from ..client import MerakiClient
from ..credentials import resolve_api_key
from ..errors import CCIEError, to_envelope
from ..output import render_json, render_table, render_yaml


console = Console()

# Global catalog cache (loaded lazily, once per process)
_CATALOG_CACHE: Optional[List[ToolSpec]] = None
_COMMAND_INDEX: Dict[str, ToolSpec] = {}


class Context:
    """Global context passed to all commands."""

    def __init__(
        self,
        format: str = "json",
        api_key: Optional[str] = None,
        vault_entry: str = "meraki_default",
        verbose: bool = False,
        params_json: Optional[str] = None,
    ):
        self.format = format
        self.api_key = api_key
        self.vault_entry = vault_entry
        self.verbose = verbose
        self.params_json = params_json


def get_catalog() -> List[ToolSpec]:
    """
    Get cached catalog or generate it if not yet loaded.

    Catalog generation happens once per process and is cached in memory.
    This takes ~1-2 seconds but only happens on first use.

    Returns:
        List of ToolSpec objects (933 tools)
    """
    global _CATALOG_CACHE, _COMMAND_INDEX
    if _CATALOG_CACHE is None:
        _CATALOG_CACHE = generate_catalog()

        # Build command index for O(1) lookup
        for tool in _CATALOG_CACHE:
            command_name = f"{tool.resource}-{tool.action}"
            _COMMAND_INDEX[command_name] = tool

    return _CATALOG_CACHE


def get_tool_spec(command_name: str) -> Optional[ToolSpec]:
    """
    Lookup a tool spec by command name.

    Args:
        command_name: Command in format resource-action (e.g., "organizations-list")

    Returns:
        ToolSpec if found, None otherwise
    """
    # Ensure catalog is loaded
    get_catalog()
    return _COMMAND_INDEX.get(command_name)


def kebab_to_snake(name: str) -> str:
    """Convert kebab-case to snake_case."""
    return name.replace('-', '_')


def snake_to_kebab(name: str) -> str:
    """Convert snake_case to kebab-case."""
    return name.replace('_', '-')


def camel_to_kebab(name: str) -> str:
    """
    Convert camelCase to kebab-case.

    Examples:
        organizationId -> organization-id
        networkId -> network-id
        perPage -> per-page
    """
    import re
    # Insert hyphen before uppercase letters and convert to lowercase
    return re.sub('([A-Z])', r'-\1', name).lower().lstrip('-')


def kebab_to_camel(name: str) -> str:
    """
    Convert kebab-case to camelCase.

    Examples:
        organization-id -> organizationId
        network-id -> networkId
        per-page -> perPage
    """
    parts = name.split('-')
    return parts[0] + ''.join(word.capitalize() for word in parts[1:])


def python_type_from_json_schema(schema_type: str) -> Any:
    """
    Map JSON schema type to Click type.

    Args:
        schema_type: JSON schema type string

    Returns:
        Click type
    """
    type_map = {
        "string": str,
        "integer": int,
        "number": float,
        "boolean": bool,
        "array": str,  # JSON string for arrays
        "object": str,  # JSON string for objects
    }
    return type_map.get(schema_type, str)


def execute_tool_call(ctx: click.Context, tool_spec: ToolSpec, **kwargs):
    """
    Execute a Meraki API call for the given tool spec.

    Args:
        ctx: Click context
        tool_spec: ToolSpec describing the tool
        **kwargs: CLI parameters (kebab-case)
    """
    context: Context = ctx.obj

    try:
        # Resolve API key from flags/vault/env
        api_key = resolve_api_key(
            vault_entry=context.vault_entry if not context.api_key else None,
            explicit_token=context.api_key,
        )

        # Create MerakiClient
        client = MerakiClient.from_token(api_key)

        # Merge params from --params JSON if provided
        call_params = {}
        if context.params_json:
            try:
                json_params = json.loads(context.params_json)
                call_params.update(json_params)
            except json.JSONDecodeError as e:
                raise CCIEError(
                    f"Invalid JSON in --params: {e}",
                    hint="Ensure --params contains valid JSON"
                )

        # Merge CLI flags
        # Note: CLI accepts kebab-case (--organization-id) but SDK expects camelCase (organizationId)
        # Click normalizes parameter names to lowercase with underscores
        # We need to convert back to camelCase for the SDK
        for key, value in kwargs.items():
            if value is not None:  # Only include explicit flags
                # Convert from Click's normalized form to camelCase for SDK
                # Click converts --organization-id to organization_id
                # We need to convert organization_id to organizationId
                camel_key = kebab_to_camel(key.replace('_', '-'))
                call_params[camel_key] = value

        if context.verbose:
            # Note: Rich Console.print() doesn't support file parameter
            # Use standard print() for stderr output
            print(f"Calling: {tool_spec.resource}.{tool_spec.action}", file=sys.stderr)
            print(f"Params: {call_params}", file=sys.stderr)
            print(f"Endpoint: {tool_spec.endpoint['method']} {tool_spec.endpoint['path']}", file=sys.stderr)
            print(f"Blast radius: {tool_spec.blast_radius}", file=sys.stderr)

        # Call API
        result = client.call(tool_spec.resource, tool_spec.action, **call_params)

        # Render output based on format flag
        output = render_output(result, context.format)

        # Print to stdout
        if context.format in ("json", "yaml"):
            print(output)
        else:
            console.print(output)

        # Exit with appropriate code
        sys.exit(0 if result.get("ok", False) else 1)

    except CCIEError as exc:
        envelope = to_envelope(exc)
        output = render_output(envelope, context.format)
        if context.format in ("json", "yaml"):
            print(output)
        else:
            console.print(output)
        sys.exit(1)
    except Exception as exc:
        envelope = to_envelope(exc)
        output = render_output(envelope, context.format)
        if context.format in ("json", "yaml"):
            print(output)
        else:
            console.print(output)
        sys.exit(1)


def render_output(envelope: dict, format: str) -> str:
    """
    Route envelope to appropriate renderer based on format flag.

    Args:
        envelope: Response or error envelope
        format: Output format (json, table, yaml)

    Returns:
        Rendered string
    """
    if format == "table":
        return render_table(envelope)
    elif format == "yaml":
        return render_yaml(envelope)
    else:  # json is default
        return render_json(envelope)


class DynamicMerakiCLI(click.Group):
    """
    Dynamic CLI that resolves 933 commands lazily from the catalog.

    This uses Click's Group pattern to provide command completion
    and help without loading all commands at startup.
    """

    def list_commands(self, ctx):
        """
        List all available commands.

        For performance, we only load the catalog when needed.
        """
        # Get catalog (cached after first load)
        catalog = get_catalog()

        # Return all command names plus static commands
        commands = ["list-commands"]
        commands.extend([f"{t.resource}-{t.action}" for t in catalog])
        return sorted(commands)

    def get_command(self, ctx, name):
        """
        Resolve a command by name.

        Args:
            ctx: Click context
            name: Command name

        Returns:
            Click Command object or None
        """
        # Handle static commands
        if name == "list-commands":
            return list_commands_cmd

        # Try to resolve from catalog
        tool_spec = get_tool_spec(name)
        if not tool_spec:
            return None

        # Build dynamic command
        return make_dynamic_command(tool_spec)


def make_dynamic_command(tool_spec: ToolSpec) -> click.Command:
    """
    Create a Click command for the given tool spec.

    Args:
        tool_spec: ToolSpec describing the tool

    Returns:
        Click Command object
    """
    # Build help text
    help_lines = []
    if tool_spec.description:
        help_lines.append(tool_spec.description)
        help_lines.append("")
    help_lines.append(f"Endpoint: {tool_spec.endpoint['method']} {tool_spec.endpoint['path']}")
    help_lines.append(f"Blast radius: {tool_spec.blast_radius}")
    if tool_spec.destructive:
        help_lines.append("")
        help_lines.append("WARNING: This is a DESTRUCTIVE operation!")
    if tool_spec.required:
        help_lines.append("")
        help_lines.append(f"Required: {', '.join([camel_to_kebab(r) for r in tool_spec.required])}")

    help_text = "\n".join(help_lines)

    # Build parameters
    params = []
    for param_name, param_schema in tool_spec.args.items():
        # Convert camelCase parameters to kebab-case for CLI
        option_name = camel_to_kebab(param_name)
        is_required = param_name in tool_spec.required
        param_type = python_type_from_json_schema(param_schema.get("type", "string"))
        param_desc = param_schema.get("description", "")

        # Create Click option
        option = click.Option(
            [f"--{option_name}"],
            type=param_type,
            required=is_required,
            help=param_desc,
        )
        params.append(option)

    # Create handler
    def handler(**kwargs):
        ctx = click.get_current_context()
        execute_tool_call(ctx, tool_spec, **kwargs)

    # Create command
    cmd = click.Command(
        name=f"{tool_spec.resource}-{tool_spec.action}",
        callback=handler,
        params=params,
        help=help_text,
    )

    return cmd


@click.command()
@click.pass_context
def list_commands_cmd(ctx):
    """
    List all 933 available Meraki API commands.

    Shows command names, HTTP methods, endpoints, and blast-radius tiers.
    """
    context: Context = ctx.obj
    catalog = get_catalog()

    if context.format == "json":
        output = json.dumps([t.to_dict() for t in catalog], indent=2)
        print(output)
    elif context.format == "yaml":
        import yaml
        output = yaml.dump([t.to_dict() for t in catalog], default_flow_style=False)
        print(output)
    else:
        # Table output
        from rich.table import Table

        table = Table(title=f"Meraki API Commands ({len(catalog)} total)")
        table.add_column("Command", style="cyan", no_wrap=True)
        table.add_column("Method", style="magenta")
        table.add_column("Blast", style="yellow")
        table.add_column("Description", style="white")

        for tool in catalog:
            command_name = f"{tool.resource}-{tool.action}"
            method = tool.endpoint['method']
            desc = tool.description[:60] + "..." if len(tool.description) > 60 else tool.description

            blast_color = {
                "low": "green",
                "medium": "yellow",
                "high": "orange1",
                "destructive": "red"
            }.get(tool.blast_radius, "white")

            table.add_row(
                command_name,
                method,
                f"[{blast_color}]{tool.blast_radius}[/{blast_color}]",
                desc
            )

        console.print(table)


@click.group(cls=DynamicMerakiCLI, invoke_without_command=False)
@click.option("--format", "-f", default="json", type=click.Choice(["json", "table", "yaml"]),
              help="Output format")
@click.option("--api-key", envvar="MERAKI_API_KEY", help="Meraki Dashboard API key")
@click.option("--vault-entry", default="meraki_default", help="Vault entry name for API key")
@click.option("--params", help="Complex parameters as JSON string")
@click.option("--verbose", "-v", is_flag=True, help="Enable debug logging")
@click.pass_context
def cli(ctx, format, api_key, vault_entry, params, verbose):
    """
    Meraki Dashboard API CLI - Full coverage of 933 API endpoints.

    Examples:
        meraki-cli organizations-list
        meraki-cli networks-list --organization-id O_123
        meraki-cli networks-list-clients --network-id N_456 --timespan 86400
        meraki-cli list-commands  # Show all 933 commands
    """
    ctx.obj = Context(
        format=format,
        api_key=api_key,
        vault_entry=vault_entry,
        params_json=params,
        verbose=verbose,
    )

    if verbose:
        print(f"Version: {__version__}", file=sys.stderr)
        print(f"Format: {format}", file=sys.stderr)


if __name__ == "__main__":
    cli()
