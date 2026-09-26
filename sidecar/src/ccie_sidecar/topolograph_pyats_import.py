"""Direct, payload-private pyATS LSDB import for Topolograph."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlsplit

from ccie_sidecar.pyats import bridge as pyats_bridge
from ccie_sidecar import topolograph


COMMANDS = {
    "iosxe": {
        "ospf": (
            "show ip ospf database router",
            "show ip ospf database network",
            "show ip ospf database external",
        ),
        "ospfv3": ("show ospfv3 database",),
        "isis": ("show isis database detail",),
    },
    "nxos": {
        "ospf": (
            "show ip ospf database router detail",
            "show ip ospf database network detail",
            "show ip ospf database external detail",
        ),
        "ospfv3": ("show ipv6 ospf database",),
        "isis": ("show isis database detail",),
    },
}


class LsdbImportError(RuntimeError):
    """Fixed-code import failure with a safe user-facing message."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.safe_message = message
        super().__init__(code)


@dataclass(frozen=True)
class LsdbImportRequest:
    testbed_path: str
    device: str
    protocol: str
    base_url: str
    verify_tls: bool
    token: str
    description: str | None

    @classmethod
    def from_params(cls, params: Any) -> "LsdbImportRequest":
        if not isinstance(params, Mapping):
            raise LsdbImportError(
                "INVALID_PARAMETERS", "The import parameters were rejected."
            )

        text_fields = {
            name: params.get(name)
            for name in ("testbed_path", "device", "protocol", "base_url", "token")
        }
        if any(
            not isinstance(value, str) or not value.strip()
            for value in text_fields.values()
        ):
            raise LsdbImportError(
                "INVALID_PARAMETERS", "The import parameters were rejected."
            )

        protocol = text_fields["protocol"]
        verify_tls = params.get("verify_tls")
        description = params.get("description")
        if (
            protocol not in COMMANDS["iosxe"]
            or not isinstance(verify_tls, bool)
            or (description is not None and not isinstance(description, str))
            or not cls._valid_base_url(text_fields["base_url"])
        ):
            raise LsdbImportError(
                "INVALID_PARAMETERS", "The import parameters were rejected."
            )

        return cls(
            testbed_path=text_fields["testbed_path"].strip(),
            device=text_fields["device"].strip(),
            protocol=protocol,
            base_url=text_fields["base_url"].strip(),
            verify_tls=verify_tls,
            token=text_fields["token"],
            description=description,
        )

    @staticmethod
    def _valid_base_url(value: str) -> bool:
        try:
            parts = urlsplit(value.strip())
        except ValueError:
            return False
        return (
            parts.scheme in {"http", "https"}
            and bool(parts.netloc)
            and parts.username is None
            and parts.password is None
            and not parts.query
            and not parts.fragment
        )


class TopolographPyatsLsdbImporter:
    """Collect one raw LSDB from one saved device and upload it directly."""

    def run(self, params: Any) -> dict[str, Any]:
        request = LsdbImportRequest.from_params(params)
        pyats_client = self._load_pyats_client(request.testbed_path)
        device = self._resolve_device(pyats_client, request.device)
        platform = str(getattr(device, "os", "")).strip().lower()
        if platform not in COMMANDS:
            raise LsdbImportError(
                "UNSUPPORTED_DEVICE_PLATFORM",
                "The selected device platform is not supported.",
            )

        output = self._collect(device, COMMANDS[platform][request.protocol])
        client = topolograph.TopolographClient(
            topolograph.TopolographRuntimeConfig(
                base_url=request.base_url,
                verify_tls=request.verify_tls,
            ),
            request.token,
        )
        client.upload_lsdb(output, "Cisco", request.protocol, request.description)
        return {
            "ok": True,
            "message": "LSDB collected and uploaded.",
            "bytes": len(output.encode("utf-8")),
            "warnings": [],
        }

    @staticmethod
    def _load_pyats_client(testbed_path: str):
        try:
            client = pyats_bridge.build_pyats_client(testbed_path)
        except Exception:
            client = None
        if client is None:
            raise LsdbImportError(
                "PYATS_UNAVAILABLE", "The pyATS testbed is unavailable."
            )
        return client

    @staticmethod
    def _resolve_device(pyats_client: Any, device_name: str):
        devices = getattr(getattr(pyats_client, "testbed", None), "devices", {})
        try:
            device = devices.get(device_name)
        except Exception:
            device = None
        if device is None:
            raise LsdbImportError(
                "DEVICE_NOT_FOUND", "The selected pyATS device was not found."
            )
        return device

    @staticmethod
    def _collect(device: Any, commands: tuple[str, ...]) -> str:
        try:
            from terminai_pyats.connect import ensure_connected

            ensure_connected(device)
            outputs = [device.execute(command) for command in commands]
        except Exception:
            raise LsdbImportError(
                "LSDB_COLLECTION_FAILED", "The LSDB collection was not completed."
            ) from None
        if any(not isinstance(output, str) or not output.strip() for output in outputs):
            raise LsdbImportError(
                "LSDB_COLLECTION_FAILED", "The LSDB collection was not completed."
            )
        return "\n\n".join(output.rstrip("\n") for output in outputs)


class TopolographPyatsLsdbRequestHandler:
    """Translate importer outcomes into the sidecar's NDJSON response shape."""

    def handle(self, req_id: str, params: Any) -> dict[str, Any]:
        try:
            result = TopolographPyatsLsdbImporter().run(params)
            return {"id": req_id, "type": "done", "result": result}
        except LsdbImportError as error:
            return self._error(req_id, error.code, error.safe_message)
        except topolograph.TopolographError as error:
            return self._error(
                req_id,
                error.code,
                "The Topolograph upload was not completed.",
            )
        except Exception:
            return self._error(
                req_id,
                "ADAPTER_FAILURE",
                "The Topolograph upload was not completed.",
            )

    @staticmethod
    def _error(req_id: str, code: str, message: str) -> dict[str, Any]:
        return {
            "id": req_id,
            "type": "error",
            "code": code,
            "message": f"{code}: {message}",
        }
