"""Cross-helper integration test: the shared error-surfacing change is wired in.

Guards the two behaviours that matter across every vendor REST helper:
1. A generic 4xx now carries the vendor's own message (not a bare "HTTP 400").
2. Helpers that had a custom 401/403 auth message keep it (the shared enricher
   only touches the generic `>= 400` branch).

Uses fake sessions so no live device is needed.
"""

import pytest

from ccie_sidecar.netbox import NetboxClient


class _FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _FakeSession:
    def __init__(self, response):
        self._response = response
        self.headers = {}

    def request(self, **_kwargs):
        return self._response


def _netbox_with(response):
    client = NetboxClient({"url": "https://nb.example", "token": "t"})
    client._session = _FakeSession(response)
    return client


def test_netbox_generic_400_surfaces_message():
    resp = _FakeResponse(400, {"detail": "Invalid filter: foo"})
    result = _netbox_with(resp).call("GET", "/api/dcim/devices/")
    assert result["error"] == "HTTP 400: Invalid filter: foo"


def test_netbox_401_keeps_custom_auth_message():
    # The custom auth branch must win over the generic enricher.
    resp = _FakeResponse(401, {"detail": "Invalid token"})
    result = _netbox_with(resp).call("GET", "/api/dcim/devices/")
    assert result["error"] == "Authentication failed. Check the API token in Settings → NetBox."


def test_netbox_success_no_error():
    resp = _FakeResponse(200, {"results": []})
    result = _netbox_with(resp).call("GET", "/api/dcim/devices/")
    assert result["error"] is None
