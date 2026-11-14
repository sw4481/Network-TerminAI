"""Shared HTTP catalog guards distinguish blocked access from bad requests."""
from __future__ import annotations

import json

import pytest

from ccie_sidecar.agents.catalog_grounding import (
    CatalogApiError,
    CatalogGroundingError,
    install_catalog_grounding,
)


class FakeApi:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        return self.response


def _sandbox(response):
    helper = FakeApi(response)
    sandbox = {"synthetic_api_call": helper}
    install_catalog_grounding(sandbox, [{
        "id": "synthetic",
        "entries": [{
            "name": "read-status",
            "description": "Read status",
            "endpoint": {"method": "GET", "path": "/status"},
        }],
    }])
    sandbox["api_catalog"].search("read status", catalog_id="synthetic")
    return sandbox, helper


@pytest.mark.parametrize("status", [0, 401, 403, 407, 408, 429, 500, 503])
@pytest.mark.parametrize("as_json", [False, True])
def test_blocked_access_does_not_recommend_endpoint_hunting(status, as_json):
    response = {"status_code": status, "data": None, "error": "synthetic failure"}
    sandbox, helper = _sandbox(json.dumps(response) if as_json else response)

    with pytest.raises(CatalogApiError) as failure:
        sandbox["synthetic_api_call"]("GET", "/status")

    message = str(failure.value)
    assert "synthetic failure" in message
    assert ("transport/configuration failure" if status == 0 else f"HTTP {status}") in message
    assert "Stop" in message
    assert "endpoint or argument variations" in message
    assert "Retain successful evidence" in message
    assert "blocked or partial coverage" in message
    assert "search_api_catalog" not in message
    assert len(helper.calls) == 1


@pytest.mark.parametrize("status", [0, 401, 403, 404])
def test_duplicate_failure_preserves_original_recovery_without_blind_variants(status):
    sandbox, helper = _sandbox({"status_code": status, "error": "synthetic failure"})
    with pytest.raises(CatalogApiError):
        sandbox["synthetic_api_call"]("GET", "/status")

    with pytest.raises(CatalogGroundingError) as failure:
        sandbox["synthetic_api_call"]("GET", "/status")

    message = str(failure.value)
    assert "already failed" in message
    assert "duplicate network retry blocked" in message
    assert "Follow the original failure guidance" in message
    assert "Retain successful evidence" in message
    assert "blocked or partial coverage" in message
    assert "Search the synthetic catalog" not in message
    assert "change the endpoint or arguments" not in message
    assert len(helper.calls) == 1


@pytest.mark.parametrize("status", [400, 404, 405, 422])
@pytest.mark.parametrize("as_json", [False, True])
def test_request_errors_keep_actionable_catalog_correction(status, as_json):
    response = {"status_code": status, "error": "invalid path or input"}
    sandbox, helper = _sandbox(json.dumps(response) if as_json else response)

    with pytest.raises(CatalogApiError) as failure:
        sandbox["synthetic_api_call"]("GET", "/status")

    message = str(failure.value)
    assert f"HTTP {status}" in message
    assert "invalid path or input" in message
    assert "search_api_catalog" in message
    assert "corrected documented endpoint" in message
    assert len(helper.calls) == 1


@pytest.mark.parametrize("as_json", [False, True])
def test_success_returns_the_original_source_unchanged(as_json):
    response = {"status_code": 200, "data": {"state": "healthy", "source": "synthetic"}}
    source = json.dumps(response) if as_json else response
    sandbox, helper = _sandbox(source)

    assert sandbox["synthetic_api_call"]("GET", "/status") is source
    assert len(helper.calls) == 1
