import sys
import types


def test_system_trust_store_is_installed_when_available(monkeypatch):
    from ccie_sidecar.tls import install_system_trust_store

    calls = []
    monkeypatch.setitem(
        sys.modules,
        "truststore",
        types.SimpleNamespace(inject_into_ssl=lambda: calls.append("installed")),
    )

    assert install_system_trust_store() is True
    assert calls == ["installed"]


def test_system_trust_store_is_optional(monkeypatch):
    from ccie_sidecar.tls import install_system_trust_store

    monkeypatch.setitem(sys.modules, "truststore", None)
    assert install_system_trust_store() is False
