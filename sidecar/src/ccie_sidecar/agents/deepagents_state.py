"""State management for interrupted DeepAgents graphs.

Maintains in-memory registry of paused graphs so they can be resumed
from a separate RPC call.
"""
from __future__ import annotations

from typing import Any, Callable, Optional
from dataclasses import dataclass
import threading


@dataclass
class InterruptedGraphState:
    """State for a paused graph execution."""
    graph: Any  # CompiledStateGraph
    thread_id: str
    config: dict[str, Any]
    on_event: Callable[[dict], None]
    conversation_id: Optional[str] = None


class GraphStateRegistry:
    """Thread-safe registry of interrupted graphs."""

    def __init__(self):
        self._states: dict[str, InterruptedGraphState] = {}
        self._lock = threading.Lock()

    def store(self, thread_id: str, state: InterruptedGraphState) -> None:
        """Store interrupted graph state."""
        with self._lock:
            self._states[thread_id] = state

    def retrieve(self, thread_id: str) -> Optional[InterruptedGraphState]:
        """Retrieve and remove interrupted graph state."""
        with self._lock:
            return self._states.pop(thread_id, None)

    def has(self, thread_id: str) -> bool:
        """Check if thread_id has stored state."""
        with self._lock:
            return thread_id in self._states

    def clear(self, thread_id: str) -> None:
        """Clear stored state without returning it."""
        with self._lock:
            self._states.pop(thread_id, None)


# Global registry (singleton)
_REGISTRY = GraphStateRegistry()


def store_interrupted_graph(
    thread_id: str,
    graph: Any,
    config: dict[str, Any],
    on_event: Callable[[dict], None],
    conversation_id: Optional[str] = None,
) -> None:
    """
    Store interrupted graph state for later resume.

    Args:
        thread_id: Unique thread ID for this execution
        graph: Compiled LangGraph
        config: LangGraph config with thread_id
        on_event: Event callback
        conversation_id: Optional conversation ID for logging
    """
    state = InterruptedGraphState(
        graph=graph,
        thread_id=thread_id,
        config=config,
        on_event=on_event,
        conversation_id=conversation_id,
    )
    _REGISTRY.store(thread_id, state)


def retrieve_interrupted_graph(thread_id: str) -> Optional[InterruptedGraphState]:
    """
    Retrieve interrupted graph state.

    Args:
        thread_id: Thread ID to retrieve

    Returns:
        InterruptedGraphState or None if not found
    """
    return _REGISTRY.retrieve(thread_id)


def has_interrupted_graph(thread_id: str) -> bool:
    """Check if thread_id has interrupted state."""
    return _REGISTRY.has(thread_id)


def clear_interrupted_graph(thread_id: str) -> None:
    """Clear interrupted graph state."""
    _REGISTRY.clear(thread_id)
