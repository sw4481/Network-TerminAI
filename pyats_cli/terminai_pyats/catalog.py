"""Verb catalog for terminai-pyats.

Defines the 15-verb catalog with metadata for each operation. Phase 1 includes
6 read verbs; Phase 2 adds the remaining 9.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class VerbSpec:
    """Specification for a single pyATS verb.

    Attributes:
        name: Kebab-case verb name (e.g., "run-show-command")
        description: Human-readable description
        blast_radius: low/medium/high/destructive
        args: JSON Schema-style parameter definitions
        required: List of required parameter names
    """
    name: str
    description: str
    blast_radius: str
    args: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    required: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for JSON serialization."""
        return {
            "name": self.name,
            "description": self.description,
            "blast_radius": self.blast_radius,
            "args": self.args,
            "required": self.required,
        }


# Phase 1 + 2: 15 verbs (low/medium/high/computed tiers)
VERBS: List[VerbSpec] = [
    # === Low blast radius (read operations) ===
    VerbSpec(
        name="list-devices",
        description="List all devices in the testbed",
        blast_radius="low",
        args={},
        required=[],
    ),
    VerbSpec(
        name="search-devices",
        description="Search devices by name pattern",
        blast_radius="low",
        args={
            "query": {
                "type": "string",
                "description": "Search pattern (case-insensitive substring match)"
            }
        },
        required=["query"],
    ),
    VerbSpec(
        name="run-show-command",
        description="Run a show command on a device (Genie-parsed when available)",
        blast_radius="low",
        args={
            "device": {
                "type": "string",
                "description": "Device name from testbed"
            },
            "command": {
                "type": "string",
                "description": "Show command to execute"
            }
        },
        required=["device", "command"],
    ),
    VerbSpec(
        name="run-show-command-multi",
        description="Run a show command on multiple devices in parallel",
        blast_radius="low",
        args={
            "devices": {
                "type": "array",
                "description": "List of device names"
            },
            "command": {
                "type": "string",
                "description": "Show command to execute"
            }
        },
        required=["devices", "command"],
    ),
    VerbSpec(
        name="learn",
        description="Learn structured feature state using Genie (ospf, bgp, interface, routing, etc.)",
        blast_radius="low",
        args={
            "device": {
                "type": "string",
                "description": "Device name from testbed"
            },
            "feature": {
                "type": "string",
                "description": "Genie feature to learn (e.g., 'ospf', 'bgp', 'interface')"
            }
        },
        required=["device", "feature"],
    ),
    VerbSpec(
        name="device-health",
        description="Get device health snapshot (platform, interfaces, routing summary)",
        blast_radius="low",
        args={
            "device": {
                "type": "string",
                "description": "Device name from testbed"
            }
        },
        required=["device"],
    ),
    VerbSpec(
        name="get-neighbors",
        description="Get CDP and LLDP neighbors for a device",
        blast_radius="low",
        args={
            "device": {
                "type": "string",
                "description": "Device name from testbed"
            }
        },
        required=["device"],
    ),
    VerbSpec(
        name="find-interface-by-ip",
        description="Find which interface has a given IP address",
        blast_radius="low",
        args={
            "device": {
                "type": "string",
                "description": "Device name from testbed"
            },
            "ip": {
                "type": "string",
                "description": "IP address to search for"
            }
        },
        required=["device", "ip"],
    ),
    VerbSpec(
        name="ping",
        description="Ping a destination from a device",
        blast_radius="low",
        args={
            "device": {
                "type": "string",
                "description": "Device name from testbed"
            },
            "destination": {
                "type": "string",
                "description": "Destination IP or hostname"
            }
        },
        required=["device", "destination"],
    ),
    # === Medium blast radius ===
    VerbSpec(
        name="run-linux-command",
        description="Run a Linux command on a host/server device",
        blast_radius="medium",
        args={
            "device": {
                "type": "string",
                "description": "Device name from testbed"
            },
            "command": {
                "type": "string",
                "description": "Linux command to execute"
            }
        },
        required=["device", "command"],
    ),
    # === High blast radius (configuration changes) ===
    VerbSpec(
        name="configure",
        description="Apply configuration commands to a device",
        blast_radius="high",
        args={
            "device": {
                "type": "string",
                "description": "Device name from testbed"
            },
            "config": {
                "type": "string",
                "description": "Configuration commands (one per line)"
            }
        },
        required=["device", "config"],
    ),
    VerbSpec(
        name="configure-multi",
        description="Apply configuration to multiple devices in parallel",
        blast_radius="high",
        args={
            "devices": {
                "type": "array",
                "description": "List of device names"
            },
            "config": {
                "type": "string",
                "description": "Configuration commands (one per line)"
            }
        },
        required=["devices", "config"],
    ),
    VerbSpec(
        name="configure-with-diff",
        description="Apply configuration and return before/after diff (snapshots saved for rollback)",
        blast_radius="high",
        args={
            "device": {
                "type": "string",
                "description": "Device name from testbed"
            },
            "config": {
                "type": "string",
                "description": "Configuration commands (one per line)"
            }
        },
        required=["device", "config"],
    ),
    VerbSpec(
        name="rollback-config",
        description="Rollback to the last configure-with-diff snapshot",
        blast_radius="high",
        args={
            "device": {
                "type": "string",
                "description": "Device name from testbed"
            }
        },
        required=["device"],
    ),
    # === Computed blast radius (depends on code content) ===
    VerbSpec(
        name="run-pyats-code",
        description="Execute raw pyATS Python code (testbed pre-bound). Blast radius computed from code content.",
        blast_radius="computed",
        args={
            "code": {
                "type": "string",
                "description": "Python code to execute (has access to 'testbed' variable)"
            }
        },
        required=["code"],
    ),
]


def get_verb_spec(name: str) -> Optional[VerbSpec]:
    """Lookup a verb spec by name.

    Args:
        name: Verb name (e.g., "run-show-command")

    Returns:
        VerbSpec if found, None otherwise
    """
    for verb in VERBS:
        if verb.name == name:
            return verb
    return None
