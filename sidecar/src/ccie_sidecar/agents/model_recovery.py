"""Bounded, provider-neutral recovery for malformed model responses.

The recovery happens inside LangChain's model-call middleware seam.  Retrying
there is important: the graph has not received a model response yet, so a
retry cannot replay tool calls that completed during earlier graph steps.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
from dataclasses import dataclass
from typing import Any, Iterable

from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.language_models.chat_models import BaseChatModel
from langgraph.errors import GraphRecursionError


_RECOVERY_ENV = "CCIE_MODEL_PROTOCOL_RECOVERY"
_FALSE_VALUES = frozenset({"0", "false", "no", "off", "disabled"})

# These are properties of a malformed *response*, not provider or model names.
# Keep the phrases narrow so ordinary application/API errors do not cause a
# second model call.
_PROTOCOL_PHRASES = (
    "unexpected tokens remaining in message header",
    "unexpected token remaining in message header",
    "unknown role:",
    "invalid role:",
    "malformed message header",
    "invalid message header",
    "failed to decode response",
    "failed to decode stream",
    "error decoding response",
    "error decoding stream",
    "response parse error",
    "response parser error",
    "stream parse error",
    "stream parser error",
    "malformed streaming response",
    "malformed stream response",
    "invalid streaming response",
    "invalid stream response",
    "unterminated streaming response",
)
_PROTOCOL_CLASS_PARTS = (
    "responsedecode",
    "streamdecode",
    "responseparse",
    "streamparse",
    "responseprotocol",
    "streamprotocol",
)

_AUTH_CLASS_PARTS = (
    "authentication",
    "authorization",
    "permissiondenied",
    "unauthorized",
    "forbidden",
)
_AUTH_PHRASES = (
    "invalid api key",
    "incorrect api key",
    "missing api key",
    "authentication failed",
    "not authorized",
    "permission denied",
    "unauthorized",
    "forbidden",
)
_CONFIG_CLASS_PARTS = (
    "configuration",
    "configerror",
    "modelnotfound",
    "endpointnotfound",
    "notfounderror",
)
_CONFIG_PHRASES = (
    "api key is required",
    "api key must be provided",
    "base url is required",
    "invalid base url",
    "model is not configured",
    "provider is not configured",
    "missing required configuration",
    "model not found",
    "model_not_found",
    "model does not exist",
    "does not exist",
    "unknown model",
    "no such model",
    "invalid model",
    "endpoint not found",
    "endpoint does not exist",
    "unknown endpoint",
    "invalid endpoint",
)
_CLIENT_ERROR_CLASS_PARTS = ("badrequest", "invalidrequest", "unprocessableentity")
_CLIENT_ERROR_PHRASES = ("bad request", "unprocessable entity")
_RATE_CLASS_PARTS = ("ratelimit", "toomanyrequests")
_RATE_PHRASES = ("rate limit", "too many requests", "quota exceeded")
_CONTEXT_PHRASES = (
    "context length",
    "context window",
    "maximum context",
    "max context",
    "too many tokens",
    "token limit exceeded",
    "prompt is too long",
)
_TIMEOUT_CLASS_PARTS = ("timeout", "deadlineexceeded")
_TIMEOUT_PHRASES = (
    "timed out",
    "timeout",
    "deadline exceeded",
)
_TOOL_CLASS_PARTS = ("toolexception", "toolerror")


@dataclass(frozen=True)
class AgentExecutionPolicy:
    """Execution policy shared by every DeepAgents react-code caller.

    ``protocol_recovery_enabled`` is intentionally the only retry control.
    The implementation always permits at most one fallback model call.
    """

    protocol_recovery_enabled: bool = True

    @classmethod
    def from_environment(cls) -> "AgentExecutionPolicy":
        """Load the safe process-wide kill switch.

        Recovery is enabled by default.  Set ``CCIE_MODEL_PROTOCOL_RECOVERY=0``
        (also accepts false/no/off/disabled) to stop all fallback calls without
        changing an agent, provider, or model configuration.
        """

        raw = os.getenv(_RECOVERY_ENV)
        enabled = raw is None or raw.strip().lower() not in _FALSE_VALUES
        return cls(protocol_recovery_enabled=enabled)


@dataclass
class ModelRecoveryTelemetry:
    """Per-graph recovery facts folded into the structured run outcome."""

    recovery_attempts: int = 0
    fallback_mode: str | None = None
    first_error_type: str | None = None


class ModelProtocolRecoveryError(RuntimeError):
    """Both the original streaming call and the one fallback call failed."""

    recovery_attempts = 1
    fallback_mode = "non_streaming_model_call"

    def __init__(
        self,
        first_error: BaseException,
        fallback_error: BaseException,
    ) -> None:
        self.first_error_type = type(first_error).__name__
        self.fallback_error_type = type(fallback_error).__name__
        self.first_error = first_error
        self.fallback_error = fallback_error
        self.error_kind, final_error = _classify_model_exception_details(
            fallback_error,
            ignored_errors=(first_error,),
        )
        self.final_error_type = type(final_error).__name__
        fallback_detail = str(fallback_error) or repr(fallback_error)
        super().__init__(
            "Model response recovery failed after one non-streaming retry: "
            f"{self.fallback_error_type}: {fallback_detail}"
        )


def _status_code(error: BaseException) -> int | None:
    """Best-effort status extraction without depending on a provider SDK."""

    for attr in ("status_code", "status"):
        value = getattr(error, attr, None)
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    response = getattr(error, "response", None)
    value = getattr(response, "status_code", None)
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    if isinstance(response, dict):
        for key in ("status_code", "status"):
            value = response.get(key)
            if isinstance(value, int):
                return value
            if isinstance(value, str) and value.isdigit():
                return int(value)
    return None


def _exception_chain(
    error: BaseException,
    *,
    ignored_errors: tuple[BaseException, ...] = (),
) -> Iterable[BaseException]:
    """Yield a complete, cycle-safe exception chain (including groups).

    Some client libraries wrap the useful decoder exception two or three
    levels deep, so inspecting only ``str(error)`` misses the actionable
    response-protocol symptom.
    """

    ignored_ids = {id(item) for item in ignored_errors}
    pending: list[BaseException] = [error]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        marker = id(current)
        if marker in seen or marker in ignored_ids:
            continue
        seen.add(marker)
        yield current

        cause = getattr(current, "__cause__", None)
        context = getattr(current, "__context__", None)
        if isinstance(cause, BaseException):
            pending.append(cause)
        if isinstance(context, BaseException):
            pending.append(context)
        for attr in ("first_error", "fallback_error"):
            related = getattr(current, attr, None)
            if isinstance(related, BaseException):
                pending.append(related)

        nested = getattr(current, "exceptions", None)
        if isinstance(nested, (list, tuple)):
            pending.extend(item for item in nested if isinstance(item, BaseException))


def _error_text(error: BaseException) -> str:
    """Include common structured error payloads in classification."""

    parts = [str(error)]
    for attr in ("message", "detail", "body"):
        value = getattr(error, attr, None)
        if value is None or value == str(error):
            continue
        if isinstance(value, (dict, list)):
            try:
                parts.append(json.dumps(value, sort_keys=True, default=str))
            except (TypeError, ValueError):
                parts.append(str(value))
        else:
            parts.append(str(value))
    return " ".join(parts).lower()


def _contains_any(value: str, needles: tuple[str, ...]) -> bool:
    return any(needle in value for needle in needles)


def _classify_model_exception_details(
    error: BaseException,
    *,
    ignored_errors: tuple[BaseException, ...] = (),
) -> tuple[str, BaseException]:
    """Return the stable category and representative error from a full chain."""

    chain = list(_exception_chain(error, ignored_errors=ignored_errors))
    if not chain:
        return "runtime", error

    # Permanent/non-protocol categories take precedence over response-decoder
    # wording on an outer wrapper.
    for item in chain:
        if isinstance(item, GraphRecursionError):
            return "step_limit", item
        class_name = type(item).__name__.lower()
        if _contains_any(class_name, _TOOL_CLASS_PARTS):
            return "tool", item

    for item in chain:
        class_name = type(item).__name__.lower()
        text = _error_text(item)
        status = _status_code(item)
        if status in {401, 403} or _contains_any(
            class_name, _AUTH_CLASS_PARTS
        ) or _contains_any(text, _AUTH_PHRASES):
            return "authentication", item

    for item in chain:
        class_name = type(item).__name__.lower()
        text = _error_text(item)
        if (
            _status_code(item) == 429
            or _contains_any(class_name, _RATE_CLASS_PARTS)
            or _contains_any(text, _RATE_PHRASES)
        ):
            return "rate_limit", item

    for item in chain:
        if _status_code(item) == 408:
            return "timeout", item

    for item in chain:
        class_name = type(item).__name__.lower()
        text = _error_text(item)
        if (
            _status_code(item) == 404
            or _contains_any(class_name, _CONFIG_CLASS_PARTS)
            or _contains_any(text, _CONFIG_PHRASES)
        ):
            return "configuration", item

    for item in chain:
        if _contains_any(_error_text(item), _CONTEXT_PHRASES):
            return "context_overflow", item

    for item in chain:
        class_name = type(item).__name__.lower()
        text = _error_text(item)
        if (
            isinstance(item, (asyncio.TimeoutError, TimeoutError))
            or _contains_any(class_name, _TIMEOUT_CLASS_PARTS)
            or _contains_any(text, _TIMEOUT_PHRASES)
        ):
            return "timeout", item

    for item in chain:
        class_name = type(item).__name__.lower()
        text = _error_text(item)
        status = _status_code(item)
        if (
            (status is not None and 400 <= status < 500)
            or _contains_any(class_name, _CLIENT_ERROR_CLASS_PARTS)
            or _contains_any(text, _CLIENT_ERROR_PHRASES)
        ):
            return "client_error", item

    for item in chain:
        class_name = type(item).__name__.lower()
        text = _error_text(item)
        if isinstance(item, (UnicodeDecodeError, json.JSONDecodeError)):
            return "model_protocol", item
        if _contains_any(class_name, _PROTOCOL_CLASS_PARTS):
            return "model_protocol", item
        if _contains_any(text, _PROTOCOL_PHRASES):
            return "model_protocol", item

    return "runtime", error


def classify_model_exception(error: BaseException) -> str:
    """Classify a model-call failure without provider/model-name branching."""

    kind, _ = _classify_model_exception_details(error)
    return kind


def is_retryable_model_protocol_error(error: BaseException) -> bool:
    """Return True only for response-protocol/stream-decoding failures.

    Permanent categories take precedence across the complete exception chain,
    preventing a generic decoder wrapper from hiding authentication,
    configuration, rate-limit, context, timeout, graph-loop, or tool failures.
    """

    return classify_model_exception(error) == "model_protocol"


def clone_model_without_streaming(model: BaseChatModel) -> BaseChatModel:
    """Clone the current concrete model and force non-streaming execution.

    No provider-specific constructor is used.  Pydantic-backed LangChain
    models support ``model_copy``; the shallow-copy fallback keeps this helper
    compatible with custom ``BaseChatModel`` implementations.
    """

    if not isinstance(model, BaseChatModel):
        raise TypeError(f"Expected BaseChatModel, got {type(model).__name__}")

    try:
        cloned = model.model_copy(update={"disable_streaming": True})
    except (AttributeError, TypeError, ValueError):
        cloned = copy.copy(model)
        object.__setattr__(cloned, "disable_streaming", True)

    if cloned is model:
        cloned = copy.copy(model)
        object.__setattr__(cloned, "disable_streaming", True)
    if getattr(cloned, "disable_streaming", None) is not True:
        raise TypeError(
            f"{type(model).__name__} could not be cloned with streaming disabled"
        )
    return cloned


class ModelProtocolRecoveryMiddleware(AgentMiddleware):
    """Retry one failed model turn with the same request, non-streaming.

    Completed tools are not replayed because this middleware wraps only the
    current LangChain model call.  A failure from the fallback call propagates
    immediately; there is deliberately no third call.
    """

    name = "ModelProtocolRecovery"

    def __init__(
        self,
        policy: AgentExecutionPolicy | None = None,
        telemetry: ModelRecoveryTelemetry | None = None,
    ) -> None:
        super().__init__()
        self.policy = policy or AgentExecutionPolicy.from_environment()
        self.telemetry = telemetry or ModelRecoveryTelemetry()

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Any,
    ) -> ModelResponse:
        try:
            return await handler(request)
        except Exception as first_error:
            if (
                not self.policy.protocol_recovery_enabled
                or not is_retryable_model_protocol_error(first_error)
            ):
                raise

            self.telemetry.recovery_attempts += 1
            self.telemetry.fallback_mode = "non_streaming_model_call"
            self.telemetry.first_error_type = type(first_error).__name__
            retry_request = request.override(
                model=clone_model_without_streaming(request.model)
            )

            try:
                return await handler(retry_request)
            except Exception as retry_error:
                # Preserve both failures and expose stable fields to the stream
                # bridge/heartbeat parser instead of leaking an untyped retry.
                recovery_error = ModelProtocolRecoveryError(
                    first_error=first_error,
                    fallback_error=retry_error,
                )
                raise recovery_error from retry_error
