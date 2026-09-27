import os

import os

import pytest


def _worker_api():
    try:
        from ccie_sidecar.stp_worker import (
            MAX_WORKERS,
            STPWorker,
            STPWorkerPool,
            platform_state,
        )
    except (ImportError, ModuleNotFoundError) as exc:
        pytest.fail(f"STP worker is not implemented: {exc}")
    return MAX_WORKERS, STPWorker, STPWorkerPool, platform_state


def _collect_pool_results(monkeypatch, results):
    class ResultQueue:
        def __init__(self):
            self.items = []

        def put(self, item):
            self.items.append(item)

        def get_nowait(self):
            if not self.items:
                raise __import__("queue").Empty
            return self.items.pop(0)

    class ResultProcess:
        def __init__(self, target, args):
            self.name = args[1]
            self.queue = args[2]
            self.alive = False

        def start(self):
            self.alive = True
            self.queue.put(results[self.name])

        def is_alive(self):
            return self.alive

        def join(self, timeout=None):
            self.alive = False

    _, _, pool_type, _ = _worker_api()
    monkeypatch.setattr("ccie_sidecar.stp_worker.Queue", ResultQueue)
    monkeypatch.setattr("ccie_sidecar.stp_worker.Process", ResultProcess)
    return pool_type().collect("/saved/testbed.yaml", results)


def _production_records(*, reverse=True, conflicting_bundle=False):
    d1_neighbors = [
        {
            "device_id": "D2",
            "local_interface": "GigabitEthernet1/0/1",
            "port_id": "Ethernet1/1",
            "instance": "10",
        },
        {
            "device_id": "D2",
            "local_interface": "GigabitEthernet1/0/2",
            "port_id": "Ethernet1/2",
            "instance": "10",
        },
    ]
    d2_neighbors = [
        {
            "name": "D1",
            "local_interface": "Ethernet1/1",
            "port_id": "GigabitEthernet1/0/1",
            "instance": "10",
        },
        {
            "name": "D1",
            "local_interface": "Ethernet1/2",
            "port_id": "GigabitEthernet1/0/2",
            "instance": "10",
        },
    ] if reverse else []
    d2_bundles = [
        {"id": "Port-channel10", "name": "Port-channel10", "members": ["Ethernet1/1"]},
        {
            "id": "Port-channel20" if conflicting_bundle else "Port-channel10",
            "name": "Port-channel20" if conflicting_bundle else "Port-channel10",
            "members": ["Ethernet1/2"],
        },
    ]
    return {
        "D1": {
            "device": "D1",
            "platform": "iosxe",
            "status": "complete",
            "stp": {
                "mode": "rapid_pvst",
                "instances": [{
                    "id": "10",
                    "vlan_id": "10",
                    "bridge_id": "0011.2233.4455",
                    "root_id": "00aa.bbcc.ddee",
                    "interfaces": [
                        {"interface": "GigabitEthernet1/0/1", "status": "designated forwarding", "cost": 4},
                        {"interface": "GigabitEthernet1/0/2", "role": "designated", "port_state": "forwarding", "cost": 4},
                    ],
                }],
                "ports": [],
            },
            "neighbors": {"cdp": d1_neighbors, "lldp": []},
            "bundle": [{
                "id": "Port-channel1",
                "name": "Port-channel1",
                "members": ["GigabitEthernet1/0/1", "GigabitEthernet1/0/2"],
            }],
            "gaps": [],
        },
        "D2": {
            "device": "D2",
            "platform": "nxos",
            "status": "complete",
            "stp": {
                "mode": "rapid_pvst",
                "instances": [{
                    "id": "10",
                    "vlan_id": "10",
                    "bridge_id": "0066.7788.9900",
                    "root_id": "00ff.eedd.ccbb",
                    "interfaces": [
                        {"interface": "Ethernet1/1", "role": "designated", "state": "forwarding", "cost": 4},
                        {"interface": "Ethernet1/2", "role": "designated", "state": "forwarding", "cost": 4},
                    ],
                }],
                "ports": [],
            },
            "neighbors": {"cdp": [], "lldp": d2_neighbors},
            "bundle": d2_bundles,
            "gaps": [],
        },
    }


def test_worker_pool_is_bounded_to_four_workers():
    max_workers, _, _, _ = _worker_api()

    assert max_workers == 4


def test_worker_passes_only_testbed_path_and_device_name_to_hydrated_client(monkeypatch):
    _, worker_type, _, _ = _worker_api()
    captured = {}

    class FakeClient:
        testbed = type("Testbed", (), {"devices": {"CORE1": object()}})()

    def fake_build(path):
        captured["path"] = path
        return FakeClient()

    class FakeCollector:
        def __init__(self, device_name, platform):
            captured["collector"] = (device_name, platform)

        def collect(self, device):
            return {"device": "CORE1", "platform": "iosxe", "stp": {}, "neighbors": {}, "bundle": []}

    monkeypatch.setattr("ccie_sidecar.stp_worker.build_pyats_client", fake_build)
    monkeypatch.setattr("ccie_sidecar.stp_worker.STPCollector", FakeCollector)

    result = worker_type(testbed_path="/saved/testbed.yaml", device_name="CORE1", platform="iosxe").run()

    assert captured == {
        "path": "/saved/testbed.yaml",
        "collector": ("CORE1", "iosxe"),
    }
    assert result["device"] == "CORE1"
    assert "password" not in repr(result).lower()


def test_worker_entry_keeps_worker_stdout_off_protocol_stream(monkeypatch, capfd):
    from ccie_sidecar.stp_worker import _worker_entry

    class FakeWorker:
        def __init__(self, **kwargs):
            pass

        def run(self):
            print("Unicon informational line")
            os.write(1, b"Unicon fd output\n")
            return {"device": "CORE1", "status": "complete"}

    class ResultQueue:
        def __init__(self):
            self.items = []

        def put(self, item):
            self.items.append(item)

    result_queue = ResultQueue()
    monkeypatch.setattr("ccie_sidecar.stp_worker.STPWorker", FakeWorker)

    _worker_entry("/saved/testbed.yaml", "CORE1", result_queue)

    assert result_queue.items == [{"device": "CORE1", "status": "complete"}]
    assert capfd.readouterr().out == ""


def test_worker_entry_keeps_exception_output_off_protocol_stream(monkeypatch, capfd):
    from ccie_sidecar.stp_worker import _worker_entry

    class FakeWorker:
        def __init__(self, **kwargs):
            pass

        def run(self):
            print("Unicon exception output")
            os.write(1, b"Unicon exception fd output\n")
            raise RuntimeError("worker failure")

        def _failure(self, code):
            return {"device": "CORE1", "status": "failed", "code": code}

    class ResultQueue:
        def __init__(self):
            self.items = []

        def put(self, item):
            self.items.append(item)

    result_queue = ResultQueue()
    monkeypatch.setattr("ccie_sidecar.stp_worker.STPWorker", FakeWorker)

    _worker_entry("/saved/testbed.yaml", "CORE1", result_queue)

    assert result_queue.items == [{"device": "CORE1", "status": "failed", "code": "worker_failed"}]
    assert capfd.readouterr().out == ""


def test_windows_has_explicit_unsupported_state(monkeypatch):
    _, _, pool_type, platform_state = _worker_api()
    monkeypatch.setattr("ccie_sidecar.stp_worker.platform.system", lambda: "Windows")

    assert platform_state() == {
        "supported": False,
        "platform": "Windows",
        "code": "unsupported_platform",
    }
    result = pool_type().collect("/saved/testbed.yaml", ["CORE1"])
    assert result["status"] == "unsupported"
    assert result["code"] == "unsupported_platform"


def test_collect_stp_returns_platform_code_before_testbed_resolution(monkeypatch):
    from ccie_sidecar.stp_worker import collect_stp

    monkeypatch.setattr(
        "ccie_sidecar.stp_worker.platform_state",
        lambda: {"supported": False, "platform": "Windows", "code": "unsupported_platform"},
    )

    def unexpected_testbed_resolution(_path):
        raise AssertionError("platform failures must not resolve a pyATS testbed")

    monkeypatch.setattr("ccie_sidecar.stp_worker.build_pyats_client", unexpected_testbed_resolution)

    assert collect_stp() == {
        "status": "unsupported",
        "platform": "Windows",
        "code": "unsupported_platform",
        "devices": [],
    }


def test_collect_stp_reports_a_stable_testbed_unavailable_code(monkeypatch):
    from ccie_sidecar.stp_worker import collect_stp

    monkeypatch.setattr(
        "ccie_sidecar.stp_worker.platform_state",
        lambda: {"supported": True, "platform": "Darwin"},
    )
    monkeypatch.setattr("ccie_sidecar.stp_worker.build_pyats_client", lambda _path: None)

    assert collect_stp() == {
        "status": "failed",
        "code": "testbed_unavailable",
        "devices": [],
    }


def test_worker_pool_labels_an_empty_supported_inventory_stably():
    _, _, pool_type, _ = _worker_api()

    result = pool_type().collect("/saved/testbed.yaml", [])

    assert result["status"] == "unsupported"
    assert result["code"] == "no_supported_devices"


def test_worker_pool_terminates_expired_workers(monkeypatch):
    _, _, pool_type, _ = _worker_api()
    terminated = []

    class HangingProcess:
        def __init__(self, *args, **kwargs):
            self.alive = False

        def start(self):
            self.alive = True

        def is_alive(self):
            return self.alive

        def terminate(self):
            terminated.append(True)

        def kill(self):
            self.alive = False

        def join(self, timeout=None):
            return None

    clock = iter([0.0, 0.0, 0.0, 61.0])
    monkeypatch.setattr("ccie_sidecar.stp_worker.Process", HangingProcess)
    monkeypatch.setattr("ccie_sidecar.stp_worker.monotonic", lambda: next(clock))

    result = pool_type(device_timeout_seconds=60, overall_timeout_seconds=900).collect(
        "/saved/testbed.yaml", ["CORE1"]
    )

    assert terminated
    assert result["devices"][0]["status"] == "timeout"


def test_worker_pool_launches_at_most_four_and_skips_pending_after_overall_deadline(monkeypatch):
    _, _, pool_type, _ = _worker_api()
    started = []

    class FakeQueue:
        def get_nowait(self):
            raise __import__("queue").Empty

    class HangingProcess:
        def __init__(self, *args, **kwargs):
            self.alive = False

        def start(self):
            started.append(True)
            self.alive = True

        def is_alive(self):
            return self.alive

        def terminate(self):
            return None

        def kill(self):
            self.alive = False

        def join(self, timeout=None):
            return None

    clock = iter([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0])
    monkeypatch.setattr("ccie_sidecar.stp_worker.Queue", FakeQueue)
    monkeypatch.setattr("ccie_sidecar.stp_worker.Process", HangingProcess)
    monkeypatch.setattr("ccie_sidecar.stp_worker.monotonic", lambda: next(clock))

    result = pool_type(overall_timeout_seconds=1).collect(
        "/saved/testbed.yaml", ["D1", "D2", "D3", "D4", "D5"]
    )

    assert len(started) == 4
    assert [item["status"] for item in result["devices"]] == ["timeout"] * 4 + ["skipped"]


def test_worker_pool_clamps_configurable_limits_to_production_contract():
    _, _, pool_type, _ = _worker_api()

    pool = pool_type(max_workers=99, device_timeout_seconds=120, overall_timeout_seconds=1800)

    assert pool.max_workers == 4
    assert pool.device_timeout_seconds == 60
    assert pool.overall_timeout_seconds == 900


def test_worker_pool_reports_failed_when_no_supported_device_has_parsable_stp(monkeypatch):
    _, _, pool_type, _ = _worker_api()
    results = {
        "D1": {"device": "D1", "status": "failed", "stp": {"instances": []}},
        "D2": {"device": "D2", "status": "failed", "stp": {"instances": []}},
    }

    class ResultQueue:
        def __init__(self):
            self.items = []

        def put(self, item):
            self.items.append(item)

        def get_nowait(self):
            if not self.items:
                raise __import__("queue").Empty
            return self.items.pop(0)

    class ResultProcess:
        def __init__(self, target, args):
            self.name = args[1]
            self.queue = args[2]
            self.alive = False

        def start(self):
            self.alive = True
            self.queue.put(results[self.name])

        def is_alive(self):
            return self.alive

        def join(self, timeout=None):
            self.alive = False

    monkeypatch.setattr("ccie_sidecar.stp_worker.Queue", ResultQueue)
    monkeypatch.setattr("ccie_sidecar.stp_worker.Process", ResultProcess)

    result = pool_type().collect("/saved/testbed.yaml", ["D1", "D2"])

    assert result["status"] == "failed"


def test_worker_pool_requires_meaningful_stp_evidence_not_an_identifier_only_record(monkeypatch):
    result = _collect_pool_results(
        monkeypatch,
        {
            "D1": {
                "device": "D1",
                "platform": "iosxe",
                "status": "complete",
                "stp": {"instances": [{"id": "1"}], "ports": []},
                "neighbors": {"cdp": [], "lldp": []},
                "bundle": [],
                "gaps": [],
            }
        },
    )

    assert result["status"] == "failed"


def test_worker_pool_uses_stp_parseability_not_auxiliary_gaps_for_complete(monkeypatch):
    result = _collect_pool_results(
        monkeypatch,
        {
            "D1": {
                "device": "D1",
                "platform": "iosxe",
                "status": "partial",
                "stp": {"mode": "rapid_pvst", "instances": [{"id": "1", "bridge_id": "0011.2233.4455"}], "ports": []},
                "neighbors": {"cdp": [], "lldp": []},
                "bundle": [],
                "gaps": [{"source": "cdp", "code": "parse_failed"}],
            },
            "D2": {
                "device": "D2",
                "platform": "nxos",
                "status": "complete",
                "stp": {"mode": "rapid_pvst", "instances": [{"id": "1", "bridge_id": "0066.7788.9900"}], "ports": []},
                "neighbors": {"cdp": [], "lldp": []},
                "bundle": [],
                "gaps": [],
            },
        },
    )

    assert result["status"] == "complete"
    assert result["devices"][0]["gaps"] == [{"source": "cdp", "code": "parse_failed"}]


def test_worker_pool_reports_partial_when_only_some_supported_devices_have_stp(monkeypatch):
    result = _collect_pool_results(
        monkeypatch,
        {
            "D1": {
                "device": "D1",
                "platform": "iosxe",
                "status": "complete",
                "stp": {"mode": "rapid_pvst", "instances": [{"id": "1", "bridge_id": "0011.2233.4455"}], "ports": []},
                "neighbors": {"cdp": [], "lldp": []},
                "bundle": [],
                "gaps": [],
            },
            "D2": {
                "device": "D2",
                "platform": "nxos",
                "status": "failed",
                "stp": {"instances": [], "ports": []},
                "neighbors": {"cdp": [], "lldp": []},
                "bundle": [],
                "gaps": [{"source": "spanning_tree", "code": "parse_failed"}],
            },
        },
    )

    assert result["status"] == "partial"


def test_worker_pool_runs_collector_records_through_normalization_and_findings(monkeypatch):
    result = _collect_pool_results(monkeypatch, _production_records())

    assert result["status"] == "complete"
    assert result["adjacencies"] == [{
        "local_device_id": "d1",
        "remote_device_id": "d2",
        "local_interface": "po1",
        "remote_interface": "po10",
        "confidence": "confirmed",
        "member_interfaces": [
            ["gi1/0/1", "eth1/1"],
            ["gi1/0/2", "eth1/2"],
        ],
    }]
    assert {finding["code"] for finding in result["findings"]} == {"ROOT_DISAGREEMENT"}
    assert all(
        neighbor["bidirectional"] is True
        for device in result["devices"]
        for family in ("cdp", "lldp")
        for neighbor in device["neighbors"][family]
    )
    port = result["devices"][0]["stp"]["instances"][0]["interfaces"][0]
    assert (port["role"], port["state"]) == ("designated", "forwarding")


def test_worker_pool_keeps_one_sided_adjacency_provisional(monkeypatch):
    result = _collect_pool_results(monkeypatch, _production_records(reverse=False))

    assert len(result["adjacencies"]) == 2
    assert all(adjacency["confidence"] == "provisional" for adjacency in result["adjacencies"])
    assert all(neighbor["bidirectional"] is False for neighbor in result["devices"][0]["neighbors"]["cdp"])


def test_worker_pool_keeps_physical_links_when_bundle_members_disagree(monkeypatch):
    result = _collect_pool_results(monkeypatch, _production_records(conflicting_bundle=True))

    assert len(result["adjacencies"]) == 2
    assert {adjacency["local_interface"] for adjacency in result["adjacencies"]} == {"gi1/0/1", "gi1/0/2"}


def test_worker_pool_keeps_unsupported_devices_separate_from_supported_aggregation(monkeypatch):
    _, _, pool_type, _ = _worker_api()
    results = {
        "D1": {
            "device": "D1",
            "platform": "iosxe",
            "status": "complete",
            "stp": {"mode": "rapid_pvst", "instances": [{"id": "1", "bridge_id": "0011.2233.4455"}]},
        },
        "D2": {"device": "D2", "platform": "junos", "status": "unsupported", "code": "unsupported_device_platform"},
    }

    class ResultQueue:
        def __init__(self):
            self.items = []

        def put(self, item):
            self.items.append(item)

        def get_nowait(self):
            if not self.items:
                raise __import__("queue").Empty
            return self.items.pop(0)

    class ResultProcess:
        def __init__(self, target, args):
            self.name = args[1]
            self.queue = args[2]
            self.alive = False

        def start(self):
            self.alive = True
            self.queue.put(results[self.name])

        def is_alive(self):
            return self.alive

        def join(self, timeout=None):
            self.alive = False

    monkeypatch.setattr("ccie_sidecar.stp_worker.Queue", ResultQueue)
    monkeypatch.setattr("ccie_sidecar.stp_worker.Process", ResultProcess)

    result = pool_type().collect("/saved/testbed.yaml", ["D1", "D2"])

    assert result["status"] == "complete"
    assert result["devices"][1]["status"] == "unsupported"
    assert result["unsupported"] == ["D2"]


def test_worker_pool_does_not_trust_partial_label_when_both_devices_have_stp(monkeypatch):
    _, _, pool_type, _ = _worker_api()
    results = {
        "D1": {
            "device": "D1",
            "platform": "iosxe",
            "status": "complete",
            "stp": {"mode": "rapid_pvst", "instances": [{"id": "1", "bridge_id": "0011.2233.4455"}]},
        },
        "D2": {
            "device": "D2",
            "platform": "nxos",
            "status": "partial",
            "stp": {"mode": "rapid_pvst", "instances": [{"id": "1", "bridge_id": "0066.7788.9900"}]},
        },
    }

    class ResultQueue:
        def __init__(self):
            self.items = []

        def put(self, item):
            self.items.append(item)

        def get_nowait(self):
            if not self.items:
                raise __import__("queue").Empty
            return self.items.pop(0)

    class ResultProcess:
        def __init__(self, target, args):
            self.name = args[1]
            self.queue = args[2]
            self.alive = False

        def start(self):
            self.alive = True
            self.queue.put(results[self.name])

        def is_alive(self):
            return self.alive

        def join(self, timeout=None):
            self.alive = False

    monkeypatch.setattr("ccie_sidecar.stp_worker.Queue", ResultQueue)
    monkeypatch.setattr("ccie_sidecar.stp_worker.Process", ResultProcess)

    result = pool_type().collect("/saved/testbed.yaml", ["D1", "D2"])

    assert result["status"] == "complete"


def test_worker_pool_escalates_and_verifies_kill_after_timeout(monkeypatch):
    _, _, pool_type, _ = _worker_api()
    events = []

    class HangingProcess:
        def __init__(self, *args, **kwargs):
            self.alive = False

        def start(self):
            self.alive = True

        def is_alive(self):
            return self.alive

        def terminate(self):
            events.append("terminate")

        def kill(self):
            events.append("kill")
            self.alive = False

        def join(self, timeout=None):
            events.append(("join", timeout))

    class EmptyQueue:
        def get_nowait(self):
            raise __import__("queue").Empty

    clock = iter([0.0, 0.0, 0.0, 61.0])
    monkeypatch.setattr("ccie_sidecar.stp_worker.Queue", EmptyQueue)
    monkeypatch.setattr("ccie_sidecar.stp_worker.Process", HangingProcess)
    monkeypatch.setattr("ccie_sidecar.stp_worker.monotonic", lambda: next(clock))

    result = pool_type(device_timeout_seconds=60).collect("/saved/testbed.yaml", ["D1"])

    assert result["devices"][0]["status"] == "timeout"
    assert events[0] == "terminate"
    assert "kill" in events
