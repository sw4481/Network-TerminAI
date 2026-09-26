"""RAG (retrieval-augmented generation) primitives for the CCIE sidecar.

Phase 2 of Plan 12 — Vendor-Aware Completion. Provides:

- ``chunker``: whitespace-token sliding-window chunking.
- ``extract``: text extraction from pdf/html/md/txt sources.
- ``embed``:  ONNX MiniLM-L6-v2 embedder singleton (384-dim, L2-normalized).
"""
