"""Install the `proxmox` facade into a sandbox globals dict.

Mirrors drawio_helper.install_drawio: registers the facade as a global AND as an
importable module, so both `proxmox.get_nodes()` and `import proxmox` work inside
execute_python_code.
"""
from __future__ import annotations

import sys
import types
from typing import Any, Callable, Optional

from ccie_sidecar.proxmox_api.facade import ProxmoxFacade


def install_proxmox(globals_dict: dict[str, Any], emit: Optional[Callable[[dict], None]] = None) -> ProxmoxFacade:
    """Create a ProxmoxFacade, register it as the `proxmox` global, and expose it
    as an importable module named `proxmox`.

    `emit` is accepted for parity with other helpers (unused in v1; reserved for
    future event streaming).
    """
    facade = ProxmoxFacade()

    # As a global.
    globals_dict["proxmox"] = facade

    # As an importable module: build a lightweight module object proxying the facade.
    mod = types.ModuleType("proxmox")
    for attr in dir(facade):
        if attr.startswith("_"):
            continue
        setattr(mod, attr, getattr(facade, attr))
    sys.modules["proxmox"] = mod

    return facade
