import pytest

from ccie_sidecar import server


def test_stp_collect_returns_only_normalized_worker_evidence(monkeypatch):
    monkeypatch.setattr(
        "ccie_sidecar.stp_worker.collect_stp",
        lambda: {
            "status": "complete",
            "devices": [{
                "device": "r1",
                "platform": "iosxe",
                "stp": {"ports": [{"interface": "Gi1", "state": "forwarding"}]},
                "neighbors": {"cdp": [], "lldp": []},
                "password": "must-not-cross-the-boundary",
            }],
            "adjacencies": [{
                "local_device_id": "r1",
                "remote_device_id": "r2",
                "local_interface": "gi1",
                "remote_interface": "gi2",
                "confidence": "confirmed",
                "raw": "must-not-cross-the-boundary",
            }],
            "findings": [{
                "code": "ROOT_DISAGREEMENT",
                "severity": "warning",
                "message": "conflicting roots",
                "scope_type": "vlan",
                "scope_id": "10",
                "raw": "must-not-cross-the-boundary",
            }],
        },
    )

    response = server.handle_request({"id": "stp-1", "method": "stp.collect", "params": {}})

    assert response["type"] == "done"
    assert response["result"]["devices"][0]["device"] == "r1"
    assert "password" not in response["result"]["devices"][0]
    assert response["result"]["adjacencies"][0]["confidence"] == "confirmed"
    assert response["result"]["findings"][0]["code"] == "ROOT_DISAGREEMENT"
    assert "raw" not in repr(response["result"])


def test_stp_collect_preserves_the_stable_collection_failure_code(monkeypatch):
    monkeypatch.setattr(
        "ccie_sidecar.stp_worker.collect_stp",
        lambda: {
            "status": "unsupported",
            "code": "unsupported_platform",
            "devices": [],
            "raw": "must-not-cross-the-boundary",
        },
    )

    response = server.handle_request({"id": "stp-2", "method": "stp.collect", "params": {}})

    assert response["type"] == "done"
    assert response["result"]["code"] == "unsupported_platform"
    assert "raw" not in response["result"]


def test_stp_collect_redacts_credential_like_text_inside_allowed_fields():
    result = server._safe_stp_result({
        "status": "complete",
        "devices": [],
        "findings": [{"code": "ROOT_DISAGREEMENT", "message": "token=not-a-real-token"}],
    })

    assert "not-a-real-token" not in repr(result)
    assert "[REDACTED]" in result["findings"][0]["message"]


def test_stp_collect_redacts_bearer_suffix_inside_authorization_text():
    result = server._safe_stp_result({
        "status": "complete",
        "devices": [],
        "findings": [{"code": "ROOT_DISAGREEMENT", "message": "Authorization: Bearer not-a-real-token"}],
    })

    assert "not-a-real-token" not in repr(result)
    assert result["findings"][0]["message"] == "[REDACTED]"


@pytest.mark.parametrize(
    "message",
    (
        "Authorization: Bearer not-a-real-token",
        "Authorization: Basic not-a-real-token",
        "Bearer not-a-real-token",
    ),
)
def test_stp_collect_redacts_authorization_credentials(message):
    result = server._safe_stp_result({
        "status": "complete",
        "devices": [],
        "findings": [{
            "code": "ROOT_DISAGREEMENT",
            "message": message,
        }],
    })

    assert "not-a-real-token" not in repr(result)
    assert "[REDACTED]" in result["findings"][0]["message"]
