"""Tests for the in-turn GET de-dup memoizer (api_memo)."""
import json

from ccie_sidecar.agents.api_memo import install_api_memo, wrap_api_call


def _counter_fn(counter, status=200, error=None):
    def fn(method, path, body=None, query_params=None):
        counter["n"] += 1
        return json.dumps({"status_code": status, "data": [{"id": "1"}], "error": error})
    return fn


def test_identical_gets_hit_api_once():
    c = {"n": 0}
    g = {"meraki_api_call": _counter_fn(c)}
    install_api_memo(g)
    f = g["meraki_api_call"]
    f("GET", "/organizations")
    f("GET", "/organizations")
    f("GET", "/organizations")
    assert c["n"] == 1  # 3 identical GETs -> 1 real call


def test_different_paths_not_deduped():
    c = {"n": 0}
    g = {"meraki_api_call": _counter_fn(c)}
    install_api_memo(g)
    f = g["meraki_api_call"]
    f("GET", "/organizations")
    f("GET", "/networks")
    assert c["n"] == 2


def test_query_params_affect_key():
    c = {"n": 0}
    g = {"meraki_api_call": _counter_fn(c)}
    install_api_memo(g)
    f = g["meraki_api_call"]
    f("GET", "/clients", query_params={"timespan": 86400})
    f("GET", "/clients", query_params={"timespan": 3600})  # different -> new call
    assert c["n"] == 2


def test_post_clears_cache():
    c = {"n": 0}
    g = {"meraki_api_call": _counter_fn(c)}
    install_api_memo(g)
    f = g["meraki_api_call"]
    f("GET", "/organizations")      # cached
    f("POST", "/x", body={"a": 1})  # mutating -> clears cache
    f("GET", "/organizations")      # must re-fetch
    assert c["n"] == 3


def test_errors_not_cached():
    c = {"n": 0}
    g = {"ise_api_call": _counter_fn(c, status=404, error="HTTP 404")}
    install_api_memo(g)
    f = g["ise_api_call"]
    f("GET", "/e")
    f("GET", "/e")
    assert c["n"] == 2  # a failed GET is retried, not pinned


def test_install_returns_count_and_only_wraps_api_calls():
    g = {"meraki_api_call": _counter_fn({"n": 0}),
         "ise_api_call": _counter_fn({"n": 0}),
         "drawio": object(), "json": json}
    n = install_api_memo(g)
    assert n == 2
    assert g["meraki_api_call"].__name__ == "memoized"
    assert g["ise_api_call"].__name__ == "memoized"
    assert g["drawio"].__class__ is object  # untouched


def test_shared_store_no_cross_vendor_collision():
    ca, cb = {"n": 0}, {"n": 0}
    g = {"meraki_api_call": _counter_fn(ca), "ise_api_call": _counter_fn(cb)}
    install_api_memo(g)
    # Same method+path on two different vendors must NOT collide.
    g["meraki_api_call"]("GET", "/x")
    g["ise_api_call"]("GET", "/x")
    assert ca["n"] == 1 and cb["n"] == 1
