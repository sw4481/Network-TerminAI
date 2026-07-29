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
            cap.close()
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
    cap.close()
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
        cap.close()


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
        cap.close()
