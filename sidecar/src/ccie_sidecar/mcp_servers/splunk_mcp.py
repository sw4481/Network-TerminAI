#!/usr/bin/env python3
"""
Cisco Splunk MCP Server

Implements Model Context Protocol (JSON-RPC 2.0) to expose the Splunk Enterprise
REST API as a single unified tool. Splunk's management API listens on HTTPS port
8089; the shared SplunkClient handles Bearer-token or HTTP-Basic auth and the
output_mode=json convention.
"""

import json
import os
import sys
from typing import Dict, Any, Optional

from ccie_sidecar.splunk import SplunkClient, _blast_radius

_client: Optional[SplunkClient] = None


def get_blast_radius(method: str, path: str) -> str:
    return _blast_radius(method, path)


def _get_client() -> SplunkClient:
    global _client
    if _client is None:
        try:
            port = int(os.environ.get("SPLUNK_PORT", "8089"))
        except ValueError:
            port = 8089
        _client = SplunkClient({
            "host": os.environ.get("SPLUNK_HOST", ""),
            "port": port,
            "token": os.environ.get("SPLUNK_TOKEN", ""),
            "username": os.environ.get("SPLUNK_USERNAME", ""),
            "password": os.environ.get("SPLUNK_PASSWORD", ""),
            "verify_ssl": os.environ.get("SPLUNK_VERIFY_SSL", "0") == "1",
        })
    return _client


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None) -> Dict[str, Any]:
    """Call a Splunk REST endpoint. Returns {status_code, data, error, blast_radius}."""
    return _get_client().call(method, path, body, query_params)


def get_tool_description() -> str:
    return """Call the Cisco Splunk Enterprise REST API.

Splunk's management API is rooted at https://<host>:8089. Authentication
(Bearer token or HTTP Basic) is handled for you. Responses default to JSON
(output_mode=json is added automatically on GETs).

RESPONSE SHAPE: {"status_code", "data", "error", "blast_radius"}. Check
status_code < 400 before trusting data. Config objects (indexes, saved
searches, server info) come back under data["entry"] (each item has "name" and
"content"); search output comes back under data["results"].

COMMON ENDPOINTS:

SERVER / HEALTH:
  GET  /services/server/info                 Server version + health

INDEXES:
  GET  /services/data/indexes                List indexes (rows under data["entry"], name in entry[].name)

SAVED SEARCHES / ALERTS:
  GET  /services/saved/searches              List saved searches and alerts
  POST /services/saved/searches              Create a saved search (form body: name, search, ...)

SEARCH (one-shot, synchronous — easiest):
  POST /services/search/jobs/export          body={"search": "search index=_internal | head 5",
                                                   "earliest_time": "-15m", "output_mode": "json"}
                                             Returns newline-delimited JSON events (data is raw text).

SEARCH (async job + poll):
  POST /services/search/jobs                 body={"search": "search ..."} -> returns a job; sid under
                                             data["sid"] (request output_mode=json).
  GET  /services/search/jobs/<sid>           Poll status; done when content.dispatchState == "DONE".
  GET  /services/search/jobs/<sid>/results   Results under data["results"].

SPL RULE: a search string must be prefixed with "search " unless it already
starts with "|" (a generating command). Use earliest_time / latest_time to
bound the window (e.g. "-15m", "-24h", "now").

NOTES:
- Self-signed certs are common; the Verify SSL toggle in Settings -> Splunk
  controls verification.
- POST bodies are form-encoded, not JSON — just pass a flat dict of fields.
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
                "serverInfo": {"name": "splunk-mcp", "version": "1.0.0"},
                "capabilities": {"tools": {}},
            },
        }

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "splunk_api_call",
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
                                    "description": "API path from host root (e.g., '/services/data/indexes')",
                                },
                                "body": {
                                    "type": "object",
                                    "description": "Form-encoded request body for POST/PUT (optional)",
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

        if tool_name != "splunk_api_call":
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
