#!/usr/bin/env python3
"""Juniper Mist MCP Server.

Implements Model Context Protocol (JSON-RPC 2.0) to expose the Juniper Mist REST
API as a single unified tool. The single `mist_api_call` tool reaches one
regional host under the `/api/v1` prefix, authenticated with a static API token.
Auth + host routing live in the shared MistClient so the MCP server and the
in-sandbox helper can't drift.
"""

import json
import os
import sys
from typing import Dict, Any, Optional

from ccie_sidecar.mist import MistClient, MIST_CAPABILITIES_DOC, _blast_radius

_client: Optional[MistClient] = None


def get_blast_radius(method: str, path: str) -> str:
    return _blast_radius(method, path)


def _get_client() -> MistClient:
    global _client
    if _client is None:
        _client = MistClient({
            "region": os.environ.get("MIST_REGION", "global01"),
            "api_token": os.environ.get("MIST_API_TOKEN", ""),
            "verify_ssl": os.environ.get("MIST_VERIFY_SSL", "1") == "1",
        })
    return _client


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None) -> Dict[str, Any]:
    return _get_client().call(method, path, body, query_params)


def get_tool_description() -> str:
    return (
        "Call the Juniper Mist REST API.\n\n"
        "ONE TOOL: mist_api_call(method, path, body=None, query_params=None)\n"
        "Host + auth are resolved automatically; you supply only method + path "
        "(+ body/query). Paths start at /api/v1.\n"
        "BLAST RADIUS (metadata only, never blocks): GET=low, POST/PUT/PATCH=medium, "
        "DELETE=destructive.\n\n"
        + MIST_CAPABILITIES_DOC
    )


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {"jsonrpc": "2.0", "id": req_id, "result": {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "mist-mcp", "version": "1.0.0"},
            "capabilities": {"tools": {}},
        }}

    elif method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": [{
            "name": "mist_api_call",
            "description": get_tool_description(),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "method": {"type": "string",
                               "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
                               "description": "HTTP method"},
                    "path": {"type": "string",
                             "description": "API endpoint path under /api/v1 "
                                            "(e.g., '/api/v1/self' or '/api/v1/orgs/{org_id}/sites')"},
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
        if tool_name != "mist_api_call":
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
