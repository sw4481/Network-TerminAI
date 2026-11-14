"""Real loopback TLS regressions for the shared unverified Requests adapter."""

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import ipaddress
import ssl
from threading import Thread

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
import pytest
import requests
import requests.adapters
import truststore
import urllib3.util.ssl_

from ccie_sidecar.tls import install_system_trust_store, mount_unverified_tls


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


class _HttpsServer(HTTPServer):
    def __init__(self, context):
        self.context = context
        self.connections = 0
        super().__init__(("127.0.0.1", 0), _Handler)

    @property
    def url(self):
        return f"https://127.0.0.1:{self.server_port}/"

    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(5)
        try:
            wrapped = self.context.wrap_socket(sock, server_side=True)
        except BaseException:
            sock.close()
            raise
        self.connections += 1
        return wrapped, address


@pytest.fixture
def tls_origins(tmp_path, monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path = tmp_path / "loopback-cert.pem"
    key_path = tmp_path / "loopback-key.pem"
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    key_path.chmod(0o600)

    # Build server contexts before installing the client-side truststore shim.
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

        # Restore every global modified by truststore when this fixture finishes.
        monkeypatch.setattr(ssl, "SSLContext", ssl.SSLContext)
        monkeypatch.setattr(urllib3.util.ssl_, "SSLContext", urllib3.util.ssl_.SSLContext)
        if hasattr(requests.adapters, "_preloaded_ssl_context"):
            monkeypatch.setattr(
                requests.adapters, "_preloaded_ssl_context", requests.adapters._preloaded_ssl_context
            )
        assert install_system_trust_store() is True
        assert ssl.SSLContext is truststore.SSLContext
        yield servers
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(timeout=5)
            assert not thread.is_alive()


@pytest.mark.parametrize("separate_origins", [True, False], ids=["two-origins", "same-origin-reconnect"])
def test_unverified_adapter_allows_two_physical_tls_connections(tls_origins, separate_origins):
    first, second = tls_origins
    urls = [first.url, second.url if separate_origins else first.url]
    with mount_unverified_tls(requests.Session()) as session:
        session.trust_env = False
        for url in urls:
            response = session.get(url, verify=False, timeout=5)
            assert response.status_code == 200
            assert response.text == "ok"
    assert first.connections == (1 if separate_origins else 2)
    assert second.connections == (1 if separate_origins else 0)


@pytest.mark.parametrize("mounted_adapter", [False, True], ids=["default-verified", "adapter-verified"])
def test_verification_enabled_rejects_self_signed_certificate(tls_origins, mounted_adapter):
    with requests.Session() as session:
        session.trust_env = False
        if mounted_adapter:
            mount_unverified_tls(session)
        with pytest.raises(requests.exceptions.SSLError, match="certificate (verify failed|is not trusted)"):
            session.get(tls_origins[0].url, verify=True, timeout=5)
