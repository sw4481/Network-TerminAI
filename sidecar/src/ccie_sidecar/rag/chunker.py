"""Whitespace-token sliding-window chunker.

Token approximation: we use ``str.split()`` (whitespace) as a cheap proxy
for the real BERT WordPiece tokenizer. MiniLM-L6-v2's true context window
is 512 WordPiece tokens; whitespace tokens are typically a slight
underestimate of WordPiece, so a 512-word target stays comfortably below
the model limit while keeping chunker logic dependency-free.

The real embedder (see ``ccie_sidecar.rag.embed``) uses the model's own
tokenizer with truncation enabled, so even a chunk that overshoots is
handled safely — the chunker's job is to keep chunks roughly the right
size and produce overlapping windows that preserve cross-boundary
context.
"""
from __future__ import annotations


def chunk_text(
    text: str,
    target_tokens: int = 512,
    overlap_tokens: int = 64,
) -> list[str]:
    """Split ``text`` into overlapping word-windows.

    - Empty / whitespace-only input returns ``[]``.
    - Input shorter than ``target_tokens`` words returns ``[text]``
      verbatim (no chunking, no normalization).
    - Otherwise emits sliding windows of ``target_tokens`` words advancing
      by ``target_tokens - overlap_tokens`` words. The final window may be
      shorter than ``target_tokens`` if the document doesn't divide
      evenly.

    Args:
        text: Source text. Whitespace-tokenized via ``str.split()``.
        target_tokens: Words per chunk. MiniLM's WordPiece limit is 512;
            keep this <=512 unless the embedder truncation is being
            relied on.
        overlap_tokens: Words shared between consecutive chunks. Must be
            strictly less than ``target_tokens``.

    Returns:
        List of chunk strings. Always non-empty for non-empty input.
    """
    if overlap_tokens >= target_tokens:
        raise ValueError(
            f"overlap_tokens ({overlap_tokens}) must be < target_tokens "
            f"({target_tokens})"
        )

    words = text.split()
    if not words:
        return []
    if len(words) <= target_tokens:
        return [text]

    out: list[str] = []
    step = target_tokens - overlap_tokens
    i = 0
    while i < len(words):
        window = words[i : i + target_tokens]
        out.append(" ".join(window))
        if i + target_tokens >= len(words):
            break
        i += step
    return out
