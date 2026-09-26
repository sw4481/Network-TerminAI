"""
MerakiClient wrapper for the official Meraki Dashboard API SDK.

This module provides a unified client interface with factory methods for different
credential sources, typed envelope responses, and comprehensive error handling.
"""

import time
from typing import Any, Dict, Optional

import meraki

from .credentials import resolve_api_key
from .errors import (
    AuthError,
    NotFoundError,
    RateLimitError,
    NetworkError,
    ValidationError,
    to_envelope,
)


class MerakiClient:
    """
    Wrapper around meraki.DashboardAPI with envelope-based response format.

    This client provides:
    - Factory methods for different credential sources
    - Typed envelope responses ({ok, data/error, meta})
    - Comprehensive error handling with actionable hints
    - Blast-radius annotation (Phase 1: basic, Phase 2: full classifier)
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.meraki.com/api/v1",
        timeout: int = 60,
        maximum_retries: int = 1,
        **kwargs
    ):
        """
        Initialize MerakiClient with explicit API key.

        Args:
            api_key: Meraki Dashboard API key
            base_url: Base URL for the API (default: production)
            timeout: Request timeout in seconds (default: 60)
            maximum_retries: How many times the SDK retries a failed request
                (default: 1). The SDK default is 2, which multiplies request
                volume during upstream 5xx outages (each retry opens a fresh
                connection to a possibly-different edge shard, which can
                exhaust the resolver/socket pool). Cap it low for our use.
            **kwargs: Additional arguments passed to meraki.DashboardAPI
        """
        self.api_key = api_key
        self.base_url = base_url
        self.timeout = timeout

        # Initialize the SDK client
        # Suppress SDK's internal logging to avoid noise. The SDK holds a single
        # requests.Session internally, so connections are reused across calls on
        # THIS instance — the caller must close() it (or use it as a context
        # manager) to release sockets when done, especially for long-lived
        # processes that build many clients (e.g. scheduled heartbeats).
        self._dashboard = meraki.DashboardAPI(
            api_key=api_key,
            base_url=base_url,
            single_request_timeout=timeout,
            maximum_retries=maximum_retries,  # Cap retry storms (SDK default 2)
            wait_on_rate_limit=True,  # Auto-retry on 429
            print_console=False,  # Silence SDK logging
            suppress_logging=True,
            **kwargs
        )

    @classmethod
    def from_vault(cls, entry_name: str, **kwargs) -> "MerakiClient":
        """
        Create client using vault entry.

        Resolves API key via the TerminAI vault (requires sidecar context).
        Falls back to environment variable if vault is unavailable.

        Args:
            entry_name: Name of vault entry containing the API key
            **kwargs: Additional arguments passed to __init__

        Returns:
            MerakiClient instance

        Raises:
            AuthError: If API key cannot be resolved from vault or environment

        Examples:
            >>> client = MerakiClient.from_vault("meraki_default")
            >>> result = client.call("organizations", "list")
        """
        api_key = resolve_api_key(vault_entry=entry_name)
        return cls(api_key=api_key, **kwargs)

    @classmethod
    def from_env(cls, env_var: str = "MERAKI_API_KEY", **kwargs) -> "MerakiClient":
        """
        Create client from environment variable.

        Args:
            env_var: Environment variable name (default: MERAKI_API_KEY)
            **kwargs: Additional arguments passed to __init__

        Returns:
            MerakiClient instance

        Raises:
            AuthError: If environment variable is not set

        Examples:
            >>> client = MerakiClient.from_env()
            >>> result = client.call("organizations", "list")
        """
        api_key = resolve_api_key(env_var=env_var)
        return cls(api_key=api_key, **kwargs)

    @classmethod
    def from_token(cls, api_key: str, **kwargs) -> "MerakiClient":
        """
        Create client from explicit token.

        Args:
            api_key: Meraki Dashboard API key
            **kwargs: Additional arguments passed to __init__

        Returns:
            MerakiClient instance

        Examples:
            >>> client = MerakiClient.from_token("abc123...")
            >>> result = client.call("organizations", "list")
        """
        return cls(api_key=api_key, **kwargs)

    def close(self) -> None:
        """Close the underlying HTTP session and release its sockets.

        The Meraki SDK keeps a persistent requests.Session (reused across all
        calls on this client). In a long-lived process that builds a new client
        per task — e.g. scheduled heartbeat checks — never closing these leaks a
        connection pool each run, eventually exhausting sockets/file descriptors
        and the resolver cache. Call this when done with the client.

        Safe to call multiple times; tolerant of SDK internal shape changes.
        """
        try:
            session = getattr(self._dashboard, "_session", None)
            req_session = getattr(session, "_req_session", None)
            if req_session is not None:
                req_session.close()
        except Exception:
            # Best-effort cleanup — never raise from close().
            pass

    def __enter__(self) -> "MerakiClient":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()

    def __del__(self):
        # Backstop for callers that forget to close()/use a context manager.
        self.close()

    def call(self, resource: str, action: str, **kwargs) -> Dict[str, Any]:
        """
        Execute a Meraki API call and return typed envelope.

        This is the main interface for making API calls. It:
        - Resolves resource.action to SDK method
        - Executes the call with error handling
        - Returns standardized envelope format
        - Annotates with blast-radius metadata

        Args:
            resource: SDK resource module (e.g., "organizations", "networks")
            action: Action name (e.g., "list", "get", "update")
            **kwargs: Parameters for the API call

        Returns:
            Success envelope:
            {
                "ok": True,
                "data": <response>,
                "meta": {
                    "endpoint": {"method": "GET", "resource": "organizations"},
                    "blast_radius": "low"
                }
            }

            Error envelope:
            {
                "ok": False,
                "error": {
                    "code": "auth_error",
                    "message": "Invalid API key",
                    "hint": "Rotate your API key in the Vault..."
                }
            }

        Examples:
            >>> client.call("organizations", "list")
            {"ok": True, "data": [...], "meta": {...}}

            >>> client.call("networks", "get", network_id="N_123")
            {"ok": True, "data": {...}, "meta": {...}}

        Notes:
            - Phase 1: implements "organizations.list" as proof-of-concept
            - Phase 2: full introspection and dynamic method resolution
            - Phase 1: basic blast-radius (GET=low, others=medium)
            - Phase 2: table-driven classifier with per-endpoint overrides
        """
        start_time = time.time()

        try:
            # Resolve SDK method
            # Phase 1: proof-of-concept for organizations.list
            # Phase 2: full introspection-based resolver
            method_fn = self._resolve_method(resource, action)

            # Execute the call
            response = method_fn(**kwargs)

            # Calculate duration
            duration_ms = int((time.time() - start_time) * 1000)

            # Determine blast radius
            # Phase 1: basic heuristic (GET=low, others=medium)
            # Phase 2: table-driven classifier
            blast_radius = self._classify_blast_radius(resource, action, kwargs)

            # Return success envelope
            return {
                "ok": True,
                "data": response,
                "meta": {
                    "endpoint": {
                        "resource": resource,
                        "action": action,
                    },
                    "blast_radius": blast_radius,
                    "duration_ms": duration_ms,
                }
            }

        except Exception as exc:
            # Convert exception to envelope
            envelope = self._handle_error(exc, resource, action)

            # Add timing metadata
            duration_ms = int((time.time() - start_time) * 1000)
            envelope["meta"] = {
                "endpoint": {
                    "resource": resource,
                    "action": action,
                },
                "duration_ms": duration_ms,
            }

            return envelope

    def _resolve_method(self, resource: str, action: str):
        """
        Resolve resource.action to SDK method.

        Uses catalog to map action names back to SDK method names,
        then resolves the method on the dashboard object.

        Args:
            resource: SDK resource module
            action: Action name

        Returns:
            Callable SDK method

        Raises:
            ValidationError: If resource/action combination is not supported
        """
        # Import catalog here to avoid circular dependency
        from .catalog import get_catalog

        # Find the tool spec for this resource.action
        catalog = get_catalog()
        tool_spec = None
        for tool in catalog:
            if tool.resource == resource and tool.action == action:
                tool_spec = tool
                break

        if not tool_spec:
            raise ValidationError(
                f"Unsupported resource.action: {resource}.{action}",
                hint=(
                    f"Unknown command. Run 'meraki-cli list-commands' to see "
                    f"all 933 available commands."
                )
            )

        # Get the SDK method using the original method name
        try:
            resource_module = getattr(self._dashboard, tool_spec.resource)
            method = getattr(resource_module, tool_spec.sdk_method)
            return method
        except AttributeError as e:
            raise ValidationError(
                f"SDK method not found: {tool_spec.resource}.{tool_spec.sdk_method}",
                hint=(
                    f"This SDK version may not support this endpoint. "
                    f"Try upgrading the meraki SDK: pip install --upgrade meraki"
                )
            )

    def _classify_blast_radius(self, resource: str, action: str, params: dict) -> str:
        """
        Classify blast radius for the given action.

        Phase 1: Simple heuristic based on action verb.
        Phase 2: Table-driven classifier with per-endpoint overrides.

        Args:
            resource: SDK resource module
            action: Action name
            params: Call parameters

        Returns:
            Blast radius tier: "low" | "medium" | "high" | "destructive"
        """
        # Phase 1: Simple heuristic
        # GET-like actions (list, get) = low
        # Everything else = medium
        read_actions = {"list", "get", "show", "retrieve"}

        if action in read_actions:
            return "low"
        else:
            return "medium"

    def _handle_error(self, exc: Exception, resource: str, action: str) -> Dict[str, Any]:
        """
        Convert exception to error envelope with context.

        Maps common SDK exceptions to typed errors with helpful hints.

        Args:
            exc: The caught exception
            resource: Resource being accessed
            action: Action being performed

        Returns:
            Error envelope dict
        """
        # Check for meraki SDK exceptions
        exc_type = exc.__class__.__name__

        # Map common SDK exceptions to our error types
        if "APIError" in exc_type or "ApiError" in exc_type:
            # Extract status code if available
            status = getattr(exc, "status", None) or getattr(exc, "status_code", None)

            if status == 401 or status == 403:
                typed_exc = AuthError(
                    f"Authentication failed for {resource}.{action}",
                    hint=(
                        "API key is invalid, expired, or lacks permissions. "
                        "Rotate your key in the Vault (Settings → Vault) or update "
                        "the MERAKI_API_KEY environment variable."
                    )
                )
                return to_envelope(typed_exc)

            elif status == 404:
                typed_exc = NotFoundError(
                    f"Resource not found: {resource}.{action}",
                    resource_type=resource,
                    hint=(
                        f"The requested {resource} was not found. "
                        f"Verify the ID is correct. Use 'meraki-cli {resource} list' "
                        "to enumerate available resources."
                    )
                )
                return to_envelope(typed_exc)

            elif status == 429:
                retry_after = getattr(exc, "retry_after", None)
                typed_exc = RateLimitError(
                    f"Rate limit exceeded for {resource}.{action}",
                    retry_after=retry_after,
                    hint=(
                        "Meraki API rate limit exceeded. The SDK implements automatic "
                        "retry with exponential backoff. If this persists, reduce request "
                        "frequency or contact Meraki support to increase your rate limit."
                    )
                )
                return to_envelope(typed_exc)

            elif status and status >= 500:
                typed_exc = NetworkError(
                    f"Meraki API server error (HTTP {status})",
                    hint=(
                        "Meraki Dashboard API is experiencing issues. "
                        "Check https://status.meraki.com/ for service status."
                    )
                )
                return to_envelope(typed_exc)

        # Network/connection errors
        if isinstance(exc, (ConnectionError, TimeoutError)) or "timeout" in str(exc).lower():
            typed_exc = NetworkError(
                f"Network error during {resource}.{action}: {str(exc)}",
                hint=(
                    "Unable to connect to Meraki Dashboard API. "
                    "Check your internet connection and verify dashboard.meraki.com is accessible. "
                    "If behind a proxy, ensure it's configured correctly."
                )
            )
            return to_envelope(typed_exc)

        # Validation errors
        if isinstance(exc, (ValueError, KeyError, TypeError)):
            typed_exc = ValidationError(
                f"Invalid parameters for {resource}.{action}: {str(exc)}",
                hint=(
                    "Check that all required parameters are provided and values are in the correct format. "
                    "Run 'meraki-cli --help' or check the API documentation for parameter requirements."
                )
            )
            return to_envelope(typed_exc)

        # Fallback: use generic envelope converter
        return to_envelope(exc)
