"""Install the `nmap` facade into a sandbox globals dict.

Mirrors install_proxmox: registers the facade as a global AND as an importable
module, so both `nmap.service_scan(...)` and `import nmap` work inside
execute_python_code. (No clash — the third-party python-nmap pip package is not
installed.)
"""
from __future__ import annotations

import sys
import types
from typing import Any, Callable, Optional

from ccie_sidecar.nmap_api.facade import NmapFacade


def install_nmap(globals_dict: dict[str, Any], emit: Optional[Callable[[dict], None]] = None) -> NmapFacade:
    """Create an NmapFacade, register it as the `nmap` global, and expose it as an
    importable module named `nmap`.

    `emit` is accepted for parity with other helpers (unused).
    """
    facade = NmapFacade()

    globals_dict["nmap"] = facade

    mod = types.ModuleType("nmap")
    for attr in dir(facade):
        if attr.startswith("_"):
            continue
        setattr(mod, attr, getattr(facade, attr))
    sys.modules["nmap"] = mod

    return facade
