"""Cisco Workflows transport and read-only sandbox contract."""
import json
from types import SimpleNamespace

import pytest
import requests

from ccie_sidecar import cisco_workflows


@pytest.fixture
def transport(monkeypatch):
    requests_seen = []
    responses = []

    class Session:
        def request(self, method, url, **kwargs):
            requests_seen.append((method, url, kwargs))
            if isinstance(responses[0], Exception):
                raise responses.pop(0)
            return responses.pop(0)

    monkeypatch.setattr(cisco_workflows.requests, "Session", Session)
    return requests_seen, responses


def response(status, data):
    return SimpleNamespace(status_code=status, json=lambda: data)


def client(config=None):
    return cisco_workflows.CiscoWorkflowsClient(config if config is not None else {
        "api_key": "synthetic-key", "org_id": "12345", "host": "https://untrusted.invalid", "verify_ssl": False,
    })


@pytest.mark.parametrize("config,missing", [
    (None, "an API key"), ({"org_id": "12345"}, "an API key"),
    ({"api_key": "synthetic-key"}, "an organization ID"),
    ({"api_key": "  ", "org_id": "12345"}, "an API key"),
])
def test_incomplete_configuration_fails_before_network(transport, config, missing):
    seen, _ = transport
    result = cisco_workflows.CiscoWorkflowsClient(config).call("GET", "/v1.1/workflows")
    assert result == {"status_code": 0, "data": None,
                      "error": f"Cisco Workflows requires {missing} in Settings → Meraki.",
                      "blast_radius": "low"}
    assert seen == []


def test_saved_key_with_embedded_control_never_reaches_request(transport):
    seen, _ = transport
    out = cisco_workflows.CiscoWorkflowsClient({
        "api_key": "synthetic\nkey", "org_id": "12345",
    }).call("GET", "/v1.1/workflows")
    assert out == {"status_code": 0, "data": None,
                   "error": "Invalid Meraki API key in Settings → Meraki.", "blast_radius": "low"}
    assert seen == []
    assert "synthetic" not in json.dumps(out)


def test_netrc_cannot_replace_bearer_header_without_real_files_or_network(monkeypatch):
    netrc_calls = []
    prepared = []

    def fake_netrc(url):
        netrc_calls.append(url)
        return ("synthetic-netrc-user", "synthetic-netrc-password")

    def fake_send(self, request, **kwargs):
        prepared.append((request, kwargs, self.trust_env))
        reply = requests.Response()
        reply.status_code = 200
        reply._content = b"[]"
        return reply

    monkeypatch.setenv("REQUESTS_CA_BUNDLE", "/synthetic/enterprise-ca.pem")
    monkeypatch.setattr(requests.sessions, "get_environ_proxies", lambda url, no_proxy=None: {
        "https": "http://synthetic-proxy.invalid:8080",
    })
    monkeypatch.setattr(requests.sessions, "get_netrc_auth", fake_netrc)
    monkeypatch.setattr(requests.Session, "send", fake_send)
    assert client().call("GET", "/v1.1/workflows")["status_code"] == 200
    assert len(prepared) == 1
    request, settings, trust_env = prepared[0]
    assert trust_env is True
    assert request.headers["Authorization"] == "Bearer synthetic-key"
    assert settings["proxies"]["https"] == "http://synthetic-proxy.invalid:8080"
    assert settings["verify"] == "/synthetic/enterprise-ca.pem"
    assert settings["allow_redirects"] is False
    assert netrc_calls == []


@pytest.mark.parametrize("method,path,expected", [
    ("GET", "/v1.1/workflows/abc", "low"),
    ("GET", "/exchange/v1/workflows/export", "low"),
    ("post", "/v1.1/workflows", "low"),
    ("POST", "/v1.2/workflows", "low"),
    ("POST", "/v1.1/instances", "low"),
    ("POST", "/v1/workflows/batch_get", "low"),
    ("POST", "/v1/rules/batch_get", "low"),
    ("POST", "/v1/variable_types/batch_get", "low"),
])
def test_reads_use_fixed_origin_auth_tls_and_exact_json(transport, method, path, expected):
    seen, replies = transport
    data = [{"id": "☃️", "name": "O'Hara"}]
    body = ["a", {"offset": 2}]
    replies.append(response(200, data))
    result = client().call(method, path, body=body, query_params={"offset": 2, "limit": 100})
    assert result == {"status_code": 200, "data": data, "error": None, "blast_radius": expected}
    assert len(seen) == 1
    sent_method, sent_url, sent_options = seen[0]
    assert callable(sent_options["auth"])
    sentinel = requests.Request("GET", "https://synthetic.invalid").prepare()
    assert sent_options["auth"](sentinel) is sentinel
    assert (sent_method, sent_url, {k: v for k, v in sent_options.items() if k != "auth"}) == (
        method.upper(), f"https://api.meraki.com/api/automate/organizations/12345{path}", {
            "headers": {"Authorization": "Bearer synthetic-key", "Accept": "application/json", "Content-Type": "application/json"},
            "json": body, "params": {"offset": 2, "limit": 100}, "verify": True,
            "allow_redirects": False, "timeout": (5, 30),
        },
    )


@pytest.mark.parametrize("method,path,risk", [
    ("POST", "/v1.1/workflows/abc/start", "high"),
    ("POST", "/exchange/v1/workflows/import", "high"),
    ("POST", "/exchange/v1/workflows/export", "high"),
    ("POST", "/v1.1/workflows/abc", "high"),
    ("POST", "/v1.1/unknown", "high"),
    ("PUT", "/v1.1/workflows/abc", "high"),
    ("DELETE", "/v1.1/workflows/abc", "destructive"),
    ("PATCH", "/v1.1/workflows/abc", "high"),
])
def test_call_never_sends_mutations_and_apply_can_send_only_mutations(transport, method, path, risk):
    seen, replies = transport
    refused = client().call(method, path, {"name": "x"})
    assert refused == {"status_code": 0, "data": None,
                       "error": "Cisco Workflows mutations require the cisco_workflows_apply approval tool.",
                       "blast_radius": risk}
    assert seen == []
    replies.append(response(202, {"accepted": True}))
    assert client().apply(method, path, {"name": "x"}) == {
        "status_code": 202, "data": {"accepted": True}, "error": None, "blast_radius": risk,
    }
    assert len(seen) == 1


@pytest.mark.parametrize("method,path", [
    ("GET", "/v1.1/workflows"), ("POST", "/v1.1/workflows"),
    ("POST", "/v1/workflows/batch_get"),
    ("POST", "/v1/rules/batch_get"),
    ("POST", "/v1/variable_types/batch_get"),
])
def test_apply_rejects_reads_even_post_reads(transport, method, path):
    seen, _ = transport
    out = client().apply(method, path)
    assert out["status_code"] == 0
    assert out["blast_radius"] == "low"
    assert "only permits mutations" in out["error"]
    assert seen == []


@pytest.mark.parametrize("path", [
    "https://evil.invalid/v1.1/workflows", "//evil.invalid/v1.1/workflows",
    "/v1.1/workflows?next=1", "/v1.1/workflows#secret",
    "/v1.1/../organizations/other", "/v1.1/%2e%2e/organizations/other",
    "/v1.1/%2f%2fother", "/v1.1/workflows%2Fabc", "/v1.1/%252e%252e/other",
    "/api/v1/organizations/other", "/organizations/other/v1.1/workflows",
    "/exchange/v1/../organizations/other", "/exchange/v1/%2f%2fother",
    "/v1.1\\evil.invalid", "/v1.1/workflows%0Aother", "/v1.1/workflows\nother",
    "", None, 42, ["v1.1", "workflows"],
])
def test_hostile_paths_cannot_escape_fixed_organization(transport, path):
    seen, _ = transport
    for caller in (client().call, client().apply):
        out = caller("GET" if caller.__name__ == "call" else "DELETE", path)
        assert out["status_code"] == 0
        assert out["data"] is None
        assert out["error"]
    assert seen == []


def test_post_read_rejects_unhashable_path_without_network(transport):
    seen, _ = transport
    out = client().call("POST", ["v1.1", "workflows"])
    assert out["status_code"] == 0
    assert out["data"] is None
    assert out["error"]
    assert seen == []


@pytest.mark.parametrize("method,query,body", [
    (None, None, None), (42, None, None), ("TRACE", None, None),
    ("GET", {"Authorization": "Bearer override"}, None),
    ("GET", {"X-Cisco-Meraki-API-Key": "override"}, None),
    ("GET", {"api_key": "override"}, None),
    ("GET", {"%2561pi_key": "override"}, None),
    ("GET", {"headers": {"Authorization": "override"}}, None),
    ("GET", {"verify_ssl": False}, None),
    ("GET", {"base_url": "https://untrusted.invalid"}, None),
    ("GET", {"offset": object()}, None),
    ("GET", "offset=1", None),
    ("GET", None, object()),
])
def test_invalid_types_and_credential_overrides_fail_closed(transport, method, query, body):
    seen, _ = transport
    out = client().call(method, "/v1.1/workflows", body=body, query_params=query)
    assert out["status_code"] == 0
    assert out["error"]
    assert seen == []


def test_workflow_json_payload_fields_do_not_override_transport(transport):
    seen, replies = transport
    body = {"url": "https://synthetic.invalid", "headers": {"Authorization": "task input"},
            "api_key": "task variable", "token": "task token", "verify_ssl": False}
    replies.append(response(200, {"accepted": True}))
    assert client().call("POST", "/v1.1/workflows", body)["data"] == {"accepted": True}
    assert seen[0][2]["json"] is body
    assert seen[0][2]["headers"]["Authorization"] == "Bearer synthetic-key"
    assert seen[0][2]["verify"] is True


def test_exchange_import_preserves_authoring_json_and_requires_apply(transport):
    seen, replies = transport
    payload = {"workflow": {"name": "Full workflow"}, "subworkflows": [],
               "variables": {"url": "https://synthetic.invalid"}, "targets": {}, "rules": {}, "triggers": {}}
    path = "/exchange/v1/workflows/import"
    assert client().call("POST", path, payload)["status_code"] == 0
    assert seen == []
    replies.append(response(201, {"id": "synthetic-workflow"}))
    assert client().apply("POST", path, payload)["data"] == {"id": "synthetic-workflow"}
    assert seen[0][1] == "https://api.meraki.com/api/automate/organizations/12345" + path
    assert seen[0][2]["json"] is payload
    assert seen[0][2]["verify"] is True


def test_invalid_org_id_cannot_change_origin(transport):
    seen, _ = transport
    out = cisco_workflows.CiscoWorkflowsClient({"api_key": "synthetic-key", "org_id": "123/../../other"}).call("GET", "/v1.1/workflows")
    assert out["status_code"] == 0
    assert seen == []


def test_does_not_follow_redirects_or_retry_any_request(transport):
    seen, replies = transport
    replies.append(response(302, {"next": "https://untrusted.invalid"}))
    out = client().call("GET", "/v1.1/workflows")
    assert out == {"status_code": 302, "data": {"next": "https://untrusted.invalid"},
                   "error": "HTTP 302: Cisco Workflows redirect not followed.", "blast_radius": "low"}
    assert len(seen) == 1
    assert seen[0][2]["allow_redirects"] is False
    replies.append(response(429, {"message": "rate limited"}))
    out = client().apply("POST", "/v1.1/workflows/abc/start")
    assert out["status_code"] == 429
    assert len(seen) == 2


def test_non_json_redirect_keeps_status_and_does_not_follow(transport):
    seen, replies = transport

    def invalid_json():
        raise ValueError("no JSON")

    replies.append(SimpleNamespace(status_code=307, json=invalid_json, text="redirect"))
    assert client().apply("POST", "/v1.1/workflows/abc/start") == {
        "status_code": 307, "data": None,
        "error": "HTTP 307: Cisco Workflows redirect not followed.", "blast_radius": "high",
    }
    assert len(seen) == 1
    assert seen[0][2]["allow_redirects"] is False


def test_successful_no_content_mutation_preserves_204(transport):
    seen, replies = transport

    def invalid_json():
        raise ValueError("empty body")

    replies.append(SimpleNamespace(status_code=204, json=invalid_json, text=""))
    assert client().apply("DELETE", "/v1.1/workflows/abc") == {
        "status_code": 204, "data": None, "error": None, "blast_radius": "destructive",
    }
    assert len(seen) == 1


@pytest.mark.parametrize("error,expected", [
    (requests.exceptions.Timeout("synthetic-key"), "timed out"),
    (requests.exceptions.SSLError("synthetic-key"), "SSL certificate"),
    (requests.exceptions.ConnectionError("synthetic-key at host"), "[REDACTED]"),
])
def test_network_errors_do_not_retry_or_expose_credentials(transport, error, expected):
    seen, replies = transport
    replies.append(error)
    out = client().apply("POST", "/v1.1/workflows/abc/start")
    assert out["status_code"] == 0
    assert expected in out["error"]
    assert "synthetic-key" not in json.dumps(out)
    assert len(seen) == 1


def test_http_errors_redact_all_returned_values_and_surface_vendor_reason(transport):
    _, replies = transport
    replies.append(response(403, {"messages": ["synthetic-key forbidden"], "nested": [{"value": "synthetic-key"}], "synthetic-key": "label"}))
    out = client().call("GET", "/v1.1/workflows")
    assert out == {"status_code": 403,
                   "data": {"messages": ["[REDACTED] forbidden"], "nested": [{"value": "[REDACTED]"}], "[REDACTED]": "label"},
                   "error": "HTTP 403: [REDACTED] forbidden", "blast_radius": "low"}


def test_non_json_success_fails_closed_without_exposing_body(transport):
    _, replies = transport

    def invalid_json():
        raise ValueError("synthetic-key in parser error")

    replies.append(SimpleNamespace(status_code=200, json=invalid_json, text="synthetic-key"))
    out = client().call("GET", "/v1.1/workflows")
    assert out["status_code"] == 0
    assert out["data"] is None
    assert "JSON" in out["error"]
    assert "synthetic-key" not in json.dumps(out)


def test_non_json_error_surfaces_sanitized_http_reason(transport):
    _, replies = transport

    def invalid_json():
        raise ValueError("invalid JSON")

    replies.append(SimpleNamespace(status_code=400, json=invalid_json, text="synthetic-key bad input"))
    out = client().call("GET", "/v1.1/workflows")
    assert out == {"status_code": 400, "data": None,
                   "error": "HTTP 400: [REDACTED] bad input", "blast_radius": "low"}


def test_large_json_body_and_results_are_not_rewritten(transport):
    seen, replies = transport
    items = [{"x": n} for n in range(10_001)]
    replies.append(response(200, items))
    assert client().call("POST", "/v1/workflows/batch_get", body=items)["data"] == items
    assert seen[0][2]["json"] is items
    replies.append(response(200, []))
    assert client().call("GET", "/v1.1/workflows")["data"] == []
    replies.append(response(200, None))
    assert client().call("GET", "/v1.1/workflows")["data"] is None


def test_install_is_read_only_and_loads_meraki_config_at_install_time(monkeypatch, transport):
    seen, replies = transport
    calls = []

    def config():
        calls.append(True)
        return {"api_key": "synthetic-key", "org_id": "12345"}

    from ccie_sidecar import meraki_config
    monkeypatch.setattr(meraki_config, "get_meraki_config", config)
    scope = {}
    installed = cisco_workflows.install_cisco_workflows(scope)
    assert installed is None
    assert calls == [True]
    assert set(scope) == {"cisco_workflows_api_call"}
    replies.append(response(200, ["workflow"] ))
    assert json.loads(scope["cisco_workflows_api_call"]("GET", "/v1.1/workflows"))["data"] == ["workflow"]
    out = json.loads(scope["cisco_workflows_api_call"]("POST", "/v1.1/workflows/abc/start"))
    assert out["status_code"] == 0
    assert "cisco_workflows_apply" in out["error"]
    assert len(seen) == 1
