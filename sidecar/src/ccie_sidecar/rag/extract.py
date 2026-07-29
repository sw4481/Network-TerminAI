"""Text extraction for RAG ingestion sources.

Supported kinds:
  - ``pdf``  — via ``pypdf``
  - ``html`` — via ``BeautifulSoup`` + ``lxml`` parser
  - ``md``   — raw read (markdown structure preserved for the LLM)
  - ``txt``  — raw read

Unknown kinds raise ``ValueError`` so callers can surface a clean error
to the UI instead of silently dropping the document.
"""
from __future__ import annotations

from pathlib import Path


def extract_text(path: str, kind: str) -> str:
    """Extract plain text from a document.

    Args:
        path: Filesystem path. Must exist and be readable.
        kind: One of ``pdf``, ``html``, ``md``, ``txt``.

    Returns:
        Extracted text. May contain newlines but is otherwise a single
        string; the chunker is responsible for further segmentation.

    Raises:
        ValueError: ``kind`` is not in the supported set.
        FileNotFoundError: ``path`` does not exist.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(path)

    if kind == "pdf":
        from pypdf import PdfReader

        reader = PdfReader(str(p))
        return "\n".join((page.extract_text() or "") for page in reader.pages)

    if kind == "html":
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(
            p.read_text(encoding="utf-8", errors="replace"),
            "lxml",
        )
        return soup.get_text("\n")

    if kind in ("md", "txt"):
        # Markdown is kept raw — chunks retain ## headings and other
        # lightweight structure that the LLM can use for context.
        return p.read_text(encoding="utf-8", errors="replace")

    raise ValueError(f"unsupported kind: {kind!r}")
