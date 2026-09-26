"""
Tests for the draw.io diagram helper.

The encoding MUST stay compatible with draw.io's `#create=` fragment scheme
(encodeURIComponent -> raw DEFLATE -> base64, wrapped in a JSON envelope), so
these tests reverse the encoding the same way draw.io's JS does and assert the
original content is recovered.
"""
import base64
import json
import urllib.parse
import zlib

import pytest

from ccie_sidecar.agents.drawio_helper import (
    DrawioHelper,
    build_drawio_url,
    install_drawio,
    _compress_data,
    _encode_uri_component,
)


def _decode_create_url(url: str) -> dict:
    """Reverse build_drawio_url the way draw.io's editor does."""
    assert "#create=" in url
    fragment = url.split("#create=", 1)[1]
    create_obj = json.loads(urllib.parse.unquote(fragment))
    return create_obj


def _inflate(create_obj: dict) -> str:
    raw = base64.b64decode(create_obj["data"])
    inflated = zlib.decompress(raw, -15).decode("utf-8")  # raw inflate
    return urllib.parse.unquote(inflated)                 # decodeURIComponent


def test_encode_uri_component_matches_js():
    # Known encodeURIComponent outputs.
    assert _encode_uri_component("a b/c?d=e&f") == "a%20b%2Fc%3Fd%3De%26f"
    # The unreserved set JS leaves untouched.
    assert _encode_uri_component("aA0-_.!~*'()") == "aA0-_.!~*'()"


def test_xml_roundtrip_preserves_content_and_unicode():
    xml = (
        "<mxGraphModel><root><mxCell id=\"0\"/>"
        "<mxCell id=\"2\" value=\"Rüter ☃ &amp; <core>\" vertex=\"1\"/>"
        "</root></mxGraphModel>"
    )
    url = build_drawio_url(xml, "xml")
    obj = _decode_create_url(url)
    assert obj["type"] == "xml"
    assert obj["compressed"] is True
    assert _inflate(obj) == xml


def test_url_shape():
    url = build_drawio_url("<x/>", "xml")
    assert url.startswith(
        "https://app.diagrams.net/?grid=0&pv=0&border=10&edit=_blank#create="
    )


def test_base_url_override():
    url = build_drawio_url("<x/>", "xml", base_url="https://draw.example.com/")
    assert url.startswith("https://draw.example.com/?")


def test_invalid_format_rejected():
    with pytest.raises(ValueError):
        build_drawio_url("data", "svg")


def test_compress_data_is_standard_base64():
    # Standard base64 alphabet may include + and / and trailing =; the fragment
    # safety comes from encodeURIComponent in build_drawio_url, not here.
    out = _compress_data("hello world")
    # Round-trips back through raw inflate + decodeURIComponent.
    raw = base64.b64decode(out)
    assert urllib.parse.unquote(zlib.decompress(raw, -15).decode()) == "hello world"


def test_diagram_emits_event_and_returns_payload():
    events = []
    d = DrawioHelper(emit=events.append)
    payload = d.diagram(xml="<mxGraphModel></mxGraphModel>", title="Topology")

    assert payload["format"] == "xml"
    assert payload["title"] == "Topology"
    assert payload["xml"] == "<mxGraphModel></mxGraphModel>"
    assert payload["source"] is None
    assert payload["url"].startswith("https://app.diagrams.net/")

    assert len(events) == 1
    ev = events[0]
    assert ev["type"] == "diagram"
    assert ev["format"] == "xml"
    assert ev["xml"] == "<mxGraphModel></mxGraphModel>"
    assert ev["url"] == payload["url"]


def test_from_mermaid_sets_source_and_null_xml():
    events = []
    d = DrawioHelper(emit=events.append)
    payload = d.from_mermaid("graph TD; A-->B", title="Flow")

    assert payload["format"] == "mermaid"
    assert payload["xml"] is None
    assert payload["source"] == "graph TD; A-->B"
    obj = _decode_create_url(payload["url"])
    assert obj["type"] == "mermaid"
    assert _inflate(obj) == "graph TD; A-->B"


def test_from_csv_sets_source_and_null_xml():
    events = []
    d = DrawioHelper(emit=events.append)
    payload = d.from_csv("name,parent\nA,\nB,A", title="Org")

    assert payload["format"] == "csv"
    assert payload["xml"] is None
    assert payload["source"] == "name,parent\nA,\nB,A"
    obj = _decode_create_url(payload["url"])
    assert obj["type"] == "csv"


def test_emit_is_optional():
    # No emit hook: should not raise, still returns a payload.
    d = DrawioHelper(emit=None)
    payload = d.diagram(xml="<x/>")
    assert payload["url"]


@pytest.mark.parametrize("bad", ["", "   ", None, 123])
def test_empty_or_nonstring_content_rejected(bad):
    d = DrawioHelper(emit=lambda e: None)
    with pytest.raises((ValueError, TypeError)):
        d.diagram(xml=bad)


@pytest.mark.parametrize(
    "code",
    [
        # Documented global form.
        'drawio.diagram(xml=XML, title="t")',
        # The form an LLM commonly guesses (and that failed in the field):
        "from drawio import drawio\ndrawio.diagram(xml=XML, title='t')",
        # import module then call.
        "import drawio\ndrawio.diagram(xml=XML, title='t')",
        # from drawio import the function directly.
        "from drawio import diagram\ndiagram(xml=XML, title='t')",
    ],
)
def test_install_drawio_supports_every_access_pattern(code):
    """Regression: `from drawio import drawio` must not ModuleNotFoundError.

    The helper is injected as a global AND registered as an importable module so
    any reasonable way the model reaches for it works.
    """
    events = []
    g = {"__builtins__": __builtins__, "XML": "<mxGraphModel><root/></mxGraphModel>"}
    install_drawio(g, emit=events.append)
    exec(code, g)
    assert len(events) == 1
    assert events[0]["type"] == "diagram"
    assert events[0]["url"].startswith("https://app.diagrams.net/")
