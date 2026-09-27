"""Plan 15 Phase 5 — symptom-to-playbook matcher.

Turns a free-form symptom string ("BGP neighbor stuck in Idle") into a
ranked list of candidate playbooks.

Algorithm:

1. **BM25** over the searchable text of each playbook
   (``name + symptom_keywords + description``). We implement a small
   BM25 scorer in this module rather than pulling in `rank-bm25` —
   the corpus is small (six builtins + a handful of user playbooks),
   so the overhead of a dependency isn't justified.
2. **Embedding cosine similarity** between the symptom and each
   playbook's joined keyword string, using the ONNX MiniLM-L6 embedder
   from Plan 12 (``ccie_sidecar.rag.embed.Embedder``). Same model the
   RAG ingest path uses; embeddings are L2-normalized so cosine
   similarity is a straight dot product.
3. **Blend:** ``score = 0.4*bm25_norm + 0.6*cosine``. BM25 is min-max
   normalized to [0, 1] across the candidate set so the weights are
   meaningful (raw BM25 has no fixed range). When only BM25 is
   available (embedder import / model files missing), the cosine term
   collapses to 0 and we fall back to ``score = bm25_norm``.
4. **Vendor / platform filter.** A playbook with vendor or platform
   ``'*'`` matches anything. An explicit vendor/platform on the
   playbook excludes it when the caller passes a *different* explicit
   vendor/platform. ``None`` from the caller is treated as "any" so a
   tab without a known vendor still gets the full list.
5. **Top-5.** Sort descending by score, return up to five with
   per-match ``reasons`` strings explaining what fired.

The threshold (0.35) referenced in the plan is enforced UI-side.
This function always returns the top-5 — a sub-threshold result is the
caller's signal to surface the "no good match" pathway.
"""

from __future__ import annotations

import math
import re
from typing import Any, Iterable

# ---------------------------------------------------------------------------
# Tokenization
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    """Lower-case + alphanumeric tokenization.

    Network jargon is full of punctuation (``MM_NO_STATE``, ``2-Way``,
    ``169.254.x.x``), so we split aggressively and let BM25's term
    weighting do the lifting. Numbers are preserved because they
    occasionally carry signal (``169.254`` for APIPA, ``179`` for BGP).
    """
    if not text:
        return []
    return _TOKEN_RE.findall(text.lower())


# ---------------------------------------------------------------------------
# BM25 scorer
# ---------------------------------------------------------------------------


class BM25:
    """Tiny BM25-Okapi scorer over a small in-memory corpus.

    We pre-tokenize once at construction and cache document lengths +
    term frequencies. ``k1`` and ``b`` are the standard BM25 hyperparams;
    the defaults match the original Robertson & Walker paper.
    """

    def __init__(
        self,
        docs: list[list[str]],
        k1: float = 1.5,
        b: float = 0.75,
    ) -> None:
        self.k1 = k1
        self.b = b
        self.docs = docs
        self.N = len(docs)
        # avoid div-by-zero for an empty corpus
        self.avgdl = (sum(len(d) for d in docs) / self.N) if self.N else 0.0
        self.df: dict[str, int] = {}
        for doc in docs:
            for term in set(doc):
                self.df[term] = self.df.get(term, 0) + 1
        self.idf: dict[str, float] = {}
        for term, freq in self.df.items():
            # Standard BM25 IDF; the +1 in the numerator/denominator
            # prevents negative scores when the term is in most documents.
            self.idf[term] = math.log(1 + (self.N - freq + 0.5) / (freq + 0.5))

    def score(self, query: list[str], doc_idx: int) -> float:
        """Score a query against a single document."""
        if doc_idx < 0 or doc_idx >= self.N:
            return 0.0
        doc = self.docs[doc_idx]
        if not doc:
            return 0.0
        dl = len(doc)
        # Term frequency lookup is cheap to recompute; the corpus is
        # tiny so we skip the per-doc cache.
        tf: dict[str, int] = {}
        for term in doc:
            tf[term] = tf.get(term, 0) + 1
        score = 0.0
        for term in query:
            if term not in self.idf:
                continue
            f = tf.get(term, 0)
            if f == 0:
                continue
            denom = f + self.k1 * (1 - self.b + self.b * dl / (self.avgdl or 1.0))
            score += self.idf[term] * (f * (self.k1 + 1)) / (denom or 1.0)
        return score

    def score_all(self, query: list[str]) -> list[float]:
        """Score the query against every document. Returns a list of
        floats in document-order."""
        return [self.score(query, i) for i in range(self.N)]


# ---------------------------------------------------------------------------
# Embedding helpers
# ---------------------------------------------------------------------------


def _try_embedder():
    """Return the process-wide :class:`Embedder` instance or ``None``.

    The embedder import / model files may both be absent (e.g. CI
    without the ONNX weights). Either failure mode degrades the matcher
    to BM25-only — never raises.
    """
    try:
        from ccie_sidecar.rag.embed import Embedder
    except Exception:  # pragma: no cover — onnxruntime missing
        return None
    try:
        return Embedder.get()
    except Exception:
        return None


def _cosine(a, b) -> float:
    """Cosine similarity between two ``(384,)`` numpy vectors."""
    import numpy as np  # local import — numpy is always installed alongside the embedder

    if a is None or b is None:
        return 0.0
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na <= 1e-9 or nb <= 1e-9:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


# ---------------------------------------------------------------------------
# Vendor / platform compatibility
# ---------------------------------------------------------------------------


def _compatible(playbook_value: str, asked: str | None) -> bool:
    """Vendor / platform compatibility test.

    Wildcards on either side match anything. ``asked is None`` is
    treated as a wildcard so a tab without a known vendor still gets
    the full catalogue.
    """
    if not playbook_value or playbook_value == "*":
        return True
    if asked is None or asked == "" or asked == "*":
        return True
    return playbook_value.lower() == asked.lower()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _searchable_text(pb: dict[str, Any]) -> str:
    """Concatenate the fields BM25 / the embedder index for a playbook.

    Joining ``name + keywords + description`` mirrors the plan spec.
    Keywords are space-separated so multi-word phrases ("won't come
    up") still tokenize correctly.
    """
    name = pb.get("name", "") or ""
    keywords = " ".join(pb.get("symptom_keywords", []) or [])
    desc = pb.get("description", "") or ""
    return f"{name} {keywords} {desc}"


def _keywords_text(pb: dict[str, Any]) -> str:
    """Compact embedding text — the keywords + name are the densest
    signal. We deliberately omit `description` from the embedding
    input because the descriptions are long enough to dilute the
    cosine score."""
    name = pb.get("name", "") or ""
    keywords = " ".join(pb.get("symptom_keywords", []) or [])
    return f"{name} {keywords}".strip()


def _norm_minmax(values: list[float]) -> list[float]:
    """Min-max normalize to [0, 1]. Returns all-zeros when the input
    is degenerate (empty or all-equal)."""
    if not values:
        return []
    lo = min(values)
    hi = max(values)
    if hi - lo <= 1e-9:
        return [0.0] * len(values)
    return [(v - lo) / (hi - lo) for v in values]


def _matched_keywords(symptom_tokens: Iterable[str], pb: dict[str, Any]) -> list[str]:
    """Return the playbook keywords whose tokens appear in the symptom.

    Used to populate `reasons` with concrete "keyword 'bgp' matched"
    strings rather than only abstract scores.
    """
    sym_set = set(symptom_tokens)
    out: list[str] = []
    for kw in pb.get("symptom_keywords", []) or []:
        kw_tokens = _tokenize(kw)
        if any(t in sym_set for t in kw_tokens):
            out.append(kw)
    return out


async def match_symptom(
    symptom: str,
    vendor: str | None,
    platform: str | None,
    playbooks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Rank playbooks against a symptom string.

    Args:
        symptom: free-form text from the operator.
        vendor: caller's vendor (e.g. ``"cisco"``); ``None`` treated as
            wildcard.
        platform: caller's platform (e.g. ``"iosxe"``); ``None`` treated
            as wildcard.
        playbooks: list of validated playbook dicts (the same shape
            ``yaml_loader.load_playbook`` returns).

    Returns:
        Up to five ``{id, score, reasons}`` dicts, sorted by score
        descending. ``score`` is a float in roughly [0, 1].
    """
    symptom = (symptom or "").strip()

    # Filter incompatible playbooks first so we don't waste embedding
    # cycles. We keep `excluded_reasons` for callers that may want to
    # surface why a particular playbook was dropped (not currently
    # exposed in the API surface, but cheap to compute).
    candidates: list[dict[str, Any]] = []
    for pb in playbooks:
        v_ok = _compatible(pb.get("vendor", "*"), vendor)
        p_ok = _compatible(pb.get("platform", "*"), platform)
        if v_ok and p_ok:
            candidates.append(pb)

    if not candidates or not symptom:
        return []

    sym_tokens = _tokenize(symptom)

    # ------------------------------------------------------------------
    # BM25
    # ------------------------------------------------------------------
    bm25_docs = [_tokenize(_searchable_text(pb)) for pb in candidates]
    bm25 = BM25(bm25_docs)
    bm25_raw = bm25.score_all(sym_tokens)
    bm25_norm = _norm_minmax(bm25_raw)

    # ------------------------------------------------------------------
    # Embedding cosine
    # ------------------------------------------------------------------
    embedder = _try_embedder()
    cosines: list[float] = [0.0] * len(candidates)
    embedder_used = False
    embedder_warning: str | None = None
    if embedder is not None:
        try:
            sym_vec = embedder.embed_one(symptom)
            pb_texts = [_keywords_text(pb) for pb in candidates]
            pb_vecs = embedder.embed_batch(pb_texts)
            cosines = [_cosine(sym_vec, pb_vecs[i]) for i in range(len(candidates))]
            embedder_used = True
        except Exception as exc:  # pragma: no cover — defensive
            cosines = [0.0] * len(candidates)
            embedder_warning = f"embedder error: {exc}"
    else:
        embedder_warning = (
            "embedder unavailable — fell back to BM25-only ranking"
        )

    # ------------------------------------------------------------------
    # Blend
    # ------------------------------------------------------------------
    matches: list[dict[str, Any]] = []
    for i, pb in enumerate(candidates):
        if embedder_used:
            score = 0.4 * bm25_norm[i] + 0.6 * cosines[i]
        else:
            # When no embedder, rank purely on BM25-norm. The blended
            # 0.4 weight would otherwise depress the maximum to 0.4,
            # which is unhelpful given the 0.35 UI threshold.
            score = bm25_norm[i]

        reasons: list[str] = []
        # Concrete keyword matches first — most actionable for users.
        for kw in _matched_keywords(sym_tokens, pb):
            reasons.append(f"keyword '{kw}' matched")
        # Vendor / platform compatibility annotations (skip wildcards).
        if pb.get("vendor", "*") != "*" and vendor:
            reasons.append(f"vendor {pb['vendor']} compatible")
        if pb.get("platform", "*") != "*" and platform:
            reasons.append(f"platform {pb['platform']} compatible")
        if embedder_used and cosines[i] > 0.4:
            reasons.append(
                f"semantic similarity {cosines[i]:.2f} (embedding match)"
            )
        if embedder_warning:
            reasons.append(embedder_warning)

        matches.append(
            {
                "id": pb["id"],
                "score": float(score),
                "reasons": reasons,
            }
        )

    matches.sort(key=lambda m: m["score"], reverse=True)
    return matches[:5]


__all__ = ["BM25", "match_symptom"]
