#!/usr/bin/env python3
"""
Cisco Identity Services Engine (ISE) MCP Server

Implements Model Context Protocol (JSON-RPC 2.0) to expose the ISE REST API as a
single unified tool with blast radius classification for approval gating.

ISE has three surfaces (ERS port 9060, OpenAPI/MnT port 443) reachable with the
same admin Basic-Auth credentials. The single `ise_api_call` tool dispatches
across all three: the surface (and port) is inferred from the path prefix.
"""

import json
import os
import sys
from typing import Dict, Any, Optional

# The real auth/call logic lives in the shared IseClient so the MCP server and
# the in-sandbox `ise_api_call` helper can't drift.
from ccie_sidecar.ise import IseClient, _blast_radius

# Single client reused across tool calls; reads creds from the ISE_* env vars
# the Rust MCP transport injects.
_client: Optional[IseClient] = None


def get_blast_radius(method: str, path: str) -> str:
    """Determine blast radius tier for approval policy."""
    return _blast_radius(method, path)


def _get_client() -> IseClient:
    global _client
    if _client is None:
        _client = IseClient({
            "host": os.environ.get("ISE_HOST", ""),
            "username": os.environ.get("ISE_USERNAME", ""),
            "password": os.environ.get("ISE_PASSWORD", ""),
            "verify_ssl": os.environ.get("ISE_VERIFY_SSL", "1") == "1",
        })
    return _client


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None,
             base: Optional[str] = None) -> Dict[str, Any]:
    """Call an ISE API endpoint.

    Returns a dict with keys: status_code, data, error, blast_radius.
    """
    return _get_client().call(method, path, body, query_params, base)


def get_tool_description() -> str:
    """
    Get comprehensive tool description with embedded API catalog.

    This is the primary guidance for agents on how to use the API.
    """
    return """Call the Cisco Identity Services Engine (ISE) REST API.

ISE HAS THREE SURFACES (the port is inferred from the path prefix, or set `base`):
- ERS     (/ers/config/...)   port 9060 - classic config API (Basic Auth, JSON)
- OpenAPI (/api/v1/...)        port 443  - newer config API (same creds)
- MnT     (/admin/API/mnt/...) port 443  - read-only monitoring (sessions, health)

BLAST RADIUS TIERS:
- low: GET operations + all MnT calls (read-only, auto-allowed)
- medium: POST/PUT non-config writes
- high: config changes to network devices, identity/endpoint groups, users,
        SGTs/TrustSec, policy
- destructive: DELETE operations

ERS LIST PAGING & FILTERING:
- List endpoints wrap results under {"SearchResult": {"total": N, "resources": [...]}}.
  Each resource is a stub {id, name, link}; GET the resource by id for full detail.
- Page with ?size=<1-100>&page=<n>. Filter with ?filter=<field>.<op>.<value>
  (e.g. ?filter=name.CONTAINS.switch). Do NOT invent other query keys.

COMMON ENDPOINTS:

NETWORK DEVICES (ERS):
  GET    /ers/config/networkdevice                 List NADs (low)
  GET    /ers/config/networkdevice/{id}            Device detail (low)
  GET    /ers/config/networkdevice/name/{name}     Lookup by name (low)
  POST   /ers/config/networkdevice                 Create NAD (high)
    Body: {"NetworkDevice": {"name": "...", "NetworkDeviceIPList": [{"ipaddress": "...", "mask": 32}], "authenticationSettings": {"radiusSharedSecret": "..."}}}
  DELETE /ers/config/networkdevice/{id}            Delete NAD (destructive)

ENDPOINTS & GROUPS (ERS):
  GET  /ers/config/endpoint                        List endpoints (low)
  GET  /ers/config/endpoint/{id}                   Endpoint detail (low)
  GET  /ers/config/endpoint?filter=mac.EQ.{MAC}    Find by MAC (low)
  GET  /ers/config/endpointgroup                   List endpoint identity groups (low)
  POST /ers/config/endpoint                        Register endpoint (high)
    Body: {"ERSEndPoint": {"mac": "AA:BB:CC:DD:EE:FF", "groupId": "...", "staticGroupAssignment": true}}

IDENTITY (ERS):
  GET  /ers/config/identitygroup                   List user identity groups (low)
  GET  /ers/config/internaluser                    List internal users (low)
  POST /ers/config/internaluser                    Create internal user (high)
    Body: {"InternalUser": {"name": "...", "password": "...", "identityGroups": "..."}}

TRUSTSEC / SGT (ERS):
  GET  /ers/config/sgt                             List Security Group Tags (low)
  POST /ers/config/sgt                             Create SGT (high)

POLICY (OpenAPI, base="openapi"):
  GET  /api/v1/policy/network-access/policy-set    List policy sets (low)
  GET  /api/v1/trustsec/sgacl                       List SGACLs (low)

MONITORING (MnT, base="mnt", read-only):
  GET  /admin/API/mnt/Version                       MnT/ISE version (low)
  GET  /admin/API/mnt/Session/ActiveList            Active auth sessions (low)
  GET  /admin/API/mnt/Session/ActiveCount           Active session count (low)
  GET  /admin/API/mnt/Session/MACAddress/{mac}      Session detail by MAC (low)
  GET  /admin/API/mnt/FailureReasons                Auth failure reason catalog (low)

NOTES:
- ERS must be enabled in ISE: Admin -> System -> Settings -> API Settings -> ERS.
- Self-signed certs are common; the Verify SSL toggle in Settings -> ISE controls
  verification.
- Responses are returned as {"status_code", "data", "error", "blast_radius"};
  check status_code < 400 before trusting data.
"""


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle a single JSON-RPC 2.0 request.

    Args:
        request: Dict with keys: jsonrpc, id, method, params

    Returns:
        Dict with keys: jsonrpc, id, result or error
    """
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {
                    "name": "ise-mcp",
                    "version": "1.0.0"
                },
                "capabilities": {
                    "tools": {}
                }
            }
        }

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "ise_api_call",
                        "description": get_tool_description(),
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "method": {
                                    "type": "string",
                                    "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
                                    "description": "HTTP method"
                                },
                                "path": {
                                    "type": "string",
                                    "description": "API endpoint path (e.g., '/ers/config/networkdevice')"
                                },
                                "body": {
                                    "type": "object",
                                    "description": "Request body for POST/PUT/PATCH (optional)"
                                },
                                "query_params": {
                                    "type": "object",
                                    "description": "URL query parameters as key-value pairs (optional, e.g. {\"size\": 100, \"filter\": \"name.CONTAINS.switch\"})"
                                },
                                "base": {
                                    "type": "string",
                                    "enum": ["ers", "openapi", "mnt"],
                                    "description": "Force the API surface/port. Optional; inferred from the path prefix when omitted."
                                }
                            },
                            "required": ["method", "path"]
                        }
                    }
                ]
            }
        }

    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})

        if tool_name != "ise_api_call":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32602,
                    "message": f"Unknown tool: {tool_name}"
                }
            }

        # Extract arguments
        api_method = arguments.get("method")
        api_path = arguments.get("path")
        api_body = arguments.get("body")
        api_query = arguments.get("query_params")
        api_base = arguments.get("base")

        if not api_method or not api_path:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32602,
                    "message": "Missing required arguments: method and path"
                }
            }

        # Call API
        result = call_api(api_method, api_path, api_body, api_query, api_base)

        # Check for errors
        if result["error"]:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": f"Error: {result['error']}\nStatus: {result['status_code']}"
                        }
                    ],
                    "blast_radius": get_blast_radius(api_method, api_path)
                }
            }

        # Return success
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(result["data"], indent=2)
                    }
                ],
                "blast_radius": get_blast_radius(api_method, api_path)
            }
        }

    else:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {
                "code": -32601,
                "message": f"Method not found: {method}"
            }
        }


def main():
    """Main loop: read JSON-RPC requests from stdin, write responses to stdout."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            response = handle_request(request)
            print(json.dumps(response), flush=True)
        except json.JSONDecodeError as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32700,
                    "message": f"Parse error: {str(e)}"
                }
            }
            print(json.dumps(error_response), flush=True)
        except Exception as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32603,
                    "message": f"Internal error: {str(e)}"
                }
            }
            print(json.dumps(error_response), flush=True)


if __name__ == "__main__":
    main()
