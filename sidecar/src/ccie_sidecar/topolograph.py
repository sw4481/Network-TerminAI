"""Dedicated Topolograph Streamable HTTP and REST client."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit

import requests


CERTIFIED_TOOL_ALLOWLIST = frozenset({
    "get_graph_by_time",
    "get_all_graphs",
    "get_network_by_graph_time",
    "get_graph_status",
    "get_network_events",
    "get_adjacency_events",
    "get_events_timeline",
    "get_nodes",
    "get_edges",
    "get_lsps",
    "get_shortest_path",
    "get_cspf_path",
    "get_edge_failure_reaction",
    "list_bgp_graphs",
    "get_bgp_graph",
    "list_bgp_nodes",
    "list_bgp_sessions",
    "search_bgp_routes",
    "get_bgp_node_route_summary",
    "get_bgp_route_state",
    "compare_bgp_routes",
    "get_bgp_events_timeline",
    "list_bgp_bindings",
    "get_bgp_binding",
    "resolve_route",
    "get_vrf_inventory",
    "list_vpn_routers",
    "upload_graph",
    "add_lsp",
    "update_lsp",
    "delete_lsp",
})

READ_ONLY_TOOLS = frozenset({
    "get_graph_by_time",
    "get_all_graphs",
    "get_network_by_graph_time",
    "get_graph_status",
    "get_network_events",
    "get_adjacency_events",
    "get_events_timeline",
    "get_nodes",
    "get_edges",
    "get_lsps",
    "get_shortest_path",
    "get_cspf_path",
    "get_edge_failure_reaction",
    "list_bgp_graphs",
    "get_bgp_graph",
    "list_bgp_nodes",
    "list_bgp_sessions",
    "search_bgp_routes",
    "get_bgp_node_route_summary",
    "get_bgp_route_state",
    "compare_bgp_routes",
    "get_bgp_events_timeline",
    "list_bgp_bindings",
    "get_bgp_binding",
    "resolve_route",
    "get_vrf_inventory",
    "list_vpn_routers",
})

MUTATION_TOOLS = frozenset({
    "upload_graph",
    "add_lsp",
    "update_lsp",
    "delete_lsp",
})

REQUIRED_TOOL_NAMES = frozenset({"get_all_graphs"})
_MCP_PROTOCOL_VERSION = "2025-06-18"
_MCP_PATH = "/mcp"
_REQUEST_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class TopolographRuntimeConfig:
    base_url: str
    verify_tls: bool


@dataclass(frozen=True)
class TopolographConnectionReport:
    server_name: str
    server_version: str
    latency_ms: float
    tools: tuple[str, ...]
    unexpected_tools: tuple[str, ...]
    stages: tuple[tuple[str, str], ...] = ()


class TopolographError(RuntimeError):
    """Safe, fixed-code error raised by the Topolograph adapter."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


class TopolographClient:
    """Small, token-private client for a private Topolograph deployment."""

    def __init__(
        self,
        config: TopolographRuntimeConfig,
        token: str,
        *,
        session: requests.Session | None = None,
        clock: Callable[[], float] | None = None,
    ):
        self._base = self._validate_base_url(config.base_url)
        self._verify_tls = config.verify_tls
        self.__token = token
        self._session = session or requests.Session()
        self._clock = clock or time.monotonic
        self._session_id: str | None = None
        self._next_request_id = 1

    @staticmethod
    def _validate_base_url(base_url: str) -> str:
        parts = urlsplit((base_url or "").strip())
        if (
            parts.scheme not in {"http", "https"}
            or not parts.netloc
            or parts.username is not None
            or parts.password is not None
            or parts.query
            or parts.fragment
        ):
            raise TopolographError(
                "INVALID_CONFIGURATION",
                "Topolograph base URL must be an HTTP(S) URL without credentials, query, or fragment.",
            )
        return base_url.rstrip("/")

    def test_connection(self) -> TopolographConnectionReport:
        """Perform the real MCP handshake, tool inventory, and bounded read."""
        started = self._clock()
        initialized = self._rpc("initialize", {
            "protocolVersion": _MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "ccie-terminal", "version": "0.0.1"},
        }, retry_read=True)
        server_info = initialized.get("serverInfo")
        if not isinstance(server_info, dict):
            raise TopolographError("UPSTREAM_PROTOCOL_ERROR", "Topolograph initialize response was invalid.")

        self._rpc("notifications/initialized", notification=True)
        listed = self._rpc("tools/list", {}, retry_read=True)
        raw_tools = listed.get("tools")
        if not isinstance(raw_tools, list):
            raise TopolographError("UPSTREAM_PROTOCOL_ERROR", "Topolograph tool inventory was invalid.")
        tool_names = tuple(
            item["name"] for item in raw_tools
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        )
        missing = REQUIRED_TOOL_NAMES.difference(tool_names)
        if missing:
            raise TopolographError("REQUIRED_TOOL_MISSING", "Topolograph is missing a required tool.")

        self.call_tool("get_all_graphs", {"page": 1, "per_page": 1})
        elapsed_ms = max(0.0, (self._clock() - started) * 1000)
        unexpected = tuple(name for name in tool_names if name not in CERTIFIED_TOOL_ALLOWLIST)
        return TopolographConnectionReport(
            server_name=self._safe_string(server_info.get("name")),
            server_version=self._safe_string(server_info.get("version")),
            latency_ms=round(elapsed_ms, 1),
            tools=tool_names,
            unexpected_tools=unexpected,
            stages=(
                ("initialize", "passed"),
                ("tool_inventory", "passed"),
                ("bounded_probe", "passed"),
            ),
        )

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call one certified MCP tool, retrying reads once on reset/timeout."""
        if name not in CERTIFIED_TOOL_ALLOWLIST:
            raise TopolographError("TOOL_NOT_CERTIFIED", "The requested Topolograph tool is not certified.")
        if arguments is not None and not isinstance(arguments, dict):
            raise TopolographError("INVALID_ARGUMENTS", "Topolograph tool arguments must be an object.")
        if name == "delete_lsp" and not ((arguments or {}).get("lsp_name") or (arguments or {}).get("delete_all") is True):
            raise TopolographError("DELETE_CONFIRMATION_REQUIRED", "Provide lsp_name or set delete_all=True.")
        return self._rpc(
            "tools/call",
            {"name": name, "arguments": dict(arguments or {})},
            retry_read=name in READ_ONLY_TOOLS,
        )

    def get_all_graphs(self, page: int = 1, per_page: int = 1) -> Any:
        """Return a bounded page of graphs."""
        return self.call_tool("get_all_graphs", {"page": page, "per_page": per_page})

    def delete_lsp(self, lsp_name: str | None = None, *, delete_all: bool = False) -> Any:
        """Delete one LSP, or explicitly confirm deletion of all LSPs."""
        if not lsp_name and not delete_all:
            raise TopolographError(
                "DELETE_CONFIRMATION_REQUIRED",
                "Provide lsp_name or set delete_all=True.",
            )
        arguments: dict[str, Any] = {"delete_all": True} if delete_all else {"lsp_name": lsp_name}
        return self.call_tool("delete_lsp", arguments)

    def upload_lsdb(
        self,
        content: str,
        vendor: str,
        protocol: str,
        description: str | None = None,
    ) -> Any:
        """Upload an LSDB text document through Topolograph's REST API."""
        if protocol not in {"ospf", "ospfv3", "isis"} or not isinstance(content, str) or not vendor:
            raise TopolographError("INVALID_UPLOAD", "LSDB content, vendor, and protocol are invalid.")
        data = {
            "lsdb_output": content,
            "vendor_device": vendor,
            "igp_protocol": protocol,
        }
        if description is not None:
            data["graph_description"] = description
        return self._rest_upload(
            "/api/graph/",
            data,
        )

    def upload_yaml(self, content: str) -> Any:
        """Upload a YAML diagram document through Topolograph's REST API."""
        if not isinstance(content, str):
            raise TopolographError("INVALID_UPLOAD", "YAML content is invalid.")
        return self._rest_upload(
            "/api/diagram",
            {"yaml_diagram_str": content},
        )

    def _rpc(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        retry_read: bool = False,
        notification: bool = False,
    ) -> dict[str, Any] | None:
        request_id = None if notification else self._take_request_id()
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if request_id is not None:
            payload["id"] = request_id
        if params is not None:
            payload["params"] = params

        attempts = 2 if retry_read else 1
        for attempt in range(attempts):
            try:
                response = self._session.request(
                    method="POST",
                    url=f"{self._base}{_MCP_PATH}",
                    headers=self._headers(),
                    json=payload,
                    verify=self._verify_tls,
                    timeout=_REQUEST_TIMEOUT_SECONDS,
                )
                return self._decode_rpc_response(response, request_id, notification)
            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
                if attempt + 1 < attempts:
                    continue
                code = "UPSTREAM_TIMEOUT" if isinstance(exc, requests.exceptions.Timeout) else "UPSTREAM_UNAVAILABLE"
                raise TopolographError(code, "Topolograph request could not be completed.") from None

        raise TopolographError("UPSTREAM_UNAVAILABLE", "Topolograph request could not be completed.")

    def _decode_rpc_response(
        self,
        response: requests.Response,
        request_id: int | None,
        notification: bool,
    ) -> dict[str, Any] | None:
        if response.status_code >= 400:
            code = "AUTHENTICATION_FAILED" if response.status_code in {401, 403} else "UPSTREAM_HTTP_ERROR"
            raise TopolographError(code, "Topolograph returned an unsuccessful HTTP status.")
        if notification:
            return None

        session_id = self._header(response, "Mcp-Session-Id")
        if session_id:
            self._session_id = session_id
        content_type = self._header(response, "Content-Type").lower()
        if "text/event-stream" in content_type:
            message = self._decode_sse(response.text, request_id)
        else:
            try:
                message = response.json()
            except Exception:
                raise TopolographError("UPSTREAM_PROTOCOL_ERROR", "Topolograph returned invalid JSON.") from None
        return self._rpc_result(message, request_id)

    def _decode_sse(self, text: str, request_id: int | None) -> dict[str, Any]:
        for block in text.replace("\r\n", "\n").split("\n\n"):
            data = "\n".join(
                line[5:].lstrip() for line in block.splitlines() if line.startswith("data:")
            )
            if not data or data == "[DONE]":
                continue
            try:
                message = json.loads(data)
            except (TypeError, ValueError):
                continue
            if isinstance(message, dict) and (message.get("id") == request_id or "error" in message):
                return message
        raise TopolographError("UPSTREAM_PROTOCOL_ERROR", "Topolograph SSE response had no result.")

    @staticmethod
    def _rpc_result(message: Any, request_id: int | None) -> dict[str, Any]:
        if not isinstance(message, dict) or message.get("id") != request_id:
            raise TopolographError("UPSTREAM_PROTOCOL_ERROR", "Topolograph JSON-RPC response was invalid.")
        if "error" in message:
            raise TopolographError("UPSTREAM_RPC_ERROR", "Topolograph rejected the MCP request.")
        result = message.get("result")
        if not isinstance(result, dict):
            raise TopolographError("UPSTREAM_PROTOCOL_ERROR", "Topolograph MCP result was invalid.")
        return result

    def _rest_upload(
        self,
        path: str,
        payload: dict[str, str],
    ) -> Any:
        try:
            headers = self._headers()
            response = self._session.request(
                method="POST",
                url=f"{self._base}{path}",
                headers=headers,
                json=payload,
                verify=self._verify_tls,
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
        except requests.exceptions.Timeout:
            raise TopolographError("UPSTREAM_TIMEOUT", "Topolograph upload timed out.") from None
        except requests.exceptions.ConnectionError:
            raise TopolographError("UPSTREAM_UNAVAILABLE", "Topolograph upload could not be completed.") from None
        if response.status_code >= 400:
            code = "AUTHENTICATION_FAILED" if response.status_code in {401, 403} else "UPSTREAM_HTTP_ERROR"
            raise TopolographError(code, "Topolograph returned an unsuccessful HTTP status.")
        try:
            return response.json()
        except Exception:
            return response.text

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": _MCP_PROTOCOL_VERSION,
            "Authorization": f"Bearer {self.__token}",
        }
        if self._session_id:
            headers["MCP-Session-Id"] = self._session_id
        return headers

    def _take_request_id(self) -> int:
        request_id = self._next_request_id
        self._next_request_id += 1
        return request_id

    @staticmethod
    def _header(response: requests.Response, name: str) -> str:
        headers = getattr(response, "headers", {})
        for key, value in headers.items():
            if key.lower() == name.lower():
                return str(value)
        return ""

    @staticmethod
    def _safe_string(value: Any) -> str:
        return value if isinstance(value, str) else "unknown"
