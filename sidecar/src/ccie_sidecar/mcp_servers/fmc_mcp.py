#!/usr/bin/env python3
"""
Cisco Secure Firewall Management Center (FMC) MCP Server

Implements Model Context Protocol (JSON-RPC 2.0) to expose the FMC REST API as a
single unified tool. Auth (token + default domain UUID) is handled by the shared
FmcClient. Credentials arrive via FMC_* env vars (injected by the Rust MCP
transport).
"""

import json
import os
import sys
from typing import Dict, Any, Optional

from ccie_sidecar.fmc import FmcClient, _blast_radius

_client: Optional[FmcClient] = None


def get_blast_radius(method: str, path: str) -> str:
    return _blast_radius(method, path)


def _get_client() -> FmcClient:
    global _client
    if _client is None:
        _client = FmcClient({
            "host": os.environ.get("FMC_HOST", ""),
            "username": os.environ.get("FMC_USERNAME", ""),
            "password": os.environ.get("FMC_PASSWORD", ""),
            "domain_uuid": os.environ.get("FMC_DOMAIN_UUID", ""),
            "verify_ssl": os.environ.get("FMC_VERIFY_SSL", "0") == "1",
        })
    return _client


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None) -> Dict[str, Any]:
    """Call an FMC API endpoint. Returns {status_code, data, error, blast_radius}."""
    return _get_client().call(method, path, body, query_params)


def get_tool_description() -> str:
    return """Call the Cisco Secure Firewall Management Center (FMC) REST API.

Auth (token + default domain UUID) is handled for you — do NOT call
/auth/generatetoken yourself. Config resources live under
/api/fmc_config/v1/domain/{domainUUID}/...  Use the LITERAL "{domainUUID}" in
your path and it is auto-filled with the default domain. Platform resources live
under /api/fmc_platform/v1/...

RESPONSE SHAPE: {"status_code", "data", "error", "blast_radius"}. Check
status_code < 400 before trusting data. List endpoints return
{"items": [...], "paging": {...}}; pass query_params {"limit": N, "offset": M}
and {"expanded": true} for full objects.

COMMON ENDPOINTS:
  GET /api/fmc_platform/v1/info/serverversion              FMC version
  GET /api/fmc_platform/v1/info/domain                     List domains
  GET /api/fmc_config/v1/domain/{domainUUID}/devices/devicerecords   Managed FTDs
  GET /api/fmc_config/v1/domain/{domainUUID}/policy/accesspolicies   Access policies
  GET /api/fmc_config/v1/domain/{domainUUID}/policy/accesspolicies/{policyId}/accessrules
       Rules within an access policy
  GET /api/fmc_config/v1/domain/{domainUUID}/object/networks         Network objects
  GET /api/fmc_config/v1/domain/{domainUUID}/object/hosts            Host objects
  GET /api/fmc_config/v1/domain/{domainUUID}/object/ports            Port objects

WRITES: POST/PUT/DELETE to policy, rule and object paths change firewall
configuration and require approval. Many rule operations need the parent
accesspolicy container UUID in the path. Consult Cisco's FMC API explorer for
exact object schemas; do NOT brute-force unknown paths."""


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "fmc-mcp", "version": "1.0.0"},
                "capabilities": {"tools": {}},
            },
        }

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "fmc_api_call",
                        "description": get_tool_description(),
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "method": {
                                    "type": "string",
                                    "enum": ["GET", "POST", "PUT", "DELETE"],
                                    "description": "HTTP method",
                                },
                                "path": {
                                    "type": "string",
                                    "description": "API path; use literal {domainUUID} for the default domain",
                                },
                                "body": {
                                    "type": "object",
                                    "description": "Request body for POST/PUT (optional)",
                                },
                                "query_params": {
                                    "type": "object",
                                    "description": "URL query parameters (e.g. limit/offset/expanded) (optional)",
                                },
                            },
                            "required": ["method", "path"],
                        },
                    }
                ]
            },
        }

    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})

        if tool_name != "fmc_api_call":
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
            return {
                "jsonrpc": "2.0", "id": req_id,
                "result": {
                    "content": [{"type": "text",
                                 "text": f"Error: {result['error']}\nStatus: {result['status_code']}"}],
                    "blast_radius": get_blast_radius(api_method, api_path),
                },
            }

        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(result["data"], indent=2)}],
                "blast_radius": get_blast_radius(api_method, api_path),
            },
        }

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
