"""Pcap summarization + display-filter + raw-bytes helpers.

Plan 11 builds on the Plan 00 `summarize_pcap` shape. We keep that signature
backward-compatible (positional `path`, `max_packets`) and add an optional
`display_filter` kwarg + two new helpers:

* `packet_bytes(path, index)` — hex/ASCII for the hex-view tab.
* `follow_stream(path, stream_index)` — TCP reassembly for the
  follow-stream modal.

Errors that the orchestrator/UI cares about (invalid display filter, file
missing) propagate as `PcapInvalidFilterError` / `FileNotFoundError` so the
NDJSON server handler can surface a structured `pcap.error` payload.
"""

import asyncio
import csv
import re
import shutil
import subprocess
from pathlib import Path
from typing import Iterable

import pyshark


class PcapInvalidFilterError(Exception):
    """Raised when pyshark / tshark rejects a display filter expression."""


def _ensure_event_loop() -> None:
    """Guarantee the current thread has a running-capable asyncio event loop.

    pyshark.FileCapture calls asyncio.get_event_loop() internally. On Python
    3.12 that raises "There is no current event loop in thread 'MainThread'"
    when no loop is set — which happens after any asyncio.run() (it closes the
    loop and clears the thread's current loop). The sidecar runs many
    asyncio.run() agent loops in one long-lived process, so a pcap call that
    follows an agent turn would hit this. Install a fresh loop when needed.
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError("event loop is closed")
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())


def _ip_field(pkt, field: str):
    layer = getattr(pkt, "ip", None) or getattr(pkt, "ipv6", None)
    return getattr(layer, field, None) if layer is not None else None


def _packet_to_dict(pkt, count: int) -> dict:
    return {
        "no": count,
        "time": float(pkt.sniff_timestamp),
        "src": _ip_field(pkt, "src"),
        "dst": _ip_field(pkt, "dst"),
        "protocol": pkt.highest_layer,
        "length": int(pkt.length),
    }


def _close_capture(cap, *, display_filter: str | None = None) -> None:
    """Close PyShark while tolerating its Python 3.12 child-watcher race.

    In a long-lived sidecar (and in the full pytest suite), another asyncio
    consumer can replace the process child watcher after PyShark has reaped an
    empty-filter TShark process. PyShark then reports return code 255 with no
    TShark error line during `close()` even though iteration completed. That is
    cleanup bookkeeping, not a packet/filter failure. A real rejected display
    filter carries a concrete last-error line and remains an invalid-filter
    error.
    """
    try:
        cap.close()
    except Exception as exc:  # noqa: BLE001 - PyShark exposes several wrappers
        message = str(exc)
        lowered = message.lower()
        watcher_race = "retcode: 255" in lowered and "last error line: none" in lowered
        event_loop_cleanup = (
            "event loop is closed" in lowered or "event loop is already running" in lowered
        )
        if watcher_race or event_loop_cleanup:
            return
        if display_filter:
            raise PcapInvalidFilterError(message) from exc
        raise


def summarize_pcap(
    path: str,
    max_packets: int = 100,
    display_filter: str | None = None,
) -> dict:
    """Walk `path`, return the first `max_packets` packets + total count.

    `display_filter` is the Wireshark display-filter expression (e.g.
    ``"icmp"``, ``"tcp.port == 443"``). When provided, pyshark filters the
    iteration; an invalid expression surfaces as `PcapInvalidFilterError`.
    """
    _ensure_event_loop()
    kwargs: dict = {"keep_packets": False}
    if display_filter:
        kwargs["display_filter"] = display_filter
    cap = pyshark.FileCapture(path, **kwargs)
    packets: list[dict] = []
    count = 0
    try:
        for pkt in cap:
            count += 1
            if len(packets) < max_packets:
                packets.append(_packet_to_dict(pkt, count))
    except Exception as exc:  # noqa: BLE001 - tshark crash maps to invalid filter
        msg = str(exc)
        # Close before raising so pyshark's destructor doesn't re-raise on
        # cleanup. Best-effort: a second exception here is swallowed because
        # we already have the canonical one.
        try:
            _close_capture(cap, display_filter=display_filter)
        except Exception:
            pass
        if display_filter and (
            "display filter" in msg.lower()
            or "syntax error" in msg.lower()
            or "invalid filter" in msg.lower()
            or "tshark" in msg.lower()
            or "crashed" in msg.lower()
        ):
            raise PcapInvalidFilterError(msg) from exc
        raise
    _close_capture(cap, display_filter=display_filter)
    return {"packet_count": count, "packets": packets}


def packet_bytes(path: str, index: int) -> dict:
    """Return raw bytes for the 1-indexed packet at `index`.

    Yields ``{"hex": "ff aa …", "ascii": ".....", "length": N}``.
    """
    _ensure_event_loop()
    cap = pyshark.FileCapture(
        path, include_raw=True, use_json=True, keep_packets=False
    )
    try:
        count = 0
        for pkt in cap:
            count += 1
            if count == index:
                raw = pkt.get_raw_packet()
                hex_str = " ".join(f"{b:02x}" for b in raw)
                ascii_str = "".join(
                    chr(b) if 32 <= b < 127 else "." for b in raw
                )
                return {"hex": hex_str, "ascii": ascii_str, "length": len(raw)}
        raise IndexError(f"packet index {index} out of range (count={count})")
    finally:
        _close_capture(cap)


def follow_stream(path: str, stream_index: int) -> dict:
    """Reassemble TCP stream `stream_index` into client/server byte buffers.

    Direction is decided by the first packet's ``ip.src`` (the client).
    Non-printable bytes are replaced with ``.`` in the ASCII view consumers
    see in the modal.
    """
    _ensure_event_loop()
    cap = pyshark.FileCapture(
        path,
        display_filter=f"tcp.stream eq {stream_index}",
        keep_packets=False,
    )
    try:
        client_ip: str | None = None
        client_buf = bytearray()
        server_buf = bytearray()
        packets: list[dict] = []
        count = 0
        for pkt in cap:
            count += 1
            try:
                src = _ip_field(pkt, "src")
            except Exception:
                src = None
            if client_ip is None and src is not None:
                client_ip = src
            payload_hex = getattr(getattr(pkt, "tcp", None), "payload", None)
            if payload_hex:
                # tcp.payload is colon-delimited hex.
                try:
                    payload = bytes(
                        int(b, 16)
                        for b in payload_hex.replace(":", " ").split()
                    )
                except ValueError:
                    payload = b""
                if src == client_ip:
                    client_buf.extend(payload)
                else:
                    server_buf.extend(payload)
            packets.append(_packet_to_dict(pkt, count))

        def _printable(b: int) -> str:
            return chr(b) if 32 <= b < 127 or b in (9, 10, 13) else "."

        return {
            "client_ascii": "".join(_printable(b) for b in client_buf),
            "server_ascii": "".join(_printable(b) for b in server_buf),
            "client_bytes": len(client_buf),
            "server_bytes": len(server_buf),
            "packets": packets,
        }
    finally:
        _close_capture(cap, display_filter=f"tcp.stream eq {stream_index}")


FINDINGS_SCAN_LIMIT = 250_000
FINDINGS_EVIDENCE_LIMIT = 20


class PcapUnsupportedFindingFilterError(Exception):
    """Raised when the installed TShark cannot compile the built-in filters."""


class PcapInvalidFindingRulesError(Exception):
    """Raised when a caller requests a rule ID outside the built-in suite."""


# Fixed, backend-owned rules. The UI may enable/disable IDs, but it never
# supplies a display filter or executable predicate.
_FINDING_RULES = (
    {
        "rule_id": "arp.duplicate_address",
        "category": "ARP",
        "severity": "critical",
        "title": "ARP duplicate address",
        "display_filter": "arp.duplicate-address-detected",
    },
    {
        "rule_id": "bgp.notification",
        "category": "BGP",
        "severity": "critical",
        "title": "BGP NOTIFICATION",
        "display_filter": "bgp.type == 3",
    },
    {
        "rule_id": "checksum.bad",
        "category": "Integrity",
        "severity": "medium",
        "title": "Bad IP/TCP/UDP checksum",
        "display_filter": "ip.checksum_bad.expert || tcp.checksum_bad.expert || udp.checksum.bad",
    },
    {
        "rule_id": "dhcpv4.nak",
        "category": "DHCP",
        "severity": "medium",
        "title": "DHCPv4 NAK",
        "display_filter": "dhcp.option.dhcp == 6",
    },
    {
        "rule_id": "dhcpv6.failure",
        "category": "DHCP",
        "severity": "medium",
        "title": "DHCPv6 non-success status",
        "display_filter": "dhcpv6.status_code != 0",
    },
    {
        "rule_id": "dns.response_error",
        "category": "DNS",
        "severity": "medium",
        "title": "DNS response error",
        "display_filter": "dns.flags.response == 1 && dns.flags.rcode != 0",
    },
    {
        "rule_id": "http.client_error",
        "category": "HTTP",
        "severity": "low",
        "title": "HTTP 4xx response",
        "display_filter": "http.response.code >= 400 && http.response.code <= 499",
    },
    {
        "rule_id": "http.server_error",
        "category": "HTTP",
        "severity": "high",
        "title": "HTTP 5xx response",
        "display_filter": "http.response.code >= 500 && http.response.code <= 599",
    },
    {
        "rule_id": "icmp.failure",
        "category": "ICMP",
        "severity": "medium",
        "title": "ICMP/ICMPv6 failure",
        "display_filter": (
            "icmp.type == 3 || icmp.type == 4 || icmp.type == 5 || "
            "icmp.type == 11 || icmp.type == 12 || icmpv6.type == 1 || "
            "icmpv6.type == 2 || icmpv6.type == 3 || icmpv6.type == 4"
        ),
    },
    {
        "rule_id": "kerberos.error",
        "category": "Kerberos",
        "severity": "high",
        "title": "Kerberos error",
        "display_filter": "kerberos.error_code != 0",
    },
    {
        "rule_id": "packet.malformed",
        "category": "Integrity",
        "severity": "high",
        "title": "Malformed packet",
        "display_filter": "_ws.malformed",
    },
    {
        "rule_id": "smb2.error",
        "category": "SMB",
        "severity": "high",
        "title": "SMB2 error status",
        "display_filter": "smb2.nt_status != 0x00000000",
    },
    {
        "rule_id": "ssh.disconnect",
        "category": "SSH",
        "severity": "medium",
        "title": "SSH disconnect",
        "display_filter": "ssh.message_code == 1 || ssh.disconnect_reason",
    },
    {
        "rule_id": "tcp.analysis",
        "category": "TCP",
        "severity": "high",
        "title": "TCP delivery anomaly",
        "display_filter": (
            "tcp.analysis.retransmission || tcp.analysis.fast_retransmission || "
            "tcp.analysis.lost_segment || tcp.analysis.out_of_order"
        ),
    },
    {
        "rule_id": "tcp.reset",
        "category": "TCP",
        "severity": "medium",
        "title": "TCP reset",
        "display_filter": "tcp.flags.reset == 1",
    },
    {
        "rule_id": "tcp.zero_window",
        "category": "TCP",
        "severity": "high",
        "title": "TCP zero window",
        "display_filter": "tcp.analysis.zero_window",
    },
    {
        "rule_id": "tls.alert",
        "category": "TLS",
        "severity": "high",
        "title": "TLS alert",
        "display_filter": "tls.alert_message",
    },
)

_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}

# First eight columns are evidence; the remainder are rule signals. Keep this
# order synchronized with `_matches_rule` and the TShark command builder.
_FINDING_FIELDS = (
    "frame.number",
    "frame.time_epoch",
    "ip.src",
    "ipv6.src",
    "ip.dst",
    "ipv6.dst",
    "_ws.col.Protocol",
    "frame.len",
    "dns.flags.response",
    "dns.flags.rcode",
    "tcp.analysis.retransmission",
    "tcp.analysis.fast_retransmission",
    "tcp.analysis.lost_segment",
    "tcp.analysis.out_of_order",
    "tcp.flags.reset",
    "tcp.analysis.zero_window",
    "icmp.type",
    "icmpv6.type",
    "tls.alert_message",
    "dhcp.option.dhcp",
    "dhcpv6.status_code",
    "arp.duplicate-address-detected",
    "bgp.type",
    "http.response.code",
    "smb2.nt_status",
    "kerberos.error_code",
    "ssh.message_code",
    "ssh.disconnect_reason",
    "_ws.malformed",
    "ip.checksum_bad.expert",
    "tcp.checksum_bad.expert",
    "udp.checksum.bad",
)


def finding_rules() -> list[dict]:
    """Return immutable built-in rule metadata in stable rule-ID order."""
    return [
        {**rule, "enabled_by_default": True}
        for rule in sorted(_FINDING_RULES, key=lambda item: item["rule_id"])
    ]


def _values(raw: str) -> list[str]:
    return [value.strip() for value in raw.split(",") if value.strip()]


def _ints(raw: str) -> list[int]:
    values = []
    for value in _values(raw):
        try:
            values.append(int(value, 0))
        except ValueError:
            try:
                values.append(int(float(value)))
            except ValueError:
                continue
    return values


def _present(fields: dict[str, str], *names: str) -> bool:
    return any(bool(_values(fields.get(name, ""))) for name in names)


def _matches_rule(rule_id: str, fields: dict[str, str]) -> bool:
    if rule_id == "dns.response_error":
        return 1 in _ints(fields["dns.flags.response"]) and any(
            value != 0 for value in _ints(fields["dns.flags.rcode"])
        )
    if rule_id == "tcp.analysis":
        return _present(
            fields,
            "tcp.analysis.retransmission",
            "tcp.analysis.fast_retransmission",
            "tcp.analysis.lost_segment",
            "tcp.analysis.out_of_order",
        )
    if rule_id == "tcp.reset":
        return 1 in _ints(fields["tcp.flags.reset"])
    if rule_id == "tcp.zero_window":
        return _present(fields, "tcp.analysis.zero_window")
    if rule_id == "icmp.failure":
        return bool({3, 4, 5, 11, 12}.intersection(_ints(fields["icmp.type"]))) or bool(
            {1, 2, 3, 4}.intersection(_ints(fields["icmpv6.type"]))
        )
    if rule_id == "tls.alert":
        return _present(fields, "tls.alert_message")
    if rule_id == "dhcpv4.nak":
        return 6 in _ints(fields["dhcp.option.dhcp"])
    if rule_id == "dhcpv6.failure":
        return any(value != 0 for value in _ints(fields["dhcpv6.status_code"]))
    if rule_id == "arp.duplicate_address":
        return _present(fields, "arp.duplicate-address-detected")
    if rule_id == "bgp.notification":
        return 3 in _ints(fields["bgp.type"])
    if rule_id == "http.client_error":
        return any(400 <= value <= 499 for value in _ints(fields["http.response.code"]))
    if rule_id == "http.server_error":
        return any(500 <= value <= 599 for value in _ints(fields["http.response.code"]))
    if rule_id == "smb2.error":
        return any(value != 0 for value in _ints(fields["smb2.nt_status"]))
    if rule_id == "kerberos.error":
        return any(value != 0 for value in _ints(fields["kerberos.error_code"]))
    if rule_id == "ssh.disconnect":
        return 1 in _ints(fields["ssh.message_code"]) or _present(
            fields, "ssh.disconnect_reason"
        )
    if rule_id == "packet.malformed":
        return _present(fields, "_ws.malformed")
    if rule_id == "checksum.bad":
        return _present(
            fields,
            "ip.checksum_bad.expert",
            "tcp.checksum_bad.expert",
            "udp.checksum.bad",
        )
    return False


def _row_fields(row: list[str]) -> dict[str, str]:
    padded = row + [""] * max(0, len(_FINDING_FIELDS) - len(row))
    return dict(zip(_FINDING_FIELDS, padded, strict=True))


def _parse_findings_rows(rows: Iterable[list[str]], enabled_rule_ids: list[str]) -> dict:
    by_id = {rule["rule_id"]: rule for rule in _FINDING_RULES}
    counts = {rule_id: 0 for rule_id in enabled_rule_ids}
    evidence = {rule_id: [] for rule_id in enabled_rule_ids}
    scanned_packets = 0
    scan_truncated = False

    for row in rows:
        fields = _row_fields(row)
        frame_numbers = _ints(fields["frame.number"])
        if not frame_numbers:
            continue
        frame_number = frame_numbers[0]
        scanned_packets = max(scanned_packets, frame_number)
        if frame_number >= FINDINGS_SCAN_LIMIT:
            scan_truncated = True
        packet = {
            "no": frame_number,
            "time": float(fields["frame.time_epoch"] or 0),
            "src": fields["ip.src"] or fields["ipv6.src"] or None,
            "dst": fields["ip.dst"] or fields["ipv6.dst"] or None,
            "protocol": fields["_ws.col.Protocol"] or "Unknown",
            "length": (_ints(fields["frame.len"]) or [0])[0],
        }
        for rule_id in enabled_rule_ids:
            if _matches_rule(rule_id, fields):
                counts[rule_id] += 1
                if len(evidence[rule_id]) < FINDINGS_EVIDENCE_LIMIT:
                    evidence[rule_id].append(packet)

    findings = []
    for rule_id in enabled_rule_ids:
        count = counts[rule_id]
        if count == 0:
            continue
        rule = by_id[rule_id]
        findings.append(
            {
                "rule_id": rule_id,
                "category": rule["category"],
                "severity": rule["severity"],
                "title": rule["title"],
                "count": count,
                "display_filter": rule["display_filter"],
                "evidence": evidence[rule_id],
                "evidence_truncated": count > FINDINGS_EVIDENCE_LIMIT,
            }
        )
    findings.sort(key=lambda item: (_SEVERITY_ORDER[item["severity"]], item["rule_id"]))
    return {
        "findings": findings,
        "scanned_packets": min(scanned_packets, FINDINGS_SCAN_LIMIT),
        "scan_limit": FINDINGS_SCAN_LIMIT,
        "scan_truncated": scan_truncated,
    }


def pcap_findings(path: str, enabled_rule_ids: list[str] | None = None) -> dict:
    """Run one bounded TShark pass for all enabled deterministic rules."""
    capture = Path(path)
    if not capture.is_file():
        raise FileNotFoundError(path)
    by_id = {rule["rule_id"]: rule for rule in _FINDING_RULES}
    enabled = (
        sorted(by_id)
        if enabled_rule_ids is None
        else list(dict.fromkeys(enabled_rule_ids))
    )
    unknown = sorted(set(enabled).difference(by_id))
    if unknown:
        raise PcapInvalidFindingRulesError(
            f"unknown finding rule IDs: {', '.join(unknown)}"
        )
    if not enabled:
        return {
            "findings": [],
            "scanned_packets": 0,
            "scan_limit": FINDINGS_SCAN_LIMIT,
            "scan_truncated": False,
        }
    tshark = shutil.which("tshark")
    if tshark is None:
        raise RuntimeError("tshark was not found; install Wireshark to compute PCAP findings")

    union_filter = " || ".join(f"({by_id[rule_id]['display_filter']})" for rule_id in enabled)
    command = [
        tshark,
        "-n",
        "-r",
        str(capture),
        "-c",
        str(FINDINGS_SCAN_LIMIT),
        "-Y",
        union_filter,
        "-T",
        "fields",
        "-E",
        "separator=/t",
        "-E",
        "quote=d",
        "-E",
        "occurrence=a",
        "-z",
        "io,stat,0",
    ]
    for field in _FINDING_FIELDS:
        command.extend(("-e", field))

    process = subprocess.Popen(  # noqa: S603 - fixed executable and backend-owned args
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert process.stdout is not None
    packet_lines = []
    scanned_packets = None
    io_stat_row = re.compile(
        r"^\|\s*[0-9.]+\s+<>\s+[0-9.]+\s+\|\s*([0-9]+)\s*\|"
    )
    for line in process.stdout:
        match = io_stat_row.match(line)
        if match:
            scanned_packets = int(match.group(1))
        elif line.startswith('"') or line[:1].isdigit():
            packet_lines.append(line)
    rows = csv.reader(packet_lines, delimiter="\t", quotechar='"')
    result = _parse_findings_rows(rows, enabled)
    if scanned_packets is not None:
        result["scanned_packets"] = min(scanned_packets, FINDINGS_SCAN_LIMIT)
        # `-c` never dissects packet 250001. At exactly the limit we mark the
        # result conservatively truncated because PCAP itself has no count
        # header that can prove there is no next record.
        result["scan_truncated"] = scanned_packets >= FINDINGS_SCAN_LIMIT
    stderr = process.stderr.read() if process.stderr is not None else ""
    return_code = process.wait()
    if return_code != 0:
        detail = stderr.strip() or f"tshark exited with status {return_code}"
        lowered = detail.lower()
        if "valid protocol or protocol field" in lowered or "isn't a valid" in lowered:
            raise PcapUnsupportedFindingFilterError(detail)
        raise RuntimeError(detail)
    return result
