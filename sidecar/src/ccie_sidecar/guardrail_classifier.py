"""Conservative second-opinion classifier for guardrails.

Invoked by the Rust side (`guardrail.classify` NDJSON method) when the
rule engine returns Ambiguous. The contract:
  * Input: { "vendor": str, "platform": str, "command": str }
  * Output: { "tier": int 0..3, "reasoning": str }

The Rust caller treats this only as a tier-RAISING overlay (see
`src-tauri/src/guardrails/ambiguity.rs::merge`), so the safety story does
not depend on the LLM being right — only on it being conservative when it
recognizes a dangerous pattern. We err on the side of higher tier.

Phase 5 ships a heuristic implementation. A future change can swap this
for an LLM call to whichever provider is configured.
"""
from __future__ import annotations

import re
from typing import Any


# Patterns that should bump the tier even when the rule engine missed them.
T3_PATTERNS = [
    re.compile(r"\breload\b", re.IGNORECASE),
    re.compile(r"\bwrite\s+erase\b", re.IGNORECASE),
    re.compile(r"\berase\s+(startup|nvram|flash)", re.IGNORECASE),
    re.compile(r"\bzeroize\b", re.IGNORECASE),
    re.compile(r"\bno\s+router\s+(bgp|ospf|isis|eigrp)\b", re.IGNORECASE),
    re.compile(r"\bno\s+feature\s+\w+", re.IGNORECASE),
    re.compile(r"\bclear\s+(ip\s+)?bgp\s+\*", re.IGNORECASE),
    re.compile(r"\brequest\s+system\s+(reboot|halt|power-off|zeroize)\b", re.IGNORECASE),
    re.compile(r"\binstall\s+(all|activate)\b", re.IGNORECASE),
    re.compile(r"\bspanning-tree\s+mode\b", re.IGNORECASE),
    re.compile(r"\bvtp\s+mode\b", re.IGNORECASE),
    re.compile(r"\bconfigure\s+replace\b", re.IGNORECASE),
    re.compile(r"\brestart\s+routing\b", re.IGNORECASE),
]

T2_PATTERNS = [
    re.compile(r"\bshutdown\b(?:\s*$)?", re.IGNORECASE),
    re.compile(r"\bclear\s+(ip\s+)?bgp\s+\d", re.IGNORECASE),
    re.compile(r"\bip\s+route\s+\d", re.IGNORECASE),
    re.compile(r"\bno\s+ip\s+route\s+\d", re.IGNORECASE),
    re.compile(r"\bset\s+interfaces\s+\S+\s+disable\b", re.IGNORECASE),
    re.compile(r"\bdelete\s+(protocols|routing-instances|interfaces)\b", re.IGNORECASE),
    re.compile(r"\bcommit\s*$", re.IGNORECASE),
    re.compile(r"\bswitchport\s+access\s+vlan\s+\d", re.IGNORECASE),
    re.compile(r"\bcrypto\s+map\b", re.IGNORECASE),
    re.compile(r"\baccess-(group|list)\b", re.IGNORECASE),
]

T1_PATTERNS = [
    re.compile(r"\bhostname\s+\S", re.IGNORECASE),
    re.compile(r"\bclock\s+set\b", re.IGNORECASE),
    re.compile(r"\bntp\s+server\b", re.IGNORECASE),
    re.compile(r"\bsnmp-server\s+community\b", re.IGNORECASE),
    re.compile(r"\blogging\s+(host|buffered)\b", re.IGNORECASE),
    re.compile(r"\bbanner\s+(motd|login|exec)\b", re.IGNORECASE),
    re.compile(r"\busername\s+\S", re.IGNORECASE),
    re.compile(r"\bdebug\s+\S", re.IGNORECASE),
    re.compile(r"\bwrite\s+memory\b", re.IGNORECASE),
]

T0_PATTERNS = [
    re.compile(r"^\s*show\s+\S", re.IGNORECASE),
    re.compile(r"^\s*display\s+\S", re.IGNORECASE),
    re.compile(r"^\s*ping\b", re.IGNORECASE),
    re.compile(r"^\s*traceroute\b", re.IGNORECASE),
    re.compile(r"^\s*dir\b", re.IGNORECASE),
    re.compile(r"^\s*more\s+\S", re.IGNORECASE),
    re.compile(r"^\s*commit\s+check\b", re.IGNORECASE),
]


def classify(vendor: str, platform: str, command: str) -> dict[str, Any]:
    """Return {'tier': int 0..3, 'reasoning': str}."""
    cmd = command.strip()

    for pat in T3_PATTERNS:
        if pat.search(cmd):
            return {
                "tier": 3,
                "reasoning": f"Matches service-affecting pattern '{pat.pattern}'.",
            }
    for pat in T2_PATTERNS:
        if pat.search(cmd):
            return {
                "tier": 2,
                "reasoning": f"Matches forwarding-affecting pattern '{pat.pattern}'.",
            }
    for pat in T1_PATTERNS:
        if pat.search(cmd):
            return {
                "tier": 1,
                "reasoning": f"Matches local-write pattern '{pat.pattern}'.",
            }
    for pat in T0_PATTERNS:
        if pat.match(cmd):
            return {
                "tier": 0,
                "reasoning": f"Matches read-only pattern '{pat.pattern}'.",
            }

    # Default for unknown config commands: T2. The Rust merge layer will
    # apply its own safety floor (Ambiguous → at least T2 even if we say
    # T0/T1), but explicit T2 here is more honest.
    return {
        "tier": 2,
        "reasoning": "Unknown configuration command; defaulting to typed-confirm (Tier 2).",
    }
