"""Tests for the shared vendor API error-surfacing helper."""

from ccie_sidecar.api_errors import build_http_error


def test_splunk_messages_shape():
    data = {"messages": [{"type": "FATAL", "text": "Unknown search command 'index'."}]}
    assert build_http_error(400, data) == "HTTP 400: Unknown search command 'index'."


def test_meraki_errors_list_of_strings():
    data = {"errors": ["Invalid API key", "Access denied"]}
    assert build_http_error(403, data) == "HTTP 403: Invalid API key; Access denied"


def test_ise_ersresponse_nested():
    data = {"ERSResponse": {"messages": [{"title": "Resource not found"}]}}
    assert build_http_error(404, data) == "HTTP 404: Resource not found"


def test_dnac_response_wrapper():
    data = {"response": {"errorCode": 400, "message": "Invalid site id"}}
    assert build_http_error(400, data) == "HTTP 400: Invalid site id"


def test_generic_message_key():
    assert build_http_error(500, {"message": "Internal error"}) == "HTTP 500: Internal error"


def test_generic_detail_key():
    assert build_http_error(400, {"detail": "field x required"}) == "HTTP 400: field x required"


def test_prometheus_error_key():
    data = {"status": "error", "errorType": "bad_data", "error": "invalid query"}
    assert build_http_error(400, data) == "HTTP 400: invalid query"


def test_text_body_that_is_json():
    # /export streams text; the helper must parse it before extracting.
    text = '{"messages":[{"text":"Error in search"}]}'
    assert build_http_error(400, text) == "HTTP 400: Error in search"


def test_text_body_html_falls_back_truncated():
    html = "<html><body>" + "x" * 500 + "</body></html>"
    out = build_http_error(502, html)
    assert out.startswith("HTTP 502: ")
    assert out.endswith("…")
    assert len(out) < 400


def test_empty_body_returns_bare_status():
    assert build_http_error(400, "") == "HTTP 400"
    assert build_http_error(400, "   ") == "HTTP 400"
    assert build_http_error(500, None) == "HTTP 500"


def test_unrecognized_dict_returns_bare_status():
    # No known message key -> don't fabricate detail.
    assert build_http_error(400, {"results": [], "foo": "bar"}) == "HTTP 400"


def test_long_message_truncated():
    data = {"message": "y" * 500}
    out = build_http_error(400, data)
    assert out.endswith("…")
    assert len(out) <= len("HTTP 400: ") + 301
