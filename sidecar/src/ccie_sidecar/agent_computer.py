from __future__ import annotations

import base64
import ipaddress
import os
import shlex
import sqlite3
import subprocess
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import requests


def _db_path() -> Path:
    if os.name == "nt":
        config_dir = Path(os.environ.get("APPDATA", "")) / "ccie-terminal"
    elif os.uname().sysname == "Darwin":
        config_dir = Path.home() / "Library" / "Application Support" / "ccie-terminal"
    else:
        config_dir = Path.home() / ".config" / "ccie-terminal"
    return config_dir / "sessions.db"


def get_agent_computer_config() -> list[dict[str, Any]]:
    db = _db_path()
    try:
        if not db.exists():
            return []
        conn = sqlite3.connect(str(db))
        try:
            row = conn.execute("SELECT value FROM app_flags WHERE key = ?1", ("ccie_agent_computers",)).fetchone()
        finally:
            conn.close()
        if not row:
            return []
        import json
        value = json.loads(row[0])
        return value.get("computers", []) if isinstance(value, dict) else []
    except Exception:
        return []


def _is_loopback_http(base_url: str) -> bool:
    parsed = urlparse(base_url)
    if parsed.scheme != "http":
        return False
    host = parsed.hostname or ""
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class PctTransport:
    def __init__(self, config_loader: Callable[[], dict[str, Any] | None] | None = None) -> None:
        self._config_loader = config_loader

    def _safe_path(self, path: str) -> str:
        root = Path("/opt/ccie-agent-computer/workspace")
        resolved = (root / path.lstrip("/")).resolve()
        if resolved != root and root not in resolved.parents:
            raise ValueError("path is outside root")
        return str(resolved)

    def _pct(self, computer: dict[str, Any], args: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
        if self._config_loader is None:
            from ccie_sidecar.proxmox_api.config import get_proxmox_config
            conf = get_proxmox_config() or {}
        else:
            conf = self._config_loader() or {}
        parsed = urlparse(str(computer.get("base_url") or computer.get("baseUrl") or ""))
        host = str(conf.get("host") or computer.get("node") or parsed.hostname or "")
        user = str(conf.get("user") or "root@pam").split("@", 1)[0]
        vmid = str(computer.get("vmid") or parsed.path.strip("/") or "")
        if not vmid.isdigit():
            return subprocess.CompletedProcess([], 2, "", "Invalid VMID.")
        remote_cmd = " ".join(shlex.quote(part) for part in ["pct", "exec", vmid, "--", *args])
        ssh = ["ssh", f"{user}@{host}", remote_cmd]
        password = str(conf.get("password") or "")
        cmd = ["sshpass", "-e", *ssh] if password else ssh
        env = {**os.environ, "SSHPASS": password} if password else None
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)

    def health(self, computer: dict[str, Any]) -> dict[str, Any]:
        proc = self._pct(computer, ["hostname"], timeout=10)
        return {"ok": proc.returncode == 0, "transport": "pct", "hostname": proc.stdout.strip(), "error": proc.stderr.strip()}

    def exec(self, computer: dict[str, Any], command: str) -> dict[str, Any]:
        proc = self._pct(computer, ["/bin/sh", "-lc", command])
        return {"ok": proc.returncode == 0, "stdout": proc.stdout, "stderr": proc.stderr, "returncode": proc.returncode}

    def read_file(self, computer: dict[str, Any], path: str) -> dict[str, Any]:
        try:
            safe_path = self._safe_path(path)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        proc = self._pct(computer, ["cat", safe_path], timeout=10)
        return {"ok": proc.returncode == 0, "content": proc.stdout, "error": proc.stderr.strip()}

    def write_file(self, computer: dict[str, Any], path: str, content: str) -> dict[str, Any]:
        try:
            safe_path = self._safe_path(path)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        encoded = base64.b64encode(content.encode()).decode()
        proc = self._pct(computer, ["/bin/sh", "-lc", f"mkdir -p {shlex.quote(str(Path(safe_path).parent))} && printf %s {shlex.quote(encoded)} | base64 -d > {shlex.quote(safe_path)}"])
        return {"ok": proc.returncode == 0, "error": proc.stderr.strip()}


class ComputerFacade:
    def __init__(
        self,
        config_loader: Callable[[], list[dict[str, Any]]] = get_agent_computer_config,
        request: Callable[..., Any] = requests.request,
        pct_transport: PctTransport | None = None,
        proxmox_config_loader: Callable[[], dict[str, Any] | None] | None = None,
    ) -> None:
        self._config_loader = config_loader
        self._request = request
        self._pct_transport = pct_transport or PctTransport(config_loader=proxmox_config_loader)

    def help(self) -> str:
        return (
            "Agent computer capabilities: list(), health(name), exec(name, command, confirm=False), "
            "read_file(name, path), write_file(name, path, content, confirm=False). "
            "exec/write_file require confirm=True after user approval."
        )

    def list(self) -> list[dict[str, Any]]:
        return [{k: v for k, v in c.items() if k != "token"} for c in self._config_loader()]

    def _find(self, name: str) -> dict[str, Any] | None:
        return next((c for c in self._config_loader() if c.get("name") == name), None)

    def _call(self, name: str, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        computer = self._find(name)
        if not computer:
            return {"ok": False, "error": f"Agent computer '{name}' is not configured."}
        base_url = str(computer.get("base_url") or computer.get("baseUrl") or "").rstrip("/")
        token = str(computer.get("token") or "")
        if not base_url or not token:
            return {"ok": False, "error": f"Agent computer '{name}' is missing base_url/token."}
        scheme = urlparse(base_url).scheme
        if scheme == "pct":
            if path == "/health":
                return self._pct_transport.health(computer)
            if path == "/exec":
                return self._pct_transport.exec(computer, str((payload or {}).get("command") or ""))
            if path == "/files/read":
                return self._pct_transport.read_file(computer, str((payload or {}).get("path") or ""))
            if path == "/files/write":
                return self._pct_transport.write_file(computer, str((payload or {}).get("path") or ""), str((payload or {}).get("content") or ""))
        if scheme != "https" and not _is_loopback_http(base_url):
            return {"ok": False, "error": "Agent computer base_url must use HTTPS unless it is loopback HTTP."}
        try:
            kwargs: dict[str, Any] = {"headers": {"Authorization": f"Bearer {token}"}, "timeout": 10}
            if payload is not None:
                kwargs["json"] = payload
            response = self._request(method, f"{base_url}{path}", **kwargs)
            response.raise_for_status()
            data = response.json()
            return data if isinstance(data, dict) else {"ok": True, "data": data}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def health(self, name: str) -> dict[str, Any]:
        return self._call(name, "GET", "/health")

    def exec(self, name: str, command: str, confirm: bool = False) -> dict[str, Any]:
        if not confirm:
            return {"ok": False, "needs_confirm": True, "reason": "exec runs a shell command on the agent computer; get user approval then retry with confirm=True."}
        return self._call(name, "POST", "/exec", {"command": command})

    def read_file(self, name: str, path: str) -> dict[str, Any]:
        return self._call(name, "POST", "/files/read", {"path": path})

    def write_file(self, name: str, path: str, content: str, confirm: bool = False) -> dict[str, Any]:
        if not confirm:
            return {"ok": False, "needs_confirm": True, "reason": "write_file changes files on the agent computer; get user approval then retry with confirm=True."}
        return self._call(name, "POST", "/files/write", {"path": path, "content": content})
