from __future__ import annotations

import os
import sys
import types
from pathlib import Path


def test_bridge_reconnects_after_connect_returns(monkeypatch, tmp_path: Path):
    from ccie_sidecar.whatsapp_bridge import _WhatsAppBridge

    calls: list[str] = []
    bridge: _WhatsAppBridge | None = None

    class FakeClient:
        def __init__(self, _db_path: str) -> None:
            self.connected = None

        def qr(self, func):
            return func

        def event(self, _event_type):
            def register(func):
                if _event_type is events_module.ConnectedEv:
                    self.connected = func
                return func

            return register

        def connect(self) -> None:
            calls.append("connect")
            if len(calls) == 1 and self.connected is not None:
                self.connected(self, None)
            if len(calls) == 2:
                assert bridge is not None
                bridge._stop_event.set()

    monkeypatch.setitem(sys.modules, "neonize", types.ModuleType("neonize"))
    client_module = types.ModuleType("neonize.client")
    client_module.NewClient = FakeClient
    monkeypatch.setitem(sys.modules, "neonize.client", client_module)
    events_module = types.ModuleType("neonize.events")
    events_module.ConnectedEv = object()
    events_module.MessageEv = object()
    events_module.ReceiptEv = object()
    monkeypatch.setitem(sys.modules, "neonize.events", events_module)

    bridge = _WhatsAppBridge()
    bridge._reconnect_delay = lambda _attempt: 0
    bridge._run(str(tmp_path))

    assert calls == ["connect", "connect"]
    assert bridge.status()["state"] != "linked"


def test_send_logs_result_without_message_content(monkeypatch):
    import ccie_sidecar.whatsapp_bridge as module
    from ccie_sidecar.whatsapp_bridge import _WhatsAppBridge

    logs: list[str] = []

    class FakeResponse:
        ID = "message-id"

    class FakeClient:
        def send_message(self, _jid, _text):
            return FakeResponse()

    utils_module = types.ModuleType("neonize.utils")
    utils_module.build_jid = lambda user, server=None: (user, server)
    monkeypatch.setitem(sys.modules, "neonize.utils", utils_module)
    monkeypatch.setattr(module, "_log", logs.append)

    bridge = _WhatsAppBridge()
    bridge._client = FakeClient()
    bridge._state = "linked"

    assert bridge.send("recipient@s.whatsapp.net", "secret message")["ok"] is True
    assert logs == ["send succeeded"]
    assert "secret message" not in logs[0]


def test_send_suppresses_native_stdout(monkeypatch, capfd):
    import ccie_sidecar.whatsapp_bridge as module
    from ccie_sidecar.whatsapp_bridge import _WhatsAppBridge

    class FakeResponse:
        ID = "message-id"

    class FakeClient:
        def send_message(self, _jid, _text):
            os.write(1, b"native SendMessage error\n")
            return FakeResponse()

    utils_module = types.ModuleType("neonize.utils")
    utils_module.build_jid = lambda user, server=None: (user, server)
    monkeypatch.setitem(sys.modules, "neonize.utils", utils_module)

    bridge = _WhatsAppBridge()
    bridge._client = FakeClient()
    bridge._state = "linked"

    assert bridge.send("recipient@s.whatsapp.net", "test")["ok"] is True
    assert capfd.readouterr().out == ""
