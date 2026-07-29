"""Error envelope structure for terminai-meraki CLI.

This module defines the base exception class and specific error types used
throughout the Meraki CLI package, along with utilities to convert exceptions
to standardized error envelope format.
"""

from typing import Any, Dict, Optional


class CCIEError(Exception):
    """Base exception for terminai-meraki.

    All custom exceptions in this package inherit from this class and include
    both a message and an optional hint for troubleshooting.
    """

    def __init__(self, message: str, hint: str = ""):
        """Initialize CCIEError.

        Args:
            message: Primary error message describing what went wrong
            hint: Optional actionable hint to help resolve the error
        """
        self.message = message
        self.hint = hint
        super().__init__(message)


class AuthError(CCIEError):
    """Authentication or authorization error (401/403).

    Raised when API key is invalid, expired, or lacks required permissions.
    """

    def __init__(self, message: str, hint: str = ""):
        default_hint = (
            "Verify your API key is valid and has the required permissions. "
            "Rotate your key in the Vault (Settings → Vault) or update the "
            "MERAKI_API_KEY environment variable."
        )
        super().__init__(message, hint or default_hint)


class NotFoundError(CCIEError):
    """Resource not found error (404).

    Raised when a requested resource (org, network, device, etc.) doesn't exist.
    """

    def __init__(self, message: str, resource_type: str = "", hint: str = ""):
        default_hint = f"The requested {resource_type or 'resource'} was not found. " if resource_type else "Resource not found. "
        default_hint += "Verify the ID is correct. Use list commands to enumerate available resources."
        super().__init__(message, hint or default_hint)


class RateLimitError(CCIEError):
    """API rate limit exceeded (429).

    Raised when hitting Meraki Dashboard API rate limits.
    """

    def __init__(self, message: str, retry_after: Optional[int] = None, hint: str = ""):
        retry_info = f" Retry after {retry_after} seconds." if retry_after else ""
        default_hint = (
            f"Meraki API rate limit exceeded.{retry_info} "
            "The SDK implements automatic retry with exponential backoff. "
            "If this persists, reduce request frequency or contact Meraki support "
            "to increase your rate limit."
        )
        super().__init__(message, hint or default_hint)


class NetworkError(CCIEError):
    """Network connectivity or timeout error.

    Raised when unable to reach the Meraki Dashboard API due to network issues.
    """

    def __init__(self, message: str, hint: str = ""):
        default_hint = (
            "Unable to connect to Meraki Dashboard API. "
            "Check your internet connection and verify dashboard.meraki.com is accessible. "
            "If behind a proxy, ensure it's configured correctly."
        )
        super().__init__(message, hint or default_hint)


class ValidationError(CCIEError):
    """Invalid input parameters or malformed request.

    Raised when input validation fails or API rejects the request due to bad data.
    """

    def __init__(self, message: str, param: str = "", hint: str = ""):
        param_info = f" Parameter: {param}." if param else ""
        default_hint = (
            f"Request validation failed.{param_info} "
            "Check that all required parameters are provided and values are in the correct format. "
            "Run with --verbose for detailed parameter requirements."
        )
        super().__init__(message, hint or default_hint)


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
        >>> exc = AuthError("Invalid API key")
        >>> envelope = to_envelope(exc)
        >>> envelope["ok"]
        False
        >>> envelope["error"]["code"]
        'auth_error'
    """
    # Map exception types to error codes
    error_code = "unknown_error"
    message = str(exc)
    hint = ""

    if isinstance(exc, CCIEError):
        # Extract code from class name (e.g., AuthError -> auth_error)
        # Convert from PascalCase to snake_case
        class_name = exc.__class__.__name__.replace("Error", "")
        # Insert underscore before uppercase letters (for multi-word names)
        import re
        error_code = re.sub(r'(?<!^)(?=[A-Z])', '_', class_name).lower()
        if error_code and not error_code.endswith("_error"):
            error_code = f"{error_code}_error"
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
        hint = "Unable to connect to Meraki Dashboard API. Check your internet connection."
    elif isinstance(exc, TimeoutError):
        error_code = "network_error"
        hint = "Request timed out. The Meraki API may be experiencing issues or your connection is slow."

    # Try to map common meraki SDK exceptions
    exc_class_name = exc.__class__.__name__
    if "APIError" in exc_class_name or "ApiError" in exc_class_name:
        # Check for HTTP status codes in the exception
        if hasattr(exc, "status") or hasattr(exc, "status_code"):
            status = getattr(exc, "status", None) or getattr(exc, "status_code", None)
            if status == 401 or status == 403:
                error_code = "auth_error"
                hint = "API key is invalid or lacks required permissions."
            elif status == 404:
                error_code = "not_found_error"
                hint = "Resource not found. Verify the ID is correct."
            elif status == 429:
                error_code = "rate_limit_error"
                hint = "API rate limit exceeded. Requests will be retried automatically."
            elif status >= 500:
                error_code = "network_error"
                hint = "Meraki Dashboard API is experiencing issues. Try again later."

    return {
        "ok": False,
        "error": {
            "code": error_code,
            "message": message,
            "hint": hint,
        }
    }
