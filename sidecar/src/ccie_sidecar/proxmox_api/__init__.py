"""
Proxmox VE code-API for the execution sandbox.

Exposes Proxmox operations as a single importable `proxmox` object so the LLM
sees one tool (execute_python_code) instead of dozens of tool schemas, per
Anthropic's "Code execution with MCP" pattern.

Operation logic is adapted from ProxmoxMCP-Plus (https://github.com/RekklesNA/
ProxmoxMCP-Plus), MIT License, Copyright (c) 2024 Kevin. The FastMCP server
layer is dropped; ops return plain Python dicts.
"""
from ccie_sidecar.proxmox_api.helper import install_proxmox
from ccie_sidecar.proxmox_api.facade import ProxmoxFacade

__all__ = ["install_proxmox", "ProxmoxFacade"]
