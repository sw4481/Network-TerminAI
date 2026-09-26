"""neonize-backed WhatsApp linked-device bridge.

Runs a single long-lived neonize client on a daemon thread (neonize's sync
client blocks in `connect()` + `event.wait()`, so it cannot live on the sidecar
`run_loop` thread). Inbound messages are allowlist-filtered and pushed onto a
queue that the Rust poll task drains via the `whatsapp.poll` RPC. Link/QR state
is likewise polled via `whatsapp.status`.

Transport: personal linked-device (unofficial). No public webhook; the client
dials out to WhatsApp, so it works behind NAT. See the WhatsApp Bridge design
doc for the full rationale and the ban-risk caveat.
"""
from __future__ import annotations

import base64
import threading
from io import BytesIO
from typing import Any, Optional

from ccie_sidecar.whatsapp_config import (
    config_dir,
    get_whatsapp_config,
    is_allowed,
    normalize_number,
)


def _log(msg: str) -> None:
    """Append a line to the WhatsApp debug log. The sidecar can't use stdout
    (it's the NDJSON channel), so bridge events go to a file we can tail:
    ~/Library/Application Support/ccie-terminal/whatsapp-debug.log
    """
    try:
        path = config_dir() / "whatsapp-debug.log"
        with open(path, "a") as f:
            f.write(msg.rstrip() + "\n")
    except Exception:
        pass


_NATIVE_OUTPUT_LOCK = threading.Lock()


def _call_native_quietly(fn):
    """Run a neonize call without allowing native stdout to corrupt NDJSON."""
    import os

    with _NATIVE_OUTPUT_LOCK:
        saved_stdout = os.dup(1)
        devnull = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(devnull, 1)
            return fn()
        finally:
            os.dup2(saved_stdout, 1)
            os.close(devnull)
            os.close(saved_stdout)


class _WhatsAppBridge:
    """Module-level singleton. All public methods are safe to call from the
    sidecar RPC thread; the neonize client itself lives on `_thread`."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._client: Any = None
        self._thread: Optional[threading.Thread] = None
        self._inbound: list[dict[str, Any]] = []
        # state: "idle" | "starting" | "qr" | "linked" | "error"
        self._state: str = "idle"
        self._qr_png_data_url: Optional[str] = None
        self._me: Optional[str] = None
        self._error: Optional[str] = None
        self._allowlist: list[str] = []
        self._stop_event = threading.Event()
        # Full JID (…@g.us or …@s.whatsapp.net) CCIE is scoped to. Empty => any.
        self._bound_chat: str = ""
        # IDs of messages CCIE itself sent. On a single account, every outgoing
        # message echoes back as an inbound `IsFromMe` event; without this we'd
        # treat our own alerts/replies as commands and loop forever.
        self._sent_ids: set[str] = set()
        self._sent_order: list[str] = []
        # Chats CCIE has observed a message in: jid -> {"jid","name","is_group"}.
        # This is how the Settings picker discovers the "CCIE Ops" group — the
        # native get_joined_groups() call is BROKEN in this neonize build
        # (protobuf wire-format error) and whatsmeow's local store keeps no group
        # roster, so harvesting from the working message path is the only option.
        # PERSISTED to disk (`_chats_path`) so a sidecar restart doesn't forget
        # them — otherwise you'd have to re-message the group every relaunch.
        self._observed_chats: dict[str, dict[str, Any]] = {}
        self._session_dir: str = ""

    # -- observed-chat persistence ----------------------------------------

    def _chats_path(self) -> str:
        import os

        return os.path.join(self._session_dir or "", "observed_chats.json")

    def _load_observed(self) -> None:
        import json

        path = self._chats_path()
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self._observed_chats = {k: v for k, v in data.items() if isinstance(v, dict)}
                _log(f"loaded {len(self._observed_chats)} observed chats from disk")
        except FileNotFoundError:
            pass
        except Exception as e:
            _log(f"load observed chats failed: {e}")

    def _save_observed_locked(self) -> None:
        """Persist observed chats. Caller must hold self._lock."""
        import json

        path = self._chats_path()
        try:
            with open(path, "w") as f:
                json.dump(self._observed_chats, f)
        except Exception as e:
            _log(f"save observed chats failed: {e}")

    # -- lifecycle ---------------------------------------------------------

    def link(
        self,
        session_dir: str,
        allowlist: list[str],
        bound_chat: str = "",
    ) -> dict[str, Any]:
        """Start (or restart) the neonize client. Idempotent while running."""
        with self._lock:
            self._allowlist = list(allowlist or [])
            self._bound_chat = (bound_chat or "").strip()
            self._session_dir = session_dir or self._session_dir
            # Restore chats discovered in previous runs so the picker isn't
            # empty after a restart.
            if not self._observed_chats:
                self._load_observed()
            if self._thread is not None and self._thread.is_alive():
                # Already running — just refresh allowlist/scope and report state.
                return self._status_locked()
            self._stop_event.clear()
            self._state = "starting"
            self._qr_png_data_url = None
            self._error = None

        t = threading.Thread(
            target=self._run,
            args=(session_dir,),
            name="ccie-whatsapp",
            daemon=True,
        )
        with self._lock:
            self._thread = t
        t.start()
        with self._lock:
            return self._status_locked()

    def _run(self, session_dir: str) -> None:
        import os

        os.makedirs(session_dir, exist_ok=True)

        # Recreate the client after every disconnect. neonize's connect() blocks
        # until the websocket dies; leaving the old client in place makes the
        # bridge report a permanently false "linked" state and send into a
        # dead socket.
        attempt = 0
        while not self._stop_event.is_set():
            client: Any = None
            try:
                from neonize.client import NewClient
                from neonize.events import ConnectedEv, MessageEv

                # neonize 0.4's NewClient takes the sqlite store path as its
                # first positional arg (`name`); there is no `database=` kwarg.
                db_path = os.path.join(session_dir, "neonize.db")
                client = NewClient(db_path)
                with self._lock:
                    self._client = client

                @client.qr
                def _on_qr(_c: Any, qr_data: bytes) -> None:  # noqa: ANN401
                    self._set_qr(qr_data)

                @client.event(ConnectedEv)
                def _on_connected(c: Any, _e: Any) -> None:  # noqa: ANN401
                    me_user = None
                    try:
                        me = c.get_me()
                        me_user = getattr(getattr(me, "JID", None), "User", None)
                    except Exception:
                        pass
                    self._set_linked(me_user)

                @client.event(MessageEv)
                def _on_message(_c: Any, ev: Any) -> None:  # noqa: ANN401
                    self._on_message(ev)

                # Try to also capture group/receipt/history events that reveal
                # chats even when no text arrives.
                try:
                    from neonize.events import ReceiptEv

                    @client.event(ReceiptEv)
                    def _on_receipt(_c: Any, ev: Any) -> None:  # noqa: ANN401
                        self._on_receipt(ev)
                except Exception as e:
                    _log(f"ReceiptEv not available: {e}")

                _log(f"connecting… session_dir={session_dir}")
                client.connect()  # blocks until disconnect; runs the C event loop
                if self._stop_event.is_set():
                    break
                _log("connect() returned (disconnected); scheduling reconnect")
            except Exception as e:  # pragma: no cover - requires native lib
                if self._stop_event.is_set():
                    break
                _log(f"_run error; scheduling reconnect: {e}")
            finally:
                with self._lock:
                    if self._client is client:
                        self._client = None
                    if not self._stop_event.is_set():
                        self._state = "starting"
                        self._error = "WhatsApp connection lost; reconnecting"

            if self._stop_event.is_set():
                break
            delay = self._reconnect_delay(attempt)
            attempt += 1
            self._stop_event.wait(delay)

    def _reconnect_delay(self, attempt: int) -> float:
        """Bound reconnect backoff so a transient outage cannot spin the client."""
        return min(60.0, max(1.0, 2.0**min(attempt, 5)))

    def unlink(self) -> dict[str, Any]:
        with self._lock:
            self._stop_event.set()
            client = self._client
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass
        with self._lock:
            self._client = None
            self._thread = None
            self._state = "idle"
            self._qr_png_data_url = None
            self._me = None
            self._inbound.clear()
            self._observed_chats.clear()
            try:
                import os

                p = self._chats_path()
                if p and os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass
            return self._status_locked()

    # -- event handlers (run on the neonize thread) ------------------------

    def _set_qr(self, qr_data: bytes) -> None:
        data_url = _qr_to_png_data_url(qr_data)
        with self._lock:
            self._state = "qr"
            self._qr_png_data_url = data_url

    def _set_linked(self, me_user: Optional[str]) -> None:
        with self._lock:
            self._state = "linked"
            self._qr_png_data_url = None
            if me_user:
                self._me = me_user

    def _on_message(self, ev: Any) -> None:  # noqa: ANN401
        # neonize 0.4 exposes protobuf messages with capitalized field names:
        # MessageEv.Message.conversation, MessageEv.Info.{ID,MessageSource},
        # MessageSource.{Sender,Chat,IsFromMe}, JID.{User,Server}. (The Context7
        # docs describe an older lowercase API.)
        try:
            wa_msg = getattr(ev, "Message", None)
            text = getattr(wa_msg, "conversation", "") or ""
            if not text:
                ext = getattr(wa_msg, "extendedTextMessage", None)
                text = getattr(ext, "text", "") if ext is not None else ""
            info = getattr(ev, "Info", None)
            msg_id = getattr(info, "ID", "") or ""
            src = getattr(info, "MessageSource", None)
            sender_jid = getattr(src, "Sender", None)
            chat_jid = getattr(src, "Chat", None)
            sender = getattr(sender_jid, "User", None) or ""
            chat_str = _jid_to_string(chat_jid)
            is_group = bool(getattr(src, "IsGroup", False)) or getattr(chat_jid, "Server", "") == "g.us"
            pushname = getattr(info, "Pushname", "") or ""
            from_me = bool(getattr(src, "IsFromMe", False))
        except Exception as e:
            _log(f"MessageEv parse error: {e}")
            return

        _log(
            f"MessageEv: chat={chat_str!r} sender={sender!r} is_group={is_group} "
            f"from_me={getattr(src,'IsFromMe',None)} text={text[:40]!r} id={msg_id}"
        )

        # Record the chat so the Settings picker can discover it — BEFORE any
        # text/allowlist/scope filtering, so even non-text/system messages (e.g.
        # a freshly-created group's notifications) reveal the chat JID. For a
        # group we get no subject from a message, so label it "Group".
        if chat_str:
            with self._lock:
                if chat_str not in self._observed_chats:
                    self._observed_chats[chat_str] = {
                        "jid": chat_str,
                        "name": "Group" if is_group else (pushname or sender),
                        "is_group": is_group,
                    }
                    _log(f"observed new chat: {chat_str} (group={is_group})")
                    if len(self._observed_chats) > 100:
                        self._observed_chats.pop(next(iter(self._observed_chats)))
                    self._save_observed_locked()

        if not text or not sender:
            return

        with self._lock:
            allowlist = list(self._allowlist)
            bound = self._bound_chat
            # Loop protection: drop the echo of a message CCIE itself just sent.
            if msg_id and msg_id in self._sent_ids:
                return

        # Chat scoping: when bound to a specific chat/group, ignore everything
        # else. This is how CCIE coexists with another bot (e.g. Hermes) on one
        # account — CCIE lives in its group, Hermes in the self-chat/DMs.
        if bound and chat_str != bound:
            return

        # Allowlist is the only guardrail under full-trust — enforce it on the
        # human SENDER. CRITICAL: a message you send yourself (`IsFromMe`) must
        # ALWAYS pass — in a group your own `Sender` is a WhatsApp LID (a random
        # id), NOT your E.164 number, so it will never match the allowlist. You
        # are the linked account owner by definition, so bypass the allowlist for
        # your own messages; the allowlist only gates OTHER people.
        if not from_me and not is_allowed(sender, allowlist):
            _log(f"dropped: sender {sender!r} not in allowlist")
            return

        # Reply target: the chat the message arrived in (a group, or the sender
        # for a DM). Fall back to the sender's number when no full JID is present.
        reply_to = chat_str or sender

        with self._lock:
            # `authorized` tells the Rust layer this message already passed the
            # sidecar's allowlist/from_me gate — needed because a group's own-
            # message `from`/sender is a LID that won't re-match the allowlist.
            self._inbound.append({
                "chat": reply_to,
                "from": sender,
                "text": text,
                "authorized": True,
                "from_me": from_me,
            })
            # Bound the queue so a flood can't grow memory unboundedly.
            if len(self._inbound) > 200:
                self._inbound = self._inbound[-200:]

    def _on_receipt(self, ev: Any) -> None:  # noqa: ANN401
        # Receipts (delivery/read) also carry a Chat JID — another way to
        # discover a chat/group even when no text message is delivered.
        try:
            src = getattr(getattr(ev, "MessageSource", None), "Chat", None)
            if src is None:
                src = getattr(getattr(getattr(ev, "Info", None), "MessageSource", None), "Chat", None)
            chat_str = _jid_to_string(src)
            is_group = getattr(src, "Server", "") == "g.us"
        except Exception:
            return
        if chat_str:
            with self._lock:
                if chat_str not in self._observed_chats:
                    self._observed_chats[chat_str] = {
                        "jid": chat_str,
                        "name": "Group" if is_group else chat_str.split("@")[0],
                        "is_group": is_group,
                    }
                    _log(f"observed chat via receipt: {chat_str} (group={is_group})")
                    self._save_observed_locked()

    # -- RPC surface (called from the sidecar run_loop thread) -------------

    def poll(self) -> list[dict[str, Any]]:
        with self._lock:
            drained = self._inbound
            self._inbound = []
        return drained

    def status(self) -> dict[str, Any]:
        with self._lock:
            return self._status_locked()

    def _status_locked(self) -> dict[str, Any]:
        return {
            "state": self._state,
            "qr": self._qr_png_data_url,
            "me": self._me,
            "error": self._error,
        }

    def send(self, to: str, text: str) -> dict[str, Any]:
        with self._lock:
            client = self._client
            state = self._state
        if client is None or state != "linked":
            _log(f"send rejected: state={state}")
            return {"ok": False, "message": f"WhatsApp not linked (state={state})"}
        try:
            jid = _parse_jid(to)
            resp = _call_native_quietly(lambda: client.send_message(jid, text))
            # Record the outgoing ID so its inbound echo (IsFromMe) is ignored.
            sent_id = getattr(resp, "ID", "") or ""
            if sent_id:
                with self._lock:
                    self._sent_ids.add(sent_id)
                    self._sent_order.append(sent_id)
                    if len(self._sent_order) > 500:
                        old = self._sent_order.pop(0)
                        self._sent_ids.discard(old)
            _log("send succeeded")
            return {"ok": True}
        except Exception as e:
            _log(f"send failed: {type(e).__name__}")
            return {"ok": False, "message": str(e)}

    def list_groups(self) -> dict[str, Any]:
        """List chats the UI can bind CCIE to.

        Primary source: chats CCIE has observed a message in (reliable — reuses
        the working message path). Secondary: neonize's get_joined_groups(),
        which is best-effort because it can raise protobuf wire-format errors in
        0.4.1; we swallow that and still return the observed chats.
        """
        with self._lock:
            client = self._client
            state = self._state
            observed = list(self._observed_chats.values())
        if client is None or state != "linked":
            return {"ok": False, "message": f"WhatsApp not linked (state={state})", "groups": []}

        by_jid: dict[str, dict[str, Any]] = {}
        # Best-effort native enumeration first (gives real group names).
        native_note = ""
        try:
            native = client.get_joined_groups() or []
            _log(f"get_joined_groups native returned {len(list(native))} groups")
            for g in native:
                jid = _jid_to_string(getattr(g, "JID", None))
                if jid:
                    by_jid[jid] = {
                        "jid": jid,
                        "name": _group_name_str(getattr(g, "GroupName", "")) or jid,
                        "is_group": True,
                    }
        except Exception as e:
            native_note = f"group list unavailable ({e}); showing chats CCIE has seen"
            _log(f"get_joined_groups failed: {e}")

        _log(f"list_groups: native={len(by_jid)} observed={len(observed)}")

        # Observed chats fill in / override (this is what makes the picker work
        # when the native call fails — send a message in the group, then refresh).
        for c in observed:
            by_jid.setdefault(c["jid"], c)

        # Resolve real group names. A MessageEv carries no subject, so groups
        # come through as "Group". get_group_info() uses a DIFFERENT return type
        # than the broken get_joined_groups(), so it usually parses fine. BUT it
        # is a synchronous native network call that can HANG — so we run each in
        # a worker thread with a short per-call timeout, and only for groups
        # whose name is still unresolved. Resolved names are cached back into the
        # persisted observed-chats so this cost is paid at most once per group.
        unresolved = [
            jid for jid, c in by_jid.items()
            if c.get("is_group") and c.get("name") in ("Group", jid, "")
        ]
        for jid in unresolved[:20]:  # bound the work per call
            real = self._resolve_group_name(client, jid, timeout=4.0)
            if real:
                by_jid[jid]["name"] = real
                with self._lock:
                    if jid in self._observed_chats:
                        self._observed_chats[jid]["name"] = real
                        self._save_observed_locked()

        groups = sorted(
            by_jid.values(),
            key=lambda c: (not c.get("is_group"), str(c.get("name", "")).lower()),
        )
        result: dict[str, Any] = {"ok": True, "groups": groups}
        if native_note:
            result["message"] = native_note
        return result

    def _resolve_group_name(self, client: Any, jid: str, timeout: float) -> str:  # noqa: ANN401
        """Best-effort GroupName via get_group_info, in a thread with a timeout
        so a hung native call can never block the RPC response."""
        result: dict[str, str] = {}

        def worker() -> None:
            try:
                gi = client.get_group_info(_parse_jid(jid))
                result["name"] = _group_name_str(getattr(gi, "GroupName", ""))
            except Exception as e:  # noqa: BLE001
                _log(f"get_group_info({jid}) failed: {e}")

        t = threading.Thread(target=worker, daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive():
            _log(f"get_group_info({jid}) timed out after {timeout}s")
            return ""
        name = result.get("name", "")
        if name:
            _log(f"resolved group name: {jid} -> {name!r}")
        return name


_BRIDGE: Optional[_WhatsAppBridge] = None
_BRIDGE_LOCK = threading.Lock()


def get_bridge() -> _WhatsAppBridge:
    global _BRIDGE
    with _BRIDGE_LOCK:
        if _BRIDGE is None:
            _BRIDGE = _WhatsAppBridge()
        return _BRIDGE


def _group_name_str(name: Any) -> str:  # noqa: ANN401
    """Coerce a GroupName to a plain string. In neonize 0.3.x `GroupName` is a
    protobuf sub-message with a `.Name` field, not a bare str."""
    if isinstance(name, str):
        return name
    inner = getattr(name, "Name", None)
    if isinstance(inner, str):
        return inner
    return str(name) if name else ""


def _jid_to_string(jid: Any) -> str:  # noqa: ANN401
    """Serialize a neonize JID to its canonical `user@server` string.

    Uses neonize's Jid2String when available; falls back to building it from the
    User/Server fields. Returns "" for a missing/empty JID.
    """
    if jid is None:
        return ""
    try:
        from neonize.utils import Jid2String

        s = Jid2String(jid)
        if s:
            return s
    except Exception:
        pass
    user = getattr(jid, "User", "") or ""
    server = getattr(jid, "Server", "") or "s.whatsapp.net"
    return f"{user}@{server}" if user else ""


def _parse_jid(to: str):  # noqa: ANN401 (returns a neonize JID)
    """Build a neonize JID from either a full `user@server` string (group or
    user) or a bare phone number."""
    from neonize.utils import build_jid

    to = (to or "").strip()
    if "@" in to:
        user, _, server = to.partition("@")
        return build_jid(user, server=server or "s.whatsapp.net")
    return build_jid(normalize_number(to))


def _qr_to_png_data_url(qr_data: bytes) -> str:
    """Render QR payload bytes to a base64 PNG data URL for the Settings UI."""
    try:
        import segno

        payload = qr_data.decode("utf-8", "ignore") if isinstance(qr_data, bytes) else str(qr_data)
        buf = BytesIO()
        segno.make_qr(payload).save(buf, kind="png", scale=6, border=2)
        b64 = base64.b64encode(buf.getvalue()).decode()
        return f"data:image/png;base64,{b64}"
    except Exception:
        # Fall back to the raw payload; the UI can render it with a JS QR lib.
        raw = qr_data.decode("utf-8", "ignore") if isinstance(qr_data, bytes) else str(qr_data)
        return f"raw:{raw}"


# -- helpers used by the sidecar run_loop dispatch -------------------------

def maybe_autostart() -> None:
    """If WhatsApp is enabled and a session already exists on disk, start the
    client at boot so linked devices reconnect without a manual Link click."""
    import os

    cfg = get_whatsapp_config()
    if not cfg["enabled"]:
        return
    session_dir = cfg["session_dir"]
    db_path = os.path.join(session_dir, "neonize.db")
    if os.path.exists(db_path):
        get_bridge().link(session_dir, cfg["allowlist"], cfg.get("bound_chat", ""))
