#!/usr/bin/env python3
"""
Cisco Stealthwatch Enterprise MCP Server

Implements Model Context Protocol (JSON-RPC 2.0) to expose Stealthwatch REST API
as a single unified tool with blast radius classification for approval gating.
"""

import json
import os
import sys
from typing import Dict, Any, Optional

# The real auth/call logic lives in the shared StealthwatchClient so the MCP
# server and the in-sandbox `stealthwatch_api_call` helper can't drift. The SMC
# sets XSRF-TOKEN + stealthwatch.jwt cookies on login (NOT JSESSIONID), which a
# persistent requests.Session carries automatically.
from ccie_sidecar.stealthwatch import StealthwatchClient, _blast_radius

# Single client reused across tool calls; reads creds from the STEALTHWATCH_*
# env vars the Rust MCP transport injects.
_client: Optional[StealthwatchClient] = None


def get_blast_radius(method: str, path: str) -> str:
    """Determine blast radius tier for approval policy."""
    return _blast_radius(method, path)


def _get_client() -> StealthwatchClient:
    global _client
    if _client is None:
        _client = StealthwatchClient({
            "host": os.environ.get("STEALTHWATCH_HOST", ""),
            "username": os.environ.get("STEALTHWATCH_USERNAME", ""),
            "password": os.environ.get("STEALTHWATCH_PASSWORD", ""),
            "verify_ssl": os.environ.get("STEALTHWATCH_VERIFY_SSL", "1") == "1",
        })
    return _client


def authenticate() -> bool:
    """Authenticate with Stealthwatch and cache the session. Returns success."""
    return _get_client()._authenticate()


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None) -> Dict[str, Any]:
    """Call a Stealthwatch API endpoint with session authentication.

    Returns a dict with keys: status_code, data, error, blast_radius.
    """
    return _get_client().call(method, path, body, query_params)


def get_tool_description() -> str:
    """
    Get comprehensive tool description with embedded API catalog.

    This is the primary guidance for agents on how to use the API.
    """
    return """Call Cisco Stealthwatch Enterprise REST API.

BLAST RADIUS TIERS:
- low: GET operations (read-only, auto-allowed)
- medium: POST/PUT for queries, non-destructive writes
- high: Configuration changes (tags, policies, custom security events)
- destructive: DELETE operations

COMMON ENDPOINTS:

SECURITY-EVENT TYPES (catalog of event types — a single GET) (low):
  GET /sw-reporting/v1/tenants/{tenantId}/security-events/templates
    The catalog of security-event TYPES. Use this for "what event types exist".
    Returns {"data": [{"id", "name", "description"}]} (~100 types, e.g. SYN Flood,
    Host Lock Violation). There is NO /sw-reporting/v1/security-event-types (404).

SECURITY EVENTS & FLOWS (low):
  GET /sw-reporting/v1/tenants/{tenantId}/security-events/queries
    Retrieve security event queries for threat analysis
    Parameters: tenantId (path), startTime, endTime (query)

  GET /sw-reporting/v1/tenants/{tenantId}/flows/queries
    Retrieve flow query data for network analysis
    Parameters: tenantId (path), limit, offset (query)

  GET /sw-reporting/v1/tenants/{tenantId}/security-events/results/{queryId}
    Get results for a specific security event query
    Parameters: tenantId, queryId (path)

  GET /sw-reporting/v1/tenants/{tenantId}/flows/top-hosts
    Get top hosts by traffic volume
    Parameters: tenantId (path), startTime, endTime (query)

HOSTS & INVENTORY (low):
  GET /sw-reporting/v1/tenants/{tenantId}/hosts
    Get list of all monitored hosts
    Parameters: tenantId (path), filter (query)

  GET /sw-reporting/v1/tenants/{tenantId}/host-groups
    Get configured host groups
    Parameters: tenantId (path)

  GET /sw-reporting/v1/tenants/{tenantId}/hosts/{hostId}
    Get detailed information for specific host
    Parameters: tenantId, hostId (path)

QUERIES (medium):
  POST /sw-reporting/v1/tenants/{tenantId}/flows/queries
    Create a new flow query for analysis
    Body: {startTime: "ISO8601", endTime: "ISO8601", filters: [...], orderBy: "...", limit: int}

  POST /sw-reporting/v1/tenants/{tenantId}/security-events/queries
    Create security event query
    Body: {startTime: "ISO8601", endTime: "ISO8601", eventTypes: [...], severity: int}

CONFIGURATION (high):
  POST /smc-configuration/rest/v1/tenants/{tenantId}/tags
    Create new tag for host classification
    Body: {name: "string", ranges: ["CIDR", ...], description: "string"}

  PUT /smc-configuration/rest/v1/tenants/{tenantId}/tags/{id}
    Update existing tag configuration
    Body: {name: "string", ranges: ["CIDR", ...], description: "string"}

  POST /smc-configuration/rest/v1/tenants/{tenantId}/custom-security-events
    Create custom security event rule
    Body: {name: "string", conditions: {...}, severity: int, actions: [...]}

  PUT /smc-configuration/rest/v1/tenants/{tenantId}/policies/{policyId}
    Update policy configuration
    Body: {policy configuration object}

USER MANAGEMENT (high):
  GET /smc-configuration/rest/v1/tenants/{tenantId}/users
    Get list of users

  POST /smc-configuration/rest/v1/tenants/{tenantId}/users
    Create new user account
    Body: {username: "string", password: "string", role: "string", email: "string"}

  PUT /smc-configuration/rest/v1/tenants/{tenantId}/users/{userId}
    Update user information or password
    Body: {password: "string", role: "string", email: "string"}

DESTRUCTIVE OPERATIONS (destructive):
  DELETE /smc-configuration/rest/v1/tenants/{tenantId}/tags/{id}
    Permanently delete tag

  DELETE /smc-configuration/rest/v1/tenants/{tenantId}/custom-security-events/{id}
    Permanently delete custom security event rule

  DELETE /smc-configuration/rest/v1/tenants/{tenantId}/users/{userId}
    Permanently delete user account

NOTES:
- All timestamps should be ISO 8601 format (e.g., "2024-06-17T10:00:00Z")
- Tenant ID is typically returned in authentication response
- Most endpoints support pagination via limit/offset query parameters
- Filter syntax varies by endpoint - consult Stealthwatch API docs for specifics
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
                    "name": "stealthwatch-mcp",
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
                        "name": "stealthwatch_api_call",
                        "description": get_tool_description(),
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "method": {
                                    "type": "string",
                                    "enum": ["GET", "POST", "PUT", "DELETE"],
                                    "description": "HTTP method"
                                },
                                "path": {
                                    "type": "string",
                                    "description": "API endpoint path (e.g., '/sw-reporting/v1/tenants/123/flows/queries')"
                                },
                                "body": {
                                    "type": "object",
                                    "description": "Request body for POST/PUT (optional)"
                                },
                                "query_params": {
                                    "type": "object",
                                    "description": "URL query parameters as key-value pairs (optional)"
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

        if tool_name != "stealthwatch_api_call":
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
        result = call_api(api_method, api_path, api_body, api_query)

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
