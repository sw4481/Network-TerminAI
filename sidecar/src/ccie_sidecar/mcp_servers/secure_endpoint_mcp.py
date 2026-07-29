#!/usr/bin/env python3
"""Cisco Secure Endpoint (AMP for Endpoints) MCP Server.

Implements Model Context Protocol (JSON-RPC 2.0) to expose the Secure Endpoint
REST API as a single unified tool. The single `secure_endpoint_api_call` tool
hits one regional host; v1 uses Basic auth, v3 uses an OAuth bearer (set in
Settings). Auth + host live in the shared SecureEndpointClient so the MCP server
and the in-sandbox helper can't drift.
"""

import json
import os
import sys
from typing import Dict, Any, Optional

from ccie_sidecar.secure_endpoint import SecureEndpointClient, _blast_radius

_client: Optional[SecureEndpointClient] = None


def get_blast_radius(method: str, path: str) -> str:
    return _blast_radius(method, path)


def _get_client() -> SecureEndpointClient:
    global _client
    if _client is None:
        _client = SecureEndpointClient({
            "region": os.environ.get("SECURE_ENDPOINT_REGION", "nam"),
            "auth_mode": os.environ.get("SECURE_ENDPOINT_AUTH_MODE", "v1_basic"),
            "client_id": os.environ.get("SECURE_ENDPOINT_CLIENT_ID", ""),
            "api_key": os.environ.get("SECURE_ENDPOINT_API_KEY", ""),
            "verify_ssl": os.environ.get("SECURE_ENDPOINT_VERIFY_SSL", "1") == "1",
        })
    return _client


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None) -> Dict[str, Any]:
    return _get_client().call(method, path, body, query_params)


def get_tool_description() -> str:
    return """Call the Cisco Secure Endpoint (AMP for Endpoints) REST API.

ONE TOOL: secure_endpoint_api_call(method, path, body=None, query_params=None)
Host + auth are resolved from Settings; you supply only method + path (+ body/query).
Responses: {"status_code", "data", "error", "blast_radius"} - check status_code < 400.

API VERSION: v1 (Basic auth, default) or v3 (OAuth bearer) - set in Settings.
Paths below are v1. The v1 response envelope is {"version","metadata","data"};
the rows you want are under "data". Page with query_params {"limit":N,"offset":M}
(limit max 500). metadata.results.total gives the full count.

BLAST RADIUS (metadata only, never blocks): GET=low, POST/PUT/PATCH=medium, DELETE=destructive.

ENDPOINTS (v1):

COMPUTERS (endpoints):
  GET /v1/computers                          List computers (low)
    Filters: query_params {"hostname[]":"foo","group_guid[]":"...","internal_ip":"..."}
  GET /v1/computers/{guid}                   Computer detail (low)
  GET /v1/computers/{guid}/trajectory        File/network activity timeline (low)
  GET /v1/computers/{guid}/activity          Recent activity (low)
  GET /v1/computers/activity                 Find computers by activity; query_params {"q":"<ip|hostname|url>"} (low)

ISOLATION (network quarantine of a host):
  GET    /v1/computers/{guid}/isolation      Isolation status (low)
  PUT    /v1/computers/{guid}/isolation      Start isolation (medium); body {"comment":"reason"}
  DELETE /v1/computers/{guid}/isolation      Stop isolation (destructive)

EVENTS:
  GET /v1/events                             List events (low)
    Filters: query_params {"detection_id[]":"","event_type[]":"","group_guid[]":"","start_date":"ISO8601"}
  GET /v1/event_types                        Event type catalog (low)

GROUPS & POLICIES:
  GET   /v1/groups                           List groups (low)
  GET   /v1/groups/{guid}                     Group detail (low)
  PATCH /v1/groups/{guid}                     Reassign group policy (medium)
  GET   /v1/policies                          List policies (low)
  GET   /v1/policies/{guid}                   Policy detail (low)

MOVE A COMPUTER TO A GROUP:
  PATCH /v1/computers/{guid}                  body {"group_guid":"<dest-group-guid>"} (medium)

VULNERABILITIES:
  GET /v1/vulnerabilities                    Hosts with vulnerable apps (low)
  GET /v1/computers/{guid}/vulnerabilities   Per-host vulns (low)

FILE LISTS (allow/block lists):
  GET    /v1/file_lists                      List file lists (low)
  GET    /v1/file_lists/{guid}/files         Items in a list (low)
  POST   /v1/file_lists/{guid}/files/{sha256} Add SHA256 (medium)
  DELETE /v1/file_lists/{guid}/files/{sha256} Remove SHA256 (destructive)

SANITY:
  GET /v1/version                            API version (low)

NOTES:
- connector_guid identifies a computer; group_guid/policy_guid identify groups/policies.
- Dates are ISO-8601, times UTC. Find a host's guid via GET /v1/computers first.
- v3 paths differ (/v3/organizations/{org}/...); prefer v1 unless told otherwise.
- Responses are {"status_code","data","error","blast_radius"}; check status_code < 400.
"""


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {"jsonrpc": "2.0", "id": req_id, "result": {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "secure-endpoint-mcp", "version": "1.0.0"},
            "capabilities": {"tools": {}},
        }}

    elif method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": [{
            "name": "secure_endpoint_api_call",
            "description": get_tool_description(),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "method": {"type": "string",
                               "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
                               "description": "HTTP method"},
                    "path": {"type": "string",
                             "description": "API endpoint path (e.g., '/v1/computers')"},
                    "body": {"type": "object",
                             "description": "Request body for POST/PUT/PATCH (optional)"},
                    "query_params": {"type": "object",
                                     "description": "URL query parameters (optional, e.g. {\"limit\": 100})"},
                },
                "required": ["method", "path"],
            },
        }]}}

    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        if tool_name != "secure_endpoint_api_call":
            return {"jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32602, "message": f"Unknown tool: {tool_name}"}}
        api_method = arguments.get("method")
        api_path = arguments.get("path")
        api_body = arguments.get("body")
        api_query = arguments.get("query_params")
        if not api_method or not api_path:
            return {"jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32602, "message": "Missing required arguments: method and path"}}
        result = call_api(api_method, api_path, api_body, api_query)
        if result["error"]:
            return {"jsonrpc": "2.0", "id": req_id, "result": {
                "content": [{"type": "text",
                             "text": f"Error: {result['error']}\nStatus: {result['status_code']}"}],
                "blast_radius": get_blast_radius(api_method, api_path),
            }}
        return {"jsonrpc": "2.0", "id": req_id, "result": {
            "content": [{"type": "text", "text": json.dumps(result["data"], indent=2)}],
            "blast_radius": get_blast_radius(api_method, api_path),
        }}

    else:
        return {"jsonrpc": "2.0", "id": req_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            response = handle_request(request)
            print(json.dumps(response), flush=True)
        except json.JSONDecodeError as e:
            print(json.dumps({"jsonrpc": "2.0", "id": None,
                              "error": {"code": -32700, "message": f"Parse error: {str(e)}"}}), flush=True)
        except Exception as e:
            print(json.dumps({"jsonrpc": "2.0", "id": None,
                              "error": {"code": -32603, "message": f"Internal error: {str(e)}"}}), flush=True)


if __name__ == "__main__":
    main()
