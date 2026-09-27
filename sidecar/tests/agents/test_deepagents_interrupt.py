"""Integration tests for interrupt/resume flow."""
import pytest
from ccie_sidecar.agents.deepagents_state import (
    store_interrupted_graph,
    retrieve_interrupted_graph,
    has_interrupted_graph,
    clear_interrupted_graph,
)


def test_store_and_retrieve_graph():
    """Test storing and retrieving interrupted graph state."""
    thread_id = "test_thread_123"

    # Mock graph and config
    mock_graph = {"type": "mock_graph"}
    mock_config = {"configurable": {"thread_id": thread_id}}
    events = []
    def mock_on_event(event):
        events.append(event)

    # Store state
    store_interrupted_graph(
        thread_id=thread_id,
        graph=mock_graph,
        config=mock_config,
        on_event=mock_on_event,
        conversation_id="conv_123",
    )

    # Verify stored
    assert has_interrupted_graph(thread_id)

    # Retrieve state
    state = retrieve_interrupted_graph(thread_id)
    assert state is not None
    assert state.thread_id == thread_id
    assert state.graph == mock_graph
    assert state.config == mock_config
    assert state.conversation_id == "conv_123"

    # Verify removed after retrieval
    assert not has_interrupted_graph(thread_id)


def test_retrieve_nonexistent_graph():
    """Test retrieving non-existent graph returns None."""
    state = retrieve_interrupted_graph("nonexistent_thread")
    assert state is None


def test_clear_graph():
    """Test clearing interrupted graph state."""
    thread_id = "test_thread_456"

    store_interrupted_graph(
        thread_id=thread_id,
        graph={"mock": "graph"},
        config={},
        on_event=lambda x: None,
    )

    assert has_interrupted_graph(thread_id)

    clear_interrupted_graph(thread_id)

    assert not has_interrupted_graph(thread_id)


def test_thread_safety():
    """Test that registry is thread-safe (basic check)."""
    import threading

    results = []

    def store_thread(tid):
        store_interrupted_graph(
            thread_id=tid,
            graph={"id": tid},
            config={},
            on_event=lambda x: None,
        )
        results.append(f"stored_{tid}")

    def retrieve_thread(tid):
        state = retrieve_interrupted_graph(tid)
        if state:
            results.append(f"retrieved_{tid}")

    threads = []
    for i in range(10):
        t1 = threading.Thread(target=store_thread, args=(f"thread_{i}",))
        t2 = threading.Thread(target=retrieve_thread, args=(f"thread_{i}",))
        threads.extend([t1, t2])

    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Should have 10 stores and up to 10 retrieves (race condition may affect exact count)
    assert len([r for r in results if r.startswith("stored_")]) == 10
    # At least some retrievals should succeed
    assert len([r for r in results if r.startswith("retrieved_")]) > 0
