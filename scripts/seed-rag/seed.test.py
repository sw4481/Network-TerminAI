"""Plan 12 Phase 6 — pytest suite for the seed downloader.

Mocks ``httpx`` entirely; never touches the network. The test suite
skips itself if pytest isn't installed in the local interpreter.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import List, Optional

import pytest  # type: ignore

# Bring `seed.py` (sibling file) onto the import path.
THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))

import seed  # noqa: E402


# ---------------------------------------------------------------------------
# httpx mocks


class _Resp:
    def __init__(self, status_code: int = 200, content: bytes = b"PDFDATA"):
        self.status_code = status_code
        self.content = content


class _Recorder:
    """Records `client.get` calls and replays a pre-seeded response queue."""

    def __init__(self, responses: List[_Resp]):
        self._responses = list(responses)
        self.calls: List[dict] = []

    def __enter__(self) -> "_Recorder":
        return self

    def __exit__(self, *exc) -> None:
        return None

    def get(self, url, headers=None, timeout=None, follow_redirects=False):
        self.calls.append(
            {
                "url": url,
                "headers": dict(headers or {}),
                "timeout": timeout,
                "follow_redirects": follow_redirects,
            }
        )
        if not self._responses:
            raise RuntimeError("recorder out of canned responses")
        nxt = self._responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def _make_sources_file(tmp: Path, entries: List[dict]) -> Path:
    p = tmp / "sources.json"
    p.write_text(json.dumps({"sources": entries}))
    return p


# ---------------------------------------------------------------------------
# Tests


def test_reads_sources_and_downloads(tmp_path, capsys, monkeypatch):
    src = _make_sources_file(
        tmp_path,
        [
            {
                "title": "Sample PDF",
                "url": "https://example.com/sample.pdf",
                "kind": "pdf",
                "tags": ["generic"],
            }
        ],
    )
    out = tmp_path / "rag-seed"
    rec = _Recorder([_Resp(200, b"%PDF-1.4 fake")])

    rc = seed.run(sources_path=src, out_dir=out, client_factory=lambda: rec)
    assert rc == 0

    # Header sent on every request.
    assert rec.calls, "client.get was never called"
    assert rec.calls[0]["headers"]["User-Agent"] == "CCIE-Terminal-Seed/1.0"
    assert rec.calls[0]["follow_redirects"] is True

    # File on disk (excluding the manifest).
    files = sorted(p for p in out.iterdir() if p.name != "manifest.json")
    assert len(files) == 1
    assert files[0].read_bytes() == b"%PDF-1.4 fake"

    # Manifest carries the title/tags so the UI can ingest with the
    # right metadata.
    manifest = json.loads((out / "manifest.json").read_text())
    assert len(manifest) == 1
    only = next(iter(manifest.values()))
    assert only["title"] == "Sample PDF"
    assert only["tags"] == ["generic"]

    out_text = capsys.readouterr().out
    assert "seed: start total=1" in out_text
    assert "seed: download 1/1" in out_text
    assert "seed: done ok=1 skipped=0 errored=0" in out_text


def test_skips_already_downloaded(tmp_path, capsys):
    src = _make_sources_file(
        tmp_path,
        [
            {
                "title": "Sample PDF",
                "url": "https://example.com/sample.pdf",
                "kind": "pdf",
                "tags": ["generic"],
            }
        ],
    )
    out = tmp_path / "rag-seed"
    out.mkdir()
    # Pre-stage the destination filename the slug helper will produce.
    dest = out / seed._slug("Sample PDF", "https://example.com/sample.pdf", "pdf")
    dest.write_bytes(b"already-here")

    rec = _Recorder([])  # we expect zero GETs
    rc = seed.run(sources_path=src, out_dir=out, client_factory=lambda: rec)
    assert rc == 0
    assert rec.calls == []

    out_text = capsys.readouterr().out
    assert "reason=already-on-disk" in out_text
    assert "ok=0 skipped=1 errored=0" in out_text
    # File untouched.
    assert dest.read_bytes() == b"already-here"


@pytest.mark.parametrize("status", [403, 429])
def test_blocked_status_logs_and_skips(tmp_path, capsys, status):
    src = _make_sources_file(
        tmp_path,
        [
            {
                "title": "Blocked",
                "url": "https://blocked.example/doc.pdf",
                "kind": "pdf",
                "tags": ["generic"],
            }
        ],
    )
    out = tmp_path / "rag-seed"
    rec = _Recorder([_Resp(status, b"")])

    rc = seed.run(sources_path=src, out_dir=out, client_factory=lambda: rec)
    # 403/429 are friendly skips, not errors → exit 0.
    assert rc == 0
    out_text = capsys.readouterr().out
    assert f"reason=blocked-{status}" in out_text
    assert "hint=retry-from-browser" in out_text
    assert "ok=0 skipped=1 errored=0" in out_text
    # No download file written. The manifest is still emitted but
    # contains zero entries (the blocked file wasn't on disk to keep).
    files = [p for p in out.iterdir() if p.name != "manifest.json"]
    assert files == []
    manifest_path = out / "manifest.json"
    if manifest_path.exists():
        assert json.loads(manifest_path.read_text()) == {}


def test_network_error_retries_three_times_then_errors(tmp_path, capsys, monkeypatch):
    src = _make_sources_file(
        tmp_path,
        [
            {
                "title": "Flaky",
                "url": "https://flaky.example/doc.pdf",
                "kind": "pdf",
                "tags": ["generic"],
            }
        ],
    )
    out = tmp_path / "rag-seed"
    boom = ConnectionError("kaboom")
    rec = _Recorder([boom, boom, boom])
    # Skip the actual sleeps so the test stays fast.
    monkeypatch.setattr(seed.time, "sleep", lambda *_a, **_kw: None)

    rc = seed.run(sources_path=src, out_dir=out, client_factory=lambda: rec)
    assert rc == 1  # any errored entry => non-zero
    assert len(rec.calls) == 3, "must retry exactly MAX_ATTEMPTS times"
    out_text = capsys.readouterr().out
    assert "seed: error 1/1" in out_text
    assert "ok=0 skipped=0 errored=1" in out_text


def test_network_error_then_success(tmp_path, capsys, monkeypatch):
    src = _make_sources_file(
        tmp_path,
        [
            {
                "title": "Recovers",
                "url": "https://recovers.example/doc.pdf",
                "kind": "pdf",
                "tags": ["generic"],
            }
        ],
    )
    out = tmp_path / "rag-seed"
    rec = _Recorder([ConnectionError("flaky"), _Resp(200, b"hi")])
    monkeypatch.setattr(seed.time, "sleep", lambda *_a, **_kw: None)

    rc = seed.run(sources_path=src, out_dir=out, client_factory=lambda: rec)
    assert rc == 0
    assert len(rec.calls) == 2
    out_text = capsys.readouterr().out
    assert "seed: download 1/1" in out_text


def test_missing_sources_file_errors_cleanly(tmp_path, capsys):
    rc = seed.run(sources_path=tmp_path / "no-such.json", out_dir=tmp_path / "out")
    assert rc == 2
    assert "sources-missing" in capsys.readouterr().out


def test_slug_is_filesystem_safe():
    s = seed._slug("Cisco IOS / XE — 17.x !!", "https://example.com/x", "pdf")
    # No spaces, slashes, or punctuation that would break a path.
    assert "/" not in s
    assert " " not in s
    assert s.endswith(".pdf")
    assert len(s.split(".")[0]) <= 48 + 1 + 8  # title prefix + dash + hash
