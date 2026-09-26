"""Task 1 contract tests for direct pyATS LSDB import."""

from __future__ import annotations

import json
import sys
from types import ModuleType
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from ccie_sidecar.server import handle_request
from ccie_sidecar.topolograph import TopolographError


COMMAND_CASES = (
    (
        "iosxe",
        "ospf",
        (
            "show ip ospf database router",
            "show ip ospf database network",
            "show ip ospf database external",
        ),
    ),
    ("iosxe", "ospfv3", ("show ospfv3 database",)),
    ("iosxe", "isis", ("show isis database detail",)),
    (
        "nxos",
        "ospf",
        (
            "show ip ospf database router detail",
            "show ip ospf database network detail",
            "show ip ospf database external detail",
        ),
    ),
    ("nxos", "ospfv3", ("show ipv6 ospf database",)),
    ("nxos", "isis", ("show isis database detail",)),
)


class FakeDevice:
    def __init__(self, platform: str, output: object = "RAW LSDB\n"):
        self.os = platform
        self.output = output
        self.execute_error: Exception | None = None
        self.executed: list[str] = []

    def execute(self, command: str):
        self.executed.append(command)
        if self.execute_error is not None:
            raise self.execute_error
        if isinstance(self.output, list):
            return self.output.pop(0)
        return self.output


class FakePyatsClient:
    def __init__(self, devices: dict[str, FakeDevice]):
        self.testbed = SimpleNamespace(devices=devices)

    def call(self, *_args, **_kwargs):
        raise AssertionError("The generic pyATS verb path must not be used.")


class FakeTopolographClient:
    instances: list["FakeTopolographClient"] = []
    upload_error: Exception | None = None

    def __init__(self, config, token: str):
        self.config = config
        self.token = token
        self.uploads: list[tuple[str, str, str, str | None]] = []
        type(self).instances.append(self)

    def upload_lsdb(
        self,
        content: str,
        vendor: str,
        protocol: str,
        description: str | None = None,
    ):
        self.uploads.append((content, vendor, protocol, description))
        if type(self).upload_error is not None:
            raise type(self).upload_error
        return {
            "accepted": True,
            "body": content,
            "authorization": self.token,
        }


@pytest.fixture(autouse=True)
def reset_fake_topolograph_client():
    FakeTopolographClient.instances = []
    FakeTopolographClient.upload_error = None


def import_params(**overrides):
    params = {
        "testbed_path": "/tmp/testbed.yaml",
        "device": "CORE1",
        "protocol": "ospf",
        "base_url": "https://topolograph.example",
        "verify_tls": True,
        "token": "selected-token",
        "description": "nightly import",
    }
    params.update(overrides)
    return params


def run_import(params, pyats_client, connected):
    def record_connection(device):
        connected.append(device)

    connect_module = ModuleType("terminai_pyats.connect")
    connect_module.ensure_connected = record_connection
    package_module = ModuleType("terminai_pyats")
    package_module.connect = connect_module

    with (
        patch.dict(
            sys.modules,
            {
                "terminai_pyats": package_module,
                "terminai_pyats.connect": connect_module,
            },
        ),
        patch(
            "ccie_sidecar.pyats.bridge.build_pyats_client",
            return_value=pyats_client,
        ),
        patch(
            "ccie_sidecar.topolograph.TopolographClient",
            FakeTopolographClient,
        ),
    ):
        return handle_request({
            "id": "lsdb-import",
            "method": "topolograph.import_lsdb_from_pyats",
            "params": params,
        })


@pytest.mark.parametrize("platform, protocol, commands", COMMAND_CASES)
def test_import_uses_exact_platform_command_and_direct_device_execute(
    platform, protocol, commands
):
    outputs = [f"RAW {platform} {protocol} {index}\n" for index, _ in enumerate(commands)]
    device = FakeDevice(platform, outputs.copy())
    connected: list[FakeDevice] = []

    response = run_import(
        import_params(protocol=protocol),
        FakePyatsClient({"CORE1": device}),
        connected,
    )

    assert response["id"] == "lsdb-import"
    assert response["type"] == "done"
    assert response["result"]["ok"] is True
    assert response["result"]["message"] == "LSDB collected and uploaded."
    assert response["result"]["warnings"] == []
    assert connected == [device]
    assert device.executed == list(commands)
    assert len(FakeTopolographClient.instances) == 1
    upload = FakeTopolographClient.instances[0].uploads
    assert len(upload) == 1
    assert response["result"]["bytes"] == len(upload[0][0].encode("utf-8"))
    assert upload[0][1:] == ("Cisco", protocol, "nightly import")
    assert all(output.strip() in upload[0][0] for output in outputs)
    assert [upload[0][0].index(output.strip()) for output in outputs] == sorted(
        upload[0][0].index(output.strip()) for output in outputs
    )


@pytest.mark.parametrize(
    "overrides",
    (
        {"testbed_path": ""},
        {"device": ""},
        {"protocol": "bgp"},
        {"base_url": ""},
        {"base_url": "https://[malformed"},
        {"verify_tls": "yes"},
        {"token": ""},
        {"description": 7},
    ),
)
def test_import_rejects_malformed_or_unsupported_parameters_before_collection(
    overrides,
):
    with patch(
        "ccie_sidecar.pyats.bridge.build_pyats_client",
        side_effect=AssertionError("invalid input reached pyATS"),
    ):
        response = handle_request({
            "id": "invalid",
            "method": "topolograph.import_lsdb_from_pyats",
            "params": import_params(**overrides),
        })

    assert response["type"] == "error"
    assert response["code"] == "INVALID_PARAMETERS"


def test_import_reports_unavailable_testbed_without_exposing_parameters():
    response = run_import(import_params(), None, [])

    assert response["type"] == "error"
    assert response["code"] == "PYATS_UNAVAILABLE"
    assert "testbed.yaml" not in json.dumps(response)
    assert "selected-token" not in json.dumps(response)


def test_import_reports_missing_device():
    response = run_import(import_params(device="MISSING"), FakePyatsClient({}), [])

    assert response["type"] == "error"
    assert response["code"] == "DEVICE_NOT_FOUND"


def test_import_rejects_unsupported_device_platform_before_connecting():
    device = FakeDevice("ios")
    connected: list[FakeDevice] = []

    response = run_import(
        import_params(),
        FakePyatsClient({"CORE1": device}),
        connected,
    )

    assert response["type"] == "error"
    assert response["code"] == "UNSUPPORTED_DEVICE_PLATFORM"
    assert connected == []
    assert device.executed == []


@pytest.mark.parametrize("output", ("", "   ", {"parsed": "not raw text"}))
def test_import_rejects_empty_or_non_text_lsdb_output(output):
    device = FakeDevice("iosxe", output)

    response = run_import(
        import_params(),
        FakePyatsClient({"CORE1": device}),
        [],
    )

    assert response["type"] == "error"
    assert response["code"] == "LSDB_COLLECTION_FAILED"
    assert FakeTopolographClient.instances == []


def test_import_rejects_a_missing_required_lsdb_section():
    device = FakeDevice("iosxe", ["ROUTERS\n", "", "EXTERNALS\n"])

    response = run_import(
        import_params(),
        FakePyatsClient({"CORE1": device}),
        [],
    )

    assert response["type"] == "error"
    assert response["code"] == "LSDB_COLLECTION_FAILED"
    assert FakeTopolographClient.instances == []


@pytest.mark.parametrize("failure_stage", ("connect", "execute"))
def test_import_returns_safe_collection_error_without_exception_text(failure_stage):
    secret = "RAW-LSDB selected-token 192.0.2.15"
    device = FakeDevice("iosxe")
    connected: list[FakeDevice] = []

    if failure_stage == "execute":
        device.execute_error = RuntimeError(secret)

    def connect(device_to_connect):
        connected.append(device_to_connect)
        if failure_stage == "connect":
            raise RuntimeError(secret)

    connect_module = ModuleType("terminai_pyats.connect")
    connect_module.ensure_connected = connect
    package_module = ModuleType("terminai_pyats")
    package_module.connect = connect_module

    with (
        patch.dict(
            sys.modules,
            {
                "terminai_pyats": package_module,
                "terminai_pyats.connect": connect_module,
            },
        ),
        patch(
            "ccie_sidecar.pyats.bridge.build_pyats_client",
            return_value=FakePyatsClient({"CORE1": device}),
        ),
        patch(
            "ccie_sidecar.topolograph.TopolographClient",
            FakeTopolographClient,
        ),
    ):
        response = handle_request({
            "id": "collection-failed",
            "method": "topolograph.import_lsdb_from_pyats",
            "params": import_params(),
        })

    encoded = json.dumps(response)
    assert response["type"] == "error"
    assert response["code"] == "LSDB_COLLECTION_FAILED"
    assert secret not in encoded
    assert "selected-token" not in encoded


def test_import_preserves_topolograph_error_code_in_bridged_safe_message():
    output = "RAW-LSDB selected-token 192.0.2.15"
    FakeTopolographClient.upload_error = TopolographError(
        "UPSTREAM_TIMEOUT", "unsafe upstream selected-token"
    )

    response = run_import(
        import_params(),
        FakePyatsClient({"CORE1": FakeDevice("iosxe", output)}),
        [],
    )

    encoded = json.dumps(response)
    assert response["type"] == "error"
    assert response["code"] == "UPSTREAM_TIMEOUT"
    # SidecarSupervisor drops the separate code field and preserves only message.
    bridged_message = response["message"]
    assert (
        bridged_message
        == "UPSTREAM_TIMEOUT: The Topolograph upload was not completed."
    )
    assert output not in encoded
    assert "selected-token" not in encoded
