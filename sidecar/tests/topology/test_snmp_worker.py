"""Synthetic ASN.1 only; transport is patched before any SNMP calls."""
import asyncio
import io
import json
from unittest.mock import AsyncMock, Mock

import pytest
from pysnmp.proto import errind, rfc1902, rfc1905

from ccie_sidecar.topology import snmp_worker as worker
from ccie_sidecar.topology.snmp_mib import SnmpMib


REQUEST = {"host": "switch.example.test", "credential": {
    "schema": 1, "version": "3", "username": "operator",
    "auth_key": "auth-secret-123", "priv_key": "priv-secret-123",
}}


def oid(value):
    return tuple(int(n) for n in value.split("."))


def binding(root, suffix, value):
    return rfc1902.ObjectName(root + suffix), value


def fixture_cells():
    text = rfc1902.OctetString
    integer = rfc1902.Integer32
    return {
        "ifName": [((101,), text("Gi1/0/1")), ((7,), text("Gi1/0/7"))],
        "ifDescr": [((101,), text("GigabitEthernet1/0/1")), ((7,), text("GigabitEthernet1/0/7"))],
        "ifAlias": [((101,), text("uplink"))],
        "cdpCacheTable": [((3, 101, 1), integer(1)),
            ((4, 101, 1), text(bytes([192, 0, 2, 10]))),
            ((6, 101, 1), text("dist-1.example.test")), ((7, 101, 1), text("Gi0/2"))],
        "lldpLocPortTable": [((2, 7), integer(5)), ((3, 7), text("Gi1/0/1")),
            ((4, 7), text("GigabitEthernet1/0/1"))],
        "lldpRemTable": [((6, 42, 7, 1), integer(5)), ((7, 42, 7, 1), text("Gi0/2")),
            ((8, 42, 7, 1), text("GigabitEthernet0/2")), ((9, 42, 7, 1), text("dist-1.example.test"))],
        "lldpRemManAddrTable": [((3, 42, 7, 1, 1, 4, 192, 0, 2, 10), integer(2))],
    }


@pytest.fixture
def transport(monkeypatch):
    cells = fixture_cells()
    engine = Mock()
    monkeypatch.setattr(worker, "SnmpEngine", Mock(return_value=engine))
    create = AsyncMock(return_value=Mock())
    monkeypatch.setattr(worker.UdpTransportTarget, "create", create)
    monkeypatch.setattr(worker.Udp6TransportTarget, "create", create)

    async def bulk(engine, auth, target, context, non_repeaters, repetitions, varbind, **options):
        cursor = tuple(varbind[0])
        assert options == {"lookupMib": False}
        assert non_repeaters == 0 and 1 <= repetitions <= 25
        for name, root in SnmpMib.ROOTS.items():
            if cursor[:len(root)] != root:
                continue
            values = sorted([binding(root, suffix, value) for suffix, value in cells[name]], key=lambda b: tuple(b[0]))
            values = [b for b in values if tuple(b[0]) > cursor]
            return None, 0, 0, values[:repetitions] or [(rfc1902.ObjectName(cursor), rfc1905.endOfMibView)]
        raise AssertionError("unexpected subtree")

    command = AsyncMock(side_effect=bulk)
    monkeypatch.setattr(worker, "bulk_cmd", command)
    return cells, engine, create, command


def collect():
    return asyncio.run(worker.SnmpWorker(REQUEST).run())


def test_actual_numeric_asn1_joins_and_safe_provenance(transport):
    result = collect()
    assert [c["status"] for c in result["captures"]] == ["completed", "completed"]
    for capture in result["captures"]:
        record = capture["records"][0]
        assert record["local_port"] == "Gi1/0/1"  # LLDP localPortNum 7 is NOT ifIndex 7.
        assert record["neighbor_mgmt_ip"] == "192.0.2.10"
        assert record["neighbor_vendor"] is None
        observation = capture["observations"][0]
        assert "record" not in observation
        assert observation["management_addresses"] == ["192.0.2.10"]
        assert observation["management_indexes"]
    assert result["captures"][1]["observations"][0]["index"] == [42, 7, 1]
    transport[1].close_dispatcher.assert_called_once()
    assert transport[2].call_args.kwargs == {"timeout": 2, "retries": 1}


@pytest.mark.parametrize("version", ["3", "2c"])
def test_auth_exact_profiles_and_explicit_v2c(version, transport):
    request = json.loads(json.dumps(REQUEST))
    if version == "2c":
        request["credential"] = {"schema": 1, "version": "2c", "community": "explicit-community", "port": 1161}
    asyncio.run(worker.SnmpWorker(request).run())
    auth = transport[3].call_args.args[1]
    if version == "3":
        assert auth.security_level == "authPriv"
        assert auth.authentication_protocol == worker.USM_AUTH_HMAC192_SHA256
        assert auth.privacy_protocol == worker.USM_PRIV_CFB128_AES
    else:
        assert auth.message_processing_model == 1
    assert transport[2].call_args.args[0][1] == (161 if version == "3" else 1161)


@pytest.mark.parametrize("error,status", [(errind.requestTimedOut, "timeout"), (None, "denied")])
def test_protocol_failure_is_independent_and_errors_are_fixed(transport, error, status):
    original = transport[3].side_effect

    async def bulk(*args, **kwargs):
        if tuple(args[6][0])[:len(SnmpMib.ROOTS["cdpCacheTable"])] == SnmpMib.ROOTS["cdpCacheTable"]:
            return error, 0 if error else 6, 1, []
        return await original(*args, **kwargs)

    transport[3].side_effect = bulk
    result = collect()["captures"]
    assert result[0]["status"] == "failed" and status in result[0]["error"].lower()
    assert result[1]["status"] == "completed"
    transport[1].close_dispatcher.assert_called_once()


@pytest.mark.parametrize("terminal,completed", [(rfc1905.endOfMibView, True),
    (rfc1905.noSuchObject, False), (rfc1905.noSuchInstance, False), (None, False)])
def test_empty_completion_is_not_no_such_or_empty_packet(transport, terminal, completed):
    async def bulk(*args, **kwargs):
        return None, 0, 0, [] if terminal is None else [(rfc1902.ObjectName(tuple(args[6][0])), terminal)]
    transport[3].side_effect = bulk
    captures = collect()["captures"]
    assert [c["status"] for c in captures] == (["completed"] * 2 if completed else ["failed"] * 2)
    assert all(c["records"] == [] for c in captures)
    if isinstance(terminal, (rfc1905.NoSuchObject, rfc1905.NoSuchInstance)):
        assert all(c["error"] == "SNMP object unavailable" for c in captures)


def test_outside_subtree_is_completed_empty(transport):
    transport[3].side_effect = None
    transport[3].return_value = (None, 0, 0, [(rfc1902.ObjectName((2, 1)), rfc1902.Integer32(1))])
    assert all(c["status"] == "completed" for c in collect()["captures"])


@pytest.mark.parametrize("failure", ["opaque", "duplicate-ifname", "missing-interface"])
def test_unresolved_never_marks_old_neighbors_absent(transport, failure):
    cells = transport[0]
    if failure == "opaque":
        cells["lldpRemTable"][0] = ((6, 42, 7, 1), rfc1902.Integer32(7))
    elif failure == "duplicate-ifname":
        cells["ifName"][1] = ((7,), rfc1902.OctetString("Gi1/0/1"))
    else:
        cells["ifName"] = []
    capture = collect()["captures"][1]
    assert capture["status"] == "failed" and capture["records"] == []
    assert capture["observations"][0]["reason"]
    assert capture["observations"][0]["remote_port_id"] == "Gi0/2"


def test_advertised_management_ambiguity_retains_full_indexes(transport):
    transport[0]["lldpRemManAddrTable"].append(
        ((3, 42, 7, 1, 1, 4, 192, 0, 2, 11), rfc1902.Integer32(2)))
    capture = collect()["captures"][1]
    assert capture["records"][0]["neighbor_mgmt_ip"] is None
    assert capture["observations"][0]["management_addresses"] == ["192.0.2.10", "192.0.2.11"]
    assert capture["observations"][0]["management_indexes"] == [
        [42, 7, 1, 1, 4, 192, 0, 2, 10], [42, 7, 1, 1, 4, 192, 0, 2, 11]]


@pytest.mark.parametrize("change", ["missing-host", "url-host", "subnet-host", "unknown-key", "schema-bool",
    "version", "empty-user", "short-key", "large-key", "nul-key", "port-bool", "port-range", "context-large"])
def test_credentials_fail_before_engine_creation(change, transport):
    request = json.loads(json.dumps(REQUEST))
    credential = request["credential"]
    if change == "missing-host": request.pop("host")
    elif change == "url-host": request["host"] = "https://switch.test"
    elif change == "subnet-host": request["host"] = "192.0.2.0/24"
    elif change == "unknown-key": credential["auth_protocol"] = "MD5"
    elif change == "schema-bool": credential["schema"] = True
    elif change == "version": credential["version"] = "1"
    elif change == "empty-user": credential["username"] = ""
    elif change == "short-key": credential["auth_key"] = "short"
    elif change == "large-key": credential["priv_key"] = "x" * 1025
    elif change == "nul-key": credential["auth_key"] = "bad\x00secret"
    elif change == "port-bool": credential["port"] = True
    elif change == "port-range": credential["port"] = 65536
    elif change == "context-large": credential["context"] = "x" * 33
    with pytest.raises(ValueError, match="Invalid SNMP request") as caught:
        worker.SnmpWorker(request)
    assert "secret" not in str(caught.value)
    worker.SnmpEngine.assert_not_called()


def test_timeout_and_exception_close_dispatcher_without_secrets(transport, monkeypatch):
    transport[3].side_effect = RuntimeError("auth-secret-123 priv-secret-123")
    result = collect()
    assert all(c["status"] == "failed" for c in result["captures"])
    assert "secret" not in json.dumps(result)
    transport[1].close_dispatcher.assert_called_once()


def test_whole_worker_deadline_closes_engine(transport, monkeypatch):
    monkeypatch.setattr(worker, "WORKER_SECONDS", 0.015)
    async def hung(*args, **kwargs):
        await asyncio.sleep(1)
    transport[3].side_effect = hung
    assert all(c["status"] == "failed" for c in collect()["captures"])
    transport[1].close_dispatcher.assert_called_once()


def test_standalone_json_io_limit_and_no_secret_echo(monkeypatch, transport):
    stdout = io.StringIO()
    assert worker.main(io.BytesIO(json.dumps(REQUEST).encode()), stdout) == 0
    parsed = json.loads(stdout.getvalue())
    assert set(parsed) == {"captures"} and len(parsed["captures"]) == 2
    assert stdout.getvalue().count("\n") == 1 and "secret" not in stdout.getvalue()
    for payload in (b"{" + b"x" * 16384, b"{\"credential\":\"auth-secret-123\"}", b"{} {}", b"\xff"):
        stdout = io.StringIO()
        assert worker.main(io.BytesIO(payload), stdout) == 1
        assert all(c["status"] == "failed" for c in json.loads(stdout.getvalue())["captures"])
        assert "secret" not in stdout.getvalue()


def test_agent_cannot_echo_supplied_secrets(transport):
    transport[0]["cdpCacheTable"][2] = ((6, 101, 1), rfc1902.OctetString("auth-secret-123"))
    result = collect()
    assert "auth-secret-123" not in json.dumps(result)
    assert result["captures"][0]["status"] == "failed"
    assert result["captures"][1]["status"] == "completed"


@pytest.mark.parametrize("limit,value,error", [("MAX_ROWS", 1, "row limit"), ("MAX_CELLS", 1, "cell limit"),
    ("MAX_BYTES", 1, "byte limit"), ("MAX_CALLS", 1, "call limit")])
def test_independent_table_budgets_are_not_bulk_batch_counts(transport, monkeypatch, limit, value, error):
    monkeypatch.setattr(worker, limit, value)
    captures = collect()["captures"]
    assert all(c["status"] == "failed" and c["records"] == [] for c in captures)
    assert error in captures[0]["error"]
    transport[1].close_dispatcher.assert_called_once()


@pytest.mark.parametrize("malformed", ["repeated", "short-index", "long-index", "string-oid", "negative-index", "batch-oversize"])
def test_malformed_transport_fails_closed(transport, malformed):
    original = transport[3].side_effect
    root = SnmpMib.ROOTS["cdpCacheTable"]

    async def bulk(*args, **kwargs):
        cursor = tuple(args[6][0])
        if cursor[:len(root)] != root:
            return await original(*args, **kwargs)
        if malformed == "repeated":
            bindings = [(rfc1902.ObjectName(cursor), rfc1902.OctetString("x"))]
        elif malformed == "short-index":
            bindings = [binding(root, (6, 101), rfc1902.OctetString("x"))]
        elif malformed == "long-index":
            bindings = [binding(root, (6, 101, 1, 1), rfc1902.OctetString("x"))]
        elif malformed == "string-oid":
            bindings = [("1.3.6.1", rfc1902.OctetString("x"))]
        elif malformed == "negative-index":
            bindings = [binding(root, (6, -1, 1), rfc1902.OctetString("x"))]
        else:
            bindings = [binding(root, (6, 101, n), rfc1902.OctetString("x")) for n in range(1, 27)]
        return None, 0, 0, bindings

    transport[3].side_effect = bulk
    captures = collect()["captures"]
    assert captures[0]["status"] == "failed" and captures[0]["records"] == []
    assert captures[1]["status"] == "completed"
    transport[1].close_dispatcher.assert_called_once()


def test_bulk_packet_may_cross_subtree_more_than_once(transport):
    original = transport[3].side_effect
    async def bulk(*args, **kwargs):
        result = await original(*args, **kwargs)
        if isinstance(result[3][0][1], rfc1905.EndOfMibView):
            return None, 0, 0, [(rfc1902.ObjectName((2, 1, n)), rfc1902.Integer32(1)) for n in range(1, 4)]
        return result
    transport[3].side_effect = bulk
    assert all(c["status"] == "completed" for c in collect()["captures"])


def test_partial_remote_table_keeps_observations_but_never_records(transport):
    original = transport[3].side_effect
    root = SnmpMib.ROOTS["lldpRemTable"]
    async def bulk(*args, **kwargs):
        cursor = tuple(args[6][0])
        if cursor[:len(root)] == root and cursor != root:
            return errind.requestTimedOut, 0, 0, []
        return await original(*args, **kwargs)
    transport[3].side_effect = bulk
    captures = collect()["captures"]
    assert captures[0]["status"] == "completed"
    assert captures[1]["status"] == "failed" and captures[1]["records"] == []
    assert captures[1]["observations"][0]["neighbor_name"] == "dist-1.example.test"


def test_completed_protocol_survives_other_protocol_deadline(transport, monkeypatch):
    monkeypatch.setattr(worker, "WORKER_SECONDS", 0.02)
    original = transport[3].side_effect
    root = SnmpMib.ROOTS["lldpRemTable"]
    async def bulk(*args, **kwargs):
        if tuple(args[6][0])[:len(root)] == root:
            await asyncio.sleep(1)
        return await original(*args, **kwargs)
    transport[3].side_effect = bulk
    captures = collect()["captures"]
    assert captures[0]["status"] == "completed"
    assert captures[1]["status"] == "failed"
    transport[1].close_dispatcher.assert_called_once()


def test_engine_closed_when_transport_creation_fails(transport):
    transport[2].side_effect = RuntimeError("priv-secret-123")
    response = collect()
    assert "secret" not in json.dumps(response)
    assert all(c["status"] == "failed" for c in response["captures"])
    transport[1].close_dispatcher.assert_called_once()


def test_ipv6_host_and_context_transport(transport):
    request = json.loads(json.dumps(REQUEST))
    request["host"] = "2001:db8::1"
    request["credential"]["context"] = "blue"
    assert all(c["status"] == "completed" for c in asyncio.run(worker.SnmpWorker(request).run())["captures"])
    assert transport[2].call_args.args == (("2001:db8::1", 161),)
    assert transport[3].call_args.args[3].contextName == "blue"


def test_output_cap_preserves_observation_prefix_and_fails_explicitly(transport):
    response = collect()
    for capture in response["captures"]:
        observation = capture["observations"][0]
        observation["neighbor_name"] = "x" * 1024
        capture["observations"] = [observation] * 2000
    serialized = worker._serialize(response)
    assert len(serialized.encode()) + 1 <= worker.MAX_OUTPUT
    captures = json.loads(serialized)["captures"]
    assert all(c["status"] == "failed" and c["records"] == [] and "output limit" in c["error"] for c in captures)
    assert captures[0]["observations"]


def test_stdin_deadline_does_not_wait_for_blocked_reader(monkeypatch):
    import time
    import threading
    release = threading.Event()
    class BlockedInput:
        def read(self, size):
            release.wait(1)
            return b"{}"
    monkeypatch.setattr(worker, "STDIN_SECONDS", 0.01)
    stdout = io.StringIO()
    started = time.monotonic()
    try:
        assert worker.main(BlockedInput(), stdout) == 1
        assert time.monotonic() - started < 0.5
        assert len(json.loads(stdout.getvalue())["captures"]) == 2
    finally:
        release.set()


def test_real_cli_rejects_invalid_stdin_without_rpc_startup(tmp_path):
    import os
    from pathlib import Path
    import subprocess
    import sys
    root = Path(__file__).resolve().parents[2] / "src"
    # Trusted source bootstrap, isolated interpreter; no inherited integration config.
    code = "import sys,runpy; sys.path.insert(0,sys.argv[1]);runpy.run_module('ccie_sidecar.topology.snmp_worker',run_name='__main__')"
    environment = {"HOME": str(tmp_path)}
    if "SYSTEMROOT" in os.environ:
        environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    result = subprocess.run([sys.executable, "-I", "-c", code, str(root)], input=b"{\"auth_key\":\"auth-secret-123\"}",
        capture_output=True, env=environment, cwd=tmp_path, timeout=5)
    assert result.returncode == 1 and result.stderr == b""
    assert "secret" not in result.stdout.decode()
    assert len(json.loads(result.stdout)["captures"]) == 2


def test_actual_2001_rows_fail_at_unique_rows_not_bulk_batches(transport):
    transport[0]["ifName"] = [((n,), rfc1902.OctetString(f"Gi{n}")) for n in range(1, 2002)]
    collector = worker.SnmpWorker(REQUEST)
    response = asyncio.run(collector.run())
    assert len(collector.tables["ifName"].rows) == 2000
    assert all(c["status"] == "failed" and c["records"] == [] for c in response["captures"])
    assert all(c["error"] == "SNMP table row limit" for c in response["captures"])


def test_joined_interface_union_limit_cannot_become_empty_completed(transport):
    for name in transport[0]:
        transport[0][name] = []
    transport[0]["ifName"] = [((n,), rfc1902.OctetString(f"Gi{n}")) for n in range(1, 2001)]
    transport[0]["ifDescr"] = [((2001,), rfc1902.OctetString("outside-name-table"))]
    captures = collect()["captures"]
    assert all(c["status"] == "failed" and c["records"] == [] for c in captures)


def test_binary_remote_id_is_retained_unresolved(transport):
    transport[0]["lldpRemTable"][1] = ((7, 42, 7, 1), rfc1902.OctetString(b"\x00\xff\x01"))
    capture = collect()["captures"][1]
    assert capture["status"] == "failed" and capture["records"] == []
    assert capture["observations"][0]["remote_port_id"] == "hex:00ff01"
    assert capture["observations"][0]["reason"] == "remote_port_not_ifName"


def test_raw_numeric_request_runs_through_installed_bulk_cmd_without_transport(transport, monkeypatch):
    from pysnmp.hlapi.v3arch.asyncio import cmdgen
    transport[1].cache = {}
    monkeypatch.setattr(cmdgen.LCD, "configure", Mock(return_value=("offline", "offline")))
    def send(self, engine, address_name, context_engine, context_name, non_repeaters,
             repetitions, varbinds, callback, callback_context):
        cursor = varbinds[0][0].get_oid()
        callback(engine, 1, None, 0, 0,
            [(rfc1902.ObjectName(cursor), rfc1905.endOfMibView)], callback_context)
    monkeypatch.setattr(cmdgen.cmdgen.BulkCommandGenerator, "send_varbinds", send)
    monkeypatch.setattr(worker, "bulk_cmd", cmdgen.bulk_cmd)
    captures = collect()["captures"]
    assert all(c["status"] == "completed" and c["records"] == [] for c in captures)
    transport[1].close_dispatcher.assert_called_once()
