"""Bounded, on-demand tool-catalog discovery for code-capable agents.

Catalogs stay in Python memory.  The LLM receives only a short instruction and
asks the pre-bound ``api_catalog`` object for a handful of relevant records.
REST dispatch helpers are guarded so an undocumented or undiscovered path never
reaches the network, and HTTP failures cannot masquerade as successful code.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache, wraps
import hashlib
import inspect
import json
from pathlib import Path
import re
import sys
from typing import Any, Iterable, Mapping, Sequence


DEFAULT_SEARCH_LIMIT = 5
MAX_SEARCH_LIMIT = 5
MAX_CONSECUTIVE_DISCOVERY_CALLS = 4
MAX_SUMMARY_CHARS = 420
MAX_PROMPT_HINT_CHARS = 1_800


class CatalogGroundingError(RuntimeError):
    """A call was not grounded in a documented catalog record."""


class CatalogApiError(RuntimeError):
    """A catalog-grounded API call reached the helper but failed."""


@dataclass(frozen=True)
class CatalogRecord:
    catalog_id: str
    name: str
    summary: str
    method: str | None = None
    path: str | None = None
    operation: str | None = None
    parameters: Mapping[str, Any] | None = None
    allowed: bool = True
    # Extra catalog-native identifiers used only for ranking. These remain
    # private so SDK names improve discovery without expanding model context.
    search_terms: tuple[str, ...] = ()

    @property
    def key(self) -> tuple[str, str, str, str, str]:
        return (
            self.catalog_id,
            self.method or "*",
            self.path or "",
            self.operation or "",
            self.name,
        )

    def public(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "catalog_id": self.catalog_id,
            "summary": _clip(self.summary, MAX_SUMMARY_CHARS),
            "allowed": self.allowed,
        }
        if self.path:
            result["helper"] = f"{self.catalog_id}_api_call"
            result["path"] = self.path
        else:
            result["name"] = self.name
        if self.method:
            result["method"] = self.method
        if self.operation:
            result["operation"] = self.operation
        if self.parameters:
            result["parameters"] = dict(self.parameters)
        return result


def _clip(value: Any, limit: int) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _coerce_entries(raw: Any) -> list[dict[str, Any]]:
    """Accept an inlined list, JSON text, or a catalog file path."""
    value = raw
    if isinstance(value, str):
        stripped = value.strip()
        candidate = Path(stripped).expanduser()
        if stripped and not stripped.startswith(("[", "{")) and candidate.is_file():
            value = candidate.read_text(encoding="utf-8")
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                return []
    if isinstance(value, dict):
        value = value.get("tools") or value.get("entries") or [value]
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def normalize_catalogs(catalogs: Any) -> list[dict[str, Any]]:
    """Normalize caller/catalog-loader payloads to ``{id, entries}`` objects."""
    if not isinstance(catalogs, list):
        return []
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in catalogs:
        if not isinstance(raw, dict):
            continue
        catalog_id = str(raw.get("id") or raw.get("catalog_id") or "").strip()
        entries = _coerce_entries(raw.get("entries", raw.get("catalog")))
        if not catalog_id or not entries or catalog_id in seen:
            continue
        seen.add(catalog_id)
        normalized.append({"id": catalog_id, "entries": entries})
    return normalized


_PATH_RE = re.compile(
    r"(?<![:A-Za-z0-9])/(?!/)[A-Za-z0-9._~{}<>:*|+%=\-\[\]]+"
    r"(?:/[A-Za-z0-9._~{}<>:*|+%=\-\[\]]+)*"
    r"(?:\?[A-Za-z0-9._~{}<>:*|+%=&\-\[\]]+)?"
)
_METHOD_RE = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE)\b", re.IGNORECASE)
_PLACEHOLDER_RE = re.compile(r"(\{[^{}]+\}|<[^<>]+>)")


def _clean_path(path: str, catalog_id: str) -> str:
    clean = path.strip().rstrip(".,;:")
    clean = clean.split("?", 1)[0]
    if clean.endswith("["):
        clean = clean[:-1]
    # The generated Meraki catalog pluralized already-plural resources once
    # more (networkss, policiess, wirelesss).  Remove that generated final s.
    if catalog_id == "meraki":
        clean = "/".join(
            segment[:-1] if segment.endswith("ss") else segment
            for segment in clean.split("/")
        )
    if catalog_id == "catalyst_center" and not clean.startswith("/dna/"):
        if clean.startswith(
            (
                "/network-device",
                "/site",
                "/topology",
                "/network-health",
                "/client-health",
                "/template-programmer",
                "/task/",
            )
        ):
            clean = "/dna/intent/api/v1" + clean
    return clean


def _summary_around(text: str, start: int, end: int) -> str:
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", end)
    if line_end < 0:
        line_end = len(text)
    line = text[line_start:line_end].strip()
    if len(line) >= 24:
        return _clip(line, MAX_SUMMARY_CHARS)
    return _clip(text[max(0, start - 180) : min(len(text), end + 220)], MAX_SUMMARY_CHARS)


def _method_before(text: str, start: int, method_enum: Sequence[str]) -> str | None:
    paragraph_start = max(text.rfind("\n\n", 0, start), text.rfind(". ", 0, start))
    prefix = text[paragraph_start + 1 : start]
    methods = _METHOD_RE.findall(prefix)
    if methods:
        return methods[-1].upper()
    normalized = [str(item).upper() for item in method_enum]
    return normalized[0] if len(normalized) == 1 else None


def _is_forbidden_context(text: str, start: int) -> bool:
    context = text[max(0, start - 120) : start].lower()
    for marker in (
        "do not call",
        "don't call",
        "there is no",
        "there are no",
        "must not call",
        "never call",
    ):
        marker_at = context.rfind(marker)
        if marker_at < 0:
            continue
        tail = context[marker_at + len(marker) :]
        # A prohibition may name a comma-separated list of paths, but it never
        # crosses a sentence/line. This prevents "do not call /auth. GET /real"
        # from accidentally marking the later documented endpoint forbidden.
        if ". " not in tail and "\n" not in tail:
            return True
    return False


def _parameter_summary(schema: Any) -> dict[str, Any]:
    if not isinstance(schema, dict):
        return {}
    props = schema.get("properties") or schema.get("args") or {}
    fields: dict[str, Any] = {}
    if isinstance(props, dict):
        for idx, (name, raw) in enumerate(props.items()):
            if idx >= 20:
                fields["…"] = "additional fields omitted"
                break
            spec = raw if isinstance(raw, dict) else {}
            compact: dict[str, Any] = {}
            if spec.get("type"):
                compact["type"] = spec["type"]
            if isinstance(spec.get("enum"), list):
                compact["enum"] = spec["enum"][:20]
            fields[str(name)] = compact or "value"
    result: dict[str, Any] = {"fields": fields} if fields else {}
    required = schema.get("required")
    if isinstance(required, list) and required:
        result["required"] = required[:20]
    return result


def _expand_simple_alternatives(path: str) -> list[str]:
    if "|" not in path:
        return [path]
    prefix, _, tail = path.rpartition("/")
    if "|" not in tail:
        return [path]
    return [f"{prefix}/{choice}" for choice in tail.split("|") if choice]


_FMC_SUPPLEMENTS: tuple[tuple[str | None, str, str], ...] = (
    ("GET", "/api/fmc_platform/v1/info/serverversion", "FMC server version"),
    ("GET", "/api/fmc_platform/v1/info/domain", "FMC domains"),
    (None, "/api/fmc_config/v1/domain/{domainUUID}/devices/devicerecords", "Managed FTD devices"),
    (None, "/api/fmc_config/v1/domain/{domainUUID}/policy/accesspolicies", "Access control policies"),
    (None, "/api/fmc_config/v1/domain/{domainUUID}/policy/accesspolicies/{id}/accessrules", "Access control policy rules"),
    (None, "/api/fmc_config/v1/domain/{domainUUID}/object/networks", "Network objects"),
    (None, "/api/fmc_config/v1/domain/{domainUUID}/object/hosts", "Host objects"),
    (None, "/api/fmc_config/v1/domain/{domainUUID}/object/ports", "Port objects"),
)


@lru_cache(maxsize=1)
def _meraki_dashboard_for_catalog() -> Any:
    """Build the installed official SDK client without making a network call."""
    try:
        import meraki

        auth_arg = {"api" + "_key": "placeholder"}
        return meraki.DashboardAPI(
            **auth_arg,
            suppress_logging=True,
            print_console=False,
        )
    except Exception:
        return None


@lru_cache(maxsize=2_048)
def _meraki_official_path(resource: str, sdk_method: str) -> str | None:
    """Read the real generated SDK resource template for a catalog operation.

    The legacy 933-entry catalog guessed paths from English action names and
    produced values such as ``/inventorys``. The installed Cisco SDK already
    carries the authoritative path in each generated method, so use it when
    available and retain the catalog value only as a cross-platform fallback.
    """
    if not resource or not sdk_method:
        return None
    try:
        client = _meraki_dashboard_for_catalog()
        if client is None:
            return None
        method = getattr(getattr(client, resource), sdk_method)
        source = inspect.getsource(method)
        match = re.search(r"\bresource\s*=\s*f?([\"'])(.*?)\1", source, re.DOTALL)
        return match.group(2) if match else None
    except Exception:
        return None


def _records_for_catalog(catalog_id: str, entries: list[dict[str, Any]]) -> list[CatalogRecord]:
    records: list[CatalogRecord] = []
    for item in entries:
        name = str(item.get("name") or "catalog-entry")
        description = str(item.get("description") or "")
        search_terms = tuple(
            value
            for key in (
                "sdk_method",
                "operation_id",
                "operationId",
            )
            if (value := str(item.get(key) or "").strip())
        )
        endpoint = item.get("endpoint")
        if isinstance(endpoint, dict) and endpoint.get("path"):
            path_value = str(endpoint["path"])
            official_meraki_path: str | None = None
            if catalog_id == "meraki":
                official_meraki_path = _meraki_official_path(
                    str(item.get("resource") or ""),
                    str(item.get("sdk_method") or ""),
                )
                path_value = official_meraki_path or path_value
            raw_path = _clean_path(
                path_value,
                "" if official_meraki_path else catalog_id,
            )
            for path in _expand_simple_alternatives(raw_path):
                records.append(
                    CatalogRecord(
                        catalog_id=catalog_id,
                        name=name,
                        summary=description,
                        method=str(endpoint.get("method") or "").upper() or None,
                        path=path,
                        parameters=_parameter_summary(
                            {"properties": item.get("args"), "required": item.get("required")}
                        ),
                        search_terms=search_terms,
                    )
                )
            continue

        function = item.get("function") if isinstance(item.get("function"), dict) else {}
        function_name = str(function.get("name") or name)
        function_description = str(function.get("description") or "")
        parameters = function.get("parameters") if isinstance(function, dict) else None
        combined = "\n".join(part for part in (description, function_description) if part)
        parameter_info = _parameter_summary(parameters or {"properties": item.get("args"), "required": item.get("required")})
        op_enum: list[str] = []
        if isinstance(parameters, dict):
            op_spec = (parameters.get("properties") or {}).get("op") or {}
            if isinstance(op_spec, dict) and isinstance(op_spec.get("enum"), list):
                op_enum = [str(value) for value in op_spec["enum"]]
        if not function and name:
            op_enum = [name]
        if op_enum:
            function_records = [
                CatalogRecord(
                    catalog_id=catalog_id,
                    name=f"{function_name}:{operation}",
                    summary=f"Operation {operation}. {combined or description or name}",
                    operation=operation,
                    parameters=parameter_info,
                    search_terms=search_terms,
                )
                for operation in op_enum
            ]
        else:
            derived_operation = None
            prefix = f"{catalog_id}_"
            if function_name.startswith(prefix):
                derived_operation = function_name[len(prefix) :]
            function_records = [
                CatalogRecord(
                    catalog_id=catalog_id,
                    name=function_name,
                    summary=combined or description or name,
                    operation=derived_operation,
                    parameters=parameter_info,
                    search_terms=search_terms,
                )
            ]
        records.extend(function_records)
        endpoint_records_added = 0

        method_enum: list[str] = []
        if isinstance(parameters, dict):
            method_spec = (parameters.get("properties") or {}).get("method") or {}
            if isinstance(method_spec, dict) and isinstance(method_spec.get("enum"), list):
                method_enum = [str(value) for value in method_spec["enum"]]
        for match in _PATH_RE.finditer(combined):
            raw_path = match.group(0)
            # Surface-family notation documents routing, not a callable endpoint.
            # Keep it in the function summary but never authorize a wildcard call.
            if "..." in raw_path or "*" in raw_path:
                continue
            # Fragments such as "/{id}" from prose like "+/{id}/rules" are not
            # standalone endpoints and would authorize an unsafe broad match.
            if _PLACEHOLDER_RE.fullmatch(raw_path):
                continue
            path = _clean_path(raw_path, catalog_id)
            method = _method_before(combined, match.start(), method_enum)
            allowed = not _is_forbidden_context(combined, match.start())
            summary = _summary_around(combined, match.start(), match.end())
            for variant in _expand_simple_alternatives(path):
                records.append(
                    CatalogRecord(
                        catalog_id=catalog_id,
                        name=f"{function_name}:{variant}",
                        summary=summary,
                        method=method,
                        path=variant,
                        parameters=parameter_info,
                        allowed=allowed,
                        search_terms=search_terms,
                    )
                )
                endpoint_records_added += 1
        if endpoint_records_added:
            for function_record in function_records:
                records.remove(function_record)

    if catalog_id == "fmc":
        for method, path, summary in _FMC_SUPPLEMENTS:
            records.append(
                CatalogRecord(
                    catalog_id=catalog_id,
                    name=f"fmc_api_call:{path}",
                    summary=summary,
                    method=method,
                    path=path,
                )
            )

    # Stable de-duplication. Prefer an allowed record and the longer context.
    dedup: dict[tuple[str, str, str], CatalogRecord] = {}
    for record in records:
        key = (
            record.method or "*",
            record.path or "",
            record.operation or "",
            record.name,
        )
        current = dedup.get(key)
        if current is None or (record.allowed and not current.allowed) or len(record.summary) > len(current.summary):
            dedup[key] = record
    return list(dedup.values())


_QUERY_ALIASES: dict[str, tuple[str, ...]] = {
    "health": ("version", "status", "system", "activecount", "uptime"),
    "healthy": ("health", "version", "status"),
    "server": ("version", "system", "info"),
    "sessions": ("session", "active", "authentication"),
    "session": ("active", "authentication"),
    "inventory": ("devices", "computers", "nodes", "endpoints"),
    "device": ("devices", "networkdevice", "node"),
    "devices": ("device", "networkdevice", "nodes"),
    "errors": ("failures", "failure", "alerts"),
}


def _search_tokens(query: str) -> tuple[list[str], list[str]]:
    raw_tokens = [
        token.lower()
        for token in re.findall(r"[A-Za-z0-9_.-]+", query)
        if len(token) > 1
    ]
    camel_split = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", query)
    component_tokens = [
        token.lower()
        for token in re.findall(r"[A-Za-z0-9_.-]+", camel_split)
        if len(token) > 1
    ]
    primary = list(dict.fromkeys((*raw_tokens, *component_tokens)))
    expanded: list[str] = []
    for token in primary:
        expanded.extend(_QUERY_ALIASES.get(token, ()))
    return primary, list(dict.fromkeys(expanded))


def _score_record(record: CatalogRecord, query: str, primary: list[str], expanded: list[str]) -> int:
    path = (record.path or "").lower()
    operation = (record.operation or "").lower()
    name = record.name.lower()
    summary = record.summary.lower()
    search_terms = tuple(term.lower() for term in record.search_terms)
    aliases = " ".join(search_terms)
    haystack = f"{record.catalog_id} {name} {path} {operation} {aliases} {summary}"
    score = 0
    phrase = query.strip().lower()
    if phrase and phrase in haystack:
        score += 40
    if phrase in search_terms:
        score += 500
    for token in primary:
        if token in search_terms:
            score += 200
        elif any(token in term for term in search_terms):
            score += 16
        if token == record.catalog_id.lower():
            score += 2
        if token in path:
            score += 12
        if token in operation:
            score += 12
        if token in name:
            score += 8
        if token in summary:
            score += 4
    for token in expanded:
        if token in path:
            score += 5
        if token in operation:
            score += 5
        if token in name:
            score += 3
        if token in summary:
            score += 2
    if record.path:
        score += 1
    return score


def _template_regex(template: str) -> re.Pattern[str]:
    parts = _PLACEHOLDER_RE.split(template)
    regex_parts: list[str] = []
    for part in parts:
        if not part:
            continue
        if _PLACEHOLDER_RE.fullmatch(part):
            regex_parts.append(r"[^/?]+")
            continue
        escaped = re.escape(part)
        escaped = escaped.replace(re.escape("..."), ".*")
        escaped = escaped.replace(re.escape("*"), ".*")
        regex_parts.append(escaped)
    return re.compile("^" + "".join(regex_parts).rstrip("/") + "/?$")


def _path_matches(template: str, actual: str) -> bool:
    actual_path = str(actual or "").split("?", 1)[0].rstrip("/") or "/"
    return bool(_template_regex(template).fullmatch(actual_path))


class CatalogIndex:
    """Searchable catalog state retained for one agent turn/session."""

    def __init__(self, catalogs: Any):
        normalized = normalize_catalogs(catalogs)
        self._entries: dict[str, list[dict[str, Any]]] = {
            item["id"]: item["entries"] for item in normalized
        }
        self._records: list[CatalogRecord] = []
        for catalog_id, entries in self._entries.items():
            self._records.extend(_records_for_catalog(catalog_id, entries))
        self._authorized: set[tuple[str, str, str, str, str]] = set()
        self._failed_calls: set[str] = set()
        self._consecutive_discovery_calls = 0
        self._seen_searches: set[tuple[str, str]] = set()

    @property
    def catalog_ids(self) -> list[str]:
        return sorted(self._entries)

    def inventory(self) -> dict[str, Any]:
        return {
            "catalogs": [
                {
                    "id": catalog_id,
                    "entry_count": len(self._entries[catalog_id]),
                    "record_count": sum(
                        1 for record in self._records if record.catalog_id == catalog_id
                    ),
                }
                for catalog_id in self.catalog_ids
            ],
            "default_search_limit": DEFAULT_SEARCH_LIMIT,
            "max_search_limit": MAX_SEARCH_LIMIT,
        }

    def search(
        self,
        query: str,
        catalog_id: str | None = None,
        limit: int = DEFAULT_SEARCH_LIMIT,
    ) -> dict[str, Any]:
        """Return and authorize a bounded set of catalog records."""
        if catalog_id and catalog_id not in self._entries:
            raise CatalogGroundingError(
                f"Unknown catalog {catalog_id!r}. Available: {', '.join(self.catalog_ids)}"
            )
        normalized_query = " ".join(str(query or "").lower().split())
        search_key = (catalog_id or "*", normalized_query)
        if search_key in self._seen_searches:
            raise CatalogGroundingError(
                "The identical catalog search already returned results in this turn. "
                "STOP SEARCHING and use the prior exact match for a real helper call, "
                "or answer from live results already returned. Search again only for a "
                "genuinely different endpoint required by the user's request."
            )
        if self._consecutive_discovery_calls >= MAX_CONSECUTIVE_DISCOVERY_CALLS:
            raise CatalogGroundingError(
                "Catalog discovery budget exhausted after "
                f"{MAX_CONSECUTIVE_DISCOVERY_CALLS} consecutive lookups without a real "
                "helper call. STOP SEARCHING and call an exact allowed match already "
                "returned. If no returned match fits the request, report that the live "
                "state is unknown instead of enumerating the catalog."
            )
        self._seen_searches.add(search_key)
        self._consecutive_discovery_calls += 1
        try:
            bounded_limit = max(1, min(int(limit), MAX_SEARCH_LIMIT))
        except (TypeError, ValueError):
            bounded_limit = DEFAULT_SEARCH_LIMIT
        candidates = [
            record
            for record in self._records
            if catalog_id is None or record.catalog_id == catalog_id
        ]
        primary, expanded = _search_tokens(str(query or ""))
        ranked = sorted(
            candidates,
            key=lambda record: (
                -_score_record(record, str(query or ""), primary, expanded),
                0 if record.path else 1,
                record.catalog_id,
                record.method or "",
                record.path or "",
                record.operation or "",
                record.name,
            ),
        )
        matches = ranked[:bounded_limit]
        for record in matches:
            if record.allowed:
                self._authorized.add(record.key)
        return {
            "query": str(query or ""),
            "catalog_id": catalog_id,
            "matches": [record.public() for record in matches],
            "truncated": len(ranked) > len(matches),
            "remaining_discovery_calls_before_helper": (
                MAX_CONSECUTIVE_DISCOVERY_CALLS
                - self._consecutive_discovery_calls
            ),
            "instruction": (
                "api_catalog and vendor helpers are pre-bound globals; DO NOT import them. "
                "Search returns a dict; records are in result['matches']. If any match "
                "fits, STOP SEARCHING. For HTTP records call the exact returned helper "
                "with its method and concrete path; for object records call the exact "
                "operation. Never execute a catalog label as Python. Search again only "
                "when the current request requires a different endpoint; never repeat "
                "the same search, enumerate the whole catalog, or guess."
            ),
        }

    def describe(
        self,
        name_or_path: str,
        catalog_id: str | None = None,
    ) -> dict[str, Any]:
        """Exact lookup convenience; output is bounded like ``search``."""
        return self.search(name_or_path, catalog_id=catalog_id, limit=1)

    def help(self) -> str:
        return (
            "api_catalog and vendor helpers are pre-bound globals; DO NOT import or inspect "
            "them. api_catalog.inventory() takes no arguments and returns {'catalogs': [...]}; "
            "api_catalog.search(query, catalog_id=None, limit=5) returns a dict whose "
            "records are result['matches']; api_catalog.describe(name_or_path, "
            "catalog_id=None) has the same shape. Once a usable match is returned, STOP "
            "SEARCHING. For HTTP records call its exact helper with its method and concrete "
            "path; for object records call its exact operation."
        )

    def operations_for(self, catalog_id: str) -> list[str]:
        return sorted(
            {
                record.operation
                for record in self._records
                if record.catalog_id == catalog_id and record.operation
            }
        )

    def _matching_records(self, catalog_id: str, method: str, path: str) -> list[CatalogRecord]:
        method = method.upper()
        return [
            record
            for record in self._records
            if record.catalog_id == catalog_id
            and record.path
            and (record.method is None or record.method == method)
            and _path_matches(record.path, path)
        ]

    def require_authorized(self, catalog_id: str, method: str, path: str) -> None:
        matches = self._matching_records(catalog_id, method, path)
        if not matches:
            raise CatalogGroundingError(
                f"{method.upper()} {path} is not documented in the {catalog_id} catalog; "
                "network call blocked. Exit Python and call the TOP-LEVEL "
                f"search_api_catalog tool with catalog_id={catalog_id!r}, then choose an "
                "exact returned endpoint (legacy runtimes may call the pre-bound "
                "api_catalog.search directly without importing it)."
            )
        allowed_matches = [record for record in matches if record.allowed]
        if not allowed_matches:
            raise CatalogGroundingError(
                f"{method.upper()} {path} is explicitly forbidden by the {catalog_id} catalog; "
                "network call blocked."
            )
        if not any(record.key in self._authorized for record in allowed_matches):
            raise CatalogGroundingError(
                f"{method.upper()} {path} has not been discovered for this turn; network call "
                "blocked. Exit Python and first call the TOP-LEVEL search_api_catalog tool "
                f"with catalog_id={catalog_id!r}, then use an exact returned method/path "
                "(legacy: pre-bound api_catalog.search, never import it)."
            )
        self._consecutive_discovery_calls = 0

    def require_operation(self, catalog_id: str, operation: str) -> None:
        normalized = str(operation or "").strip()
        matches = [
            record
            for record in self._records
            if record.catalog_id == catalog_id
            and record.operation == normalized
        ]
        if not matches:
            raise CatalogGroundingError(
                f"Operation {normalized!r} is not documented in the {catalog_id} catalog; "
                "call blocked. Exit Python and call the TOP-LEVEL search_api_catalog tool "
                f"with catalog_id={catalog_id!r}, then choose an exact returned operation "
                "(legacy: pre-bound api_catalog.search, never import it)."
            )
        if not any(record.allowed and record.key in self._authorized for record in matches):
            raise CatalogGroundingError(
                f"Operation {normalized!r} has not been discovered for this turn; call "
                "blocked. Exit Python and first call the TOP-LEVEL search_api_catalog tool "
                f"with catalog_id={catalog_id!r}, then use an exact returned operation "
                "(legacy: pre-bound api_catalog.search, never import it)."
            )
        self._consecutive_discovery_calls = 0

    @staticmethod
    def _fingerprint(catalog_id: str, method: str, path: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> str:
        encoded = json.dumps(
            {
                "catalog_id": catalog_id,
                "method": method.upper(),
                "path": path,
                "args": args[2:],
                "kwargs": kwargs,
            },
            sort_keys=True,
            default=str,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def reject_duplicate_failure(
        self,
        catalog_id: str,
        method: str,
        path: str,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
    ) -> str:
        fingerprint = self._fingerprint(catalog_id, method, path, args, kwargs)
        if fingerprint in self._failed_calls:
            raise CatalogGroundingError(
                f"The identical {method.upper()} {path} call already failed in this turn; "
                f"duplicate network retry blocked. Search the {catalog_id} catalog and change "
                "the endpoint or arguments."
            )
        return fingerprint

    def mark_failed(self, fingerprint: str) -> None:
        self._failed_calls.add(fingerprint)


def _helper_names(catalog_id: str, entries: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for entry in entries:
        function = entry.get("function") if isinstance(entry.get("function"), dict) else {}
        name = function.get("name") or entry.get("name")
        if isinstance(name, str) and name.endswith("_api_call"):
            names.append(name)
    fallback = f"{catalog_id}_api_call"
    if catalog_id == "meraki":
        names.append("meraki_api_call")
    elif fallback not in names:
        names.append(fallback)
    return list(dict.fromkeys(names))


def _result_failure(result: Any) -> tuple[int | None, str | None]:
    payload = result
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return None, None
    if not isinstance(payload, dict):
        return None, None
    raw_status = payload.get("status_code")
    try:
        status = int(raw_status) if raw_status is not None else None
    except (TypeError, ValueError):
        status = None
    error = payload.get("error")
    if status is not None and status >= 400:
        return status, _clip(error or payload.get("data") or "request failed", 500)
    if status == 0 and error:
        return status, _clip(error, 500)
    return None, None


def _operation_result_error(result: Any) -> str | None:
    payload = result
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return None
    if not isinstance(payload, dict) or payload.get("ok") is not False:
        return None
    return _clip(payload.get("error") or "operation failed", 500)


_OBJECT_OPERATION_BINDINGS: dict[str, tuple[str, str]] = {
    "pyats": ("pyats", "dispatcher"),
    "gnmi": ("gnmi", "direct"),
    "iosxe_translate": ("iosxe", "direct"),
    "fwrule": ("fwrule", "direct"),
}


def _install_operation_guards(
    sandbox_globals: dict[str, Any],
    index: CatalogIndex,
    catalog_ids: Iterable[str],
) -> None:
    for catalog_id in catalog_ids:
        binding = _OBJECT_OPERATION_BINDINGS.get(catalog_id)
        if not binding:
            continue
        global_name, mode = binding
        helper = sandbox_globals.get(global_name)
        if helper is None:
            continue

        if mode == "dispatcher":
            original = getattr(helper, "call", None)
            if not callable(original) or getattr(original, "__catalog_guarded__", False):
                continue

            @wraps(original)
            def guarded_dispatch(operation: str, *args: Any, __original=original, __catalog_id=catalog_id, **kwargs: Any) -> Any:
                normalized = str(operation or "")
                index.require_operation(__catalog_id, normalized)
                fingerprint = index.reject_duplicate_failure(
                    __catalog_id,
                    "OP",
                    normalized,
                    (None, None, *args),
                    kwargs,
                )
                try:
                    result = __original(operation, *args, **kwargs)
                except Exception:
                    index.mark_failed(fingerprint)
                    raise
                error = _operation_result_error(result)
                if error:
                    index.mark_failed(fingerprint)
                    raise CatalogApiError(
                        f"{__catalog_id} operation {normalized!r} failed: {error}. "
                        "Do not retry it unchanged; search the catalog and correct the call."
                    )
                return result

            guarded_dispatch.__catalog_guarded__ = True  # type: ignore[attr-defined]
            try:
                setattr(helper, "call", guarded_dispatch)
            except Exception:
                pass
            continue

        for operation in index.operations_for(catalog_id):
            original = getattr(helper, operation, None)
            if not callable(original) or getattr(original, "__catalog_guarded__", False):
                continue

            @wraps(original)
            def guarded_operation(*args: Any, __original=original, __operation=operation, __catalog_id=catalog_id, **kwargs: Any) -> Any:
                index.require_operation(__catalog_id, __operation)
                fingerprint = index.reject_duplicate_failure(
                    __catalog_id,
                    "OP",
                    __operation,
                    (None, None, *args),
                    kwargs,
                )
                try:
                    result = __original(*args, **kwargs)
                except Exception:
                    index.mark_failed(fingerprint)
                    raise
                error = _operation_result_error(result)
                if error:
                    index.mark_failed(fingerprint)
                    raise CatalogApiError(
                        f"{__catalog_id} operation {__operation!r} failed: {error}. "
                        "Do not retry it unchanged; search the catalog and correct the call."
                    )
                return result

            guarded_operation.__catalog_guarded__ = True  # type: ignore[attr-defined]
            try:
                setattr(helper, operation, guarded_operation)
            except Exception:
                continue


def install_catalog_grounding(
    sandbox_globals: dict[str, Any],
    catalogs: Any,
    *,
    active_catalog_ids: Iterable[str] | None = None,
) -> CatalogIndex | None:
    """Inject ``api_catalog`` and guard each matching ``*_api_call`` helper."""
    normalized = normalize_catalogs(catalogs)
    # Zabbix is JSON-RPC: its helper signature is (rpc_method, params), not the
    # HTTP (method, path) signature this middleware guards. The Zabbix client
    # itself restricts namespaces and its mutation tool is independently HITL
    # gated, so treating params as a URL both blocks valid reads and causes
    # recursive agent retries.
    normalized = [item for item in normalized if item["id"] != "zabbix"]
    if active_catalog_ids is not None:
        allowed_ids = set(active_catalog_ids)
        normalized = [item for item in normalized if item["id"] in allowed_ids]
    if not normalized:
        return None

    index = CatalogIndex(normalized)
    sandbox_globals["api_catalog"] = index
    for catalog in normalized:
        catalog_id = catalog["id"]
        for helper_name in _helper_names(catalog_id, catalog["entries"]):
            original = sandbox_globals.get(helper_name)
            if not callable(original) or getattr(original, "__catalog_guarded__", False):
                continue

            @wraps(original)
            def guarded(*args: Any, __original=original, __catalog_id=catalog_id, **kwargs: Any) -> Any:
                method = str(args[0] if args else kwargs.get("method") or "GET").upper()
                path = str(args[1] if len(args) > 1 else kwargs.get("path") or "")
                if not path:
                    raise CatalogGroundingError(
                        f"{__catalog_id} API call has no path; exit Python and call the "
                        "TOP-LEVEL search_api_catalog tool first (legacy: pre-bound "
                        "api_catalog.search, never import it)."
                    )
                index.require_authorized(__catalog_id, method, path)
                fingerprint = index.reject_duplicate_failure(
                    __catalog_id, method, path, args, kwargs
                )
                try:
                    result = __original(*args, **kwargs)
                except Exception:
                    index.mark_failed(fingerprint)
                    raise
                status, error = _result_failure(result)
                if status is not None:
                    index.mark_failed(fingerprint)
                    label = f"HTTP {status}" if status else "transport/configuration failure"
                    raise CatalogApiError(
                        f"{__catalog_id} {method} {path} failed ({label}): {error}. "
                        "Do not retry the identical call; exit Python and use the TOP-LEVEL "
                        "search_api_catalog tool for the corrected documented endpoint."
                    )
                return result

            guarded.__catalog_guarded__ = True  # type: ignore[attr-defined]
            sandbox_globals[helper_name] = guarded
            module = sys.modules.get(helper_name.removesuffix("_call"))
            if module is not None and callable(getattr(module, helper_name, None)):
                setattr(module, helper_name, guarded)
    _install_operation_guards(
        sandbox_globals,
        index,
        (catalog["id"] for catalog in normalized),
    )
    return index


def catalog_prompt_hint(index: CatalogIndex | None) -> str:
    """Constant-size prompt text; never contains raw catalog descriptions."""
    if index is None or not index.catalog_ids:
        return ""
    inventory = index.inventory()["catalogs"]
    catalog_line = ", ".join(
        f"{item['id']}({item['record_count']})" for item in inventory
    )
    if len(catalog_line) > 700:
        catalog_line = catalog_line[:697].rstrip(", ") + "…"
    hint = (
        "CATALOG-GROUNDED API RULE (mandatory): raw catalogs stay in sandbox memory; "
        "vendor helpers are already-defined Python globals: NEVER import or inspect them. "
        "Never guess an endpoint or operation. Requests for current/live platform facts "
        "MUST make a real pre-bound helper call; if no call succeeds, say unknown. Before "
        "each distinct endpoint/operation, call TOP-LEVEL search_api_catalog with intent "
        "and catalog_id. Do NOT run catalog discovery inside Python. It returns a dict; "
        "records are in result['matches']. Once a usable match appears, STOP searching. "
        "For HTTP records call the returned helper with method and concrete path; for object "
        "records call the returned operation. Never execute a catalog label as Python or "
        "enumerate the catalog. Search again only for a different required endpoint. "
        "Undocumented, undiscovered, forbidden, and repeat-failed calls are blocked before "
        "network I/O. HTTP/transport failures raise code errors; do not present them as "
        "success. api_catalog.inventory() takes no arguments; use api_catalog.help() for syntax.\n"
        f"Available in-memory catalogs (record counts only): {catalog_line}"
    )
    return hint[:MAX_PROMPT_HINT_CHARS]


def _default_bundled_agents_dir() -> Path:
    return Path(__file__).resolve().parents[4] / "bundled-agents"


def _read_agent_catalogs(agent_dir: Path) -> list[dict[str, Any]]:
    agent_md = agent_dir / "AGENT.md"
    if not agent_md.is_file():
        return []
    try:
        import yaml

        content = agent_md.read_text(encoding="utf-8")
        if not content.startswith("---"):
            return []
        end = content.find("\n---", 3)
        if end < 0:
            return []
        frontmatter = yaml.safe_load(content[3:end]) or {}
        attachments = frontmatter.get("attached-tools") or frontmatter.get("attached_tools") or []
    except Exception:
        return []
    catalogs: list[dict[str, Any]] = []
    for attachment in attachments:
        if not isinstance(attachment, dict):
            continue
        catalog_id = str(attachment.get("id") or "").strip()
        raw_path = attachment.get("catalog")
        if not catalog_id or not raw_path:
            continue
        path = Path(str(raw_path)).expanduser()
        if not path.is_absolute():
            path = agent_dir / path
        try:
            entries = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        coerced = _coerce_entries(entries)
        if coerced:
            catalogs.append({"id": catalog_id, "entries": coerced})
    return catalogs


def load_catalogs_for_agent(
    agent_id: str | None,
    *,
    user_agents_dir: Path | None = None,
    bundled_agents_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Load one agent's effective catalogs, or Architect's current bundled set."""
    if not agent_id:
        return []
    user_root = user_agents_dir or (Path.home() / ".ccie-terminal" / "agents")
    bundled_root = bundled_agents_dir or _default_bundled_agents_dir()

    def effective_dir(name: str) -> Path | None:
        user = user_root / name
        bundled = bundled_root / name
        if (user / "AGENT.md").is_file():
            return user
        if (bundled / "AGENT.md").is_file():
            return bundled
        return None

    if agent_id != "network-architect":
        directory = effective_dir(agent_id)
        return _read_agent_catalogs(directory) if directory else []

    names: set[str] = set()
    for root in (bundled_root, user_root):
        try:
            names.update(path.name for path in root.iterdir() if path.is_dir())
        except OSError:
            continue
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for name in sorted(names):
        # Bundled catalogs are executable API allowlists, not editable agent
        # prompts. Prefer the current shipped copy so a first-run snapshot in
        # ~/.ccie-terminal cannot keep obsolete endpoints after an upgrade.
        bundled = bundled_root / name
        directory = (
            bundled
            if (bundled / "AGENT.md").is_file()
            else effective_dir(name)
        )
        if directory is None:
            continue
        for catalog in _read_agent_catalogs(directory):
            if catalog["id"] not in seen:
                seen.add(catalog["id"])
                merged.append(catalog)
    return merged


def resolve_agent_catalogs(agent_def: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Prefer explicit/inlined catalogs, then attachments, then disk discovery."""
    explicit = normalize_catalogs(agent_def.get("catalogs"))
    if explicit:
        return explicit
    attached: list[dict[str, Any]] = []
    for tool in agent_def.get("attached_tools") or []:
        if isinstance(tool, dict) and tool.get("id") and tool.get("catalog"):
            attached.append({"id": tool["id"], "catalog": tool["catalog"]})
    normalized = normalize_catalogs(attached)
    if normalized:
        return normalized
    return load_catalogs_for_agent(
        str(agent_def.get("agent_id") or agent_def.get("id") or agent_def.get("name") or "")
    )
