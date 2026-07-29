"""Tests for the always-available global sandbox helpers (uml/markmap/wikipedia/rfc)."""
from unittest.mock import Mock, MagicMock, patch


def test_all_helpers_injected_into_every_sandbox():
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    g = _build_sandbox_globals(None, {}, emit=lambda e: None)
    for name in ("uml", "markmap", "wikipedia", "rfc", "drawio", "proxmox"):
        assert name in g, f"{name} not injected"


def test_uml_kroki_url_encoding_roundtrips():
    # Kroki decodes URL-safe-base64(deflate(source)); verify our encode inverts.
    import base64, zlib
    from ccie_sidecar.agents.uml_helper import build_kroki_url
    src = "@startuml\nA -> B\n@enduml"
    url = build_kroki_url(src, "plantuml")
    assert url.startswith("https://kroki.io/plantuml/svg/")
    encoded = url.rsplit("/", 1)[-1]
    decoded = zlib.decompress(base64.urlsafe_b64decode(encoded)).decode("utf-8")
    assert decoded == src


def test_uml_render_posts_and_inlines_svg_data_uri():
    # Kroki is called via POST (no URL-length 414); the SVG is inlined as a
    # data: URI in image_url. Mock the POST so the test is offline.
    from unittest.mock import patch, Mock
    from ccie_sidecar.agents.uml_helper import UmlHelper
    events = []
    h = UmlHelper(emit=events.append)
    fake = Mock(status_code=200, content=b"<svg>ok</svg>")
    with patch("ccie_sidecar.agents.uml_helper.requests.post", return_value=fake) as post:
        out = h.render("graph TD; A-->B", "mermaid", "Flow")
    # POSTed source to the Kroki mermaid/svg endpoint.
    assert post.call_args.args[0].endswith("/mermaid/svg")
    assert out["format"] == "image"
    assert out["image_url"].startswith("data:image/svg+xml;base64,")
    assert events and events[0]["type"] == "diagram" and events[0]["format"] == "image"


def test_uml_render_no_event_when_kroki_fails():
    from unittest.mock import patch, Mock
    from ccie_sidecar.agents.uml_helper import UmlHelper
    events = []
    h = UmlHelper(emit=events.append)
    fake = Mock(status_code=400, text="bad", content=b"")
    with patch("ccie_sidecar.agents.uml_helper.requests.post", return_value=fake):
        out = h.render("garbage", "plantuml", "X")
    assert out["image_url"] == ""
    assert out.get("error")
    # No diagram event emitted when there's nothing to render.
    assert events == []


def test_markmap_from_outline_builds_markdown_and_emits():
    from ccie_sidecar.agents.markmap_helper import MarkmapHelper
    events = []
    h = MarkmapHelper(emit=events.append)
    out = h.from_outline({"OSPF": {"LSA": ["Type 1", "Type 2"]}}, "OSPF")
    assert out["format"] == "markmap"
    assert "# OSPF" in out["source"] and "Type 1" in out["source"]
    assert events[0]["type"] == "diagram" and events[0]["format"] == "markmap"


def test_rfc_number_normalization():
    from ccie_sidecar.agents.rfc_helper import _norm_number
    assert _norm_number(4271) == "4271"
    assert _norm_number("RFC 4271") == "4271"
    assert _norm_number("rfc2328") == "2328"
    assert _norm_number("abc") is None


def test_rfc_get_invalid_number():
    from ccie_sidecar.agents.rfc_helper import RfcHelper
    out = RfcHelper().get("not-a-number")
    assert out["ok"] is False
    assert "Invalid" in out["error"]


def test_wikipedia_search_parses_results():
    from ccie_sidecar.agents.wikipedia_helper import WikipediaHelper
    with patch("ccie_sidecar.agents.wikipedia_helper.requests.Session") as mock_cls:
        sess = MagicMock()
        resp = Mock(status_code=200)
        resp.json.return_value = {"query": {"search": [
            {"title": "BGP", "snippet": "the <b>Border</b> Gateway", "pageid": 1},
        ]}}
        sess.get.return_value = resp
        mock_cls.return_value = sess
        out = WikipediaHelper().search("BGP")
        assert out["ok"] is True
        assert out["results"][0]["title"] == "BGP"
        # HTML stripped from snippet.
        assert "<b>" not in out["results"][0]["snippet"]


def test_utility_blurb_mentions_all_four():
    from ccie_sidecar.agents.code_exec import UTILITY_SANDBOX_BLURB
    for token in ("uml", "markmap", "wikipedia", "rfc"):
        assert token in UTILITY_SANDBOX_BLURB
