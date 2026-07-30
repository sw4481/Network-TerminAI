"""Tests for provider-neutral model-call protocol recovery."""
from __future__ import annotations

from typing import Any, AsyncIterator, ClassVar

import pytest
from deepagents import create_deep_agent
from langchain.agents.middleware import ModelRequest, ModelResponse
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import ToolException, tool
from langgraph.errors import GraphRecursionError

from ccie_sidecar.agents.model_recovery import (
    AgentExecutionPolicy,
    ModelProtocolRecoveryMiddleware,
    ModelProtocolRecoveryError,
    ModelRecoveryTelemetry,
    classify_model_exception,
    is_retryable_model_protocol_error,
)


class _FakeModelBase(BaseChatModel):
    marker: str = "fake"

    @property
    def _llm_type(self) -> str:
        return self.marker

    def _generate(
        self,
        messages: list,
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(
            generations=[ChatGeneration(message=AIMessage(content="unused"))]
        )


class FakeAlphaChatModel(_FakeModelBase):
    marker: str = "alpha"


class FakeBetaChatModel(_FakeModelBase):
    marker: str = "beta"


class FakeGammaChatModel(_FakeModelBase):
    marker: str = "gamma"


class SeamStreamingChatModel(_FakeModelBase):
    """Fake model that fails only through LangChain's streaming path."""

    marker: str = "seam-streaming"
    calls: ClassVar[list[tuple[str, bool]]] = []

    def bind_tools(self, tools: list, **kwargs: Any) -> BaseChatModel:
        return self

    def _generate(
        self,
        messages: list,
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        self.calls.append(("nonstream", bool(self.disable_streaming)))
        return ChatResult(
            generations=[ChatGeneration(message=AIMessage(content="Recovered."))]
        )

    async def _astream(
        self,
        messages: list,
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        self.calls.append(("stream", bool(self.disable_streaming)))
        raise RuntimeError("Unknown role: final")
        yield ChatGenerationChunk(message=AIMessageChunk(content=""))  # pragma: no cover


class StatusError(RuntimeError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class NotFoundError(RuntimeError):
    pass


def test_react_code_interactive_default_keeps_recovery_disabled():
    from ccie_sidecar.agents.deepagents_runtime import (
        _resolve_react_code_execution_policy,
    )

    default_policy = _resolve_react_code_execution_policy(None)
    explicit_policy = AgentExecutionPolicy(protocol_recovery_enabled=True)

    assert default_policy.protocol_recovery_enabled is False
    assert _resolve_react_code_execution_policy(explicit_policy) is explicit_policy


def _request(model: BaseChatModel) -> ModelRequest:
    completed = ToolMessage(
        content='{"devices": 3}',
        tool_call_id="already-completed",
        name="execute_python_code",
    )
    messages = [
        HumanMessage(content="Check every device"),
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "execute_python_code",
                    "args": {"code": "print(devices)"},
                    "id": "already-completed",
                }
            ],
        ),
        completed,
    ]
    return ModelRequest(
        model=model,
        messages=messages,
        system_prompt="You are a network agent.",
        tool_choice="auto",
        tools=[
            {
                "name": "execute_python_code",
                "description": "Execute code",
                "parameters": {"type": "object"},
            }
        ],
        state={"messages": list(messages), "stable": "state"},
        model_settings={"temperature": 0},
    )


def _request_content(request: ModelRequest) -> dict[str, Any]:
    """Snapshot everything except the intentionally replaced model instance."""

    return {
        "messages": [message.model_dump() for message in request.messages],
        "system_message": (
            request.system_message.model_dump()
            if request.system_message is not None
            else None
        ),
        "tool_choice": request.tool_choice,
        "tools": request.tools,
        "response_format": request.response_format,
        "state": {
            **request.state,
            "messages": [
                message.model_dump() for message in request.state["messages"]
            ],
        },
        "model_settings": request.model_settings,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "model_type",
    [FakeAlphaChatModel, FakeBetaChatModel, FakeGammaChatModel],
)
async def test_protocol_failure_retries_same_turn_once_without_streaming(model_type):
    """All BaseChatModel implementations use the same two-call recovery path."""

    original_model = model_type()
    request = _request(original_model)
    original_content = _request_content(request)
    telemetry = ModelRecoveryTelemetry()
    middleware = ModelProtocolRecoveryMiddleware(telemetry=telemetry)
    calls: list[ModelRequest] = []
    tool_executions = 1  # The ToolMessage in the request was already completed.

    async def handler(current: ModelRequest) -> ModelResponse:
        calls.append(current)
        if len(calls) == 1:
            raise RuntimeError(
                "unexpected tokens remaining in message header: Some(final)"
            )
        return ModelResponse(result=[AIMessage(content="All devices are online.")])

    response = await middleware.awrap_model_call(request, handler)

    assert response.result[0].content == "All devices are online."
    assert len(calls) == 2
    assert calls[0] is request
    assert calls[1] is not request
    assert _request_content(calls[0]) == original_content
    assert _request_content(calls[1]) == original_content
    assert type(calls[1].model) is model_type
    assert calls[1].model is not original_model
    assert original_model.disable_streaming is False
    assert calls[1].model.disable_streaming is True
    assert tool_executions == 1
    assert telemetry.recovery_attempts == 1
    assert telemetry.fallback_mode == "non_streaming_model_call"


@pytest.mark.asyncio
async def test_middleware_runs_at_real_deepagents_model_seam_without_tool_replay():
    """Graph streaming retries the model node, not the graph or completed tool."""

    completed_tool_executions = 0

    @tool
    def observed_tool() -> str:
        """A tool whose execution count proves historical calls are not replayed."""
        nonlocal completed_tool_executions
        completed_tool_executions += 1
        return "new result"

    telemetry = ModelRecoveryTelemetry()
    SeamStreamingChatModel.calls.clear()
    graph = create_deep_agent(
        model=SeamStreamingChatModel(),
        tools=[observed_tool],
        middleware=[ModelProtocolRecoveryMiddleware(telemetry=telemetry)],
    )
    historical_messages = [
        HumanMessage(content="Gather status"),
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "observed_tool",
                    "args": {},
                    "id": "completed-call",
                }
            ],
        ),
        ToolMessage(
            content="already gathered",
            tool_call_id="completed-call",
            name="observed_tool",
        ),
        HumanMessage(content="Summarize the gathered status"),
    ]

    async for _ in graph.astream(
        {"messages": historical_messages},
        stream_mode=["updates", "messages", "custom"],
        subgraphs=True,
    ):
        pass

    assert SeamStreamingChatModel.calls == [
        ("stream", False),
        ("nonstream", True),
    ]
    assert telemetry.recovery_attempts == 1
    assert completed_tool_executions == 0


@pytest.mark.asyncio
async def test_failed_fallback_propagates_after_exactly_two_calls():
    telemetry = ModelRecoveryTelemetry()
    middleware = ModelProtocolRecoveryMiddleware(telemetry=telemetry)
    calls = 0

    async def handler(current: ModelRequest) -> ModelResponse:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("Unknown role: final")
        raise RuntimeError("failed to decode response")

    with pytest.raises(
        ModelProtocolRecoveryError,
        match="failed to decode response",
    ) as caught:
        await middleware.awrap_model_call(_request(FakeAlphaChatModel()), handler)

    assert calls == 2  # no third call
    assert telemetry.recovery_attempts == 1
    assert caught.value.error_kind == "model_protocol"
    assert caught.value.recovery_attempts == 1
    assert caught.value.fallback_mode == "non_streaming_model_call"
    assert caught.value.first_error_type == "RuntimeError"
    assert caught.value.fallback_error_type == "RuntimeError"
    assert caught.value.final_error_type == "RuntimeError"
    assert caught.value.__cause__ is not None
    assert "failed to decode response" in str(caught.value.__cause__)
    assert "Unknown role: final" in str(caught.value.first_error)


def _protocol_wrapper(inner: BaseException) -> RuntimeError:
    outer = RuntimeError("failed to decode response")
    outer.__cause__ = inner
    return outer


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("permanent_factory", "expected_kind"),
    [
        (lambda: StatusError("route missing", 404), "configuration"),
        (lambda: NotFoundError("requested resource missing"), "configuration"),
        (lambda: RuntimeError("model not found"), "configuration"),
        (
            lambda: RuntimeError("The model 'missing-model' does not exist"),
            "configuration",
        ),
        (lambda: RuntimeError("unknown model: missing-model"), "configuration"),
        (lambda: StatusError("invalid model selection", 400), "configuration"),
        (lambda: StatusError("generic bad request", 400), "client_error"),
        (lambda: StatusError("request timeout", 408), "timeout"),
        (lambda: StatusError("too many requests", 429), "rate_limit"),
        (lambda: StatusError("unauthorized", 401), "authentication"),
        (lambda: StatusError("unprocessable request", 422), "client_error"),
    ],
)
async def test_nested_permanent_client_error_is_never_protocol_retried(
    permanent_factory,
    expected_kind,
):
    error = _protocol_wrapper(permanent_factory())
    telemetry = ModelRecoveryTelemetry()
    middleware = ModelProtocolRecoveryMiddleware(telemetry=telemetry)
    calls = 0

    async def handler(current: ModelRequest) -> ModelResponse:
        nonlocal calls
        calls += 1
        raise error

    with pytest.raises(RuntimeError, match="failed to decode response"):
        await middleware.awrap_model_call(_request(FakeAlphaChatModel()), handler)

    assert classify_model_exception(error) == expected_kind
    assert calls == 1
    assert telemetry.recovery_attempts == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("fallback_factory", "expected_kind", "expected_type"),
    [
        (
            lambda: RuntimeError("failed to decode response"),
            "model_protocol",
            "RuntimeError",
        ),
        (
            lambda: _protocol_wrapper(StatusError("unauthorized", 401)),
            "authentication",
            "StatusError",
        ),
        (
            lambda: _protocol_wrapper(ValueError("API key is required")),
            "configuration",
            "ValueError",
        ),
        (
            lambda: _protocol_wrapper(StatusError("model not found", 404)),
            "configuration",
            "StatusError",
        ),
        (
            lambda: _protocol_wrapper(StatusError("generic bad request", 400)),
            "client_error",
            "StatusError",
        ),
        (
            lambda: _protocol_wrapper(StatusError("too many requests", 429)),
            "rate_limit",
            "StatusError",
        ),
        (
            lambda: _protocol_wrapper(
                ValueError("maximum context length exceeded")
            ),
            "context_overflow",
            "ValueError",
        ),
        (
            lambda: _protocol_wrapper(TimeoutError("model timed out")),
            "timeout",
            "TimeoutError",
        ),
        (
            lambda: _protocol_wrapper(ToolException("tool failed")),
            "tool",
            "ToolException",
        ),
        (
            lambda: _protocol_wrapper(GraphRecursionError("step limit reached")),
            "step_limit",
            "GraphRecursionError",
        ),
        (
            lambda: ValueError("fallback failed for an unrelated reason"),
            "runtime",
            "ValueError",
        ),
    ],
)
async def test_failed_fallback_uses_final_error_category(
    fallback_factory,
    expected_kind,
    expected_type,
):
    middleware = ModelProtocolRecoveryMiddleware()
    calls = 0

    async def handler(current: ModelRequest) -> ModelResponse:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("Unknown role: final")
        raise fallback_factory()

    with pytest.raises(ModelProtocolRecoveryError) as caught:
        await middleware.awrap_model_call(_request(FakeAlphaChatModel()), handler)

    assert calls == 2
    assert caught.value.recovery_attempts == 1
    assert caught.value.error_kind == expected_kind
    assert caught.value.final_error_type == expected_type


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    [
        StatusError("authentication failed", 401),
        StatusError("forbidden", 403),
        StatusError("too many requests", 429),
        ValueError("API key is required"),
        ValueError("maximum context length exceeded"),
        TimeoutError("model timed out"),
        ToolException("tool failed"),
        GraphRecursionError("step limit reached"),
    ],
)
async def test_nonretryable_failures_make_zero_recovery_calls(error):
    telemetry = ModelRecoveryTelemetry()
    middleware = ModelProtocolRecoveryMiddleware(telemetry=telemetry)
    calls = 0

    async def handler(current: ModelRequest) -> ModelResponse:
        nonlocal calls
        calls += 1
        raise error

    with pytest.raises(type(error)):
        await middleware.awrap_model_call(_request(FakeBetaChatModel()), handler)

    assert calls == 1
    assert telemetry.recovery_attempts == 0
    assert telemetry.fallback_mode is None


def test_protocol_match_traverses_wrapped_exception_chain():
    decoder_error = RuntimeError("Unknown role: final")
    try:
        raise decoder_error
    except RuntimeError as inner:
        try:
            raise RuntimeError("model invocation failed") from inner
        except RuntimeError as outer:
            wrapped = outer

    assert is_retryable_model_protocol_error(wrapped) is True


def test_nonretryable_cause_wins_over_outer_protocol_wording():
    try:
        raise TimeoutError("request timeout")
    except TimeoutError as inner:
        try:
            raise RuntimeError("failed to decode stream") from inner
        except RuntimeError as outer:
            wrapped = outer

    assert is_retryable_model_protocol_error(wrapped) is False


@pytest.mark.asyncio
async def test_policy_kill_switch_disables_fallback(monkeypatch):
    monkeypatch.setenv("CCIE_MODEL_PROTOCOL_RECOVERY", "0")
    policy = AgentExecutionPolicy.from_environment()
    middleware = ModelProtocolRecoveryMiddleware(policy=policy)
    calls = 0

    async def handler(current: ModelRequest) -> ModelResponse:
        nonlocal calls
        calls += 1
        raise RuntimeError("Unknown role: final")

    with pytest.raises(RuntimeError, match="Unknown role"):
        await middleware.awrap_model_call(_request(FakeGammaChatModel()), handler)

    assert calls == 1
    assert middleware.telemetry.recovery_attempts == 0
