"""Legacy appliance certificates must honor the connection's verification setting."""

from datetime import datetime, timedelta, timezone
import ipaddress
import ssl
from threading import Thread

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
import pytest
import requests
import requests.adapters
import truststore
import urllib3.util.ssl_

from ccie_sidecar.tls import install_system_trust_store, mount_unverified_tls
from .test_tls_connections import _HttpsServer


@pytest.fixture
def legacy_tls_origins(tmp_path, monkeypatch, request):
    trusted = getattr(request, "param", None) == "trusted"
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "legacy-appliance.invalid")])
    now = datetime.now(timezone.utc)
    issuer_key = rsa.generate_private_key(public_exponent=65537, key_size=2048) if trusted else key
    issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Loopback Test CA")]) if trusted else name
    if trusted:
        ca = (
            x509.CertificateBuilder()
            .subject_name(issuer).issuer_name(issuer).public_key(issuer_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=2))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
            .sign(issuer_key, hashes.SHA256())
        )
        (tmp_path / "test-ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    # Default matches the failing certificate's policy, not its identity:
    # ten-year lifetime, CA-marked leaf, serverAuth and no subject alternative name.
    builder = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1 if trusted else 3649))
        .add_extension(x509.BasicConstraints(ca=not trusted, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
    )
    if trusted:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False,
        ).add_extension(x509.KeyUsage(True, False, True, False, False, False, False, False, False), critical=True)
    cert = builder.sign(issuer_key, hashes.SHA384())
    cert_path = tmp_path / "legacy-cert.pem"
    key_path = tmp_path / "legacy-key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    key_path.chmod(0o600)
    servers = []
    threads = []
    try:
        for _ in range(2):
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert_path, key_path)
            server = _HttpsServer(context)
            servers.append(server)
            thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            thread.start()
            threads.append(thread)
        monkeypatch.setattr(ssl, "SSLContext", ssl.SSLContext)
        monkeypatch.setattr(urllib3.util.ssl_, "SSLContext", urllib3.util.ssl_.SSLContext)
        if hasattr(requests.adapters, "_preloaded_ssl_context"):
            monkeypatch.setattr(
                requests.adapters, "_preloaded_ssl_context", requests.adapters._preloaded_ssl_context
            )
        assert install_system_trust_store() is True
        yield servers
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(timeout=5)
            assert not thread.is_alive()


def test_unverified_legacy_certificate_reconnects_across_origins(legacy_tls_origins):
    first, second = legacy_tls_origins
    with mount_unverified_tls(requests.Session()) as session:
        session.trust_env = False
        for server in (first, first, second):
            response = session.get(server.url, verify=False, timeout=5)
            assert response.status_code == 200
            assert response.text == "ok"
    assert first.connections == 2
    assert second.connections == 1
    assert ssl.SSLContext is truststore.SSLContext


def test_adapter_keeps_pool_mapping_local():
    with requests.Session() as ordinary, mount_unverified_tls(requests.Session()) as adapted:
        normal_manager = ordinary.get_adapter("https://").poolmanager
        adapted_manager = adapted.get_adapter("https://").poolmanager
        assert normal_manager.pool_classes_by_scheme is not adapted_manager.pool_classes_by_scheme
        assert normal_manager.pool_classes_by_scheme["https"] is not adapted_manager.pool_classes_by_scheme["https"]
        proxy = adapted.get_adapter("https://").proxy_manager_for("http://127.0.0.1:1")
        assert proxy.pool_classes_by_scheme is not normal_manager.pool_classes_by_scheme
        assert proxy.pool_classes_by_scheme["https"] is adapted_manager.pool_classes_by_scheme["https"]


@pytest.mark.parametrize("legacy_tls_origins", ["trusted"], indirect=True)
@pytest.mark.parametrize("mounted_adapter", [False, True])
def test_explicitly_trusted_certificate_still_accepted(legacy_tls_origins, tmp_path, mounted_adapter):
    with requests.Session() as session:
        session.trust_env = False
        if mounted_adapter:
            mount_unverified_tls(session)
        response = session.get(legacy_tls_origins[0].url, verify=str(tmp_path / "test-ca.pem"), timeout=5)
        assert response.status_code == 200
    assert ssl.SSLContext is truststore.SSLContext


@pytest.mark.parametrize("mounted_adapter", [False, True])
def test_verified_legacy_certificate_still_rejected(legacy_tls_origins, mounted_adapter):
    with requests.Session() as session:
        session.trust_env = False
        if mounted_adapter:
            mount_unverified_tls(session)
        with pytest.raises(requests.exceptions.SSLError):
            session.get(legacy_tls_origins[0].url, verify=True, timeout=5)
    assert ssl.SSLContext is truststore.SSLContext
