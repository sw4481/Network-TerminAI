from __future__ import annotations

import sys
import types
from typing import Any, Callable, Optional


class SafeComputer:
    def help(self) -> str:
        from ccie_sidecar.agent_computer import ComputerFacade
        return ComputerFacade().help()

    def list(self) -> list[dict[str, Any]]:
        from ccie_sidecar.agent_computer import ComputerFacade
        return ComputerFacade().list()

    def health(self, name: str) -> dict[str, Any]:
        from ccie_sidecar.agent_computer import ComputerFacade
        return ComputerFacade().health(name)

    def exec(self, name: str, command: str, confirm: bool = False) -> dict[str, Any]:
        from ccie_sidecar.agent_computer import ComputerFacade
        return ComputerFacade().exec(name, command, confirm=confirm)

    def read_file(self, name: str, path: str) -> dict[str, Any]:
        from ccie_sidecar.agent_computer import ComputerFacade
        return ComputerFacade().read_file(name, path)

    def write_file(self, name: str, path: str, content: str, confirm: bool = False) -> dict[str, Any]:
        from ccie_sidecar.agent_computer import ComputerFacade
        return ComputerFacade().write_file(name, path, content, confirm=confirm)

    def __dir__(self) -> list[str]:
        return ["exec", "health", "help", "list", "read_file", "write_file"]


def install_computer(globals_dict: dict[str, Any], emit: Optional[Callable[[dict], None]] = None) -> SafeComputer:
    facade = SafeComputer()
    globals_dict["computer"] = facade

    mod = types.ModuleType("computer")
    for attr in dir(facade):
        setattr(mod, attr, getattr(facade, attr))
    sys.modules["computer"] = mod
    return facade
