"""End-to-end NDJSON round-trip for ``rag.embed``.

Spawns the sidecar as a subprocess, sends a ``rag.embed`` request, and
asserts the ``done`` reply carries a 384-dim L2-normalized vector.

Skipped when the bundled ONNX weights are absent — same skip pattern as
``test_rag_ingest_ndjson.py``.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys

import pytest

from ccie_sidecar.rag.embed import MODEL_DIR

_WEIGHTS = MODEL_DIR / "onnx" / "model.onnx"
_TOKENIZER = MODEL_DIR / "tokenizer.json"

_skip_no_weights = pytest.mark.skipif(
    not (_WEIGHTS.exists() and _TOKENIZER.exists()),
    reason=(
        f"MiniLM-L6 weights not present at {MODEL_DIR}; "
        f"run sidecar/scripts/fetch_onnx.py to download them."
    ),
)


@_skip_no_weights
def test_rag_embed_roundtrip() -> None:
    env = os.environ.copy()
    # Quiet the heartbeat so the test doesn't have to filter beats.
    env["CCIE_SIDECAR_HEARTBEAT_S"] = "3600"

    proc = subprocess.Popen(
        [sys.executable, "-m", "ccie_sidecar.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    assert proc.stdin is not None and proc.stdout is not None

    try:
        req = {
            "id": "e1",
            "method": "rag.embed",
            "params": {"text": "how do I reset a BGP session"},
        }
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()

        embedding: list[float] | None = None

        for _ in range(60):
            line = proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "sidecar.heartbeat":
                continue
            if msg.get("id") != "e1":
                continue
            mtype = msg.get("type")
            if mtype == "done":
                embedding = msg["result"]["embedding"]
                break
            if mtype == "error":
                pytest.fail(f"sidecar returned error: {msg.get('message')}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    assert embedding is not None, "expected a `done` reply with embedding"
    assert len(embedding) == 384, f"embedding must be 384-dim, got {len(embedding)}"

    # Sanity: roughly L2-normalized.
    norm = math.sqrt(sum(x * x for x in embedding))
    assert abs(norm - 1.0) < 1e-3, f"embedding must be L2-normalized; norm={norm}"


def test_rag_embed_validation_errors() -> None:
    """Bad params return synchronous errors (no streaming)."""
    from ccie_sidecar.server import handle_request

    resp = handle_request({"id": "e2", "method": "rag.embed", "params": {}})
    assert resp["type"] == "error"
    assert "text" in resp["message"]

    resp = handle_request(
        {"id": "e3", "method": "rag.embed", "params": {"text": ""}}
    )
    assert resp["type"] == "error"
    assert "text" in resp["message"]
