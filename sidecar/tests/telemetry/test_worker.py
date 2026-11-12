"""Offline tests; worker imports always come from this checkout."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

SOURCE = Path(__file__).resolve().parents[2] / "src"
sys.path.insert(0, str(SOURCE))
TEMPLATE = "Value NAME (\\S+)\nValue COUNT (\\d+)\n\nStart\n  ^${NAME} ${COUNT}$$ -> Record\n"


def request(raw="Gi1 12\n", template=TEMPLATE):
    return {"id": "r1", "operation": "parse", "capture": {
        "capture_id": "capture", "target_id": "target", "platform": "iosxe",
        "command": "show interfaces", "parser_id": "interfaces", "revision": "revision",
        "observed_at_ms": 1, "monotonic_ms": 1, "raw": raw}, "template": {
        "id": "interfaces", "platform": "iosxe", "command": "show interfaces",
        "text": template, "sha256": hashlib.sha256(template.encode()).hexdigest()}}


def handle(value):
    from ccie_sidecar.telemetry.worker import TelemetryParserWorker
    return TelemetryParserWorker().handle(value)


def test_worker_parses_textfsm_without_server_startup(tmp_path):
    script = '''import sys,json,importlib.abc
class Guard(importlib.abc.MetaPathFinder):
 def find_spec(self,fullname,path=None,target=None):
  if fullname.startswith(('ccie_sidecar.server','langchain','openai','anthropic','ollama')): raise AssertionError(fullname)
sys.meta_path.insert(0,Guard())
def audit(event,args):
 if event.startswith(('socket.','subprocess.')) or event in ('os.system','os.fork'): raise AssertionError(event)
sys.addaudithook(audit)
sys.path.insert(0,sys.argv[1])
from ccie_sidecar.telemetry.worker import TelemetryParserWorker
print(json.dumps(TelemetryParserWorker().handle(json.loads(sys.stdin.read()))))
assert 'ccie_sidecar.server' not in sys.modules
'''
    result = subprocess.run([sys.executable, "-I", "-c", script, str(SOURCE)],
        input=json.dumps(request()), text=True, capture_output=True, timeout=5,
        cwd=tmp_path, env={"HOME": str(tmp_path), "PATH": os.defpath,
            "PYTHONPATH": str(tmp_path), "OPENAI_API_KEY": "must-not-be-used"})
    assert result.returncode == 0, result.stderr
    reply = json.loads(result.stdout)
    assert reply == {"id": "r1", "headers": ["name", "count"], "records": [["Gi1", "12"]]}
    assert "ccie_sidecar.server" not in sys.modules


def test_zero_records_are_not_automatically_unsupported():
    reply = handle(request(raw="no matching data\n"))
    assert reply["records"] == []
    bad = request(raw="no matching data\n")
    bad["capture"]["command"] = "show version"
    assert handle(bad)["diagnostic"]["code"] == "parser_binding"


@pytest.mark.parametrize("field,value", [("id", "other"), ("platform", "ios"),
    ("sha256", "0" * 64), ("command", "show version")])
def test_template_binding_is_checked(field, value):
    req = request()
    req["template"][field] = value
    assert handle(req)["diagnostic"]["code"] == "parser_binding"


def test_bad_template_and_oversize_input():
    assert handle(request(template="invalid"))["diagnostic"]["code"] == "parser_template"
    assert handle(request(raw="x" * (2 * 1024 * 1024 + 1)))["diagnostic"]["code"] == "parser_limit"
    assert handle(request(template="x" * (64 * 1024 + 1)))["diagnostic"]["code"] == "parser_limit"


def test_row_and_amplification_limits_are_checked_during_collection():
    assert handle(request(raw="Gi1 12\n" * 10001))["diagnostic"]["code"] == "parser_limit"
    fill = "Value Filldown NAME (.+)\nValue COUNT (\\d+)\n\nStart\n  ^N ${NAME}$$\n  ^C ${COUNT}$$ -> Record\n\nEOF\n"
    assert handle(request(raw="N " + "x" * 40000 + "\n" + "C 1\n" * 100, template=fill))["diagnostic"]["code"] == "parser_limit"


def test_list_values_are_bounded_and_preserved():
    template = "Value List NAME (\\S+)\n\nStart\n  ^${NAME}$$\n"
    assert handle(request(raw="one\ntwo\n", template=template))["records"] == [[["one", "two"]]]
    assert handle(request(raw=("x" * 100 + "\n") * 20500, template=template))["diagnostic"]["code"] == "parser_limit"


def test_framing_rejects_bad_json_and_oversize_line(tmp_path):
    script = "import sys,runpy;sys.path.insert(0,sys.argv[1]);runpy.run_module('ccie_sidecar.telemetry.worker',run_name='__main__')"
    result = subprocess.run([sys.executable, "-I", "-c", script, str(SOURCE)],
        input=b"{\n" + b"x" * (16 * 1024 * 1024 + 1) + b"\n", capture_output=True,
        timeout=5, cwd=tmp_path, env={"HOME": str(tmp_path), "PATH": os.defpath})
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    assert [r["diagnostic"]["code"] for r in replies] == ["parser_protocol", "parser_limit"]


def test_capture_group_amplification_is_bounded_before_record_materialization(monkeypatch):
    from ccie_sidecar.telemetry.worker import BoundedRecords
    def too_late(self, record):
        raise AssertionError("Ample capture groups reached record materialization")
    monkeypatch.setattr(BoundedRecords, "append", too_late)
    names = [f"V{i}" for i in range(100)]
    template = "\n".join(f"Value {name} (.+)" for name in names)
    template += "\n\nStart\n  ^" + "".join(f"(?=${{{name}}})" for name in names) + ".*$$ -> Record\n"
    assert handle(request(raw="x" * 30000, template=template))["diagnostic"]["code"] == "parser_limit"


def test_installed_ntc_template_keeps_headers_and_table_semantics():
    import ntc_templates
    template = (Path(ntc_templates.__file__).parent / "templates" /
        "cisco_ios_show_ip_interface_brief.textfsm").read_text()
    # Synthetic offline sample exercises the shipped NTC asset, not a device.
    req = request(raw="GigabitEthernet1 192.0.2.1 YES manual up up\n", template=template)
    req["capture"]["command"] = req["template"]["command"] = "show ip interface brief"
    reply = handle(req)
    assert reply["headers"] == ["interface", "ip_address", "status", "proto"]
    assert reply["records"] == [["GigabitEthernet1", "192.0.2.1", "up", "up"]]


def test_request_cannot_supply_operations_or_import_hooks():
    req = request()
    req["operation"] = "exec"
    assert handle(req)["diagnostic"]["code"] == "parser_protocol"
    req["operation"] = "parse"
    req["module"] = "ccie_sidecar.server"
    assert handle(req)["diagnostic"]["code"] == "parser_protocol"
