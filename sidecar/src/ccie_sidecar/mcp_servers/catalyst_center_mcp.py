#!/usr/bin/env python3
"""
Cisco Catalyst Center (DNA Center) MCP Server

Implements Model Context Protocol (JSON-RPC 2.0) to expose the Catalyst Center
REST API as a single unified tool. Catalyst Center secures the Intent API with
a token obtained via HTTP Basic auth; the shared CatalystCenterClient handles
authentication and the X-Auth-Token header.
"""

import json
import os
import sys
from typing import Dict, Any, Optional

from ccie_sidecar.catalyst_center import CatalystCenterClient, _blast_radius

_client: Optional[CatalystCenterClient] = None


def get_blast_radius(method: str, path: str) -> str:
    return _blast_radius(method, path)


def _get_client() -> CatalystCenterClient:
    global _client
    if _client is None:
        _client = CatalystCenterClient({
            "host": os.environ.get("CATALYST_CENTER_HOST", ""),
            "username": os.environ.get("CATALYST_CENTER_USERNAME", ""),
            "password": os.environ.get("CATALYST_CENTER_PASSWORD", ""),
            "verify_ssl": os.environ.get("CATALYST_CENTER_VERIFY_SSL", "0") == "1",
        })
    return _client


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None) -> Dict[str, Any]:
    """Call a Catalyst Center API endpoint. Returns {status_code, data, error, blast_radius}."""
    return _get_client().call(method, path, body, query_params)


def get_tool_description() -> str:
    return """Call the Cisco Catalyst Center (DNA Center) REST API.

Catalyst Center exposes several API bases under one host. Pass the FULL path
from the host root. Authentication (HTTP Basic -> token -> X-Auth-Token header)
is handled for you — do NOT call the auth/token endpoint yourself.

API BASES:
  /dna/intent/api/v1   Intent API (most resources)
  /dna/intent/api/v2   Intent API v2 (a few newer resources)
  /dna/system/api/v1   System/auth API

RESPONSE SHAPE: {"status_code", "data", "error", "blast_radius"}. Check
status_code < 400 before trusting data. Most list endpoints return the rows
under data["response"].

COMMON ENDPOINTS:

DEVICES:
  GET  /dna/intent/api/v1/network-device              List devices (rows under data.response)
  GET  /dna/intent/api/v1/network-device/count        Device count
  GET  /dna/intent/api/v1/network-device/{id}         Device detail
  GET  /dna/intent/api/v1/device-detail               Device 360 (query: identifier, searchBy)
  GET  /dna/intent/api/v1/network-device/{id}/config  Running config

SITES & TOPOLOGY:
  GET  /dna/intent/api/v1/site                         List sites
  GET  /dna/intent/api/v1/topology/physical-topology   Physical topology
  GET  /dna/intent/api/v1/topology/l3/{topologyType}   L3 topology (OSPF/ISIS/etc.)
  GET  /dna/intent/api/v1/membership/{siteId}          Site membership

CLIENTS & HEALTH:
  GET  /dna/intent/api/v1/client-health                Client health
  GET  /dna/intent/api/v1/network-health               Network health
  GET  /dna/intent/api/v1/client-detail                Client detail (query: macAddress, timestamp)

TEMPLATES & CONFIG:
  GET  /dna/intent/api/v1/template-programmer/template  List config templates
  POST /dna/intent/api/v1/template-programmer/template/deploy  Deploy a template

COMMAND RUNNER:
  GET  /dna/intent/api/v1/network-device-poller/cli/legit-reads  Allowed show commands
  POST /dna/intent/api/v1/network-device-poller/cli/read-request  Run read-only CLI (returns taskId)

TASKS (async pattern):
  GET  /dna/intent/api/v1/task/{taskId}                Poll an async task result
  Many POST/PUT calls return {"response": {"taskId": "...", "url": "..."}}; poll
  the task endpoint until it reports progress/endTime.

SITE / DISCOVERY:
  GET  /dna/intent/api/v1/discovery                    List discoveries
  GET  /dna/intent/api/v1/global-credential            Global credentials

PAGINATION: most list endpoints take query_params {"offset": 1, "limit": 500}
(offset is 1-based). Default page size is small — pass limit explicitly.

NOTES:
- Self-signed certs are common; the Verify SSL toggle in Settings -> Catalyst
  Center controls verification.
- If a path 404s it is the wrong SHAPE — consult this catalog, do not
  brute-force endpoint names.
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
                "serverInfo": {"name": "catalyst-center-mcp", "version": "1.0.0"},
                "capabilities": {"tools": {}},
            },
        }

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "catalyst_center_api_call",
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
                                    "description": "Full API path from host root (e.g., '/dna/intent/api/v1/network-device')",
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

        if tool_name != "catalyst_center_api_call":
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
