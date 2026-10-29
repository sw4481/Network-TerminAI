"""Turn-local, opt-in Canvas evidence and data-only card validation.

Callers must capture actual helper results, not JSON printed by the model. This
contract does not sandbox or attest to full-trust Python execution.
"""
from __future__ import annotations

import copy
import json
import re
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError
from typing import Literal

from ccie_sidecar.agents.tool_output import DEFAULT_MAX_QUERY_CHARS, DEFAULT_MAX_RETAINED_BYTES, DEFAULT_MAX_RETURN_CHARS, ToolOutputPolicy, _utf8_prefix

_SENSITIVE = {"apikey", "secret", "secretkey", "clientsecret", "password", "passwd", "pwd", "token", "accesstoken", "authorization", "auth", "headers", "cookie", "setcookie", "credential", "privatekey"}
_SENSITIVE_SUFFIXES = ("token", "secret", "password", "credential", "apikey")
_REF_KEYS = {"evidence_id", "path"}
_CARD_TYPES = {"findings", "table", "key_value", "chart", "topology", "text", "assessment"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _sensitive_key(key: str) -> bool:
    name = re.sub(r"[^a-z0-9]", "", key.lower())
    return name in _SENSITIVE or name.endswith(_SENSITIVE_SUFFIXES)


class _PublishModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class _PublishColumn(_PublishModel):
    key: str
    label: str


class _PublishRow(_PublishModel):
    cells: dict[str, JsonValue]


class _PublishTable(_PublishModel):
    columns: list[_PublishColumn]
    rows: list[_PublishRow]


class _PublishField(_PublishModel):
    label: str
    value: JsonValue


class _PublishKeyValue(_PublishModel):
    fields: list[_PublishField]


class _PublishPoint(_PublishModel):
    label: str | int | float
    value: int | float


class _PublishChart(_PublishModel):
    form: Literal["bar", "line"]
    x_label: str
    y_label: str
    points: list[_PublishPoint]


class _PublishNode(_PublishModel):
    id: str | int | float


class _PublishLink(_PublishModel):
    from_: str | int | float = Field(alias="from")
    to: str | int | float


class _PublishTopology(_PublishModel):
    nodes: list[_PublishNode]
    links: list[_PublishLink]


class _PublishFinding(_PublishModel):
    device: str | int | float
    interface: str | int | float
    symptom: str
    severity: Literal["critical", "warning", "info"]
    cause_assessment: Literal["evidence_supported", "likely", "undetermined"]
    unknowns: list[str]
    remediation_considerations: list[str]


class _PublishFindings(_PublishModel):
    findings: list[_PublishFinding]


class _PublishText(_PublishModel):
    body: str


class _PublishAssessment(_PublishModel):
    narrative: str
    unknowns: list[str]
    remediation_considerations: list[str]


class CanvasPublication(_PublishModel):
    """Values-only authoring contract shared by the native tool and Python facade."""
    type: Literal["findings", "table", "key_value", "chart", "topology", "text", "assessment"]
    title: str
    metadata: _PublishFindings | _PublishTable | _PublishKeyValue | _PublishChart | _PublishTopology | _PublishText | _PublishAssessment


class CanvasContext:
    """A single workspace/run's bounded temporary captures and pinned evidence."""

    def __init__(self, request: dict, emit: Callable[[dict], None], sensitive_values: tuple[str, ...]):
        self._policy = ToolOutputPolicy(sensitive_values=sensitive_values)
        self.workspace_id = request["workspace_id"]
        self.run_id = request["run_id"]
        if not self._identities_safe():
            raise ValueError("Canvas needs safe workspace and run IDs")
        self._emit = emit
        self._lock = threading.RLock()
        self._seq = 0
        self._snapshots: dict[str, dict] = {}
        self._temporary: OrderedDict[str, int] = OrderedDict()
        self._sizes: dict[str, int] = {}
        self._card_pinned: set[str] = set()
        self._cards_delivered = 0

    def sources(self) -> list[dict]:
        """Bounded newest-first source IDs, shared by Python and native tools."""
        with self._lock:
            summary, size = [], 2
            for snapshot in reversed(list(self._snapshots.values())):
                item = {key: copy.deepcopy(snapshot[key]) for key in ("evidence_id", "source", "origin", "complete")}
                encoded_size = len(json.dumps(item, ensure_ascii=False).encode("utf-8")) + 2
                if size + encoded_size > DEFAULT_MAX_RETURN_CHARS:
                    break
                summary.append(item)
                size += encoded_size
            return summary

    def inspect(self, ref: dict) -> dict:
        """Inspect retained redacted evidence only, using the same card ref validator."""
        with self._lock:
            try:
                value = self._resolve(ref)
                encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
                result = {
                    "ref": copy.deepcopy(ref), "origin": self._snapshots[ref["evidence_id"]]["origin"],
                    "type": type(value).__name__, "count": len(value) if isinstance(value, (dict, list, str)) else None,
                    "preview": _utf8_prefix(encoded, DEFAULT_MAX_QUERY_CHARS),
                    "truncated": len(encoded) > DEFAULT_MAX_QUERY_CHARS,
                }
                if result["truncated"]:
                    result["limitation"] = "Preview truncated; inspect a narrower JSON Pointer with the same evidence_id."
                if len(json.dumps(result).encode("utf-8")) > DEFAULT_MAX_RETURN_CHARS:
                    raise ValueError("Canvas inspection exceeded the existing output bound")
                return result
            except (ValueError, TypeError, KeyError, RecursionError) as exc:
                return {"kind": "warning", "limitation": self._policy.redact(str(exc))}

    def finish_presentation(self) -> None:
        """Make a zero-card completion visible without changing the chat answer."""
        with self._lock:
            if not self._cards_delivered:
                self._event("warning", {"limitation": (
                    "Canvas presentation unavailable: no validated cards were delivered for this turn. "
                    "The chat answer is unchanged; source operations were not repeated."
                )})

    @property
    def snapshots(self) -> dict[str, dict]:
        """Read-only-by-copy inspection; callers cannot mutate retained evidence."""
        with self._lock:
            return copy.deepcopy(self._snapshots)

    def _identities_safe(self) -> bool:
        return all(isinstance(identity, str) and identity and self._policy.redact(identity) == identity
                   for identity in (self.workspace_id, self.run_id))

    def register_sensitive_config(self, config: dict) -> None:
        """Add actual helper credentials; invalidate old evidence, never rewrite deliveries.

        Newly unsafe identities disable further retention/delivery for this context.
        """
        with self._lock:
            values = []

            def collect(value: Any, sensitive: bool = False) -> None:
                if isinstance(value, dict):
                    for key, item in value.items():
                        collect(item, sensitive or isinstance(key, str) and _sensitive_key(key))
                elif isinstance(value, (list, tuple)):
                    for item in value:
                        collect(item, sensitive)
                elif sensitive and isinstance(value, str):
                    # Clients may strip configured tokens before authenticating.
                    values.extend((value, value.strip()))

            collect(config)
            policy = ToolOutputPolicy(sensitive_values=(*self._policy.sensitive_values, *values))
            if policy == self._policy:
                return
            self._policy = policy
            had_evidence = bool(self._snapshots) or self._seq > 0
            # Old immutable evidence cannot be re-delivered under a stronger policy.
            self._snapshots.clear()
            self._temporary.clear()
            self._sizes.clear()
            self._card_pinned.clear()
            if had_evidence:
                limitation = "New credentials registered; retained Canvas evidence discarded. Prior deliveries cannot be retroactively redacted."
                self._event("warning", {"limitation": self._policy.redact(limitation)})

    def _safe(self, value: Any) -> Any:
        if isinstance(value, dict):
            if any(not isinstance(key, str) for key in value):
                raise ValueError("capture requires string JSON keys")
            result = {}
            for key, item in value.items():
                safe_key = self._policy.redact(key)
                if safe_key in result:
                    raise ValueError("redaction collided with an existing JSON key")
                result[safe_key] = "[REDACTED]" if _sensitive_key(key) else self._safe(item)
            return result
        if isinstance(value, (tuple, list)):
            return [self._safe(item) for item in value]
        if isinstance(value, str):
            return self._policy.redact(value)
        if value is None or isinstance(value, (bool, int, float)):
            return value
        raise ValueError("capture requires JSON values")

    def _event(self, kind: str, payload: dict) -> bool:
        if not self._identities_safe():
            return False
        self._seq += 1
        try:
            self._emit({"type": "canvas", "version": 1, "workspace_id": self.workspace_id,
                        "run_id": self.run_id, "seq": self._seq, "kind": kind, "payload": payload})
            return True
        except Exception:  # Canvas notification cannot turn a successful helper into a failure.
            return False

    def capture(self, source: dict, value: Any, *, call_id: str, origin: str = "observed",
                parent_refs: list[dict] | None = None, calculation: str | None = None) -> str | None:
        with self._lock:
            if not self._identities_safe():
                return None
            evidence_id = str(uuid4())
            safe_call_id = call_id if isinstance(call_id, str) and self._policy.redact(call_id) == call_id else ""
            safe_calculation = self._policy.redact(calculation) if isinstance(calculation, str) else None
            oversized_provenance = (len(safe_call_id) > DEFAULT_MAX_RETURN_CHARS or
                                    len(safe_calculation or "") > DEFAULT_MAX_RETURN_CHARS)
            if oversized_provenance:
                safe_call_id, safe_calculation = "", None
            safe_parents: list[dict] = []
            try:
                if oversized_provenance:
                    raise ValueError("Canvas provenance exceeded the existing output bound")
                if origin not in {"observed", "derived", "execution_output", "agent_authored"}:
                    raise ValueError("invalid origin")
                if origin == "derived":
                    if not isinstance(parent_refs, list) or not parent_refs or not safe_calculation or not safe_calculation.strip():
                        raise ValueError("derived data requires parents and calculation")
                    safe_parents = self._safe(parent_refs)
                    for ref in safe_parents:
                        self._resolve(ref)
                elif parent_refs or calculation:
                    raise ValueError("only derived data may specify parents/calculation")
                if not isinstance(call_id, str) or not call_id or not safe_call_id:
                    raise ValueError("Canvas requires an unredacted nonempty call ID")
                if (not isinstance(source, dict) or not isinstance(source.get("helper"), str) or not source["helper"] or
                        ("resource" in source and not isinstance(source["resource"], str))):
                    raise ValueError("capture needs a helper and string resource when provided")
                # Only allow known source fields; never archive credentials or raw headers.
                safe_source = self._safe({key: source[key] for key in ("helper", "resource", "arguments") if key in source})
                data = self._safe(value)
                encoded = json.dumps({"source": safe_source, "data": data, "parent_refs": safe_parents,
                                      "calculation": safe_calculation}, ensure_ascii=False, allow_nan=False).encode("utf-8")
                if len(encoded) > DEFAULT_MAX_RETAINED_BYTES:
                    raise ValueError("capture exceeded the 2 MiB complete-result bound")
                complete, limitation = True, None
            except (ValueError, TypeError, RecursionError) as exc:
                helper = source.get("helper") if isinstance(source, dict) else None
                safe_source, data = {"helper": self._policy.redact(helper)[:DEFAULT_MAX_RETURN_CHARS] if isinstance(helper, str) else "unknown"}, None
                safe_parents = []
                complete, limitation = False, self._policy.redact(str(exc))
                encoded = b""
            snapshot = {"evidence_id": evidence_id, "workspace_id": self.workspace_id,
                        "run_id": self.run_id, "call_id": safe_call_id, "collected_at": _now(),
                        "source": safe_source, "origin": origin if isinstance(origin, str) and origin in {"observed", "derived", "execution_output", "agent_authored"} else "execution_output",
                        "complete": complete, "limitation": limitation, "data": data,
                        "parent_refs": safe_parents, "calculation": safe_calculation}
            if complete:
                encoded = json.dumps(snapshot, ensure_ascii=False, allow_nan=False).encode("utf-8")
                if len(encoded) > DEFAULT_MAX_RETAINED_BYTES:
                    snapshot.update(complete=False, limitation="capture exceeded the 2 MiB complete-result bound",
                                    data=None, parent_refs=[], calculation=None)
                    complete, limitation = False, snapshot["limitation"]
            if not complete:
                self._event("warning", {"limitation": limitation, "snapshot": snapshot})
                return None
            self._snapshots[evidence_id] = snapshot
            self._sizes[evidence_id] = len(encoded)
            self._temporary[evidence_id] = len(encoded)
            if safe_parents:
                for parent_id in self._ancestors({ref["evidence_id"] for ref in safe_parents}):
                    self._temporary.pop(parent_id, None)
            # ponytail: linear cache accounting; track a total if turns collect many tiny results.
            while sum(self._temporary.values()) > DEFAULT_MAX_RETAINED_BYTES:
                oldest, _ = self._temporary.popitem(last=False)
                del self._snapshots[oldest]
                del self._sizes[oldest]
                self._release_orphans()
            return evidence_id

    def _release_orphans(self) -> None:
        referenced = self._card_pinned | {
            ref["evidence_id"] for snapshot in self._snapshots.values()
            for ref in snapshot["parent_refs"]
        }
        for evidence_id in self._snapshots:
            if evidence_id not in referenced and evidence_id not in self._temporary:
                self._temporary[evidence_id] = self._sizes[evidence_id]
                self._temporary.move_to_end(evidence_id, last=False)

    def _ancestors(self, evidence_ids: set[str]) -> set[str]:
        pending = list(evidence_ids)
        while pending:
            evidence_id = pending.pop()
            if evidence_id in evidence_ids and evidence_id not in self._snapshots:
                raise ValueError("missing derived parent")
            for ref in self._snapshots[evidence_id]["parent_refs"]:
                if ref["evidence_id"] not in evidence_ids:
                    evidence_ids.add(ref["evidence_id"])
                    pending.append(ref["evidence_id"])
        return evidence_ids

    def _resolve(self, ref: dict) -> Any:
        if not isinstance(ref, dict) or set(ref) != _REF_KEYS:
            raise ValueError("invalid evidence reference")
        snapshot = self._snapshots.get(ref["evidence_id"])
        if not snapshot or snapshot["workspace_id"] != self.workspace_id or snapshot["run_id"] != self.run_id or not snapshot["complete"]:
            raise ValueError("missing, foreign or incomplete evidence")
        path = ref["path"]
        if not isinstance(path, str) or (path and not path.startswith("/")):
            raise ValueError("invalid JSON Pointer")
        data = snapshot["data"]
        for part in path.split("/")[1:] if path else ():
            if re.search(r"~(?![01])", part):
                raise ValueError("invalid JSON Pointer escape")
            key = part.replace("~1", "/").replace("~0", "~")
            if key in {"__proto__", "prototype", "constructor"}:
                raise ValueError("unsafe JSON property")
            if isinstance(data, dict) and key in data:
                data = data[key]
            elif isinstance(data, list) and re.fullmatch(r"0|[1-9][0-9]*", key) and int(key) < len(data):
                data = data[int(key)]
            else:
                raise ValueError("missing evidence path")
        return data

    @staticmethod
    def _check_topology_ids(nodes: list, links: list[tuple]) -> None:
        def key(value):
            return ("string" if isinstance(value, str) else "number", value)
        ids = {key(value) for value in nodes}
        if len(ids) != len(nodes):
            raise ValueError("topology requires unique typed node IDs")
        if any(key(start) not in ids or key(end) not in ids for start, end in links):
            raise ValueError("topology links require declared node endpoints")

    def publish(self, spec: dict) -> dict:
        """Publish display values, explicitly agent-authored rather than observed proof."""
        with self._lock:
            try:
                publication = CanvasPublication.model_validate(spec)
                expected = {"table": _PublishTable, "key_value": _PublishKeyValue,
                            "chart": _PublishChart, "topology": _PublishTopology,
                            "findings": _PublishFindings, "text": _PublishText,
                            "assessment": _PublishAssessment}
                if not publication.title.strip() or not isinstance(publication.metadata, expected[publication.type]):
                    raise ValueError("metadata must match the selected card type")
                safe = self._safe(publication.model_dump(by_alias=True))
                if len(json.dumps(safe, ensure_ascii=False, allow_nan=False).encode("utf-8")) > DEFAULT_MAX_RETAINED_BYTES:
                    raise ValueError("publication exceeded the existing complete-result bound")
                kind, data = safe["type"], safe["metadata"]
                if kind == "topology":
                    self._check_topology_ids([node["id"] for node in data["nodes"]],
                                             [(link["from"], link["to"]) for link in data["links"]])
                metadata = copy.deepcopy(data)
                refs = []
                def ref(path):
                    value = {"evidence_id": "", "path": path}
                    refs.append(value)
                    return value
                if kind == "table":
                    for index, row in enumerate(metadata["rows"]):
                        row["cells"] = {key: ref(f"/rows/{index}/cells/" + key.replace("~", "~0").replace("/", "~1"))
                                        for key in row["cells"]}
                elif kind == "key_value":
                    for index, field in enumerate(metadata["fields"]):
                        del field["value"]
                        field["ref"] = ref(f"/fields/{index}/value")
                elif kind == "chart":
                    for index, point in enumerate(metadata["points"]):
                        point.update(label=ref(f"/points/{index}/label"), value=ref(f"/points/{index}/value"))
                elif kind == "topology":
                    for index, node in enumerate(metadata["nodes"]):
                        node["id"] = ref(f"/nodes/{index}/id")
                    for index, link in enumerate(metadata["links"]):
                        link.update({"from": ref(f"/links/{index}/from"), "to": ref(f"/links/{index}/to"),
                                     "relationship": ref(f"/links/{index}")})
                elif kind == "findings":
                    for index, finding in enumerate(metadata["findings"]):
                        finding.update(device=ref(f"/findings/{index}/device"), interface=ref(f"/findings/{index}/interface"),
                                       supporting_refs=[], contradictory_refs=[])
                elif kind == "assessment":
                    metadata.update(supporting_refs=[], contradictory_refs=[])
                else:
                    metadata["body"] = ref("/body")
                identity = self.capture({"helper": "canvas_publish"}, data, call_id=str(uuid4()), origin="agent_authored")
                if identity is None:
                    return {"kind": "warning", "limitation": "Canvas publication data exceeded the existing retention contract."}
                for value in refs:
                    value["evidence_id"] = identity
                return self.present({"type": kind, "title": safe["title"],
                                     "source_refs": [{"evidence_id": identity, "path": ""}], "metadata": metadata})
            except (ValidationError, ValueError, TypeError, KeyError, RecursionError):
                limitation = ("Canvas publication rejected. Use the declared display-ready metadata for this card type; "
                              "finite JSON only, within the existing 2 MiB bound. "
                              "Correct presentation only; never repeat source operations.")
                self._event("warning", {"limitation": limitation})
                return {"kind": "warning", "limitation": limitation}

    def derive(self, parent_refs: list[dict], value: Any, calculation: str) -> str | None:
        return self.capture({"helper": "calculation"}, value, call_id=str(uuid4()),
                            origin="derived", parent_refs=parent_refs, calculation=calculation)

    def present(self, spec: dict) -> dict:
        with self._lock:
            try:
                if not isinstance(spec, dict) or set(spec) != {"type", "title", "source_refs", "metadata"}:
                    raise ValueError("invalid card shape")
                spec = self._safe(spec)
                kind, title, refs, meta = (spec[key] for key in ("type", "title", "source_refs", "metadata"))
                if kind not in _CARD_TYPES or not isinstance(title, str) or not title.strip() or not isinstance(refs, list) or not refs or not isinstance(meta, dict):
                    raise ValueError("invalid card type/title/source")
                for ref in refs:
                    self._resolve(ref)
                self._validate_metadata(kind, meta)
                # Card events carry all referenced snapshots, including metadata refs.
                referenced: set[str] = {ref["evidence_id"] for ref in refs}
                self._collect_refs(meta, referenced)
                referenced = self._ancestors(referenced)
                snapshots = [self._snapshots[evidence_id] for evidence_id in sorted(referenced)]
                card = {**spec, "card_id": str(uuid4()), "workspace_id": self.workspace_id,
                        "run_id": self.run_id, "created_at": _now()}
                if len(json.dumps({"card": card, "snapshots": snapshots}, ensure_ascii=False).encode("utf-8")) > DEFAULT_MAX_RETAINED_BYTES:
                    raise ValueError("card event exceeded the 2 MiB bound")
                if not self._event("card", {"card": json.loads(json.dumps(card)),
                                            "snapshots": json.loads(json.dumps(snapshots))}):
                    return {"kind": "warning", "limitation": "Canvas card delivery failed"}
                self._cards_delivered += 1
                self._card_pinned.update(referenced)
                for evidence_id in referenced:
                    self._temporary.pop(evidence_id, None)
                return card
            except (ValueError, TypeError, KeyError, RecursionError) as exc:
                limitation = self._policy.redact(str(exc))
                self._event("warning", {"limitation": limitation})
                return {"kind": "warning", "limitation": limitation}

    def _collect_refs(self, value: Any, ids: set[str]) -> None:
        if isinstance(value, dict):
            if set(value) == _REF_KEYS:
                self._resolve(value)
                ids.add(value["evidence_id"])
            else:
                for item in value.values():
                    self._collect_refs(item, ids)
        elif isinstance(value, list):
            for item in value:
                self._collect_refs(item, ids)

    def _validate_metadata(self, kind: str, meta: dict) -> None:
        def shape(obj: Any, keys: set[str], *, column_keys: bool = False) -> None:
            if not isinstance(obj, dict) or set(obj) != keys:
                expected = "the declared table column keys" if column_keys else "keys " + json.dumps(sorted(keys))
                raise ValueError(f"invalid card metadata for {kind}: expected exactly {expected}")

        def ref(value: Any) -> None:
            self._resolve(value)

        def refs(values: Any) -> None:
            if not isinstance(values, list):
                raise ValueError("invalid reference list")
            for value in values:
                ref(value)

        def text(value: Any) -> None:
            if not isinstance(value, str):
                raise ValueError("invalid card text")

        def identifier(value: Any, field: str) -> None:
            if not isinstance(value, (str, int, float)) or isinstance(value, bool):
                limitation = f"identifier requires an observed scalar (string or number) for {kind}.{field}; inspect a narrower retained reference with canvas_sources(evidence_id=..., path=...)."
                if kind == "findings" and field == "interface":
                    limitation += " If no interface was assessed, use an assessment card with supporting_refs and unknowns; never invent an interface identifier."
                raise ValueError(limitation)

        def texts(values: Any) -> None:
            if not isinstance(values, list):
                raise ValueError("invalid text list")
            for item in values:
                text(item)

        if kind == "text":
            shape(meta, {"body"}); ref(meta["body"])
        elif kind == "key_value":
            shape(meta, {"fields"})
            if not meta["fields"]:
                raise ValueError("empty field projection")
            for field in meta["fields"]:
                shape(field, {"label", "ref"}); text(field["label"]); ref(field["ref"])
        elif kind == "table":
            shape(meta, {"columns", "rows"})
            if not meta["columns"] or not meta["rows"]:
                raise ValueError("empty table projection")
            columns = set()
            for col in meta["columns"]:
                shape(col, {"key", "label"}); text(col["key"]); text(col["label"])
                if col["key"] in columns:
                    raise ValueError("duplicate column")
                columns.add(col["key"])
            for row in meta["rows"]:
                shape(row, {"cells"}); shape(row["cells"], columns, column_keys=True)
                for cell in row["cells"].values():
                    ref(cell)
        elif kind == "chart":
            shape(meta, {"form", "x_label", "y_label", "points"})
            if meta["form"] not in {"bar", "line"}:
                raise ValueError("invalid chart form")
            if not meta["points"]:
                raise ValueError("empty chart projection")
            text(meta["x_label"]); text(meta["y_label"])
            for point in meta["points"]:
                shape(point, {"label", "value"}); identifier(self._resolve(point["label"]), "points.label"); ref(point["value"])
                if not isinstance(self._resolve(point["value"]), (int, float)) or isinstance(self._resolve(point["value"]), bool):
                    raise ValueError("chart requires observed numeric values")
        elif kind == "topology":
            shape(meta, {"nodes", "links"})
            if not meta["nodes"]:
                raise ValueError("empty topology projection")
            node_values, link_values = [], []
            for node in meta["nodes"]:
                shape(node, {"id"}); identifier(self._resolve(node["id"]), "nodes.id")
                node_values.append(self._resolve(node["id"]))
            for link in meta["links"]:
                shape(link, {"from", "to", "relationship"})
                start, end = self._resolve(link["from"]), self._resolve(link["to"])
                identifier(start, "links.from"); identifier(end, "links.to")
                relation = self._resolve(link["relationship"])
                if (self._snapshots[link["relationship"]["evidence_id"]]["origin"] not in {"observed", "agent_authored"} or
                        not isinstance(relation, dict) or set(relation) != {"from", "to"}):
                    raise ValueError("topology link needs matching observed relationship evidence")
                identifier(relation["from"], "links.relationship.from"); identifier(relation["to"], "links.relationship.to")
                if relation["from"] != start or relation["to"] != end:
                    raise ValueError("topology link needs matching observed relationship evidence")
                link_values.append((start, end))
            self._check_topology_ids(node_values, link_values)
        elif kind == "findings":
            shape(meta, {"findings"})
            if not meta["findings"]:
                raise ValueError("empty findings projection")
            for finding in meta["findings"]:
                shape(finding, {"device", "interface", "symptom", "severity", "cause_assessment", "supporting_refs", "contradictory_refs", "unknowns", "remediation_considerations"})
                identifier(self._resolve(finding["device"]), "device"); identifier(self._resolve(finding["interface"]), "interface"); text(finding["symptom"])
                if finding["severity"] not in {"critical", "warning", "info"} or finding["cause_assessment"] not in {"evidence_supported", "likely", "undetermined"}:
                    raise ValueError("invalid assessment")
                refs(finding["supporting_refs"]); refs(finding["contradictory_refs"])
                for name in ("unknowns", "remediation_considerations"):
                    texts(finding[name])
        else:
            shape(meta, {"narrative", "supporting_refs", "contradictory_refs", "unknowns", "remediation_considerations"})
            text(meta["narrative"]); refs(meta["supporting_refs"]); refs(meta["contradictory_refs"])
            for name in ("unknowns", "remediation_considerations"):
                texts(meta[name])
