"""Tests for the Cisco ISE client + sandbox helper."""
import json
from unittest.mock import Mock, MagicMock, patch


def test_surface_inference():
    from ccie_sidecar.ise import _surface_for_path

    assert _surface_for_path("/ers/config/endpoint") == "ers"
    assert _surface_for_path("/api/v1/policy/network-access/policy-set") == "openapi"
    assert _surface_for_path("/admin/API/mnt/Version") == "mnt"


def test_blast_radius():
    from ccie_sidecar.ise import _blast_radius

    assert _blast_radius("GET", "/ers/config/endpoint") == "low"
    assert _blast_radius("DELETE", "/ers/config/endpoint/1") == "destructive"
    assert _blast_radius("POST", "/ers/config/networkdevice") == "high"
    assert _blast_radius("PUT", "/ers/config/sgt/1") == "high"
    # MnT read-only surface is always low.
    assert _blast_radius("GET", "/admin/API/mnt/Session/ActiveList") == "low"
    # A generic write that doesn't touch a config noun is medium.
    assert _blast_radius("POST", "/api/v1/something/else") == "medium"


def test_unconfigured_call_returns_error():
    from ccie_sidecar.ise import IseClient

    client = IseClient({})
    out = client.call("GET", "/ers/config/endpoint")
    assert out["status_code"] == 0
    assert "not configured" in out["error"]


def test_call_uses_basic_auth_and_ers_port():
    from ccie_sidecar.ise import IseClient

    with patch("ccie_sidecar.ise.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"SearchResult": {"resources": []}}
        mock_session.request.return_value = mock_resp
        mock_session_cls.return_value = mock_session

        client = IseClient({
            "host": "ise.local",
            "username": "admin",
            "password": "pw",
            "verify_ssl": False,
        })
        out = client.call("GET", "/ers/config/networkdevice")

        assert out["status_code"] == 200
        assert out["blast_radius"] == "low"
        # Basic Auth set on the session.
        assert mock_session.auth == ("admin", "pw")
        _, kwargs = mock_session.request.call_args
        assert kwargs["url"] == "https://ise.local:9060/ers/config/networkdevice"
        assert kwargs["verify"] is False


def test_install_ise_binds_helper():
    from ccie_sidecar.ise import install_ise

    g = {}
    with patch("ccie_sidecar.ise_config.get_ise_config", return_value=None):
        install_ise(g)

    assert "ise_api_call" in g
    assert "ise" in g
    # Helper returns a JSON string even when unconfigured.
    out = json.loads(g["ise_api_call"]("GET", "/ers/config/endpoint"))
    assert out["status_code"] == 0


def test_xml_to_dict_parses_mnt_shape():
    from ccie_sidecar.ise import _xml_to_dict

    xml = '<?xml version="1.0"?><sessionCount><count>35</count></sessionCount>'
    assert _xml_to_dict(xml) == {"sessionCount": {"count": "35"}}
    # Non-XML returns None so the caller can fall back to the raw text.
    assert _xml_to_dict("not xml") is None


def test_mnt_call_uses_xml_accept_and_parses(monkeypatch):
    """MnT must request XML (it 406s on JSON) and the XML body is parsed to a dict."""
    from ccie_sidecar.ise import IseClient
    from unittest.mock import MagicMock, Mock

    captured = {}

    def fake_request(**kwargs):
        captured.update(kwargs)
        resp = Mock()
        resp.status_code = 200
        resp.json.side_effect = ValueError("not json")
        resp.text = '<sessionCount><count>7</count></sessionCount>'
        return resp

    session = MagicMock()
    session.request.side_effect = fake_request
    with patch("ccie_sidecar.ise.requests.Session", return_value=session):
        client = IseClient({"host": "ise.local", "username": "a", "password": "b", "verify_ssl": False})
        out = client.call("GET", "/admin/API/mnt/Session/ActiveCount")

    assert captured["headers"]["Accept"] == "application/xml"
    assert out["status_code"] == 200
    assert out["data"] == {"sessionCount": {"count": "7"}}


def test_react_code_client_section_points_at_ise_not_proxmox():
    """Regression: the ise agent's execute_python_code description must steer the
    model to ise_api_call, NOT fall through to the proxmox 'ONLY way' fallback
    (which previously sent the model hunting for env vars and it never called the
    API). proxmox is injected into every sandbox, so the ise branch must win."""
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    from ccie_sidecar.agents.react_code import _build_client_section

    g = _build_sandbox_globals("ise", {}, emit=lambda e: None)
    assert "proxmox" in g  # proxmox is always injected — the trap we must avoid
    section = _build_client_section("ise", g, False)
    assert "ise_api_call" in section
    assert "/ers/config/networkdevice" in section
    assert "ONLY way to reach Proxmox" not in section


def test_test_connection_requires_fields():
    from ccie_sidecar.ise import test_connection

    res = test_connection({"host": "ise.local"})
    assert res["ok"] is False
    assert "required" in res["message"].lower()


def test_disabled_tls_verification_uses_transport_independent_of_system_truststore():
    """Global truststore injection must not re-enable checks when Verify SSL is off."""
    import ssl

    from ccie_sidecar.ise import IseClient

    client = IseClient({
        "host": "ise.local",
        "username": "admin",
        "password": "secret",
        "verify_ssl": False,
    })

    adapter = client._ensure_session().get_adapter("https://ise.local")
    context = adapter.poolmanager.connection_pool_kw.get("ssl_context")

    assert context is not None
    assert context.check_hostname is False
    assert context.verify_mode == ssl.CERT_NONE
