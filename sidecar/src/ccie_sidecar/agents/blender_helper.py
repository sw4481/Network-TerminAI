"""Install a tiny `blender` facade into sandbox globals.

The bundled MCP server still registers as an MCP server for clients that can use it.
This helper gives code-capable agents a direct, reliable path today by speaking the
same socket protocol used by the Blender addon.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import threading
import types
from typing import Any, Callable, Optional


class BlenderFacade:
    """Small client for the Blender MCP addon's local socket protocol."""

    def __init__(self, host: str | None = None, port: int | None = None, timeout: float = 180.0) -> None:
        self.host = host or os.environ.get("BLENDER_HOST", "localhost")
        self.port = int(port or os.environ.get("BLENDER_PORT", "9876"))
        self.timeout = timeout
        self._lock = threading.Lock()

    def help(self) -> str:
        return (
            "Blender helper commands:\n"
            "- blender.status() -> connection check with setup hint\n"
            "- blender.scene_info() / blender.get_scene_info()\n"
            "- blender.object_info(name) / blender.get_object_info(name)\n"
            "- blender.screenshot(max_size=1000, filepath=None)\n"
            "- blender.execute_code(code) / blender.execute_blender_code(code)\n"
            "- blender.call(command_type, params=None) for addon protocol commands\n"
            "Requires Blender running with the BlenderMCP addon enabled and its server started."
        )

    def status(self) -> dict[str, Any]:
        try:
            scene = self.scene_info()
            return {"ok": True, "host": self.host, "port": self.port, "scene": scene}
        except Exception as exc:
            return {
                "ok": False,
                "host": self.host,
                "port": self.port,
                "error": str(exc),
                "hint": "Open Blender, enable the BlenderMCP addon, then start its server in the 3D viewport sidebar.",
            }

    def call(self, command_type: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        command = {"type": command_type, "params": params or {}}
        with self._lock:
            with socket.create_connection((self.host, self.port), timeout=self.timeout) as sock:
                sock.settimeout(self.timeout)
                sock.sendall(json.dumps(command).encode("utf-8"))
                return self._receive_result(sock)

    def scene_info(self) -> dict[str, Any]:
        return self.call("get_scene_info")

    get_scene_info = scene_info

    def object_info(self, name: str) -> dict[str, Any]:
        return self.call("get_object_info", {"name": name})

    get_object_info = object_info

    def screenshot(
        self,
        max_size: int = 1000,
        filepath: str | None = None,
        format: str = "png",
    ) -> dict[str, Any]:
        if filepath is None:
            suffix = "." + format.lstrip(".")
            handle = tempfile.NamedTemporaryFile(prefix="ccie_blender_", suffix=suffix, delete=False)
            filepath = handle.name
            handle.close()
        result = self.call(
            "get_viewport_screenshot",
            {"max_size": max_size, "filepath": filepath, "format": format},
        )
        if isinstance(result, dict):
            result.setdefault("filepath", filepath)
        return result

    get_viewport_screenshot = screenshot

    def execute_code(self, code: str) -> dict[str, Any]:
        return self.call("execute_code", {"code": code})

    execute_blender_code = execute_code

    def _receive_result(self, sock: socket.socket) -> dict[str, Any]:
        chunks: list[bytes] = []
        while True:
            chunk = sock.recv(8192)
            if not chunk:
                break
            chunks.append(chunk)
            try:
                response = json.loads(b"".join(chunks).decode("utf-8"))
                break
            except json.JSONDecodeError:
                continue
        else:  # pragma: no cover - loop exits by break/exception
            response = {}

        if not chunks:
            raise ConnectionError("Blender closed the connection without a response")
        if "response" not in locals():
            response = json.loads(b"".join(chunks).decode("utf-8"))
        if response.get("status") == "error":
            raise RuntimeError(response.get("message") or "Unknown Blender error")
        result = response.get("result", response)
        return result if isinstance(result, dict) else {"result": result}


def install_blender(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> BlenderFacade:
    """Register `blender` as both a sandbox global and an importable module."""
    facade = BlenderFacade()
    globals_dict["blender"] = facade

    module = types.ModuleType("blender")
    for attr in dir(facade):
        if attr.startswith("_"):
            continue
        setattr(module, attr, getattr(facade, attr))
    module.blender = facade
    sys.modules["blender"] = module
    return facade
