#!/usr/bin/env python3
"""
Cisco ThousandEyes MCP Server

Implements Model Context Protocol (JSON-RPC 2.0) to expose the ThousandEyes API
v7 as a single unified tool. Auth is a single Bearer token handled by the shared
ThousandEyesClient. The token arrives via THOUSANDEYES_* env vars (injected by
the Rust MCP transport). Read-only.
"""

import json
import os
import sys
from typing import Dict, Any, Optional

from ccie_sidecar.thousandeyes import ThousandEyesClient, _blast_radius

_client: Optional[ThousandEyesClient] = None


def get_blast_radius(method: str, path: str) -> str:
    return _blast_radius(method, path)


def _get_client() -> ThousandEyesClient:
    global _client
    if _client is None:
        _client = ThousandEyesClient({
            "token": os.environ.get("THOUSANDEYES_TOKEN", ""),
            "account_group_id": os.environ.get("THOUSANDEYES_ACCOUNT_GROUP_ID", ""),
        })
    return _client


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None) -> Dict[str, Any]:
    """Call a ThousandEyes API endpoint. Returns {status_code, data, error, blast_radius}."""
    return _get_client().call(method, path, body, query_params)


def get_tool_description() -> str:
    return """Call the Cisco ThousandEyes API v7 (read-only).

Base URL https://api.thousandeyes.com. Authentication (Bearer token) is handled
for you. If an account group is configured it is applied as the `aid` query
param automatically; override it by passing query_params {"aid": "<id>"}.

RESPONSE SHAPE: {"status_code", "data", "error", "blast_radius"}. Check
status_code < 400 before trusting data. Most list endpoints return a JSON object
keyed by the resource name (e.g. {"tests": [...]}, {"agents": [...]}).

COMMON ENDPOINTS:
  GET /v7/account-groups                          Account groups visible to the token
  GET /v7/users                                   Users
  GET /v7/tests                                   All configured tests
  GET /v7/tests/{testId}                          One test's config
  GET /v7/agents                                  Cloud + enterprise agents
  GET /v7/test-results/{testId}/{testType}        Latest results for a test
       (testType: network|http-server|page-load|dns-server|bgp|...)
  GET /v7/test-results/{testId}/path-vis          Path visualization (hop-by-hop)
  GET /v7/dashboards                              Dashboards
  GET /v7/dashboards/{dashboardId}                One dashboard
  GET /v7/alerts                                  Active alerts (if licensed)

WORKFLOW: list /v7/tests to find a testId, then GET its results or path-vis.
This integration is read-only; do not attempt writes."""


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "thousandeyes-mcp", "version": "1.0.0"},
                "capabilities": {"tools": {}},
            },
        }

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "thousandeyes_api_call",
                        "description": get_tool_description(),
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "method": {
                                    "type": "string",
                                    "enum": ["GET"],
                                    "description": "HTTP method (read-only)",
                                },
                                "path": {
                                    "type": "string",
                                    "description": "API path (e.g., '/v7/tests')",
                                },
                                "query_params": {
                                    "type": "object",
                                    "description": "URL query parameters (e.g. aid, window) (optional)",
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

        if tool_name != "thousandeyes_api_call":
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
