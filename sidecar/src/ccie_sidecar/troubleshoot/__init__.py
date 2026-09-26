"""Plan 15 — AI-Driven Troubleshooting Tree.

This package implements the YAML schema, validator, loader, narrator,
and (in later phases) symptom matcher for decision-tree style network
troubleshooting playbooks.

Public API:
    - load_playbook(yaml_text: str) -> dict   (validated playbook document)
    - ValidationError                          (raised on schema/cross-ref errors)
    - narrate(step, parsed, vars_, vendor, platform) -> {"text", "citations"}
    - conclude(run_history, symptom, vendor, platform) -> {"root_cause", "confidence", "suggested_fix", "evidence"}
"""

from ccie_sidecar.troubleshoot.matcher import match_symptom  # noqa: F401
from ccie_sidecar.troubleshoot.narrator import conclude, narrate  # noqa: F401
from ccie_sidecar.troubleshoot.yaml_loader import (  # noqa: F401
    ValidationError,
    load_playbook,
)

__all__ = [
    "ValidationError",
    "conclude",
    "load_playbook",
    "match_symptom",
    "narrate",
]
