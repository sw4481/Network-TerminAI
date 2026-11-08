"""One stdin request / one stdout response, independently launched and killed by Rust.

No persistent-sidecar imports or RPC. Only bounded numeric GETBULK on the single
operator-authorized host. Never pass credentials through argv, env or diagnostics.
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict
from ipaddress import ip_address
import json
import logging
import queue
import re
import sys
import threading
import warnings

from pyasn1.codec.ber.encoder import encode
from pysnmp.hlapi.v3arch.asyncio import (
    CommunityData, ContextData, SnmpEngine, UdpTransportTarget, Udp6TransportTarget,
    UsmUserData, USM_AUTH_HMAC192_SHA256, USM_PRIV_CFB128_AES, bulk_cmd,
)
from pysnmp.proto import errind, rfc1902, rfc1905

from ccie_sidecar.topology.snmp_mib import SnmpMib
from ccie_sidecar.topology.snmp_neighbors import SnmpNeighborNormalizer, SnmpTable, SnmpTableError

MAX_INPUT = 16 * 1024
MAX_OUTPUT = 2 * 1024 * 1024
WORKER_SECONDS = 80  # Plus <=3s stdin, leaving time for bounded decoding/serialization.
STDIN_SECONDS = 3
MAX_ROWS = 2000
MAX_CELLS = 24000
MAX_BYTES = 1024 * 1024
MAX_CALLS = 1024
BULK_SIZE = 25


def _failure(protocol: str, error: str) -> dict:
    return {"protocol": protocol, "status": "failed", "records": [], "observations": [], "error": error}


def _failed_response(error: str) -> dict:
    return {"captures": [_failure(protocol, error) for protocol in ("cdp", "lldp")]}


class SnmpWorker:
    def __init__(self, request: dict):
        self._validate(request)
        self.host = request["host"]
        self.credential = request["credential"]
        self.tables: dict[str, SnmpTable] = {}
        self.errors: dict[str, str] = {}
        self.captures = _failed_response("SNMP worker timeout")["captures"]
        self.engine = None

    @staticmethod
    def _validate(request):
        def text(value, minimum, maximum):
            try:
                return isinstance(value, str) and minimum <= len(value.encode("utf-8")) <= maximum and not any(
                    ord(c) < 32 or ord(c) == 127 for c in value)
            except UnicodeError:
                return False

        valid = isinstance(request, dict) and set(request) == {"host", "credential"}
        if not valid:
            raise ValueError("Invalid SNMP request")
        host, credential = request["host"], request["credential"]
        valid = text(host, 1, 253) and isinstance(credential, dict)
        if not valid:
            raise ValueError("Invalid SNMP request")
        try:
            ip_address(host)
            valid = "%" not in host  # Scoped addresses require an explicit, separately agreed scope contract.
        except ValueError:
            valid = bool(re.fullmatch(r"(?=.{1,253}\.?$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?", host))
        version = credential.get("version")
        required = {"schema", "version", "username", "auth_key", "priv_key"} if version == "3" else {"schema", "version", "community"}
        allowed = required | {"port"} | ({"context"} if version == "3" else set())
        valid &= (set(credential) <= allowed and required <= set(credential) and
            type(credential.get("schema")) is int and credential["schema"] == 1 and version in ("3", "2c"))
        port = credential.get("port", 161)
        valid &= type(port) is int and 1 <= port <= 65535
        if version == "3":
            valid &= (text(credential.get("username"), 1, 32) and text(credential.get("auth_key"), 8, 1024) and
                text(credential.get("priv_key"), 8, 1024) and text(credential.get("context", ""), 0, 32))
        else:
            valid &= text(credential.get("community"), 1, 255)
        if not valid:
            raise ValueError("Invalid SNMP request")

    async def _table(self, name: str):
        root = SnmpMib.ROOTS[name]
        cursor, cells, indexes, byte_count = root, [], set(), 0
        status = "incomplete"
        error = "SNMP table incomplete"
        try:
            for _ in range(MAX_CALLS):
                indication, pdu_status, _, batch = await asyncio.wait_for(bulk_cmd(
                    self.engine, self.auth, self.target, self.context, 0, BULK_SIZE,
                    (rfc1902.ObjectName(cursor), rfc1902.Null("")), lookupMib=False,
                ), timeout=5)
                if indication:
                    error = "SNMP request timeout" if isinstance(indication, errind.RequestTimedOut) else "SNMP request failed"
                    break
                if pdu_status:
                    error = "SNMP access denied" if int(pdu_status) in (6, 16) else "SNMP request failed"
                    break
                if not isinstance(batch, (tuple, list)) or not batch:
                    break  # An empty PDU is not proof that a subtree is empty.
                if len(batch) > BULK_SIZE or len(cells) + len(batch) > MAX_CELLS:
                    error = "SNMP table cell limit"
                    break
                ended = False
                for item in batch:
                    if not isinstance(item, (tuple, list)) or len(item) != 2:
                        raise SnmpTableError("SNMP invalid varbind")
                    raw_oid, value = item
                    numeric = SnmpMib.numeric_oid(raw_oid)
                    if isinstance(value, rfc1905.EndOfMibView):
                        ended = True
                        continue
                    if isinstance(value, (rfc1905.NoSuchObject, rfc1905.NoSuchInstance)):
                        error = "SNMP object unavailable"
                        raise SnmpTableError(error)
                    if numeric <= cursor:
                        raise SnmpTableError("SNMP nonincreasing OID")
                    if numeric[:len(root)] != root:
                        ended = True
                        continue
                    if ended:
                        raise SnmpTableError("SNMP invalid subtree order")
                    index = SnmpMib.index(name, numeric[len(root):])
                    indexes.add(index)
                    if len(indexes) > MAX_ROWS:
                        error = "SNMP table row limit"
                        raise SnmpTableError(error)
                    byte_count += len(numeric) * 4 + len(encode(value))
                    if byte_count > MAX_BYTES:
                        error = "SNMP table byte limit"
                        raise SnmpTableError(error)
                    cells.append((raw_oid, value))
                    cursor = numeric
                if ended:
                    status = "completed"
                    break
            else:
                error = "SNMP table call limit"
        except TimeoutError:
            error = "SNMP request timeout"
        except asyncio.CancelledError:
            error = "SNMP worker timeout"
            raise
        except Exception:
            # No exception formatting: PySNMP/agents may include supplied secrets.
            pass
        finally:
            try:
                self.tables[name] = SnmpMib.decode(name, cells, status)
            except Exception:
                self.tables[name] = SnmpTable("incomplete")
                status, error = "incomplete", "SNMP table decode failed"
            if status != "completed":
                self.errors[name] = error

    def _capture(self, protocol: str) -> dict:
        tables = dict(self.tables)
        tables["interfaces"] = SnmpMib.interfaces(tables)
        required = ["ifName", "ifDescr", "ifAlias", "interfaces", "cdpCacheTable"] if protocol == "cdp" else [
            "ifName", "ifDescr", "ifAlias", "interfaces", "lldpLocPortTable", "lldpRemTable", "lldpRemManAddrTable"]
        if protocol == "lldp":
            SnmpMib.join_management(tables)
        # Partial table projections may still contain useful unresolved provenance.
        # Only the resulting capture status authorizes native absence reconciliation.
        partial = {name: SnmpTable("completed", table.rows) for name, table in tables.items()}
        for name in ("interfaces", "cdpCacheTable", "lldpLocPortTable", "lldpRemTable"):
            partial.setdefault(name, SnmpTable("completed"))
        try:
            normalized = SnmpNeighborNormalizer(partial).normalize(protocol)
        except Exception:
            return _failure(protocol, "SNMP table decode failed")
        observations = []
        for observation in normalized.observations:
            value = asdict(observation)
            value.pop("record")
            value["index"] = list(value["index"])
            value["management_indexes"] = [list(index) for index in value["management_indexes"]]
            observations.append(value)
        error = next((self.errors.get(name, "SNMP table incomplete") for name in required
                      if tables.get(name, SnmpTable("incomplete")).status != "completed"), None)
        if error is None and any(o["reason"] for o in observations):
            error = "SNMP neighbor mapping incomplete"
        result = {"protocol": protocol, "status": "failed" if error else "completed",
            "records": [] if error else normalized.records, "observations": observations, "error": error}
        sensitive = [self.credential[k] for k in ("auth_key", "priv_key", "community") if k in self.credential]
        # Check decoded values, not JSON keys/fixed errors, and do not echo an agent
        # that returns a community/passphrase as an advertised name/description.
        def leaks(value):
            if isinstance(value, str):
                return any(secret in value for secret in sensitive)
            if isinstance(value, dict):
                return any(leaks(v) for v in value.values())
            if isinstance(value, (list, tuple)):
                return any(leaks(v) for v in value)
            return False
        if leaks(observations) or leaks(result["records"]):
            return _failure(protocol, "SNMP unsafe response rejected")
        return result

    async def _protocol(self, protocol: str):
        names = ("cdpCacheTable",) if protocol == "cdp" else ("lldpRemTable", "lldpLocPortTable", "lldpRemManAddrTable")
        try:
            for name in names:
                await self._table(name)
        finally:
            self.captures[0 if protocol == "cdp" else 1] = self._capture(protocol)

    async def run(self) -> dict:
        try:
            async with asyncio.timeout(WORKER_SECONDS):
                self.engine = SnmpEngine()
                credential = self.credential
                if credential["version"] == "3":
                    self.auth = UsmUserData(credential["username"], credential["auth_key"], credential["priv_key"],
                        authProtocol=USM_AUTH_HMAC192_SHA256, privProtocol=USM_PRIV_CFB128_AES)
                else:
                    self.auth = CommunityData(credential["community"], mpModel=1)
                target_class = Udp6TransportTarget if ":" in self.host else UdpTransportTarget
                self.target = await target_class.create((self.host, credential.get("port", 161)), timeout=2, retries=1)
                self.context = ContextData(contextName=credential.get("context", ""))
                await asyncio.gather(*(self._table(name) for name in ("ifName", "ifDescr", "ifAlias")))
                await asyncio.gather(self._protocol("cdp"), self._protocol("lldp"))
        except TimeoutError:
            pass  # Individual completed protocols survive another protocol's deadline.
        except Exception:
            self.captures = _failed_response("SNMP worker failed")["captures"]
        finally:
            if self.engine is not None:
                try:
                    self.engine.close_dispatcher()
                except Exception:
                    self.captures = _failed_response("SNMP worker cleanup failed")["captures"]
        return {"captures": self.captures}


def _serialize(response: dict) -> str:
    def compact(value):
        return json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
    serialized = compact(response)
    if len(serialized) + 1 <= MAX_OUTPUT:
        return serialized
    # Fail explicitly, keeping a bounded prefix of decoded evidence, never a
    # truncated successful result that could mark historical receipts absent.
    bounded = _failed_response("SNMP output limit")
    budget = MAX_OUTPUT - 4096
    for original, capture in zip(response["captures"], bounded["captures"]):
        for observation in original["observations"]:
            size = len(compact(observation)) + 1
            if size > budget:
                break
            capture["observations"].append(observation)
            budget -= size
    return compact(bounded)


def main(stdin=None, stdout=None) -> int:
    stdin = sys.stdin.buffer if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    incoming = queue.Queue(maxsize=1)

    def read_request():
        try:
            incoming.put(stdin.read(MAX_INPUT + 1))
        except Exception:
            incoming.put(None)

    # A caller that never closes stdin must not strand the worker. A daemon
    # thread avoids asyncio's executor shutdown waiting for a blocked pipe read.
    threading.Thread(target=read_request, daemon=True).start()
    exit_code = 0
    try:
        payload = incoming.get(timeout=STDIN_SECONDS)
        if not isinstance(payload, bytes) or len(payload) > MAX_INPUT:
            raise ValueError("Invalid SNMP request")
        request = json.loads(payload)
        response = asyncio.run(SnmpWorker(request).run())
    except Exception:
        response, exit_code = _failed_response("Invalid SNMP request"), 1
    stdout.write(_serialize(response) + "\n")
    stdout.flush()
    return exit_code


if __name__ == "__main__":
    # These settings belong to the dedicated process, not importers/test runners.
    logging.disable(logging.CRITICAL)
    warnings.simplefilter("ignore")
    raise SystemExit(main())
