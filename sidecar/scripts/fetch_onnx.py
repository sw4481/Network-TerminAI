#!/usr/bin/env python3
"""One-shot fetch of MiniLM-L6 ONNX weights used by ``ccie_sidecar.rag.embed``.

Idempotent — safe to re-run; ``snapshot_download`` short-circuits when the
local copy already matches the remote ETags.

Canonical source (verified 2026-05-19):
  https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2

The repository layout we depend on:
  - ``onnx/model.onnx``         (90 MB, fp32 export)
  - ``tokenizer.json``           (root)
  - ``config.json``              (root)
  - ``special_tokens_map.json``  (root)
  - ``vocab.txt``                (root)

Called from ``sidecar/scripts/build_sidecar.sh`` BEFORE the sidecar is
installed into the bundled ``python-build-standalone`` tree, so the model
files ride along inside the wheel via the standard package path
(``ccie_sidecar/rag/models/all-MiniLM-L6-v2/...``).

Requires ``huggingface-hub`` — declared as a build-only optional dep in
``pyproject.toml`` (``[project.optional-dependencies] build``).
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO = "sentence-transformers/all-MiniLM-L6-v2"
# Pin to a specific commit so build outputs are bit-for-bit reproducible
# even if upstream `main` advances. Verified 2026-05-19 against
#   https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/commit/c9745ed1d9f207416be6d2e6f8de32d1f16199bf
# (latest `main` as of that date — Mar 6, 2025 commit by tomaarsen).
REVISION = "c9745ed1d9f207416be6d2e6f8de32d1f16199bf"
DEST = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "ccie_sidecar"
    / "rag"
    / "models"
    / "all-MiniLM-L6-v2"
)

# Files we care about. ``allow_patterns`` is a whitelist passed to
# ``snapshot_download`` — anything not in this list is skipped, which keeps
# the bundle small (we only want the fp32 ONNX, not the seven quantized
# variants the repo also ships).
ALLOW_PATTERNS = [
    "onnx/model.onnx",
    "tokenizer.json",
    "config.json",
    "special_tokens_map.json",
    "vocab.txt",
]


def main() -> int:
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print(
            "error: huggingface_hub is required. Install with:\n"
            "  pip install -e '.[build]'\n"
            "(this is a build-only dep — not shipped to end users).",
            file=sys.stderr,
        )
        return 2

    DEST.mkdir(parents=True, exist_ok=True)
    print(f">> fetching {REPO}@{REVISION[:12]} -> {DEST}")
    snapshot_download(
        repo_id=REPO,
        revision=REVISION,
        local_dir=str(DEST),
        allow_patterns=ALLOW_PATTERNS,
    )

    # Sanity-check: the embedder loads onnx/model.onnx and tokenizer.json.
    required = [DEST / "onnx" / "model.onnx", DEST / "tokenizer.json"]
    missing = [p for p in required if not p.exists()]
    if missing:
        print(f"error: required files missing after download: {missing}", file=sys.stderr)
        return 1

    print(f">> wrote weights to {DEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
