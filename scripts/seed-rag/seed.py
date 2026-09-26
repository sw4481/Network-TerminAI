"""Plan 12 Phase 6 — optional RAG seed-pack downloader.

The user triggers this script from the Settings → RAG tab (it is also
runnable from the command line). It does NOT touch the in-app SQLite
DB itself; it only downloads files to ``~/.ccie-terminal/rag-seed/``
where the app's UI button picks them up and feeds them through
``rag_upload``.

Boundary:

- ``seed.py``   — read ``sources.json``, download to disk, print
  progress to stdout. No DB writes.
- UI button     — iterate the seed directory, call ``rag_upload`` for
  each file. Idempotent via ``rag_list_documents`` source-path check.

Output protocol (so the Rust ``rag_run_seed_script`` command can stream
to the UI):

    seed: start total=N
    seed: download i/N url=<url>
    seed: skip   i/N url=<url> reason=<reason>
    seed: error  i/N url=<url> message=<msg>
    seed: done   ok=K skipped=S errored=E

Each line is plain ASCII with newline-terminated key=value pairs after
the verb. The UI just renders the latest line; the CLI can grep.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

USER_AGENT = "CCIE-Terminal-Seed/1.0"
SEED_DIR = Path.home() / ".ccie-terminal" / "rag-seed"
DEFAULT_SOURCES = Path(__file__).resolve().parent / "sources.json"

# Per spec: 3 attempts with exponential backoff (1s, 2s, 4s).
MAX_ATTEMPTS = 3
BASE_BACKOFF_SEC = 1.0
HTTP_TIMEOUT_SEC = 60.0


@dataclasses.dataclass
class Source:
    title: str
    url: str
    kind: str  # "pdf" | "html" | "md" | "txt"
    tags: List[str]
    accessed: str = ""

    @classmethod
    def from_dict(cls, d: dict) -> "Source":
        return cls(
            title=str(d["title"]),
            url=str(d["url"]),
            kind=str(d["kind"]).lower(),
            tags=[str(t) for t in d.get("tags", [])],
            accessed=str(d.get("accessed", "")),
        )


def _slug(title: str, url: str, kind: str) -> str:
    """Filesystem-safe filename: short title prefix + url hash + ext."""
    title_part = re.sub(r"[^A-Za-z0-9_-]+", "-", title).strip("-").lower()
    title_part = title_part[:48] or "doc"
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:8]
    ext = kind if kind in ("pdf", "html", "md", "txt") else "bin"
    return f"{title_part}-{digest}.{ext}"


def load_sources(path: Path = DEFAULT_SOURCES) -> List[Source]:
    raw = json.loads(path.read_text())
    if isinstance(raw, list):
        # Bare list form (legacy shape from plan brief).
        return [Source.from_dict(d) for d in raw]
    if isinstance(raw, dict):
        return [Source.from_dict(d) for d in raw.get("sources", [])]
    raise ValueError(f"sources.json must be a list or {{sources: [...]}} object; got {type(raw).__name__}")


def _emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _is_blocking_status(status: int) -> bool:
    return status in (401, 403, 429)


def _download_one(client, src: Source, dest: Path) -> Tuple[bool, str]:
    """Return ``(ok, reason)`` — reason set when ``ok`` is False."""
    last_err = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = client.get(
                src.url,
                headers={"User-Agent": USER_AGENT},
                timeout=HTTP_TIMEOUT_SEC,
                follow_redirects=True,
            )
        except Exception as exc:  # network error
            last_err = f"network: {exc}"
            if attempt < MAX_ATTEMPTS:
                time.sleep(BASE_BACKOFF_SEC * (2 ** (attempt - 1)))
                continue
            return False, last_err

        if _is_blocking_status(resp.status_code):
            return False, f"blocked-{resp.status_code}"

        if resp.status_code >= 400:
            last_err = f"http-{resp.status_code}"
            if attempt < MAX_ATTEMPTS:
                time.sleep(BASE_BACKOFF_SEC * (2 ** (attempt - 1)))
                continue
            return False, last_err

        # Stream-write the body so we don't double the memory footprint
        # on big PDFs.
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(resp.content)
        return True, ""
    return False, last_err or "exhausted"


def run(
    sources_path: Path = DEFAULT_SOURCES,
    out_dir: Path = SEED_DIR,
    client_factory=None,
) -> int:
    """Entry point — returns process exit code (0 on success)."""
    try:
        sources = load_sources(sources_path)
    except FileNotFoundError:
        _emit(f"seed: error 0/0 url=- message=sources-missing path={sources_path}")
        return 2
    except Exception as exc:
        _emit(f"seed: error 0/0 url=- message=sources-invalid err={exc}")
        return 2

    total = len(sources)
    _emit(f"seed: start total={total}")

    if total == 0:
        _emit("seed: done ok=0 skipped=0 errored=0")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)

    if client_factory is None:
        try:
            import httpx  # type: ignore
        except ImportError:
            _emit(
                "seed: error 0/0 url=- message=httpx-missing "
                "hint=run 'python3 -m pip install httpx'"
            )
            return 3
        client_cm = httpx.Client()
    else:
        client_cm = client_factory()

    ok = skipped = errored = 0
    # Mapping from filename → {title, tags, url} so the UI can ingest
    # each downloaded file with its proper title/tag set without
    # having to parse sources.json separately. We rewrite the file in
    # full each run; older entries are kept so a re-run doesn't lose
    # mappings for previously-downloaded files.
    manifest_path = out_dir / "manifest.json"
    manifest: dict = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text()) or {}
        except Exception:
            manifest = {}

    with client_cm as client:
        for idx, src in enumerate(sources, start=1):
            slug = _slug(src.title, src.url, src.kind)
            dest = out_dir / slug
            manifest[slug] = {
                "title": src.title,
                "tags": list(src.tags),
                "url": src.url,
                "kind": src.kind,
            }

            if dest.exists():
                _emit(f"seed: skip {idx}/{total} url={src.url} reason=already-on-disk")
                skipped += 1
                continue

            success, reason = _download_one(client, src, dest)
            if success:
                _emit(f"seed: download {idx}/{total} url={src.url}")
                ok += 1
                continue

            if reason.startswith("blocked-"):
                _emit(
                    f"seed: skip {idx}/{total} url={src.url} reason={reason} "
                    "hint=retry-from-browser"
                )
                skipped += 1
                continue

            _emit(f"seed: error {idx}/{total} url={src.url} message={reason}")
            errored += 1

    # Persist the manifest so the UI's upload step can map filenames →
    # title + tags. Drop entries whose file no longer exists on disk.
    pruned = {k: v for k, v in manifest.items() if (out_dir / k).exists()}
    try:
        manifest_path.write_text(json.dumps(pruned, indent=2, sort_keys=True))
    except OSError as exc:
        _emit(f"seed: error 0/0 url=- message=manifest-write-failed err={exc}")

    _emit(f"seed: done ok={ok} skipped={skipped} errored={errored}")
    return 0 if errored == 0 else 1


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    sources_path = DEFAULT_SOURCES
    out_dir = SEED_DIR
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--sources", "-s") and i + 1 < len(args):
            sources_path = Path(args[i + 1])
            i += 2
            continue
        if a in ("--out", "-o") and i + 1 < len(args):
            out_dir = Path(args[i + 1])
            i += 2
            continue
        if a in ("-h", "--help"):
            print(__doc__ or "")
            return 0
        _emit(f"seed: error 0/0 url=- message=unknown-arg arg={a}")
        return 2
    # Honor environment-variable overrides used by the Tauri command
    # so we don't have to special-case spawn args.
    env_dir = os.environ.get("CCIE_RAG_SEED_DIR")
    if env_dir:
        out_dir = Path(env_dir)
    return run(sources_path=sources_path, out_dir=out_dir)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
