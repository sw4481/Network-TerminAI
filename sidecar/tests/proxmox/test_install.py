"""install_proxmox registers `proxmox` as a global and an importable module."""
from ccie_sidecar.proxmox_api.helper import install_proxmox


def test_install_registers_global():
    g = {}
    install_proxmox(g)
    assert "proxmox" in g
    assert hasattr(g["proxmox"], "get_nodes")
    assert hasattr(g["proxmox"], "help")


def test_installed_object_is_importable_as_module():
    g = {"__builtins__": __import__("builtins")}
    install_proxmox(g)
    # Code run in this globals dict can `import proxmox`.
    exec("import proxmox\nresult = proxmox.help()", g)
    assert "get_nodes" in g["result"]


def test_build_sandbox_globals_includes_proxmox():
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    g = _build_sandbox_globals(cli_package=None, secrets={})
    assert "proxmox" in g
