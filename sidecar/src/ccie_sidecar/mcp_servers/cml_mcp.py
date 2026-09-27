#!/usr/bin/env python3
"""
Cisco Modeling Labs (CML) MCP Server

Implements Model Context Protocol (JSON-RPC 2.0) to expose the CML REST API as a
single unified tool. CML uses a single base URL (https://<host>/api/v0) secured
with a Bearer JWT; the shared CmlClient handles authentication.
"""

import json
import os
import sys
from typing import Dict, Any, Optional

from ccie_sidecar.cml import CmlClient, _blast_radius

_client: Optional[CmlClient] = None


def get_blast_radius(method: str, path: str) -> str:
    return _blast_radius(method, path)


def _get_client() -> CmlClient:
    global _client
    if _client is None:
        _client = CmlClient({
            "host": os.environ.get("CML_HOST", ""),
            "username": os.environ.get("CML_USERNAME", ""),
            "password": os.environ.get("CML_PASSWORD", ""),
            "verify_ssl": os.environ.get("CML_VERIFY_SSL", "0") == "1",
        })
    return _client


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None) -> Dict[str, Any]:
    """Call a CML API endpoint. Returns {status_code, data, error, blast_radius}."""
    return _get_client().call(method, path, body, query_params)


def get_tool_description() -> str:
    return """Call the Cisco Modeling Labs (CML) REST API.

CML exposes ONE base URL: https://<host>/api/v0. Authentication (Bearer JWT) is
handled for you — do NOT call /authenticate yourself. All paths below are
relative to /api/v0.

RESPONSE SHAPE: {"status_code", "data", "error", "blast_radius"}. Check
status_code < 400 before trusting data. Most list endpoints return JSON arrays
of IDs or objects.

COMMON ENDPOINTS:

LABS:
  GET    /labs                       List lab IDs
  POST   /labs                       Create a lab (body: {"title": "...", "description": "..."})
  GET    /labs/{lab_id}              Lab detail
  PATCH  /labs/{lab_id}              Update lab (body fields: title/description/notes)
  DELETE /labs/{lab_id}              Delete a lab
  GET    /labs/{lab_id}/state        Lab state (DEFINED_ON_CORE/STARTED/STOPPED)
  GET    /labs/{lab_id}/topology     Full topology (nodes + links + interfaces)
  PUT    /labs/{lab_id}/start        Start the lab
  PUT    /labs/{lab_id}/stop         Stop the lab
  PUT    /labs/{lab_id}/wipe         Wipe the lab (clears node state)

NODES:
  GET    /labs/{lab_id}/nodes        Nodes in a lab
  POST   /labs/{lab_id}/nodes        Add a node
  GET    /labs/{lab_id}/nodes/{id}   Node detail
  GET    /nodes                      All running nodes across all labs

DEFINITIONS & IMAGES:
  GET    /node_definitions           Available node types
  GET    /image_definitions          Available images
  GET    /simplified_node_definitions  Compact node type list

SYSTEM:
  GET    /system_information         Version + readiness
  GET    /system_health              Health status
  GET    /system_stats               Compute/cluster stats
  GET    /users                      List users
  GET    /groups                     List groups

NOTES:
- Self-signed certs are common; the Verify SSL toggle in Settings -> CML controls
  verification.
- Lab lifecycle (start/stop/wipe) and deletes take effect immediately on the
  live CML server.
"""


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "cml-mcp", "version": "1.0.0"},
                "capabilities": {"tools": {}},
            },
        }

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "cml_api_call",
                        "description": get_tool_description(),
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "method": {
                                    "type": "string",
                                    "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
                                    "description": "HTTP method",
                                },
                                "path": {
                                    "type": "string",
                                    "description": "API path under /api/v0 (e.g., '/labs')",
                                },
                                "body": {
                                    "type": "object",
                                    "description": "Request body for POST/PUT/PATCH (optional)",
                                },
                                "query_params": {
                                    "type": "object",
                                    "description": "URL query parameters as key-value pairs (optional)",
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

        if tool_name != "cml_api_call":
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
