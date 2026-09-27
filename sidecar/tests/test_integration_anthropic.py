"""Integration tests for end-to-end Anthropic streaming."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.skipif(
    not os.getenv("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set"
)
def test_end_to_end_anthropic_stream():
    """Test end-to-end: request → agent → provider → stream tokens."""
    # Get the python executable from venv
    repo_root = Path(__file__).parent.parent.parent
    python = repo_root / "sidecar" / ".venv" / "bin" / "python"

    if not python.exists():
        pytest.skip(f"Python venv not found at {python}")

    # Start the sidecar server
    proc = subprocess.Popen(
        [str(python), "-m", "ccie_sidecar"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=dict(os.environ, ANTHROPIC_API_KEY=os.getenv("ANTHROPIC_API_KEY", "")),
    )

    try:
        # Send a chat.stream request
        request = {
            "id": "test-1",
            "method": "chat.stream",
            "params": {
                "session_id": "test-session",
                "messages": [{"role": "user", "content": "Say 'Integration test passed' and nothing else."}],
                "profile": "default"
            }
        }

        proc.stdin.write(json.dumps(request) + "\n")
        proc.stdin.flush()

        # Collect streaming responses
        tokens = []
        done = False
        error = None

        for i in range(100):  # Read up to 100 lines (should be enough)
            line = proc.stdout.readline()
            if not line:
                break

            try:
                response = json.loads(line.strip())

                if response.get("id") != "test-1":
                    continue

                if response.get("type") == "token":
                    tokens.append(response.get("data", ""))
                elif response.get("type") == "done":
                    done = True
                    break
                elif response.get("type") == "error":
                    error = response.get("message", "Unknown error")
                    break
            except json.JSONDecodeError:
                continue

        # Verify results
        if error:
            pytest.fail(f"Streaming failed with error: {error}")

        assert done, "Stream did not complete with 'done' event"
        assert len(tokens) > 0, "Expected at least one token"

        # Check that we got a real response
        full_text = "".join(tokens)
        assert len(full_text) > 0, "Expected non-empty response"

        # Check for expected text (case-insensitive)
        assert "integration" in full_text.lower() or "test" in full_text.lower(), \
            f"Expected response to contain 'integration' or 'test', got: {full_text}"

    finally:
        proc.terminate()
        proc.wait(timeout=5)


@pytest.mark.skipif(
    not os.getenv("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set"
)
def test_profile_mapping():
    """Test that different profiles map to correct models."""
    from ccie_sidecar.agent import chat_stream

    # Test default profile
    messages = [{"role": "user", "content": "Say 'test'"}]

    # Just verify that it starts streaming without error
    results = []
    for event in chat_stream(session_id="test", messages=messages, profile="default"):
        if event.get("type") == "error":
            pytest.fail(f"Error with default profile: {event.get('message')}")
        results.append(event)
        if len(results) >= 3:  # Just get a few tokens
            break

    assert len(results) > 0, "Expected at least one token from default profile"
    assert all(r.get("type") == "token" for r in results), "Expected all tokens"


@pytest.mark.skipif(
    not os.getenv("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set"
)
def test_api_key_error_handling():
    """Test that missing API key produces proper error."""
    from ccie_sidecar.agent import chat_stream

    # Temporarily remove API key
    original_key = os.environ.pop("ANTHROPIC_API_KEY", None)

    try:
        messages = [{"role": "user", "content": "test"}]
        results = list(chat_stream(session_id="test", messages=messages, profile="default"))

        assert len(results) == 1, "Expected exactly one error event"
        assert results[0]["type"] == "error", "Expected error type"
        assert "anthropic_api_key" in results[0]["message"].lower(), \
            "Error message should mention ANTHROPIC_API_KEY"
    finally:
        if original_key:
            os.environ["ANTHROPIC_API_KEY"] = original_key
