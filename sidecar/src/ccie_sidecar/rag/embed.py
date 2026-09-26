"""ONNX MiniLM-L6-v2 embedder singleton.

Produces 384-dim L2-normalized float32 embeddings using the same
mean-pool + normalize recipe as the sentence-transformers reference.
The model files are bundled into the sidecar wheel via
``sidecar/scripts/fetch_onnx.py`` (called from ``build_sidecar.sh``);
see ``sidecar/src/ccie_sidecar/rag/models/all-MiniLM-L6-v2/``.

Singleton pattern: ``Embedder.get()`` returns the process-wide instance,
keeping the ONNX session and tokenizer warm across calls. Construction
is lazy and thread-safe.
"""
from __future__ import annotations

from pathlib import Path
from threading import Lock

import numpy as np

# Resolved at module import time, but the model files don't have to exist
# until the first ``Embedder()`` call — supports test skips when weights
# aren't present.
MODEL_DIR = Path(__file__).parent / "models" / "all-MiniLM-L6-v2"


class Embedder:
    """Process-wide ONNX MiniLM-L6 embedder."""

    _instance: "Embedder | None" = None
    _lock: Lock = Lock()

    def __init__(self) -> None:
        # Imported lazily so onnxruntime / tokenizers are not loaded on
        # sidecar startup unless RAG is actually used.
        import onnxruntime as ort
        from tokenizers import Tokenizer

        model_path = MODEL_DIR / "onnx" / "model.onnx"
        tokenizer_path = MODEL_DIR / "tokenizer.json"
        if not model_path.exists() or not tokenizer_path.exists():
            raise FileNotFoundError(
                f"MiniLM-L6 weights not found at {MODEL_DIR}. "
                f"Run sidecar/scripts/fetch_onnx.py to download them."
            )

        self.tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        self.session = ort.InferenceSession(
            str(model_path),
            providers=["CPUExecutionProvider"],
        )

    @classmethod
    def get(cls) -> "Embedder":
        """Return the process-wide ``Embedder`` instance, building it if needed."""
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def embed_batch(self, texts: list[str]) -> np.ndarray:
        """Encode ``texts`` to a ``(N, 384)`` float32 L2-normalized matrix.

        Implements the sentence-transformers reference:
          1. Tokenize with padding + truncation.
          2. Run the ONNX model to get token embeddings ``[B, T, 384]``.
          3. Mean-pool along the sequence axis using the attention mask
             so padded tokens don't contribute.
          4. L2-normalize each row.
        """
        if not texts:
            return np.zeros((0, 384), dtype=np.float32)

        enc = self.tokenizer.encode_batch(texts)
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        ttids = np.zeros_like(ids)
        out = self.session.run(
            None,
            {
                "input_ids": ids,
                "attention_mask": mask,
                "token_type_ids": ttids,
            },
        )[0]  # [B, T, 384]

        # Mean-pool with attention mask.
        mask_f = mask[..., None].astype(np.float32)
        summed = (out * mask_f).sum(axis=1)
        counts = mask_f.sum(axis=1).clip(min=1e-9)
        pooled = summed / counts  # [B, 384]

        # L2-normalize.
        norms = np.linalg.norm(pooled, axis=1, keepdims=True).clip(min=1e-9)
        return (pooled / norms).astype(np.float32)

    def embed_one(self, text: str) -> np.ndarray:
        """Encode a single string to a ``(384,)`` float32 vector."""
        return self.embed_batch([text])[0]
