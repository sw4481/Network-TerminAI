#!/usr/bin/env python3
"""
Browser Control MCP Server (thin stdio shim).

Proxies MCP JSON-RPC tool calls to the CCIE Terminal in-process HTTP control
server (axum, 127.0.0.1, ephemeral port + bearer token). This lets ANY agent —
built-in CCIE agents, Claude Code, Codex — open and drive browser windows that
live inside the Tauri process. Mirrors stealthwatch_mcp.py's structure.

Discovery: reads {port, token} from
~/Library/Application Support/ccie-terminal/browser-control.json
(or the path in env BROWSER_CONTROL_CONFIG).
"""

import json
import os
import sys
import urllib.request
import urllib.error

def _discovery_path():
    env = os.environ.get("BROWSER_CONTROL_CONFIG")
    if env:
        return env
    home = os.environ.get("HOME", "/tmp")
    return os.path.join(home, "Library/Application Support/ccie-terminal/browser-control.json")

def _load_conn():
    with open(_discovery_path(), "r", encoding="utf-8") as f:
        cfg = json.load(f)
    return cfg["port"], cfg["token"]

def _http_post(endpoint, payload):
    port, token = _load_conn()
    url = f"http://127.0.0.1:{port}{endpoint}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))

# tool name -> (endpoint, [required arg keys])
TOOLS = {
    "browser_open":     ("/open",     ["url"]),
    "browser_navigate": ("/navigate", ["browserId", "url"]),
    "browser_back":     ("/back",     ["browserId"]),
    "browser_forward":  ("/forward",  ["browserId"]),
    "browser_reload":   ("/reload",   ["browserId"]),
    "browser_eval":     ("/eval",     ["browserId", "script"]),
    "browser_close":    ("/close",    ["browserId"]),
    "browser_list":     ("/list",     []),
    "browser_get_url":  ("/get_url",  ["browserId"]),
}

TOOL_SCHEMAS = [
    {"name": "browser_open", "description": "Open a new browser window at a URL. Returns its browserId.",
     "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}},
    {"name": "browser_navigate", "description": "Navigate an open browser window to a URL.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}, "url": {"type": "string"}}, "required": ["browserId", "url"]}},
    {"name": "browser_back", "description": "Go back in an open browser window's history.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}}, "required": ["browserId"]}},
    {"name": "browser_forward", "description": "Go forward in an open browser window's history.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}}, "required": ["browserId"]}},
    {"name": "browser_reload", "description": "Reload an open browser window.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}}, "required": ["browserId"]}},
    {"name": "browser_eval", "description": "Run JavaScript in a browser window (fire-and-forget: click, type, scroll). No return value — external pages cannot return data.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}, "script": {"type": "string"}}, "required": ["browserId", "script"]}},
    {"name": "browser_close", "description": "Close an open browser window.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}}, "required": ["browserId"]}},
    {"name": "browser_list", "description": "List all open browser windows with their browserId and url.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "browser_get_url", "description": "Get the current URL of an open browser window.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}}, "required": ["browserId"]}},
]

def handle_request(request):
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {"jsonrpc": "2.0", "id": req_id, "result": {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "browser-mcp", "version": "1.0.0"},
            "capabilities": {"tools": {}},
        }}

    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOL_SCHEMAS}}

    if method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        if tool_name not in TOOLS:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": f"Unknown tool: {tool_name}"}}
        endpoint, required = TOOLS[tool_name]
        for k in required:
            if k not in arguments:
                return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": f"Missing argument: {k}"}}
        try:
            result = _http_post(endpoint, arguments)
            return {"jsonrpc": "2.0", "id": req_id, "result": {
                "content": [{"type": "text", "text": json.dumps(result)}]
            }}
        except urllib.error.URLError as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32000, "message": f"Browser control server unreachable: {e}. Is CCIE Terminal running?"}}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32000, "message": str(e)}}

    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            response = handle_request(request)
        except Exception as e:
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {e}"}}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
