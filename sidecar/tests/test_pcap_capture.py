"""Unit tests for the pyATS-driven packet-capture lifecycle (no device)."""
from ccie_sidecar.pcap_capture import run_capture


class FakeConn:
    """Records executed commands; returns canned output by substring."""
    def __init__(self):
        self.cmds = []

    def execute(self, cmd, timeout=60, error_pattern=None):
        self.cmds.append(cmd)
        if cmd.endswith("start"):
            return "Started capture point : CAP"
        if "export location" in cmd:
            return "Export Started Successfully"
        if "include Status" in cmd:
            return "Status Information for Capture CAP\n   Status : Inactive"
        return ""

    def disconnect(self):
        pass


def test_run_capture_happy_path_runs_full_lifecycle(monkeypatch):
    fake = FakeConn()
    # No real sleep during tests.
    monkeypatch.setattr("ccie_sidecar.pcap_capture.time.sleep", lambda *_: None)
    r = run_capture(
        host="h", username="u", password="p",
        interface="GigabitEthernet1/0/48", duration_s=10,
        connect_fn=lambda *a, **k: fake,
    )
    assert r["ok"] is True
    assert r["export_path"] == "flash:CAP.pcap"
    assert r["export_basename"] == "CAP.pcap"
    # setup + start + stop + export + cleanup were all issued
    joined = " | ".join(fake.cmds)
    assert "interface GigabitEthernet1/0/48 both" in joined
    assert "match any" in joined          # default match is `any`, not ipv4
    assert "monitor capture CAP start" in joined
    assert "export location flash:CAP.pcap" in joined
    assert "no monitor capture CAP" in joined


def test_run_capture_uses_acl_when_provided(monkeypatch):
    fake = FakeConn()
    monkeypatch.setattr("ccie_sidecar.pcap_capture.time.sleep", lambda *_: None)
    run_capture(host="h", username="u", password="p", interface="Gi1/0/1",
                duration_s=5, acl="MGMT_ACL", connect_fn=lambda *a, **k: fake)
    assert any("match access-list MGMT_ACL" in c for c in fake.cmds)


def test_run_capture_reports_start_failure(monkeypatch):
    class FailStart(FakeConn):
        def execute(self, cmd, timeout=60, error_pattern=None):
            if cmd.endswith("start"):
                return "Unable to activate Capture."
            return super().execute(cmd, timeout, error_pattern)
    monkeypatch.setattr("ccie_sidecar.pcap_capture.time.sleep", lambda *_: None)
    r = run_capture(host="h", username="u", password="p", interface="Gi1/0/1",
                    duration_s=5, connect_fn=lambda *a, **k: FailStart())
    assert r["ok"] is False
    assert "start failed" in r["error"]


def test_run_capture_never_raises_on_connect_error():
    def boom(*a, **k):
        raise RuntimeError("ssh exploded")
    r = run_capture(host="h", username="u", password="p", interface="Gi1/0/1",
                    duration_s=5, connect_fn=boom)
    assert r["ok"] is False
    assert "ssh exploded" in r["error"]
