"""Tests for ccie_sidecar.rag.extract."""
from __future__ import annotations

from pathlib import Path

import pytest

from ccie_sidecar.rag.extract import extract_text

FIXTURE_DIR = Path(__file__).parent.parent / "fixtures" / "rag"


def test_extract_md_returns_clean_text():
    out = extract_text(str(FIXTURE_DIR / "tiny.md"), "md")
    assert len(out) > 100
    assert "Cisco IOS-XE" in out


def test_extract_txt_returns_clean_text():
    out = extract_text(str(FIXTURE_DIR / "tiny.txt"), "txt")
    assert len(out) > 100
    assert "show running-config" in out


def test_extract_html_strips_tags():
    out = extract_text(str(FIXTURE_DIR / "tiny.html"), "html")
    assert len(out) > 100
    assert "Cisco IOS-XE" in out
    # Tags should be gone after BeautifulSoup parsing.
    assert "<html>" not in out
    assert "<body>" not in out


def test_extract_pdf_returns_clean_text():
    out = extract_text(str(FIXTURE_DIR / "tiny.pdf"), "pdf")
    assert len(out) > 100
    assert "Cisco IOS-XE" in out
    # Sanity: pypdf should give plain text, not raw stream operators.
    assert "stream" not in out.lower() or "Lorem ipsum" in out


def test_extract_unknown_kind_raises():
    with pytest.raises(ValueError):
        extract_text(str(FIXTURE_DIR / "tiny.txt"), "docx")


def test_extract_missing_file_raises():
    with pytest.raises(FileNotFoundError):
        extract_text("/no/such/path.md", "md")
