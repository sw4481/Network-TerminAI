"""Tests for the Splunk helper's error surfacing.

The regression these guard: a malformed SPL query (e.g. one not prefixed with
`search`) makes Splunk return HTTP 400 with a specific reason in
data["messages"]. The helper used to collapse that to a bare "HTTP 400", which
left the agent flailing across endpoint guesses. It must now surface Splunk's
own message so the agent can self-correct.
"""

from ccie_sidecar.splunk import SplunkClient


class _FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _FakeSession:
    def __init__(self, response):
        self._response = response

    def request(self, **_kwargs):
        return self._response


def _client_with(response):
    client = SplunkClient({"host": "splunk.example", "username": "u", "password": "p"})
    client._session = _FakeSession(response)
    return client


def test_call_surfaces_splunk_400_message():
    resp = _FakeResponse(
        400, {"messages": [{"type": "FATAL", "text": "Unknown search command 'index'."}]}
    )
    result = _client_with(resp).call("POST", "/services/search/jobs/export", body={"search": "index=_internal"})
    assert result["status_code"] == 400
    assert result["error"] == "HTTP 400: Unknown search command 'index'."


def test_call_falls_back_to_bare_http_when_no_message():
    resp = _FakeResponse(503, {"foo": "bar"})
    result = _client_with(resp).call("GET", "/services/data/indexes")
    assert result["error"] == "HTTP 503"


def test_call_success_has_no_error():
    resp = _FakeResponse(200, {"entry": []})
    result = _client_with(resp).call("GET", "/services/data/indexes")
    assert result["error"] is None
    assert result["status_code"] == 200


def test_test_connection_uses_short_timeout():
    from ccie_sidecar.splunk import test_connection

    seen = {}

    class TimeoutSession:
        auth = None

        def mount(self, *_args, **_kwargs):
            pass

        def request(self, **kwargs):
            seen["timeout"] = kwargs["timeout"]
            raise __import__("requests").exceptions.Timeout()

    client_config = {"host": "splunk.example", "username": "u", "password": "p"}
    with __import__("unittest.mock").mock.patch("ccie_sidecar.splunk.requests.Session", return_value=TimeoutSession()):
        result = test_connection(client_config)

    assert result == {"ok": False, "message": "Request timed out"}
    assert seen["timeout"] == (5, 15)
