"""In-turn GET de-duplication for vendor `*_api_call` sandbox helpers.

Observed failure: an agent hit identical `GET /organizations` 3x and
`GET /organizations/{org}/networks` 3x within a SINGLE turn before finally
issuing the device call. Re-fetching identical discovery data in one turn is
pure waste (latency + tokens). This wraps each already-bound `{vendor}_api_call`
global with a memoizer that returns the first result for an identical GET within
the same sandbox lifetime.

Design constraints honored:
- **Vendor-agnostic:** keys on the call signature (name, method, path, body,
  query_params), NEVER on parsing the vendor response. One wrapper covers all
  11 vendors + every current/future agent.
- **Zero stale risk:** only GETs are memoized, and the cache lives for the
  sandbox instance (one turn/session), so it can never serve data older than
  the turn. Non-GET (POST/PUT/DELETE) always executes and CLEARS the cache
  (a write may change subsequent reads).
- **Transparent:** on any error, or a non-cacheable shape, it just calls
  through. Wrapping is a no-op unless enabled.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict


def _sig(name: str, method: str, path: str, body: Any, query_params: Any) -> str:
    """Stable cache key for one call. json.dumps with sort_keys so dict order
    doesn't matter; default=str tolerates non-serializable args."""
    try:
        return json.dumps(
            [name, (method or "GET").upper(), path, body, query_params],
            sort_keys=True, default=str,
        )
    except Exception:
        return f"{name}|{method}|{path}|{body!r}|{query_params!r}"


def wrap_api_call(name: str, fn: Callable[..., str], store: Dict[str, str]) -> Callable[..., str]:
    """Return a memoizing wrapper around a `{vendor}_api_call` closure.

    `store` is a shared per-sandbox dict (all vendors share it; the key includes
    the vendor name so there's no cross-vendor collision).
    """

    # If fn is already a memoizer (re-wrap can happen when the architect builds
    # the sandbox per-vendor, or a module alias points back at a wrapper),
    # return it unchanged — wrapping must be idempotent to avoid infinite
    # recursion through the `import <vendor>_api` module attribute.
    if getattr(fn, "_ccie_memoized", False):
        return fn

    def memoized(method: str, path: str, body: Any = None,
                 query_params: Any = None, *args: Any, **kwargs: Any) -> str:
        m = (method or "GET").upper()
        # Only GETs are cached; a mutating call clears the cache because it may
        # invalidate previously-read data.
        if m != "GET":
            store.clear()
            return fn(method, path, body, query_params, *args, **kwargs)

        key = _sig(name, m, path, body, query_params)
        if key in store:
            return store[key]
        result = fn(method, path, body, query_params, *args, **kwargs)
        # Only cache successful reads; never cache an error so a transient
        # failure isn't pinned for the rest of the turn.
        try:
            parsed = json.loads(result)
            ok = isinstance(parsed, dict) and (parsed.get("status_code", 0) or 0) < 400 \
                and not parsed.get("error")
        except Exception:
            ok = False
        if ok:
            store[key] = result
        return result

    memoized._ccie_memoized = True  # type: ignore[attr-defined]
    return memoized


def install_api_memo(globals_dict: Dict[str, Any]) -> int:
    """Wrap every bound `*_api_call` global in `globals_dict` with the memoizer.

    Called once in _build_sandbox_globals AFTER the vendor install_* calls, so it
    covers whatever vendor(s) got bound — no per-vendor code, no vendor-module
    changes. Returns the count wrapped (for logging/tests). Also rebinds any
    matching `import <vendor>_api` module attribute so both call paths dedup.
    """
    # Reuse a single shared store across all vendors in this sandbox so multiple
    # _build_sandbox_globals passes (the architect builds per-vendor) accumulate
    # into one cache rather than fragmenting. Wrapping is idempotent
    # (wrap_api_call returns already-memoized fns unchanged), so repeated passes
    # are safe. We deliberately do NOT touch sys.modules aliases — the sandbox
    # calls the global `*_api_call`, and rebinding the module attr created a
    # wrapper->module->wrapper recursion.
    store: Dict[str, str] = globals_dict.setdefault("_ccie_api_memo_store", {})
    wrapped = 0
    # Zabbix is JSON-RPC: its helper contract is (method, params), while this
    # HTTP memoizer invokes (method, path, body, query_params). Wrapping it
    # changes a valid two-argument call into a broken four-argument call.
    excluded_helpers = {"zabbix_api_call"}
    for gname, fn in list(globals_dict.items()):
        if gname.endswith("_api_call") and callable(fn) \
                and gname not in excluded_helpers \
                and not getattr(fn, "_ccie_memoized", False):
            globals_dict[gname] = wrap_api_call(gname, fn, store)
            wrapped += 1
    return wrapped
