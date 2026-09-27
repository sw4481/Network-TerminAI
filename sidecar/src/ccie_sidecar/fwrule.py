"""Firewall / ACL rule analysis — offline, no credentials.

Parses a rule set (Cisco IOS/IOS-XE extended ACLs, or a normalized JSON rule
list) and reports anomalies via multi-dimensional set intersection across the
6 match dimensions (protocol, src net, src port, dst net, dst port, action):

  * shadowing   - an earlier rule fully covers a later rule with a DIFFERENT
                  action, so the later rule can never match
  * redundancy  - an earlier rule fully covers a later rule with the SAME
                  action, so the later rule is unnecessary
  * duplicate   - two rules with identical match + action
  * conflict    - two overlapping rules with opposite actions (order-dependent)

Exposed to agent code as a pre-imported `fwrule` object (mirrors markmap/compact
global helpers, NOT an `_api_call`):

    fwrule.analyze(acl_text, vendor="ios")
    fwrule.analyze(rules=[{...}, {...}])
"""
from __future__ import annotations

import ipaddress
import re
from typing import Any, Callable, Dict, List, Optional, Union


class _Rule:
    """A normalized firewall rule across 6 match dimensions.

    Networks are ip_network objects (0.0.0.0/0 = any). Ports are (lo, hi)
    inclusive ranges; (0, 65535) = any. Protocol is a lowercased string or
    "ip"/"any" for the wildcard.
    """

    ANY_NET = ipaddress.ip_network("0.0.0.0/0")
    ANY_PORT = (0, 65535)

    def __init__(
        self,
        index: int,
        action: str,
        protocol: str,
        src: ipaddress._BaseNetwork,
        src_port: tuple,
        dst: ipaddress._BaseNetwork,
        dst_port: tuple,
        raw: str,
    ) -> None:
        self.index = index
        self.action = action
        self.protocol = protocol
        self.src = src
        self.src_port = src_port
        self.dst = dst
        self.dst_port = dst_port
        self.raw = raw

    # --- dimension-wise containment / overlap -------------------------------

    @staticmethod
    def _proto_covers(a: str, b: str) -> bool:
        return a in ("ip", "any") or a == b

    @staticmethod
    def _proto_overlaps(a: str, b: str) -> bool:
        return a in ("ip", "any") or b in ("ip", "any") or a == b

    @staticmethod
    def _net_covers(a: ipaddress._BaseNetwork, b: ipaddress._BaseNetwork) -> bool:
        return b.subnet_of(a) if a.version == b.version else False

    @staticmethod
    def _net_overlaps(a: ipaddress._BaseNetwork, b: ipaddress._BaseNetwork) -> bool:
        return a.overlaps(b) if a.version == b.version else False

    @staticmethod
    def _port_covers(a: tuple, b: tuple) -> bool:
        return a[0] <= b[0] and a[1] >= b[1]

    @staticmethod
    def _port_overlaps(a: tuple, b: tuple) -> bool:
        return a[0] <= b[1] and b[0] <= a[1]

    def covers(self, other: "_Rule") -> bool:
        """True if self's match set is a superset of other's (all 5 match dims)."""
        return (
            self._proto_covers(self.protocol, other.protocol)
            and self._net_covers(self.src, other.src)
            and self._port_covers(self.src_port, other.src_port)
            and self._net_covers(self.dst, other.dst)
            and self._port_covers(self.dst_port, other.dst_port)
        )

    def overlaps(self, other: "_Rule") -> bool:
        """True if self and other can both match at least one packet."""
        return (
            self._proto_overlaps(self.protocol, other.protocol)
            and self._net_overlaps(self.src, other.src)
            and self._port_overlaps(self.src_port, other.src_port)
            and self._net_overlaps(self.dst, other.dst)
            and self._port_overlaps(self.dst_port, other.dst_port)
        )

    def same_match(self, other: "_Rule") -> bool:
        return (
            self.protocol == other.protocol
            and self.src == other.src
            and self.src_port == other.src_port
            and self.dst == other.dst
            and self.dst_port == other.dst_port
        )


class FwruleAnalyzer:
    """Parses rule sets and reports overlap/shadow/conflict/duplicate anomalies."""

    _PORT_KW = {"eq", "lt", "gt", "neq", "range"}

    # --- public entrypoint --------------------------------------------------

    def analyze(
        self,
        acl_text: Optional[str] = None,
        vendor: str = "ios",
        rules: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Analyze an ACL/rule set. Returns a findings report dict.

        Provide EITHER `acl_text` (raw CLI, parsed per `vendor`) OR `rules`
        (a normalized list of dicts with keys action/protocol/src/dst and
        optional src_port/dst_port). Returns:
          {ok, vendor, rule_count, findings:[{type, earlier, later, detail}],
           summary:{shadowing, redundancy, duplicate, conflict}}
        """
        try:
            if rules is not None:
                parsed = [self._rule_from_dict(i, r) for i, r in enumerate(rules)]
            elif acl_text is not None:
                parsed = self._parse_acl(acl_text, vendor)
            else:
                return {"ok": False, "error": "Provide acl_text= or rules=."}
        except Exception as e:  # parse errors shouldn't crash the sandbox
            return {"ok": False, "error": f"Parse error: {e}"}

        parsed = [r for r in parsed if r is not None]
        findings = self._find_anomalies(parsed)
        summary = {k: 0 for k in ("shadowing", "redundancy", "duplicate", "conflict")}
        for f in findings:
            summary[f["type"]] = summary.get(f["type"], 0) + 1

        return {
            "ok": True,
            "vendor": vendor,
            "rule_count": len(parsed),
            "findings": findings,
            "summary": summary,
        }

    # --- anomaly detection --------------------------------------------------

    def _find_anomalies(self, rules: List[_Rule]) -> List[Dict[str, Any]]:
        findings: List[Dict[str, Any]] = []
        for i, earlier in enumerate(rules):
            for later in rules[i + 1:]:
                if earlier.same_match(later):
                    if earlier.action == later.action:
                        findings.append(self._finding("duplicate", earlier, later,
                                                       "identical match and action"))
                    else:
                        findings.append(self._finding("conflict", earlier, later,
                                                       "identical match, opposite action; the earlier wins"))
                    continue
                if earlier.covers(later):
                    if earlier.action == later.action:
                        findings.append(self._finding("redundancy", earlier, later,
                                                       "earlier rule already covers this; later rule is unnecessary"))
                    else:
                        findings.append(self._finding("shadowing", earlier, later,
                                                       "earlier rule fully shadows this; later rule can never match"))
                elif earlier.overlaps(later) and earlier.action != later.action:
                    findings.append(self._finding("conflict", earlier, later,
                                                   "partial overlap with opposite actions; order-dependent"))
        return findings

    @staticmethod
    def _finding(kind: str, earlier: _Rule, later: _Rule, detail: str) -> Dict[str, Any]:
        return {
            "type": kind,
            "earlier": {"index": earlier.index, "raw": earlier.raw},
            "later": {"index": later.index, "raw": later.raw},
            "detail": detail,
        }

    # --- normalized-dict input ---------------------------------------------

    def _rule_from_dict(self, index: int, r: Dict[str, Any]) -> _Rule:
        action = str(r.get("action", "permit")).lower()
        protocol = str(r.get("protocol", "ip")).lower()
        src = self._net(r.get("src", "any"))
        dst = self._net(r.get("dst", "any"))
        src_port = self._port_tuple(r.get("src_port"))
        dst_port = self._port_tuple(r.get("dst_port"))
        raw = r.get("raw") or f"{action} {protocol} {r.get('src','any')} {r.get('dst','any')}"
        return _Rule(index, action, protocol, src, src_port, dst, dst_port, raw)

    @staticmethod
    def _net(val: Any) -> ipaddress._BaseNetwork:
        if val in (None, "", "any", "0.0.0.0/0"):
            return _Rule.ANY_NET
        return ipaddress.ip_network(str(val), strict=False)

    @staticmethod
    def _port_tuple(val: Any) -> tuple:
        if val in (None, "", "any"):
            return _Rule.ANY_PORT
        if isinstance(val, (list, tuple)) and len(val) == 2:
            return (int(val[0]), int(val[1]))
        p = int(val)
        return (p, p)

    # --- Cisco IOS/IOS-XE extended ACL parser -------------------------------

    def _parse_acl(self, text: str, vendor: str) -> List[Optional[_Rule]]:
        if vendor not in ("ios", "ios-xe", "iosxe", "ios_xe"):
            # Only IOS-family CLI parsing is implemented; other vendors should
            # pass a normalized `rules=` list. Be explicit rather than silent.
            raise ValueError(
                f"CLI parsing for vendor '{vendor}' is not implemented; pass a "
                f"normalized rules=[...] list instead (ios/ios-xe supported)."
            )
        rules: List[Optional[_Rule]] = []
        idx = 0
        for line in text.splitlines():
            entry = line.strip()
            if not entry or entry.startswith(("!", "ip access-list", "access-list")):
                # Skip headers/comments; sequence-only lines fall through below.
                if entry.startswith("access-list"):
                    entry = re.sub(r"^access-list\s+\S+\s+", "", entry)
                else:
                    continue
            m = self._parse_ace(entry, idx)
            if m is not None:
                rules.append(m)
                idx += 1
        return rules

    def _parse_ace(self, entry: str, index: int) -> Optional[_Rule]:
        """Parse one extended ACE line into a _Rule (best effort)."""
        # Drop a leading sequence number ("10 permit ...").
        entry = re.sub(r"^\d+\s+", "", entry).strip()
        toks = entry.split()
        if len(toks) < 2 or toks[0] not in ("permit", "deny"):
            return None
        action = toks[0]
        protocol = toks[1].lower()
        rest = toks[2:]

        src, rest = self._take_addr(rest)
        src_port, rest = self._take_port(rest)
        dst, rest = self._take_addr(rest)
        dst_port, rest = self._take_port(rest)

        return _Rule(index, action, protocol, src, src_port, dst, dst_port, entry)

    def _take_addr(self, toks: List[str]):
        """Consume an address spec from the token list → (network, remaining)."""
        if not toks:
            return _Rule.ANY_NET, toks
        t = toks[0]
        if t == "any":
            return _Rule.ANY_NET, toks[1:]
        if t == "host" and len(toks) >= 2:
            return ipaddress.ip_network(f"{toks[1]}/32", strict=False), toks[2:]
        # "A.B.C.D wildcard" form (IOS wildcard mask).
        if self._is_ip(t) and len(toks) >= 2 and self._is_ip(toks[1]):
            net = self._wildcard_to_net(toks[0], toks[1])
            return net, toks[2:]
        if self._is_ip(t):
            return ipaddress.ip_network(f"{t}/32", strict=False), toks[1:]
        return _Rule.ANY_NET, toks

    def _take_port(self, toks: List[str]):
        """Consume an optional port spec → ((lo,hi), remaining)."""
        if not toks or toks[0] not in self._PORT_KW:
            return _Rule.ANY_PORT, toks
        op = toks[0]
        if op == "range" and len(toks) >= 3:
            return (self._port_num(toks[1]), self._port_num(toks[2])), toks[3:]
        if len(toks) >= 2:
            p = self._port_num(toks[1])
            if op == "eq":
                return (p, p), toks[2:]
            if op == "lt":
                return (0, max(0, p - 1)), toks[2:]
            if op == "gt":
                return (min(65535, p + 1), 65535), toks[2:]
            if op == "neq":
                # Approximate neq as "any" (a hole) — conservative for overlap.
                return _Rule.ANY_PORT, toks[2:]
        return _Rule.ANY_PORT, toks

    @staticmethod
    def _port_num(tok: str) -> int:
        _NAMED = {"www": 80, "http": 80, "https": 443, "ssh": 22, "telnet": 23,
                  "domain": 53, "bgp": 179, "ftp": 21, "smtp": 25, "snmp": 161,
                  "ntp": 123, "tftp": 69, "syslog": 514}
        return _NAMED.get(tok.lower(), int(tok)) if not tok.isdigit() else int(tok)

    @staticmethod
    def _is_ip(tok: str) -> bool:
        try:
            ipaddress.ip_address(tok)
            return True
        except ValueError:
            return False

    @staticmethod
    def _wildcard_to_net(addr: str, wildcard: str) -> ipaddress._BaseNetwork:
        """Convert an IOS 'address wildcard' pair to an ip_network."""
        addr_i = int(ipaddress.ip_address(addr))
        wild_i = int(ipaddress.ip_address(wildcard))
        mask_i = wild_i ^ 0xFFFFFFFF  # invert wildcard → netmask
        netmask = ipaddress.ip_address(mask_i)
        return ipaddress.ip_network(f"{addr}/{netmask}", strict=False)

    def help(self) -> str:
        return (
            "fwrule.analyze(acl_text, vendor='ios') parses Cisco IOS/IOS-XE extended "
            "ACLs and reports shadowing/redundancy/duplicate/conflict findings. "
            "fwrule.analyze(rules=[{action,protocol,src,dst,src_port,dst_port}, ...]) "
            "analyzes a normalized rule list from ANY vendor. Returns "
            "{ok, rule_count, findings:[...], summary:{...}}."
        )


def install_fwrule(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> FwruleAnalyzer:
    """Register a `fwrule` analyzer as a sandbox global AND importable module."""
    analyzer = FwruleAnalyzer()
    globals_dict["fwrule"] = analyzer

    import sys as _sys
    import types as _types
    mod = _types.ModuleType("fwrule_helper")
    mod.analyze = analyzer.analyze  # type: ignore[attr-defined]
    mod.fwrule = analyzer  # type: ignore[attr-defined]
    _sys.modules["fwrule_helper"] = mod

    return analyzer
