"""Error envelope structure for terminai-pyats CLI.

Provides PyatsError base class and to_envelope() utility for standardized
error responses matching the Meraki CLI envelope pattern.
"""

from typing import Any, Dict


class PyatsError(Exception):
    """Base exception for terminai-pyats.

    All custom exceptions inherit from this class and include both a message
    and an optional hint for troubleshooting.
    """

    def __init__(self, message: str, hint: str = ""):
        """Initialize PyatsError.

        Args:
            message: Primary error message describing what went wrong
            hint: Optional actionable hint to help resolve the error
        """
        self.message = message
        self.hint = hint
        super().__init__(message)


def to_envelope(exc: Exception) -> Dict[str, Any]:
    """Convert exception to error envelope format.

    Transforms any exception into a standardized error envelope that can be
    returned to callers or serialized to JSON.

    Args:
        exc: The exception to convert

    Returns:
        Error envelope dict with structure:
        {
            "ok": False,
            "error": {
                "code": "error_type",
                "message": "error message",
                "hint": "actionable hint"
            }
        }

    Examples:
        >>> exc = PyatsError("Device not found")
        >>> envelope = to_envelope(exc)
        >>> envelope["ok"]
        False
        >>> envelope["error"]["code"]
        'pyats_error'
    """
    error_code = "unknown_error"
    message = str(exc)
    hint = ""

    if isinstance(exc, PyatsError):
        error_code = "pyats_error"
        message = exc.message
        hint = exc.hint
    elif isinstance(exc, ValueError):
        error_code = "validation_error"
        hint = "Check input parameters and ensure all required values are provided."
    elif isinstance(exc, KeyError):
        error_code = "validation_error"
        hint = f"Missing required parameter: {message}"
    elif isinstance(exc, ConnectionError):
        error_code = "network_error"
        hint = "Unable to connect to device. Check network connectivity and credentials."
    elif isinstance(exc, TimeoutError):
        error_code = "network_error"
        hint = "Connection timed out. Device may be unreachable or slow to respond."

    return {
        "ok": False,
        "error": {
            "code": error_code,
            "message": message,
            "hint": hint,
        }
    }
