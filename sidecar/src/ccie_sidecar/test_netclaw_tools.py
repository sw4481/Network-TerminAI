"""Tests for the netclaw-inspired integrations (grafana/prometheus/netbox/
sketchfab/devnet/fwrule) — binding, envelope shape, blast radius, offline analysis."""
import warnings
from unittest.mock import Mock, patch


# --- credential-less helpers are always bound -------------------------------

def test_devnet_and_fwrule_bound_in_every_sandbox():
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    g = _build_sandbox_globals(None, {}, emit=lambda e: None)
    for name in ("devnet", "devnet_api_call", "fwrule"):
        assert name in g, f"{name} not injected into base sandbox"


# --- credentialed helpers bind under their cli_package ----------------------

def test_credentialed_helpers_bind_by_cli_package():
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    cases = {
        "grafana": "grafana_api_call",
        "zabbix": "zabbix_api_call",
        "prometheus": "prometheus_api_call",
        "netbox": "netbox_api_call",
        "sketchfab": "sketchfab_api_call",
    }
    for cli_package, fn in cases.items():
        g = _build_sandbox_globals(cli_package, {}, emit=lambda e: None)
        assert fn in g, f"{fn} not bound for cli_package={cli_package}"
        assert cli_package in g, f"{cli_package} client object not bound"


# --- envelope shape when unconfigured ---------------------------------------

def test_grafana_unconfigured_envelope():
    from ccie_sidecar.grafana import GrafanaClient
    out = GrafanaClient({}).call("GET", "/api/search")
    assert out["status_code"] == 0
    assert out["data"] is None
    assert "not configured" in out["error"]
    assert out["blast_radius"] == "low"


def test_zabbix_url_auth_and_write_classification():
    from ccie_sidecar.zabbix import ZabbixClient, _normalise_url, _risk_for_method

    assert _normalise_url("https://z.example/zabbix") == "https://z.example/zabbix/api_jsonrpc.php"
    assert _normalise_url("https://z.example/api_jsonrpc.php") == "https://z.example/api_jsonrpc.php"
    assert _risk_for_method("host.get") == "low"
    assert _risk_for_method("host.create") == "medium"
    assert _risk_for_method("host.delete") == "high"
    assert _risk_for_method("user.get") is None
    assert "not configured" in ZabbixClient({}).call("host.get", {})["error"]


def test_zabbix_token_uses_bearer_and_redacts_rpc_errors():
    from ccie_sidecar.zabbix import ZabbixClient, redact_params
    client = ZabbixClient({"url": "https://z.example", "auth_mode": "token", "token": "very-secret"})
    fake = Mock(status_code=200)
    fake.json.return_value = {"jsonrpc": "2.0", "error": {"code": -32602, "message": "bad", "data": "very-secret"}}
    with patch.object(client, "_ensure_session") as sess:
        sess.return_value.post.return_value = fake
        out = client.call("host.get", {})
        headers = sess.return_value.post.call_args.kwargs["headers"]
    assert headers["Authorization"] == "Bearer very-secret"
    assert "very-secret" not in out["error"]
    assert out["status_code"] == 200
    assert redact_params({"password": "x", "nested": [{"token": "y"}]}) == {"password": "[REDACTED]", "nested": [{"token": "[REDACTED]"}]}


def test_zabbix_disabled_tls_verification_does_not_emit_a_warning():
    """An intentional verify_ssl=False setting must not look like an agent error."""
    from requests.packages.urllib3.exceptions import InsecureRequestWarning
    from ccie_sidecar.zabbix import ZabbixClient

    client = ZabbixClient({"url": "https://z.example", "verify_ssl": False})
    response = Mock(status_code=200)
    response.json.return_value = {"jsonrpc": "2.0", "result": "7.0.0"}

    def post(*_args, **_kwargs):
        warnings.warn("unverified", InsecureRequestWarning)
        return response

    with patch.object(client, "_ensure_session") as session, warnings.catch_warnings(record=True) as emitted:
        warnings.simplefilter("always")
        session.return_value.post.side_effect = post
        result = client._request("apiinfo.version", {})

    assert result["data"] == "7.0.0"
    assert not any(issubclass(item.category, InsecureRequestWarning) for item in emitted)


def test_zabbix_string_false_disables_tls_verification():
    """Serialized Settings values must not make bool('false') verify TLS."""
    from ccie_sidecar.zabbix import ZabbixClient

    client = ZabbixClient({"url": "https://z.example", "verify_ssl": "false"})
    response = Mock(status_code=200)
    response.json.return_value = {"jsonrpc": "2.0", "result": "7.0.0"}
    with patch.object(client, "_ensure_session") as session:
        session.return_value.post.return_value = response
        client._request("apiinfo.version", {})

    assert session.return_value.post.call_args.kwargs["verify"] is False


def test_zabbix_disabled_tls_uses_transport_independent_of_system_truststore():
    """The sidecar's global truststore injection must not re-enable TLS checks
    for a Zabbix connection explicitly saved with Verify SSL disabled."""
    import ssl

    from ccie_sidecar.zabbix import ZabbixClient

    client = ZabbixClient({"url": "https://z.example", "verify_ssl": False})
    adapter = client._ensure_session().get_adapter("https://z.example")
    context = adapter.poolmanager.connection_pool_kw.get("ssl_context")

    assert context is not None
    assert context.check_hostname is False
    assert context.verify_mode == ssl.CERT_NONE


def test_zabbix_http_budget_finishes_before_sandbox_and_retries_connect_only():
    """A transient TCP failure must get one bounded retry, while read failures
    and sent POST requests are never replayed. The HTTP request must also return
    before the surrounding 30-second code sandbox kills the tool result."""
    from ccie_sidecar.zabbix import ZabbixClient

    client = ZabbixClient({"url": "https://z.example", "verify_ssl": False})
    session = client._ensure_session()
    adapter = session.get_adapter("https://z.example")

    assert adapter.max_retries.connect == 1
    assert adapter.max_retries.read == 0
    assert adapter.max_retries.status == 0
    assert "POST" in adapter.max_retries.allowed_methods

    response = Mock(status_code=200)
    response.json.return_value = {"jsonrpc": "2.0", "result": "7.0.0"}
    with patch.object(session, "post", return_value=response) as post:
        result = client._request("apiinfo.version", {})

    assert result["error"] is None
    assert post.call_args.kwargs["timeout"] == (5, 15)


def test_zabbix_json_rpc_helper_is_not_wrapped_as_an_http_catalog_call():
    """The shared catalog guard's (method, path) contract cannot represent
    JSON-RPC (method, params), and previously blocked every host.get."""
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    sandbox = _build_sandbox_globals(
        "zabbix", {}, emit=lambda _e: None,
        catalogs=[{"id": "zabbix", "entries": [{"name": "zabbix_api_call"}]}],
    )
    assert not getattr(sandbox["zabbix_api_call"], "__catalog_guarded__", False)


def test_zabbix_execute_tool_describes_preloaded_json_rpc_shape():
    """The model needs an executable contract at the tool boundary, not just
    agent prose, so it does not import helper modules or guess payload shapes."""
    from ccie_sidecar.agents.deepagents_tools import create_execute_python_code_tool

    tool = create_execute_python_code_tool("zabbix", {}, emit_callback=lambda _event: None)
    description = tool.description
    assert "pre-loaded global" in description
    assert "Do NOT import zabbix_api" in description
    assert "result = json.loads(zabbix_api_call" in description
    assert "result['data']" in description
    assert "isinstance(records, list)" in description


def test_zabbix_jsonrpc_helper_is_excluded_from_http_only_wrappers(monkeypatch):
    """Memoization/autocapture wrappers have an HTTP (method, path, body,
    query) signature and must not rewrite Zabbix's (method, params) helper."""
    from ccie_sidecar.agents.api_memo import install_api_memo
    from ccie_sidecar.agents import graph_autocapture

    def zabbix_call(method, params=None):
        return f"{method}:{params}"

    sandbox = {"zabbix_api_call": zabbix_call}
    assert install_api_memo(sandbox) == 0
    monkeypatch.setattr(graph_autocapture, "_enabled", lambda: True)
    assert graph_autocapture.install_autocapture(sandbox) == 0
    assert sandbox["zabbix_api_call"] is zabbix_call
    assert sandbox["zabbix_api_call"]("host.get", {"limit": 1}) == "host.get:{'limit': 1}"


def test_prometheus_unconfigured_envelope():
    from ccie_sidecar.prometheus import PrometheusClient
    out = PrometheusClient({}).call("GET", "/api/v1/query")
    assert out["status_code"] == 0 and out["error"]
    assert out["blast_radius"] == "low"


def test_netbox_unconfigured_and_write_blast_radius():
    from ccie_sidecar.netbox import NetboxClient, _blast_radius
    out = NetboxClient({}).call("GET", "/api/status/")
    assert out["status_code"] == 0 and "not configured" in out["error"]
    # NetBox is the one read-write tool: verbs must classify for approval gating.
    assert _blast_radius("GET", "/api/dcim/devices/") == "low"
    assert _blast_radius("POST", "/api/dcim/devices/") == "medium"
    assert _blast_radius("PATCH", "/api/dcim/devices/1/") == "medium"
    assert _blast_radius("DELETE", "/api/dcim/devices/1/") == "destructive"


def test_sketchfab_search_does_not_force_cc0_by_default():
    # Regression: cc0=True made the license filter drop specific queries to zero.
    # The default must NOT send a license filter.
    from ccie_sidecar.sketchfab import SketchfabClient
    client = SketchfabClient({})
    captured = {}
    fake = Mock(status_code=200)
    fake.json.return_value = {"results": []}

    def _capture(method, url, **kw):
        captured.update(kw.get("params") or {})
        return fake

    with patch.object(client, "_ensure_session") as sess:
        sess.return_value.request.side_effect = _capture
        client.search("network router")  # default cc0
    assert "license" not in captured, "default search must not force a CC0 filter"
    assert captured.get("downloadable") == "true"


def test_sketchfab_works_without_key():
    # No key -> still constructs; anonymous search path (mock the HTTP).
    from ccie_sidecar.sketchfab import SketchfabClient
    client = SketchfabClient({})
    fake = Mock(status_code=200)
    fake.json.return_value = {"results": [{"uid": "abc", "name": "Router"}]}
    with patch.object(client, "_ensure_session") as sess:
        sess.return_value.request.return_value = fake
        out = client.search("router", cc0=False)
    assert out["status_code"] == 200
    assert out["data"]["results"][0]["uid"] == "abc"
    assert out["blast_radius"] == "low"


# --- successful call envelope (mocked HTTP) ---------------------------------

def test_grafana_blast_radius_reads_vs_writes():
    from ccie_sidecar.grafana import _blast_radius
    # Reads (incl. the POST query proxy) are low.
    assert _blast_radius("GET", "/api/search") == "low"
    assert _blast_radius("POST", "/api/ds/query") == "low"
    # Building/updating dashboards is a gated write.
    assert _blast_radius("POST", "/api/dashboards/db") == "medium"
    assert _blast_radius("POST", "/api/folders") == "medium"
    # Deleting is high.
    assert _blast_radius("DELETE", "/api/dashboards/uid/abc") == "high"


def test_grafana_create_dashboard_body_shape():
    from ccie_sidecar.grafana import GrafanaClient
    client = GrafanaClient({"url": "https://g.example", "token": "t"})
    captured = {}
    fake = Mock(status_code=200)
    fake.json.return_value = {"uid": "new1", "status": "success"}

    def _capture(method, url, **kw):
        captured["method"] = method
        captured["url"] = url
        captured["json"] = kw.get("json")
        return fake

    with patch.object(client, "_ensure_session") as sess:
        sess.return_value.request.side_effect = _capture
        out = client.create_dashboard({"title": "Net Health", "panels": []}, message="init")

    assert captured["method"] == "POST"
    assert captured["url"].endswith("/api/dashboards/db")
    body = captured["json"]
    # Grafana requires the dashboard wrapped + id=None to create fresh.
    assert body["dashboard"]["title"] == "Net Health"
    assert body["dashboard"]["id"] is None
    assert body["overwrite"] is False
    assert body["message"] == "init"
    assert out["status_code"] == 200 and out["blast_radius"] == "medium"


def test_grafana_call_success_envelope():
    from ccie_sidecar.grafana import GrafanaClient
    client = GrafanaClient({"url": "https://g.example", "token": "t", "verify_ssl": True})
    fake = Mock(status_code=200)
    fake.json.return_value = [{"uid": "u1", "title": "Net"}]
    with patch.object(client, "_ensure_session") as sess:
        sess.return_value.request.return_value = fake
        out = client.call("GET", "/api/search")
    assert out["status_code"] == 200
    assert out["error"] is None
    assert out["data"][0]["uid"] == "u1"


# --- fwrule offline analysis ------------------------------------------------

def test_fwrule_detects_shadowing():
    from ccie_sidecar.fwrule import FwruleAnalyzer
    # A broad permit precedes a narrower deny with a different action -> shadow.
    acl = "permit ip any any\ndeny tcp host 10.0.0.1 any eq 80"
    r = FwruleAnalyzer().analyze(acl_text=acl, vendor="ios")
    assert r["ok"] is True
    assert r["rule_count"] == 2
    assert r["summary"]["shadowing"] == 1


def test_fwrule_detects_duplicate_and_redundancy():
    from ccie_sidecar.fwrule import FwruleAnalyzer
    a = FwruleAnalyzer()
    dup = a.analyze(acl_text="permit tcp any any eq 22\npermit tcp any any eq 22", vendor="ios")
    assert dup["summary"]["duplicate"] == 1
    # Broad permit then narrower permit (same action) -> redundancy.
    red = a.analyze(acl_text="permit ip any any\npermit tcp host 10.0.0.1 any eq 443", vendor="ios")
    assert red["summary"]["redundancy"] == 1


def test_fwrule_detects_conflict_on_overlap():
    from ccie_sidecar.fwrule import FwruleAnalyzer
    # Two overlapping rules, opposite actions, neither fully covers the other.
    rules = [
        {"action": "permit", "protocol": "tcp", "src": "10.0.0.0/24", "dst": "any", "dst_port": 80},
        {"action": "deny", "protocol": "tcp", "src": "10.0.0.128/25", "dst": "any", "dst_port": [80, 90]},
    ]
    r = FwruleAnalyzer().analyze(rules=rules)
    assert r["ok"] is True
    # 10.0.0.128/25 is a subnet of /24 with a wider port range -> not full cover;
    # opposite actions on overlap -> conflict (or shadowing if covered).
    assert r["summary"]["conflict"] + r["summary"]["shadowing"] >= 1


def test_fwrule_normalized_rules_any():
    from ccie_sidecar.fwrule import FwruleAnalyzer
    r = FwruleAnalyzer().analyze(rules=[
        {"action": "permit", "protocol": "ip", "src": "any", "dst": "any"},
        {"action": "permit", "protocol": "ip", "src": "any", "dst": "any"},
    ])
    assert r["summary"]["duplicate"] == 1


def test_fwrule_bad_input_returns_error_not_crash():
    from ccie_sidecar.fwrule import FwruleAnalyzer
    out = FwruleAnalyzer().analyze()
    assert out["ok"] is False and "Provide" in out["error"]
    # Unsupported vendor CLI parse is explicit, not silent.
    out2 = FwruleAnalyzer().analyze(acl_text="permit ip any any", vendor="panos")
    assert out2["ok"] is False


# --- client-section docs light up for each new id ---------------------------

def test_client_section_documents_each_new_tool():
    from ccie_sidecar.agents.react_code import _build_client_section
    checks = {
        "grafana": "grafana_api_call",
        "prometheus": "prometheus.query",
        "netbox": "netbox_api_call",
        "sketchfab": "sketchfab.search",
        "devnet": "devnet.search",
        "fwrule": "fwrule.analyze",
    }
    for cli_package, needle in checks.items():
        section = _build_client_section(cli_package, {}, meraki_client_ready=False)
        assert needle in section, f"{needle} missing from {cli_package} client-section"
