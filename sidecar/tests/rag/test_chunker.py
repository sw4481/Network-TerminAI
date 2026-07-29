"""Tests for ccie_sidecar.rag.chunker."""
from __future__ import annotations

import pytest

from ccie_sidecar.rag.chunker import chunk_text


def test_chunker_respects_target_tokens_and_overlap():
    text = ("Hello world. " * 500).strip()  # ~1000 whitespace tokens
    chunks = chunk_text(text, target_tokens=512, overlap_tokens=64)
    assert len(chunks) >= 2

    # Sliding window invariant: the trailing N tokens of chunk[i] must
    # match the leading N tokens of chunk[i+1] when overlap_tokens=N.
    tail = chunks[0].split()[-64:]
    head = chunks[1].split()[:64]
    assert tail == head


def test_chunker_handles_short_text():
    chunks = chunk_text("short text", target_tokens=512, overlap_tokens=64)
    assert chunks == ["short text"]


def test_chunker_handles_empty_text():
    assert chunk_text("", target_tokens=512, overlap_tokens=64) == []
    assert chunk_text("   \n\t  ", target_tokens=512, overlap_tokens=64) == []


def test_chunker_rejects_invalid_overlap():
    with pytest.raises(ValueError):
        chunk_text("a b c", target_tokens=10, overlap_tokens=10)
    with pytest.raises(ValueError):
        chunk_text("a b c", target_tokens=10, overlap_tokens=11)


def test_chunker_last_window_may_be_short():
    # 1000 tokens, target=512, step=448 (=512-64). Windows start at 0,
    # 448, 896. Window at 896 has 1000-896 = 104 tokens.
    text = " ".join(str(i) for i in range(1000))
    chunks = chunk_text(text, target_tokens=512, overlap_tokens=64)
    assert len(chunks) == 3
    assert len(chunks[-1].split()) == 104
