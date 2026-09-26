"""terminai-pyats: Cisco pyATS/Genie CLI and Python client for TerminAI.

Provides a curated catalog of 15 pyATS/Genie verbs with typed envelope responses
and a standalone CLI. Can be used directly or integrated into TerminAI agents.
"""

__version__ = "0.1.0"

# Public API - expose key classes for importers
from .client import PyatsClient
from .errors import PyatsError, to_envelope

__all__ = [
    "PyatsClient",
    "PyatsError",
    "to_envelope",
    "__version__",
]
