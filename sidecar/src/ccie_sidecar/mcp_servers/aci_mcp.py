#!/usr/bin/env python3
"""
Cisco ACI (APIC) MCP Server

Implements Model Context Protocol (JSON-RPC 2.0) to expose the APIC REST API as
a single unified tool. The APIC is rooted at https://<host>; auth is a login
cookie handled by the shared AciClient. Credentials arrive via ACI_* env vars
(injected by the Rust MCP transport).
"""

import json
import os
import sys
from typing import Dict, Any, Optional

from ccie_sidecar.aci import AciClient, _blast_radius

_client: Optional[AciClient] = None


def get_blast_radius(method: str, path: str) -> str:
    return _blast_radius(method, path)


def _get_client() -> AciClient:
    global _client
    if _client is None:
        _client = AciClient({
            "host": os.environ.get("ACI_HOST", ""),
            "username": os.environ.get("ACI_USERNAME", ""),
            "password": os.environ.get("ACI_PASSWORD", ""),
            "verify_ssl": os.environ.get("ACI_VERIFY_SSL", "0") == "1",
        })
    return _client


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None) -> Dict[str, Any]:
    """Call an APIC API endpoint. Returns {status_code, data, error, blast_radius}."""
    return _get_client().call(method, path, body, query_params)


def get_tool_description() -> str:
    return """Call the Cisco ACI (APIC) REST API.

The APIC is rooted at https://<host>. Authentication (login cookie) is handled
for you — do NOT call /api/aaaLogin yourself. Every path carries its own prefix.

RESPONSE SHAPE: {"status_code", "data", "error", "blast_radius"}. Check
status_code < 400 before trusting data. APIC wraps results as
{"totalCount": "N", "imdata": [ { "<className>": {"attributes": {...}} }, ... ]}.

TWO QUERY STYLES:
  CLASS queries (all objects of a type, fabric-wide):
    GET /api/node/class/<moClass>.json
    e.g. /api/node/class/fvTenant.json        (all tenants)
         /api/node/class/fvAEPg.json          (all EPGs)
         /api/node/class/fvBD.json            (all bridge domains)
         /api/node/class/topSystem.json       (all nodes/controllers)
         /api/node/class/fabricHealthTotal.json (fabric health)
  MO queries (one managed object by distinguished name / DN):
    GET /api/node/mo/<dn>.json
    e.g. /api/node/mo/uni/tn-common.json      (the 'common' tenant)
         /api/node/mo/topology/health.json    (overall fabric health)

USEFUL QUERY PARAMS (pass via query_params):
  query-target=children|subtree            scope of the query
  rsp-subtree=children|full                include child MOs in the response
  target-subtree-class=<class>             filter subtree to a class
  query-target-filter=eq(fvTenant.name,"X") filter by attribute
  order-by, page, page-size                pagination

COMMON ENDPOINTS:
  GET /api/node/class/fvTenant.json          List tenants
  GET /api/node/class/fvAEPg.json            List EPGs
  GET /api/node/class/fvBD.json              List bridge domains
  GET /api/node/class/fvCtx.json             List VRFs
  GET /api/node/class/vzBrCP.json            List contracts
  GET /api/node/class/l3extOut.json          List L3Outs
  GET /api/node/class/bgpPeer.json           BGP peers
  GET /api/node/class/topSystem.json         Fabric nodes + controllers
  GET /api/node/class/fabricNode.json        Fabric inventory
  GET /api/node/class/faultInst.json         Active faults
  GET /api/node/mo/uni/tn-<name>.json        A tenant by name
  POST /api/node/mo/uni/tn-<name>.json       Create/modify a tenant (write — gated)

WRITES: POST a managed object (the JSON body is the MO tree) to its DN path;
DELETE removes it. Writes take effect on the LIVE fabric immediately and require
approval. Consult this catalog — do NOT brute-force DNs."""


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "aci-mcp", "version": "1.0.0"},
                "capabilities": {"tools": {}},
            },
        }

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "aci_api_call",
                        "description": get_tool_description(),
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "method": {
                                    "type": "string",
                                    "enum": ["GET", "POST", "DELETE"],
                                    "description": "HTTP method",
                                },
                                "path": {
                                    "type": "string",
                                    "description": "API path (e.g., '/api/node/class/fvTenant.json')",
                                },
                                "body": {
                                    "type": "object",
                                    "description": "Request body (MO tree) for POST (optional)",
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

        if tool_name != "aci_api_call":
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
