from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


class AgentComputerDaemon:
    def __init__(self, token: str, root: str | Path = ".", hostname: str | None = None) -> None:
        self.token = token
        self.root = Path(root).resolve()
        self.hostname = hostname or socket.gethostname()

    def handle(self, method: str, path: str, headers: dict[str, str], body: bytes) -> tuple[int, dict[str, Any]]:
        if headers.get("Authorization") != f"Bearer {self.token}":
            return 401, {"ok": False, "error": "unauthorized"}
        try:
            if method == "GET" and path == "/health":
                return 200, {"ok": True, "hostname": self.hostname}
            if method == "POST" and path == "/exec":
                payload = self._json(body)
                proc = subprocess.run(
                    payload.get("command", ""),
                    shell=True,
                    cwd=self.root,
                    capture_output=True,
                    text=True,
                    timeout=int(payload.get("timeout", 30)),
                )
                return 200, {"ok": True, "returncode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
            if method == "POST" and path == "/files/read":
                file_path = self._safe_path(self._json(body).get("path", ""))
                return 200, {"ok": True, "content": file_path.read_text()}
            if method == "POST" and path == "/files/write":
                payload = self._json(body)
                file_path = self._safe_path(payload.get("path", ""))
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_text(str(payload.get("content", "")))
                return 200, {"ok": True}
            return 404, {"ok": False, "error": "not found"}
        except ValueError as exc:
            return 400, {"ok": False, "error": str(exc)}
        except subprocess.TimeoutExpired:
            return 408, {"ok": False, "error": "command timed out"}
        except Exception as exc:
            return 500, {"ok": False, "error": str(exc)}

    def _json(self, body: bytes) -> dict[str, Any]:
        data = json.loads(body.decode() or "{}")
        if not isinstance(data, dict):
            raise ValueError("body must be a JSON object")
        return data

    def _safe_path(self, path: str) -> Path:
        resolved = (self.root / path).resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise ValueError("path is outside root")
        return resolved


def serve(daemon: AgentComputerDaemon, host: str, port: int) -> None:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self._reply(*daemon.handle("GET", self.path, dict(self.headers), b""))

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            self._reply(*daemon.handle("POST", self.path, dict(self.headers), self.rfile.read(length)))

        def _reply(self, status: int, body: dict[str, Any]) -> None:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    ThreadingHTTPServer((host, port), Handler).serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--root", default=".")
    parser.add_argument("--token", default=os.environ.get("AGENT_COMPUTER_TOKEN", ""))
    args = parser.parse_args()
    if not args.token:
        raise SystemExit("AGENT_COMPUTER_TOKEN or --token is required")
    serve(AgentComputerDaemon(args.token, args.root), args.host, args.port)


if __name__ == "__main__":
    main()
