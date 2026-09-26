"""gNMI (gRPC Network Management Interface) integration via pygnmi.

Unlike the REST integrations (CML/ISE/ACI), gNMI is gRPC and addresses MANY
devices, so this module is built around a *list of named targets* rather than a
single host. Targets live in the app config DB (Settings -> gNMI) as a JSON
array of {name, host, port, username, password, vendor, skip_verify}. A single
`gnmi` sandbox object exposes targets()/capabilities()/get()/subscribe()/set(),
each opening a short-lived pygnmi connection to the chosen target by name.

Blast radius: capabilities/get/subscribe are "low" (read-only); set() mutates
live config and classifies "medium" so it surfaces for approval.
"""

import json
import sys
import types
from typing import Any, Callable, Dict, List, Optional

# Default gNMI ports by vendor family. IOS-XR / Nokia SR OS use 57400;
# Juniper uses 32767; Arista uses 6030.
_VENDOR_DEFAULT_PORT = {
    "cisco-iosxr": 57400,
    "iosxr": 57400,
    "nokia": 57400,
    "nokia-sros": 57400,
    "juniper": 32767,
    "junos": 32767,
    "arista": 6030,
    "eos": 6030,
}
_FALLBACK_PORT = 57400


def _resolve_port(target: Dict[str, Any]) -> int:
    port = target.get("port")
    if port:
        try:
            return int(port)
        except (TypeError, ValueError):
            pass
    vendor = (target.get("vendor") or "").strip().lower()
    return _VENDOR_DEFAULT_PORT.get(vendor, _FALLBACK_PORT)


def _err(op: str, msg: str, blast: str = "low") -> Dict[str, Any]:
    return {"ok": False, "op": op, "data": None, "error": msg, "blast_radius": blast}


class GnmiHelper:
    """Sandbox-facing gNMI helper bound to the configured target list.

    Each call opens a fresh pygnmi connection (gNMI is cheap to reconnect and a
    short-lived client avoids stale gRPC channels in the serialized sandbox).
    """

    def __init__(self, targets: Optional[List[Dict[str, Any]]] = None):
        self._targets: List[Dict[str, Any]] = targets or []

    # -- discovery -------------------------------------------------------------

    def targets(self) -> List[Dict[str, Any]]:
        """List configured targets (without passwords)."""
        return [
            {
                "name": t.get("name") or t.get("host"),
                "host": t.get("host"),
                "port": _resolve_port(t),
                "vendor": t.get("vendor") or "",
            }
            for t in self._targets
        ]

    def _find(self, name: str) -> Optional[Dict[str, Any]]:
        for t in self._targets:
            if (t.get("name") or t.get("host")) == name:
                return t
        # Fall back to matching on host so the agent can address by IP too.
        for t in self._targets:
            if t.get("host") == name:
                return t
        return None

    def _connect(self, target: Dict[str, Any]):
        from pygnmi.client import gNMIclient

        host = (target.get("host") or "").strip()
        port = _resolve_port(target)
        skip_verify = bool(target.get("skip_verify", True))
        kwargs: Dict[str, Any] = {
            "target": (host, str(port)),
            "username": target.get("username") or "",
            "password": target.get("password") or "",
        }
        # skip_verify keeps TLS on but ignores the cert (common in labs);
        # insecure disables TLS entirely. We default to skip_verify TLS.
        if skip_verify:
            kwargs["skip_verify"] = True
        else:
            kwargs["insecure"] = False
        return gNMIclient(**kwargs)

    # -- operations ------------------------------------------------------------

    def capabilities(self, target: str) -> Dict[str, Any]:
        """Read-only: models, encodings and gNMI version the target supports."""
        t = self._find(target)
        if t is None:
            return _err("capabilities", f"Unknown target '{target}'. Call gnmi.targets().")
        try:
            with self._connect(t) as gc:
                data = gc.capabilities()
            return {"ok": True, "op": "capabilities", "data": data, "error": None, "blast_radius": "low"}
        except Exception as e:
            return _err("capabilities", str(e))

    def get(self, target: str, paths: List[str], datatype: str = "all") -> Dict[str, Any]:
        """Read-only: fetch state/config at one or more YANG paths."""
        t = self._find(target)
        if t is None:
            return _err("get", f"Unknown target '{target}'. Call gnmi.targets().")
        if isinstance(paths, str):
            paths = [paths]
        try:
            with self._connect(t) as gc:
                data = gc.get(path=paths, datatype=datatype)
            return {"ok": True, "op": "get", "data": data, "error": None, "blast_radius": "low"}
        except Exception as e:
            return _err("get", str(e))

    def subscribe(self, target: str, paths: List[str], mode: str = "once") -> Dict[str, Any]:
        """Read-only: a bounded ONCE telemetry sample (no unbounded streaming)."""
        t = self._find(target)
        if t is None:
            return _err("subscribe", f"Unknown target '{target}'. Call gnmi.targets().")
        if isinstance(paths, str):
            paths = [paths]
        if (mode or "once").lower() != "once":
            return _err("subscribe", "Only mode='once' is supported in the sandbox (no streaming).")
        try:
            subscribe = {
                "subscription": [{"path": p, "mode": "target_defined"} for p in paths],
                "mode": "once",
                "encoding": "json",
            }
            with self._connect(t) as gc:
                data = list(gc.subscribe2(subscribe=subscribe))
            return {"ok": True, "op": "subscribe", "data": data, "error": None, "blast_radius": "low"}
        except Exception as e:
            return _err("subscribe", str(e))

    def set(
        self,
        target: str,
        update: Optional[List] = None,
        replace: Optional[List] = None,
        delete: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """WRITE: change live config. Blast 'medium' — surfaces for approval.

        update/replace are lists of (path, value) tuples; delete is a list of
        paths. Mirrors pygnmi's gc.set signature.
        """
        t = self._find(target)
        if t is None:
            return _err("set", f"Unknown target '{target}'. Call gnmi.targets().", blast="medium")
        try:
            kwargs: Dict[str, Any] = {}
            if update:
                kwargs["update"] = [tuple(u) for u in update]
            if replace:
                kwargs["replace"] = [tuple(r) for r in replace]
            if delete:
                kwargs["delete"] = list(delete)
            if not kwargs:
                return _err("set", "Provide at least one of update/replace/delete.", blast="medium")
            with self._connect(t) as gc:
                data = gc.set(**kwargs)
            return {"ok": True, "op": "set", "data": data, "error": None, "blast_radius": "medium"}
        except Exception as e:
            return _err("set", str(e), blast="medium")


def install_gnmi(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> GnmiHelper:
    """Bind a `gnmi` helper into a sandbox globals dict.

    Mirrors install_cml in spirit, but the helper is an object with methods
    (get/set/capabilities/subscribe/targets) since gNMI is multi-target gRPC,
    not a single REST endpoint. `emit` is accepted for parity.
    """
    from ccie_sidecar.gnmi_config import get_gnmi_config

    cfg = get_gnmi_config() or {}
    helper = GnmiHelper(cfg.get("targets") or [])

    globals_dict["gnmi"] = helper

    mod = types.ModuleType("gnmi_api")
    mod.gnmi = helper  # type: ignore[attr-defined]
    sys.modules["gnmi_api"] = mod

    return helper


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test gNMI by running capabilities against the first target.

    Returns {"ok": bool, "message": str}.
    """
    targets = (config or {}).get("targets") or []
    if not targets:
        return {"ok": False, "message": "Add at least one target (host/username/password)."}

    first = targets[0]
    host = (first.get("host") or "").strip()
    if not host or not (first.get("username") or "").strip():
        return {"ok": False, "message": "First target needs at least a host and username."}

    helper = GnmiHelper(targets)
    name = first.get("name") or host
    result = helper.capabilities(name)
    if result.get("ok"):
        ver = ""
        try:
            ver = result["data"].get("gnmi_version", "")
        except Exception:
            pass
        return {"ok": True, "message": f"Connected to {name} ({host}) — gNMI {ver}".strip()}
    return {"ok": False, "message": result.get("error") or "Capabilities request failed."}
