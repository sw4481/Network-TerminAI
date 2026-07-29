"""Tests for ccie_sidecar.rag.embed.Embedder.

Auto-skips when the bundled ONNX weights are absent (e.g. fresh clone
that hasn't yet run ``scripts/fetch_onnx.py``). The skip message tells
the developer how to fetch them.
"""
from __future__ import annotations

import numpy as np
import pytest

from ccie_sidecar.rag.embed import MODEL_DIR

_WEIGHTS = MODEL_DIR / "onnx" / "model.onnx"
_TOKENIZER = MODEL_DIR / "tokenizer.json"

pytestmark = pytest.mark.skipif(
    not (_WEIGHTS.exists() and _TOKENIZER.exists()),
    reason=(
        f"MiniLM-L6 weights not present at {MODEL_DIR}; "
        f"run sidecar/scripts/fetch_onnx.py to download them."
    ),
)


def test_embed_returns_384_normalized():
    from ccie_sidecar.rag.embed import Embedder

    emb = Embedder.get()
    v = emb.embed_one("show ip bgp summary")
    assert v.shape == (384,)
    assert v.dtype == np.float32
    # all-MiniLM embeddings are L2-normalized; we explicitly normalize.
    assert abs(np.linalg.norm(v) - 1.0) < 1e-5


def test_embed_batch_is_consistent_with_single():
    from ccie_sidecar.rag.embed import Embedder

    emb = Embedder.get()
    texts = ["interface GigabitEthernet1", "router bgp 65001"]
    batch = emb.embed_batch(texts)
    singles = np.stack([emb.embed_one(t) for t in texts])
    assert batch.shape == (2, 384)
    np.testing.assert_allclose(batch, singles, atol=1e-5)


def test_embed_batch_empty_returns_empty():
    from ccie_sidecar.rag.embed import Embedder

    emb = Embedder.get()
    out = emb.embed_batch([])
    assert out.shape == (0, 384)
    assert out.dtype == np.float32
