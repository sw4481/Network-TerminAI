"""End-to-end NDJSON round-trip for ``rag.ingest``.

Spawns the sidecar as a subprocess, writes a real ``rag.ingest`` request
on stdin, and asserts that:
  - at least one ``rag.ingest.progress`` message is emitted
  - exactly one ``rag.ingest.result`` is emitted, with the right id,
    title, chunk count, and 384-dim embeddings
  - a final ``done`` line closes the stream

Skipped when the bundled ONNX weights are absent — same skip pattern as
``tests/rag/test_embed.py``.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

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
def test_rag_ingest_roundtrip(tmp_path: Path) -> None:
    md = tmp_path / "mini.md"
    # ~200 repetitions of a typical config line gives us >=1 chunk
    # without blowing up the embedder.
    md.write_text("# Title\n\n" + ("interface GigabitEthernet1 " * 200))

    env = os.environ.copy()
    # Quiet the heartbeat so the test doesn't spend time consuming them.
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
            "id": "r1",
            "method": "rag.ingest",
            "params": {"path": str(md), "kind": "md", "title": "mini"},
        }
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()

        got_progress = False
        got_result = False
        got_done = False
        result_payload: dict | None = None

        # Bound the read to avoid hanging on a regression — 60 lines is
        # plenty for our tiny doc (one progress + one result + one done).
        for _ in range(60):
            line = proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Ignore startup heartbeat.
            if msg.get("type") == "sidecar.heartbeat":
                continue

            if msg.get("id") != "r1":
                continue

            mtype = msg.get("type")
            if mtype == "rag.ingest.progress":
                got_progress = True
                payload = msg["payload"]
                assert payload["chunks_total"] >= 1
                assert payload["chunks_done"] <= payload["chunks_total"]
            elif mtype == "rag.ingest.result":
                got_result = True
                result_payload = msg["payload"]
            elif mtype == "done":
                got_done = True
                break
            elif mtype == "error":
                pytest.fail(f"sidecar returned error: {msg.get('message')}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    assert got_progress, "expected at least one rag.ingest.progress line"
    assert got_result, "expected a rag.ingest.result line"
    assert got_done, "expected a final done line"
    assert result_payload is not None
    assert result_payload["title"] == "mini"
    chunks = result_payload["chunks"]
    assert len(chunks) >= 1
    assert chunks[0]["chunk_idx"] == 0
    assert isinstance(chunks[0]["text"], str) and chunks[0]["text"]
    assert len(chunks[0]["embedding"]) == 384
    # Sanity: embeddings should be roughly L2-normalized.
    import math

    norm = math.sqrt(sum(x * x for x in chunks[0]["embedding"]))
    assert abs(norm - 1.0) < 1e-3


def test_rag_ingest_validation_errors(tmp_path: Path) -> None:
    """Bad params return synchronous errors (no streaming)."""
    from ccie_sidecar.server import handle_request

    resp = handle_request({"id": "r2", "method": "rag.ingest", "params": {}})
    assert resp["type"] == "error"
    assert "path" in resp["message"]

    resp = handle_request(
        {
            "id": "r3",
            "method": "rag.ingest",
            "params": {"path": "/x", "kind": "docx", "title": "t"},
        }
    )
    assert resp["type"] == "error"
    assert "kind" in resp["message"]

    resp = handle_request(
        {
            "id": "r4",
            "method": "rag.ingest",
            "params": {"path": "/x", "kind": "md", "title": ""},
        }
    )
    assert resp["type"] == "error"
    assert "title" in resp["message"]
