"""
nmap code-API for the execution sandbox.

Exposes deep host/service/OS discovery as a single importable `nmap` object so
the LLM sees one tool (execute_python_code) instead of many tool schemas, per
Anthropic's "Code execution with MCP" pattern. Shells out to the native `nmap`
binary (auto-detected on PATH) and parses `-oX -` XML with lxml.
"""
from ccie_sidecar.nmap_api.helper import install_nmap
from ccie_sidecar.nmap_api.facade import NmapFacade

__all__ = ["install_nmap", "NmapFacade"]
