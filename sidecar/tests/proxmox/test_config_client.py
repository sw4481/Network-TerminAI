"""Tests for proxmox config reading and lazy API construction."""
import sqlite3
from pathlib import Path

import pytest

from ccie_sidecar.proxmox_api import config as cfgmod
from ccie_sidecar.proxmox_api import client as clientmod


def _make_db(tmp_path: Path) -> Path:
    db = tmp_path / "sessions.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE proxmox_config (id INTEGER PRIMARY KEY, host TEXT, port INTEGER, "
        "user TEXT, token_name TEXT, token_value TEXT, password TEXT, verify_ssl INTEGER)"
    )
    conn.execute(
        "INSERT INTO proxmox_config (id, host, port, user, token_name, token_value, password, verify_ssl) "
        "VALUES (1, 'proxmox.example.test', 8006, 'root@pam', '', '', 'secret', 0)"
    )
    conn.commit()
    conn.close()
    return db


def test_get_proxmox_config_reads_row(tmp_path, monkeypatch):
    db = _make_db(tmp_path)
    monkeypatch.setattr(cfgmod, "_db_path", lambda: db)
    conf = cfgmod.get_proxmox_config()
    assert conf is not None
    assert conf["host"] == "proxmox.example.test"
    assert conf["port"] == 8006
    assert conf["user"] == "root@pam"
    assert conf["password"] == "secret"
    assert conf["verify_ssl"] is False


def test_get_proxmox_config_none_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(cfgmod, "_db_path", lambda: tmp_path / "nope.db")
    assert cfgmod.get_proxmox_config() is None


def test_env_fallback(monkeypatch, tmp_path):
    monkeypatch.setattr(cfgmod, "_db_path", lambda: tmp_path / "nope.db")
    monkeypatch.setenv("PROXMOX_HOST", "10.0.0.9")
    monkeypatch.setenv("PROXMOX_USER", "root@pam")
    monkeypatch.setenv("PROXMOX_PASSWORD", "p")
    conf = cfgmod.get_proxmox_config()
    assert conf["host"] == "10.0.0.9"
    # Default (unset) verify_ssl is False.
    assert conf["verify_ssl"] is False


def test_env_verify_ssl_truthy(monkeypatch, tmp_path):
    monkeypatch.setattr(cfgmod, "_db_path", lambda: tmp_path / "nope.db")
    monkeypatch.setenv("PROXMOX_HOST", "10.0.0.9")
    for val, expected in [("1", True), ("true", True), ("YES", True),
                          ("0", False), ("false", False), ("", False)]:
        monkeypatch.setenv("PROXMOX_VERIFY_SSL", val)
        assert cfgmod.get_proxmox_config()["verify_ssl"] is expected, val


def test_build_proxmox_api_with_password(monkeypatch):
    calls = {}

    class FakeAPI:
        def __init__(self, **kwargs):
            calls.update(kwargs)

    monkeypatch.setattr(clientmod, "ProxmoxAPI", FakeAPI)
    api = clientmod.build_proxmox_api({
        "host": "h", "port": 8006, "user": "root@pam",
        "token_name": "", "token_value": "", "password": "pw", "verify_ssl": False,
    })
    assert isinstance(api, FakeAPI)
    assert calls["host"] == "h"
    assert calls["password"] == "pw"
    assert calls["verify_ssl"] is False


def test_build_proxmox_api_treats_string_false_as_false(monkeypatch):
    calls = {}

    class FakeAPI:
        def __init__(self, **kwargs):
            calls.update(kwargs)

    monkeypatch.setattr(clientmod, "ProxmoxAPI", FakeAPI)
    clientmod.build_proxmox_api({
        "host": "h", "port": 8006, "user": "root@pam",
        "token_name": "", "token_value": "", "password": "pw", "verify_ssl": "false",
    })
    assert calls["verify_ssl"] is False


def test_build_proxmox_api_with_token(monkeypatch):
    calls = {}

    class FakeAPI:
        def __init__(self, **kwargs):
            calls.update(kwargs)

    monkeypatch.setattr(clientmod, "ProxmoxAPI", FakeAPI)
    clientmod.build_proxmox_api({
        "host": "h", "port": 8006, "user": "root@pam",
        "token_name": "mytok", "token_value": "abc", "password": "", "verify_ssl": True,
    })
    assert calls["token_name"] == "mytok"
    assert calls["token_value"] == "abc"
    assert "password" not in calls


def test_build_proxmox_api_accepts_camelcase_token_keys(monkeypatch):
    calls = {}

    class FakeAPI:
        def __init__(self, **kwargs):
            calls.update(kwargs)

    monkeypatch.setattr(clientmod, "ProxmoxAPI", FakeAPI)
    clientmod.build_proxmox_api({
        "host": "h", "port": 8006, "user": "root@pam",
        "tokenName": "mytok", "tokenValue": "abc", "password": "pw", "verifySsl": False,
    })
    assert calls["token_name"] == "mytok"
    assert calls["token_value"] == "abc"
    assert "password" not in calls
