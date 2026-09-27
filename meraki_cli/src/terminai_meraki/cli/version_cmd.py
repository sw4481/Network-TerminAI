"""
Version command for Meraki CLI.
"""

import typer
from rich.console import Console

from .. import __version__

app = typer.Typer()
console = Console()


@app.command(name="version")
def version():
    """Show version information."""
    console.print(f"terminai-meraki version {__version__}")
