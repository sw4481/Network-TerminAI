"""Bound and retain code-execution output before it reaches DeepAgents.

DeepAgents moves very large tool messages into its own virtual filesystem.
TerminAI's Python sandbox cannot read that virtual filesystem, so an agent that
tries to reopen the resulting path with ``open()`` can loop until its step or
time limit.  This module keeps every ``execute_python_code`` result below that
eviction boundary and exposes the latest retained result through a sandbox-local
``tool_output`` helper.

The implementation is provider and model neutral.  It deals only with strings
returned by TerminAI tools and does not inspect model names, endpoints, or
provider response types.
"""
from __future__ import annotations

import csv
import io
import json as _json
import re
import threading
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, MutableMapping, Sequence

from ccie_sidecar.serialize import graph_compact


DEFAULT_MAX_RETURN_CHARS = 48_000
DEFAULT_MAX_RETAINED_BYTES = 2 * 1024 * 1024
DEFAULT_MAX_QUERY_CHARS = 12_000
_MAX_QUERY_LINES = 1_000
_MAX_GREP_MATCHES = 200
_MAX_SCHEMA_NAMES = 100
_MAX_SCHEMA_DETAIL_CHARS = 2_000
_MAX_HEADER_CHARS = 8_000

TOOL_OUTPUT_GUIDANCE = (
    "TerminAI keeps oversized execute_python_code stdout in the sandbox-local "
    "`tool_output` helper. Use tool_output.stats(), head(), tail(), grep(...), "
    "or json() to inspect that latest result. A path in DeepAgents' virtual "
    "`/large_tool_results` namespace must instead be read with DeepAgents' "
    "built-in read_file(file_path=..., offset=..., limit=...). Never pass such "
    "a path to Python open(), pathlib, or execute_python_code."
)


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    return value if isinstance(value, str) else str(value)


def _line_count(text: str) -> int:
    return 0 if not text else text.count("\n") + 1


def _utf8_prefix(encoded: bytes, byte_budget: int) -> str:
    if byte_budget <= 0:
        return ""
    if len(encoded) <= byte_budget:
        return encoded.decode("utf-8")
    return encoded[:byte_budget].decode("utf-8", errors="ignore")


def _utf8_suffix(encoded: bytes, byte_budget: int) -> str:
    if byte_budget <= 0:
        return ""
    if len(encoded) <= byte_budget:
        return encoded.decode("utf-8")
    return encoded[-byte_budget:].decode("utf-8", errors="ignore")


def _bounded_prefix(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit]


def _bounded_suffix(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[-limit:]


def _clamp_int(value: Any, *, default: int, lower: int, upper: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(lower, min(parsed, upper))


def _sample_sequence(values: Sequence[Any]) -> list[Any]:
    """Return a deterministic first-three/last-two sample."""
    if len(values) <= 5:
        return list(values)
    return [*values[:3], *values[-2:]]


def _columns(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    columns: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row:
            rendered = str(key)
            if rendered not in seen:
                seen.add(rendered)
                columns.append(rendered)
    return columns


def _schema_names_detail(label: str, names: Sequence[str]) -> str:
    """Render high-cardinality schema names without an unbounded header."""
    rendered: list[str] = []
    used = 0
    for name in names[:_MAX_SCHEMA_NAMES]:
        clean = str(name).replace("\r", "\\r").replace("\n", "\\n")
        clean = _bounded_prefix(clean, 160)
        added = len(clean) + (2 if rendered else 0)
        if used + added > _MAX_SCHEMA_DETAIL_CHARS - 80:
            break
        rendered.append(clean)
        used += added
    omitted = len(names) - len(rendered)
    result = f"{label}: {', '.join(rendered) or '(none)'}"
    if omitted:
        result += f" … (+{omitted} more)"
    return _bounded_prefix(result, _MAX_SCHEMA_DETAIL_CHARS)


@dataclass(frozen=True)
class _StructuredPreview:
    format_name: str
    shape: str
    details: tuple[str, ...]
    sample: str


def _json_preview(data: Any, *, format_name: str = "JSON") -> _StructuredPreview:
    if isinstance(data, list):
        details = [f"Records: {len(data)}"]
        rows = [row for row in data if isinstance(row, dict)]
        if rows and len(rows) == len(data):
            details.append(_schema_names_detail("Columns", _columns(rows)))
        sample = graph_compact.encode(_sample_sequence(data), mode="generic")
        return _StructuredPreview(
            format_name=format_name,
            shape=f"list[{len(data)}]",
            details=tuple(details),
            sample=sample,
        )

    if isinstance(data, dict):
        keys = [str(key) for key in data]
        sample_data: dict[Any, Any] = {}
        for key in list(data)[:8]:
            value = data[key]
            sample_data[key] = (
                _sample_sequence(value) if isinstance(value, list) else value
            )
        return _StructuredPreview(
            format_name=format_name,
            shape=f"object[{len(data)} keys]",
            details=(_schema_names_detail("Keys", keys),),
            sample=graph_compact.encode(sample_data, mode="generic"),
        )

    return _StructuredPreview(
        format_name=format_name,
        shape=type(data).__name__,
        details=(),
        sample=graph_compact.encode(data, mode="generic"),
    )


def _try_json_or_ndjson(text: str) -> _StructuredPreview | None:
    stripped = text.strip()
    if not stripped:
        return None

    try:
        return _json_preview(_json.loads(stripped))
    except (TypeError, ValueError, _json.JSONDecodeError):
        pass

    lines = [line for line in stripped.splitlines() if line.strip()]
    if len(lines) < 2:
        return None
    records: list[Any] = []
    try:
        for line in lines:
            records.append(_json.loads(line))
    except (TypeError, ValueError, _json.JSONDecodeError):
        return None
    return _json_preview(records, format_name="NDJSON")


def _try_delimited_table(text: str) -> _StructuredPreview | None:
    """Recognize ordinary CSV/TSV without treating generic prose as a table."""
    lines = text.splitlines()
    if len(lines) < 3:
        return None
    try:
        dialect = csv.Sniffer().sniff("\n".join(lines[:20]), delimiters=",\t;|")
        reader = csv.reader(io.StringIO(text), dialect)
        parsed = list(reader)
    except (csv.Error, UnicodeError):
        return None
    if len(parsed) < 3 or len(parsed[0]) < 2:
        return None
    width = len(parsed[0])
    if any(len(row) != width for row in parsed[1:]):
        return None
    headers = [cell.strip() or f"column_{index + 1}" for index, cell in enumerate(parsed[0])]
    rows = [dict(zip(headers, row, strict=True)) for row in parsed[1:]]
    return _StructuredPreview(
        format_name="delimited table",
        shape=f"{len(rows)} rows x {width} columns",
        details=(
            f"Records: {len(rows)}",
            _schema_names_detail("Columns", headers),
        ),
        sample=graph_compact.encode(_sample_sequence(rows), mode="generic"),
    )


def _structured_preview(text: str) -> _StructuredPreview | None:
    return _try_json_or_ndjson(text) or _try_delimited_table(text)


@dataclass(frozen=True)
class ToolOutputSnapshot:
    """One immutable code-execution result retained for formatting and queries."""

    head_text: str = ""
    tail_text: str = ""
    original_chars: int = 0
    original_bytes: int = 0
    original_lines: int = 0
    retained_bytes: int = 0
    retention_clipped: bool = False
    has_result: bool = False

    @property
    def complete_text(self) -> str:
        """Return complete text; clipped snapshots deliberately have none."""
        if self.retention_clipped:
            raise ValueError("A clipped tool-output snapshot is not complete.")
        return self.head_text

    def stats(self, *, max_retained_bytes: int) -> dict[str, Any]:
        return {
            "has_result": self.has_result,
            "original_chars": self.original_chars,
            "original_bytes": self.original_bytes,
            "original_lines": self.original_lines,
            "retained_chars": len(self.head_text) + len(self.tail_text),
            "retained_bytes": self.retained_bytes,
            "retention_clipped": self.retention_clipped,
            "retention_strategy": (
                "head_tail" if self.retention_clipped else "complete"
            ),
            "max_retained_bytes": max_retained_bytes,
            "latest_result_only": True,
        }

    def head(self, *, lines: int, max_chars: int) -> str:
        line_limit = _clamp_int(
            lines, default=40, lower=1, upper=_MAX_QUERY_LINES
        )
        selected = "".join(self.head_text.splitlines(keepends=True)[:line_limit])
        if not selected and self.head_text:
            selected = self.head_text
        return _bounded_prefix(selected, max_chars)

    def tail(self, *, lines: int, max_chars: int) -> str:
        line_limit = _clamp_int(
            lines, default=40, lower=1, upper=_MAX_QUERY_LINES
        )
        source = self.tail_text if self.retention_clipped else self.head_text
        selected = "".join(source.splitlines(keepends=True)[-line_limit:])
        if not selected and source:
            selected = source
        return _bounded_suffix(selected, max_chars)

    def grep(self, pattern: str, *, limit: int, max_chars: int) -> str:
        match_limit = _clamp_int(
            limit, default=20, lower=1, upper=_MAX_GREP_MATCHES
        )
        rendered_pattern = _as_text(pattern)
        try:
            regex = re.compile(rendered_pattern)
        except re.error:
            regex = re.compile(re.escape(rendered_pattern))

        parts = [self.head_text]
        if self.retention_clipped and self.tail_text:
            parts.append(self.tail_text)

        matches: list[str] = []
        for part_index, part in enumerate(parts):
            lines = part.splitlines() or ([part] if part else [])
            for line_index, line in enumerate(lines):
                match = regex.search(line)
                if match is None:
                    continue
                radius = 240
                start = max(0, match.start() - radius)
                end = min(len(line), match.end() + radius)
                prefix = "…" if start else ""
                suffix = "…" if end < len(line) else ""
                region = "head" if part_index == 0 else "tail"
                matches.append(
                    f"[{region} line {line_index + 1}] "
                    f"{prefix}{line[start:end]}{suffix}"
                )
                if len(matches) >= match_limit:
                    break
            if len(matches) >= match_limit:
                break

        if not matches:
            return f"(no retained matches for {rendered_pattern!r})"
        return _bounded_prefix("\n".join(matches), max_chars)

    def json(self) -> Any:
        if self.retention_clipped:
            raise ValueError(
                "The latest result exceeded raw retention and is not complete JSON; "
                "use head(), tail(), or grep()."
            )
        try:
            return _json.loads(self.head_text)
        except _json.JSONDecodeError as exc:
            raise ValueError("The latest retained result is not valid JSON.") from exc


class ToolOutputHelper:
    """Sandbox-local atomic view of the latest completed tool result."""

    def __init__(self, policy: "ToolOutputPolicy") -> None:
        self._policy = policy
        self._lock = threading.RLock()
        self._latest = ToolOutputSnapshot()

    def prepare_snapshot(self, text: Any) -> ToolOutputSnapshot:
        """Build one call's complete immutable snapshot without publishing it."""
        safe_text = self._policy.redact(_as_text(text))
        # Encode once. For a clipped result this avoids producing multiple
        # full-size byte copies merely to derive the retained head and tail.
        encoded = safe_text.encode("utf-8")
        encoded_len = len(encoded)
        if encoded_len <= self._policy.max_retained_bytes:
            head_text = safe_text
            tail_text = ""
            retention_clipped = False
        else:
            head_budget = int(self._policy.max_retained_bytes * 0.7)
            tail_budget = self._policy.max_retained_bytes - head_budget
            head_text = _utf8_prefix(encoded, head_budget)
            tail_text = _utf8_suffix(encoded, tail_budget)
            retention_clipped = True
        retained_bytes = len(head_text.encode("utf-8")) + len(
            tail_text.encode("utf-8")
        )
        return ToolOutputSnapshot(
            head_text=head_text,
            tail_text=tail_text,
            original_chars=len(safe_text),
            original_bytes=encoded_len,
            original_lines=_line_count(safe_text),
            retained_bytes=retained_bytes,
            retention_clipped=retention_clipped,
            has_result=True,
        )

    def publish(self, snapshot: ToolOutputSnapshot) -> None:
        """Atomically expose a fully formatted call as the latest result."""
        with self._lock:
            self._latest = snapshot

    def _current(self) -> ToolOutputSnapshot:
        # Capture the immutable reference once so one query cannot mix results
        # even if another tool call publishes concurrently.
        with self._lock:
            return self._latest

    def stats(self) -> dict[str, Any]:
        """Describe the latest completed result."""
        return self._current().stats(
            max_retained_bytes=self._policy.max_retained_bytes
        )

    def head(self, lines: int = 40) -> str:
        """Return bounded leading lines from the latest completed result."""
        return self._current().head(
            lines=lines,
            max_chars=self._policy.max_query_chars,
        )

    def tail(self, lines: int = 40) -> str:
        """Return bounded trailing lines from the latest completed result."""
        return self._current().tail(
            lines=lines,
            max_chars=self._policy.max_query_chars,
        )

    def grep(self, pattern: str, limit: int = 20) -> str:
        """Return bounded snippets from the latest completed result."""
        return self._current().grep(
            pattern,
            limit=limit,
            max_chars=self._policy.max_query_chars,
        )

    def json(self) -> Any:
        """Parse the latest completed result when it is complete, valid JSON."""
        return self._current().json()

    def help(self) -> str:
        return TOOL_OUTPUT_GUIDANCE


@dataclass(frozen=True)
class ToolOutputPolicy:
    """Configuration and formatter shared by all DeepAgents code wrappers."""

    max_return_chars: int = DEFAULT_MAX_RETURN_CHARS
    max_retained_bytes: int = DEFAULT_MAX_RETAINED_BYTES
    max_query_chars: int = DEFAULT_MAX_QUERY_CHARS
    sensitive_values: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.max_return_chars < 1:
            raise ValueError("max_return_chars must be positive")
        if self.max_retained_bytes < 1:
            raise ValueError("max_retained_bytes must be positive")
        if self.max_query_chars < 1:
            raise ValueError("max_query_chars must be positive")
        if self.max_return_chars <= len(self._footer()) + 128:
            raise ValueError(
                "max_return_chars must leave room for the required retrieval footer"
            )
        cleaned = {
            value
            for value in (_as_text(item) for item in self.sensitive_values)
            if len(value) >= 4
        }
        object.__setattr__(
            self, "sensitive_values", tuple(sorted(cleaned, key=len, reverse=True))
        )

    def redact(self, text: str) -> str:
        """Remove known credential values before retention or model exposure."""
        safe = text
        for value in self.sensitive_values:
            safe = safe.replace(value, "[REDACTED]")
        return safe

    def install(self, sandbox_globals: MutableMapping[str, Any]) -> ToolOutputHelper:
        """Install a fresh helper in one sandbox; no state is module-global."""
        helper = ToolOutputHelper(self)
        sandbox_globals["tool_output"] = helper
        return helper

    def _footer(self) -> str:
        return (
            "The latest retained result is available only in this code sandbox. "
            "Inspect it with tool_output.stats(), tool_output.head(lines=...), "
            "tool_output.tail(lines=...), tool_output.grep(pattern, limit=...), "
            "or tool_output.json() when it is complete JSON.\n"
            "TerminAI does not create paths in `/large_tool_results`. If "
            "DeepAgents returns a path in that virtual namespace, use its built-in "
            "read_file(file_path=..., offset=..., limit=...); never use Python "
            "open(), pathlib, or execute_python_code for that path."
        )

    def _assemble(self, header_lines: Iterable[str], body: str) -> str:
        prefix = "\n".join(header_lines).rstrip() + "\n\n"
        suffix = "\n\n" + self._footer()
        prefix_budget = min(
            _MAX_HEADER_CHARS,
            self.max_return_chars - len(suffix),
        )
        if len(prefix) > prefix_budget:
            marker = "\n…[header details bounded]…\n"
            if prefix_budget <= len(marker):
                prefix = prefix[:prefix_budget]
            else:
                remaining = prefix_budget - len(marker)
                head_chars = int(remaining * 0.7)
                tail_chars = remaining - head_chars
                prefix = prefix[:head_chars] + marker + prefix[-tail_chars:]
        body_budget = self.max_return_chars - len(prefix) - len(suffix)
        if len(body) > body_budget:
            marker = "\n…[middle omitted from inline preview]…\n"
            if body_budget <= len(marker):
                body = body[:body_budget]
            else:
                remaining = body_budget - len(marker)
                head_chars = int(remaining * 0.65)
                tail_chars = remaining - head_chars
                body = body[:head_chars] + marker + body[-tail_chars:]
        # Prefix is independently bounded and the footer is never sliced away.
        return prefix + body + suffix

    def format(self, text: Any, helper: ToolOutputHelper, *, kind: str) -> str:
        """Capture a result and return an inline-safe representation."""
        snapshot = helper.prepare_snapshot(text)
        stats = snapshot.stats(max_retained_bytes=self.max_retained_bytes)
        if stats["original_chars"] <= self.max_return_chars:
            rendered = snapshot.complete_text
            helper.publish(snapshot)
            return rendered

        header = [
            "[TerminAI tool output summarized before model context]",
            f"Kind: {kind}",
            (
                f"Original: {stats['original_chars']} characters, "
                f"{stats['original_bytes']} UTF-8 bytes, "
                f"{stats['original_lines']} lines"
            ),
            (
                f"Raw retention: {stats['retained_bytes']} bytes "
                f"({'clipped to head/tail' if stats['retention_clipped'] else 'complete'}; "
                "latest result only)"
            ),
        ]

        if stats["retention_clipped"]:
            # Do not parse or make another full-sized copy after the 2 MiB raw
            # retention boundary has fired. The exact counts plus bounded
            # retained head/tail are deterministic and enough for recovery.
            header.extend(
                [
                    "Format: text (raw retention clipped; structured analysis skipped)",
                    "Bounded retained head/tail preview:",
                ]
            )
            body = (
                snapshot.head(
                    lines=_MAX_QUERY_LINES,
                    max_chars=self.max_query_chars,
                )
                + "\n…[unretained middle omitted]…\n"
                + snapshot.tail(
                    lines=_MAX_QUERY_LINES,
                    max_chars=self.max_query_chars,
                )
            )
            rendered = self._assemble(header, body)
            helper.publish(snapshot)
            return rendered

        # Summarization is best-effort: even an adversarially nested or otherwise
        # unusual payload must still fall back to the bounded text path.
        safe_text = snapshot.complete_text
        try:
            structured = _structured_preview(safe_text)
        except Exception:  # noqa: BLE001 - containment is the contract here
            structured = None
        if structured is not None:
            header.extend(
                [
                    f"Format: {structured.format_name}",
                    f"Shape: {structured.shape}",
                    *structured.details,
                    "Deterministic sample (graph_compact generic mode):",
                ]
            )
            body = structured.sample
        else:
            header.extend(["Format: text", "Bounded head/tail preview:"])
            body = safe_text
        rendered = self._assemble(header, body)
        helper.publish(snapshot)
        return rendered

    def format_execution_result(
        self,
        result: Mapping[str, Any],
        helper: ToolOutputHelper,
    ) -> str:
        """Preserve the existing tool result contract while enforcing bounds."""
        if result.get("success"):
            raw_output = _as_text(result.get("output", ""))
            formatted = self.format(raw_output, helper, kind="stdout")
            return formatted if formatted else "(no output)"
        error_text = f"Error: {_as_text(result.get('error', 'Unknown error'))}"
        return self.format(error_text, helper, kind="error")


def install_tool_output_policy(
    sandbox_globals: MutableMapping[str, Any],
    *,
    sensitive_values: Iterable[Any] = (),
) -> tuple[ToolOutputPolicy, ToolOutputHelper]:
    """Create and install isolated output state for one code-exec sandbox."""
    policy = ToolOutputPolicy(
        sensitive_values=tuple(
            value for value in sensitive_values if isinstance(value, str)
        )
    )
    return policy, policy.install(sandbox_globals)
