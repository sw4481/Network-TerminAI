"""Terminable per-device subprocess workers for native STP collection."""

from __future__ import annotations

import contextlib
import os
import platform
import time
import math
from multiprocessing import Process, Queue
from queue import Empty
from typing import Any, Iterable
from collections.abc import Mapping

from ccie_sidecar.pyats.bridge import build_pyats_client, default_testbed_path

from .stp.normalization import (
    NormalizedStpSnapshot,
    StpObservation,
    adjacency_evidence,
    build_stp_snapshot,
    compare_stp_snapshots,
    finding_evidence,
    has_parsable_stp,
    normalize_identifier,
    normalize_interface,
    normalized_stp_evidence,
)
from .stp_collector import STPCollector

MAX_WORKERS = 4
DEVICE_TIMEOUT_SECONDS = 60
OVERALL_TIMEOUT_SECONDS = 15 * 60
SUPPORTED_PLATFORMS = {"iosxe", "nxos"}
monotonic = time.monotonic


def platform_state() -> dict[str, Any]:
    """Describe whether this host can run native STP workers."""
    current = platform.system()
    if current == "Windows":
        return {"supported": False, "platform": current, "code": "unsupported_platform"}
    if current not in {"Darwin", "Linux"}:
        return {"supported": False, "platform": current, "code": "unsupported_platform"}
    return {"supported": True, "platform": current}


class STPWorker:
    """Hydrate one device from the testbed path and collect its evidence."""

    def __init__(self, testbed_path: str | None = None, device_name: str = "", platform: str | None = None):
        self.testbed_path = testbed_path or default_testbed_path()
        self.device_name = device_name
        self.platform = platform.lower() if platform else None

    def run(self) -> dict[str, Any]:
        client = build_pyats_client(self.testbed_path)
        if client is None:
            return self._failure("testbed_unavailable")
        device = getattr(client.testbed, "devices", {}).get(self.device_name)
        if device is None:
            return self._failure("device_not_found")
        device_platform = self.platform or str(getattr(device, "os", "")).lower()
        if device_platform not in SUPPORTED_PLATFORMS:
            return self._failure("unsupported_device_platform", device_platform, status="unsupported")
        return STPCollector(self.device_name, device_platform).collect(device)

    def _failure(self, code: str, device_platform: str | None = None, status: str = "failed") -> dict[str, Any]:
        return {
            "device": self.device_name,
            "platform": device_platform or self.platform,
            "status": status,
            "stp": {"instances": [], "ports": []},
            "neighbors": {"cdp": [], "lldp": []},
            "bundle": [],
            "gaps": [{"source": "worker", "code": code}],
        }


class STPCollectionPipeline:
    """Finalize worker records through the deterministic STP model."""

    _NEIGHBOR_FIELDS = {
        "id", "device_id", "name", "local_interface", "interface", "port_id",
        "instance", "local_bundle", "remote_bundle",
    }
    _BUNDLE_FIELDS = {"id", "name", "bundle_id", "protocol", "members"}

    def finalize(self, records: list[dict[str, Any]]) -> dict[str, Any]:
        unsupported = [record.get("device") for record in records if record.get("status") == "unsupported"]
        supported = [record for record in records if record.get("status") != "unsupported"]
        observations = [StpObservation.from_collector_record(record) for record in supported]
        snapshot = build_stp_snapshot(observations)
        successful = sum(observation.complete for observation in observations)
        if not supported:
            status = "unsupported"
        elif successful == 0:
            status = "failed"
        elif successful == len(supported):
            status = "complete"
        else:
            status = "partial"

        normalized_supported = iter(zip(observations, snapshot.devices))
        devices = [
            self._safe_unsupported(record)
            if record.get("status") == "unsupported"
            else self._normalized_device(record, *next(normalized_supported), snapshot)
            for record in records
        ]
        findings = compare_stp_snapshots(snapshot, snapshot) if snapshot.complete else ()
        result: dict[str, Any] = {
            "status": status,
            "devices": devices,
            "unsupported": [device for device in unsupported if isinstance(device, str)],
            "adjacencies": adjacency_evidence(snapshot),
            "findings": finding_evidence(findings),
        }
        if status == "unsupported":
            result["code"] = "no_supported_devices"
        return result

    def _normalized_device(
        self,
        record: Mapping[str, Any],
        observation: StpObservation,
        device: Any,
        snapshot: NormalizedStpSnapshot,
    ) -> dict[str, Any]:
        status = "complete" if observation.complete else str(record.get("status") or "failed")
        result: dict[str, Any] = {
            "device": observation.device_id,
            "platform": observation.platform,
            "status": status,
            "stp": normalized_stp_evidence(device),
            "neighbors": self._neighbors(record, observation.device_id, snapshot),
            "bundle": self._bundles(record),
            "gaps": self._gaps(record),
        }
        if isinstance(record.get("code"), str):
            result["code"] = record["code"]
        return result

    @staticmethod
    def _safe_unsupported(record: Mapping[str, Any]) -> dict[str, Any]:
        result = {
            "device": str(record.get("device") or ""),
            "platform": str(record.get("platform") or ""),
            "status": "unsupported",
            "stp": {"instances": [], "ports": []},
            "neighbors": {"cdp": [], "lldp": []},
            "bundle": [],
            "gaps": STPCollectionPipeline._gaps(record),
        }
        if isinstance(record.get("code"), str):
            result["code"] = record["code"]
        return result

    def _neighbors(
        self,
        record: Mapping[str, Any],
        local_device: str,
        snapshot: NormalizedStpSnapshot,
    ) -> dict[str, list[dict[str, Any]]]:
        source = record.get("neighbors") if isinstance(record.get("neighbors"), Mapping) else {}
        result: dict[str, list[dict[str, Any]]] = {"cdp": [], "lldp": []}
        for family in result:
            values = source.get(family)
            if not isinstance(values, (list, tuple)):
                continue
            for item in values:
                if not isinstance(item, Mapping):
                    continue
                safe = {
                    key: value
                    for key, value in item.items()
                    if key in self._NEIGHBOR_FIELDS and isinstance(value, (str, int, float, bool))
                }
                confidence = self._confidence(snapshot, local_device, item)
                if confidence is not None:
                    safe["bidirectional"] = confidence == "confirmed"
                result[family].append(safe)
        return result

    @staticmethod
    def _confidence(
        snapshot: NormalizedStpSnapshot,
        local_device: str,
        item: Mapping[str, Any],
    ) -> str | None:
        local = normalize_identifier(local_device)
        remote = normalize_identifier(item.get("device_id") or item.get("name"))
        local_interface = normalize_interface(item.get("local_interface") or item.get("interface"))
        remote_interface = normalize_interface(item.get("port_id"))
        if not all((local, remote, local_interface, remote_interface)):
            return None
        for edge in snapshot.adjacencies:
            forward = local == edge.local_device_id and remote == edge.remote_device_id
            reverse = local == edge.remote_device_id and remote == edge.local_device_id
            if not forward and not reverse:
                continue
            if edge.member_interfaces:
                pair = (local_interface, remote_interface) if forward else (remote_interface, local_interface)
                if pair in edge.member_interfaces:
                    return edge.confidence
            elif forward and (local_interface, remote_interface) == (edge.local_interface, edge.remote_interface):
                return edge.confidence
            elif reverse and (local_interface, remote_interface) == (edge.remote_interface, edge.local_interface):
                return edge.confidence
        return None

    @classmethod
    def _bundles(cls, record: Mapping[str, Any]) -> list[dict[str, Any]]:
        values = record.get("bundle")
        if not isinstance(values, (list, tuple)):
            return []
        result: list[dict[str, Any]] = []
        for item in values:
            if not isinstance(item, Mapping):
                continue
            safe = {
                key: value
                for key, value in item.items()
                if key in cls._BUNDLE_FIELDS and isinstance(value, (str, int, float, bool, list, tuple))
            }
            if isinstance(safe.get("members"), (list, tuple)):
                safe["members"] = [
                    str(member) for member in safe["members"] if isinstance(member, (str, int, float))
                ]
            result.append(safe)
        return result

    @staticmethod
    def _gaps(record: Mapping[str, Any]) -> list[dict[str, str]]:
        values = record.get("gaps")
        if not isinstance(values, (list, tuple)):
            return []
        return [
            {"source": source, "code": code}
            for item in values
            if isinstance(item, Mapping)
            if isinstance((source := item.get("source")), str)
            if isinstance((code := item.get("code")), str)
        ]


def _worker_entry(testbed_path: str, device_name: str, result_queue: Queue) -> None:
    saved_stdout_fd = os.dup(1)
    try:
        with open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull):
            os.dup2(devnull.fileno(), 1)
            try:
                result_queue.put(STPWorker(testbed_path=testbed_path, device_name=device_name).run())
            except BaseException:
                result_queue.put(STPWorker(testbed_path=testbed_path, device_name=device_name)._failure("worker_failed"))
    finally:
        try:
            os.dup2(saved_stdout_fd, 1)
        finally:
            os.close(saved_stdout_fd)


class STPWorkerPool:
    """Run bounded, independently terminable workers for one collection run."""

    def __init__(
        self,
        max_workers: int = MAX_WORKERS,
        device_timeout_seconds: float = DEVICE_TIMEOUT_SECONDS,
        overall_timeout_seconds: float = OVERALL_TIMEOUT_SECONDS,
    ):
        self.max_workers = self._bounded_workers(max_workers)
        self.device_timeout_seconds = self._bounded_seconds(device_timeout_seconds, DEVICE_TIMEOUT_SECONDS, "device_timeout_seconds")
        self.overall_timeout_seconds = self._bounded_seconds(overall_timeout_seconds, OVERALL_TIMEOUT_SECONDS, "overall_timeout_seconds")

    @staticmethod
    def _bounded_workers(value: int) -> int:
        workers = int(value)
        if workers <= 0:
            raise ValueError("max_workers must be positive")
        return min(workers, MAX_WORKERS)

    @staticmethod
    def _bounded_seconds(value: float, maximum: float, name: str) -> float:
        seconds = float(value)
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError(f"{name} must be positive")
        return min(seconds, maximum)

    def collect(self, testbed_path: str | None, device_names: Iterable[str]) -> dict[str, Any]:
        state = platform_state()
        if not state["supported"]:
            return {"status": "unsupported", "platform": state["platform"], "code": state["code"], "devices": []}

        names = list(device_names)
        queue: Queue = Queue()
        pending = list(names)
        active: dict[str, tuple[Process, float]] = {}
        results: dict[str, dict[str, Any]] = {}
        start = monotonic()
        path = testbed_path or default_testbed_path()

        try:
            while pending or active:
                now = monotonic()
                if now - start >= self.overall_timeout_seconds:
                    for name, (process, _) in list(active.items()):
                        self._terminate(process)
                        results[name] = {"device": name, "status": "timeout", "code": "overall_timeout"}
                    for name in pending:
                        results[name] = {"device": name, "status": "skipped", "code": "overall_timeout"}
                    pending.clear()
                    active.clear()
                    break

                while pending and len(active) < self.max_workers:
                    name = pending.pop(0)
                    process = Process(target=_worker_entry, args=(path, name, queue))
                    process.start()
                    active[name] = (process, monotonic())

                self._drain_results(queue, active, results)
                now = monotonic()
                for name, (process, started) in list(active.items()):
                    if now - started >= self.device_timeout_seconds:
                        self._terminate(process)
                        results[name] = {"device": name, "status": "timeout", "code": "device_timeout"}
                        del active[name]
                if active and not results:
                    time.sleep(0.01)
        finally:
            for process, _ in active.values():
                self._terminate(process)

        ordered = [results.get(name, {"device": name, "status": "failed", "code": "missing_result"}) for name in names]
        return STPCollectionPipeline().finalize(ordered)

    def _drain_results(self, queue: Queue, active: dict[str, tuple[Process, float]], results: dict[str, dict[str, Any]]) -> None:
        while True:
            try:
                result = queue.get_nowait()
            except Empty:
                return
            name = result.get("device")
            if name not in active:
                continue
            process, _ = active.pop(name)
            process.join(timeout=0.1)
            if process.is_alive():
                self._terminate(process)
            results[name] = result

    def _terminate(self, process: Process) -> None:
        if not process.is_alive():
            return
        process.terminate()
        process.join(timeout=0.2)
        if process.is_alive():
            process.kill()
            process.join(timeout=0.2)
        if process.is_alive():
            raise RuntimeError("worker process did not terminate")

    @staticmethod
    def _has_parsable_stp(result: Mapping[str, Any]) -> bool:
        return has_parsable_stp(result.get("stp"))


def collect_stp() -> dict[str, Any]:
    """Collect every testbed device through the bounded STP worker pool."""
    state = platform_state()
    if not state["supported"]:
        return {
            "status": "unsupported",
            "platform": state["platform"],
            "code": state["code"],
            "devices": [],
        }
    path = default_testbed_path()
    client = build_pyats_client(path)
    if client is None:
        return {"status": "failed", "code": "testbed_unavailable", "devices": []}
    devices = getattr(client.testbed, "devices", {})
    return STPWorkerPool().collect(path, list(devices))
