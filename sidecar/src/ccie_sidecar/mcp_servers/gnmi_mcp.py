#!/usr/bin/env python3
"""
gNMI MCP Server

Implements Model Context Protocol (JSON-RPC 2.0) to expose gNMI (via pygnmi) as
a single unified `gnmi_call` tool. gNMI is multi-target gRPC, so the tool takes
an `op` (targets|capabilities|get|subscribe|set) plus a `target` name. Targets
arrive via the GNMI_TARGETS env var (a JSON array, injected by the Rust MCP
transport).
"""

import json
import os
import sys
from typing import Dict, Any, Optional

from ccie_sidecar.gnmi import GnmiHelper

_helper: Optional[GnmiHelper] = None


def _get_helper() -> GnmiHelper:
    global _helper
    if _helper is None:
        raw = os.environ.get("GNMI_TARGETS", "")
        try:
            targets = json.loads(raw) if raw else []
            if not isinstance(targets, list):
                targets = []
        except Exception:
            targets = []
        _helper = GnmiHelper(targets)
    return _helper


def get_tool_description() -> str:
    return """Run a gNMI operation (via pygnmi) against a configured target device.

gNMI is multi-target gRPC. Devices are configured in Settings -> gNMI; address
them BY NAME. Always call op="targets" first to see what's available.

RESPONSE SHAPE: {"ok": bool, "op": str, "data": <payload>, "error": str|None, "blast_radius": str}.

OPERATIONS (op):
  targets        List configured target names/hosts/ports/vendors. (no target needed)
  capabilities   Read-only: models, encodings, gNMI version a target supports.
  get            Read-only: fetch state/config at YANG path(s).
                 args: paths (list of YANG paths), datatype ("all"|"config"|"state")
  subscribe      Read-only: a bounded ONCE telemetry sample (no streaming).
                 args: paths (list of YANG paths)
  set            WRITE — changes live config (blast 'medium', requires approval).
                 args: update / replace (lists of [path, value] pairs), delete (list of paths)

YANG PATH EXAMPLES (origin:path):
  openconfig-interfaces:interfaces
  openconfig-interfaces:interfaces/interface[name=GigabitEthernet0/0/0/0]/state
  openconfig-system:system/state
  Cisco-IOS-XR-shellutil-oper:system-time

PORT DEFAULTS BY VENDOR: cisco-iosxr/nokia 57400, juniper 32767, arista 6030.
The configured target's port overrides the default.

Check ok / error before trusting data."""


def call_op(op: str, target: Optional[str], args: Dict[str, Any]) -> Dict[str, Any]:
    helper = _get_helper()
    op = (op or "").lower()
    if op == "targets":
        return {"ok": True, "op": "targets", "data": helper.targets(), "error": None, "blast_radius": "low"}
    if op == "capabilities":
        return helper.capabilities(target or "")
    if op == "get":
        return helper.get(target or "", args.get("paths") or [], args.get("datatype", "all"))
    if op == "subscribe":
        return helper.subscribe(target or "", args.get("paths") or [], args.get("mode", "once"))
    if op == "set":
        return helper.set(
            target or "",
            update=args.get("update"),
            replace=args.get("replace"),
            delete=args.get("delete"),
        )
    return {"ok": False, "op": op, "data": None,
            "error": f"Unknown op '{op}'. Use targets|capabilities|get|subscribe|set.",
            "blast_radius": "low"}


def get_blast_radius(op: str) -> str:
    return "medium" if (op or "").lower() == "set" else "low"


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "gnmi-mcp", "version": "1.0.0"},
                "capabilities": {"tools": {}},
            },
        }

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "gnmi_call",
                        "description": get_tool_description(),
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "op": {
                                    "type": "string",
                                    "enum": ["targets", "capabilities", "get", "subscribe", "set"],
                                    "description": "gNMI operation",
                                },
                                "target": {
                                    "type": "string",
                                    "description": "Configured target name (omit for op='targets')",
                                },
                                "paths": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "YANG paths for get/subscribe",
                                },
                                "datatype": {
                                    "type": "string",
                                    "description": "get only: all|config|state",
                                },
                                "update": {
                                    "type": "array",
                                    "description": "set only: list of [path, value] pairs to update",
                                },
                                "replace": {
                                    "type": "array",
                                    "description": "set only: list of [path, value] pairs to replace",
                                },
                                "delete": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "set only: list of paths to delete",
                                },
                            },
                            "required": ["op"],
                        },
                    }
                ]
            },
        }

    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})

        if tool_name != "gnmi_call":
            return {"jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32602, "message": f"Unknown tool: {tool_name}"}}

        op = arguments.get("op")
        target = arguments.get("target")
        if not op:
            return {"jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32602, "message": "Missing required argument: op"}}

        result = call_op(op, target, arguments)

        if result.get("error"):
            return {
                "jsonrpc": "2.0", "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error: {result['error']}"}],
                    "blast_radius": get_blast_radius(op),
                },
            }

        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(result["data"], indent=2, default=str)}],
                "blast_radius": get_blast_radius(op),
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
