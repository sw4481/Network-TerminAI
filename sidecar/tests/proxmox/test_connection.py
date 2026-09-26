"""test_connection: validate a passed-in Proxmox config without saving it."""
from unittest.mock import MagicMock

from ccie_sidecar.proxmox_api import connection


class FakeResponse:
    def __init__(self, data=None, error=None):
        self._data = data or {}
        self._error = error

    def raise_for_status(self):
        if self._error:
            raise self._error

    def json(self):
        return self._data


def test_success_summarizes_nodes_with_password_auth():
    session = MagicMock()
    session.post.return_value = FakeResponse({"data": {"ticket": "ticket"}})
    session.get.return_value = FakeResponse({"data": [
        {"node": "pve1", "status": "online"},
        {"node": "pve2", "status": "online"},
    ]})

    out = connection.ProxmoxConnectionTester(session).test({"host": "h", "user": "root@pam", "password": "p", "verify_ssl": False})

    assert out["ok"] is True
    assert "2" in out["message"]
    assert "pve1" in out["message"]
    session.post.assert_called_once()
    assert session.post.call_args.kwargs["verify"] is False
    assert session.get.call_args.kwargs["verify"] is False


def test_success_uses_token_auth_without_ticket_request():
    session = MagicMock()
    session.get.return_value = FakeResponse({"data": [{"node": "pve1", "status": "online"}]})

    out = connection.ProxmoxConnectionTester(session).test({
        "host": "h",
        "user": "root@pam",
        "token_name": "automation",
        "token_value": "secret",
        "verify_ssl": "false",
    })

    assert out["ok"] is True
    session.post.assert_not_called()
    assert session.get.call_args.kwargs["headers"] == {"Authorization": "PVEAPIToken=root@pam!automation=secret"}
    assert session.get.call_args.kwargs["verify"] is False


def test_missing_host_is_friendly_error():
    out = connection.test_connection({"host": "", "user": "root@pam"})
    assert out["ok"] is False
    assert "host" in out["message"].lower()


def test_api_error_is_caught():
    session = MagicMock()
    session.post.return_value = FakeResponse(error=Exception("401 authentication failure"))

    out = connection.ProxmoxConnectionTester(session).test({"host": "h", "user": "root@pam", "password": "bad", "verify_ssl": False})

    assert out["ok"] is False
    assert "401" in out["message"] or "auth" in out["message"].lower()


def test_node_request_error_is_caught():
    session = MagicMock()
    session.post.return_value = FakeResponse({"data": {"ticket": "ticket"}})
    session.get.return_value = FakeResponse(error=Exception("cannot resolve host"))

    out = connection.ProxmoxConnectionTester(session).test({"host": "nope", "user": "root@pam", "password": "p"})

    assert out["ok"] is False
    assert "cannot resolve host" in out["message"]
