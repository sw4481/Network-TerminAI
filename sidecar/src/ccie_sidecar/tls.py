"""TLS bootstrap for provider clients.

``truststore`` bridges Python's SSL context to the operating system trust
store. That matters on managed macOS systems where the corporate inspection
root is trusted in Keychain but absent from certifi's bundled CA file.
"""

import ssl

from requests import Session
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPSConnection
from urllib3.connectionpool import HTTPSConnectionPool
from urllib3.contrib.pyopenssl import PyOpenSSLContext
from urllib3.util.ssl_ import resolve_cert_reqs


class _UnverifiedHttpsConnection(HTTPSConnection):
    def connect(self):
        if resolve_cert_reqs(self.cert_reqs) == ssl.CERT_NONE:
            # truststore still applies macOS certificate policy with CERT_NONE.
            # PyOpenSSL avoids that policy but its context cannot be reused.
            self.ssl_context = PyOpenSSLContext(ssl.PROTOCOL_TLS_CLIENT)
            self.ssl_context.check_hostname = False
            self.ssl_context.verify_mode = ssl.CERT_NONE
        return super().connect()


class _UnverifiedHttpsPool(HTTPSConnectionPool):
    ConnectionCls = _UnverifiedHttpsConnection


class _UnverifiedTlsAdapter(HTTPAdapter):
    """HTTPS adapter that stays unverified even after truststore monkeypatching."""

    def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
        super().init_poolmanager(connections, maxsize, block=block, **pool_kwargs)
        self.poolmanager.pool_classes_by_scheme = {
            **self.poolmanager.pool_classes_by_scheme, "https": _UnverifiedHttpsPool,
        }

    def proxy_manager_for(self, proxy, **proxy_kwargs):
        manager = super().proxy_manager_for(proxy, **proxy_kwargs)
        manager.pool_classes_by_scheme = {
            **manager.pool_classes_by_scheme, "https": _UnverifiedHttpsPool,
        }
        return manager


def mount_unverified_tls(session: Session) -> Session:
    session.mount("https://", _UnverifiedTlsAdapter())
    return session


def install_system_trust_store() -> bool:
    """Install the OS trust store for subsequent HTTPS clients when available."""
    try:
        import truststore
    except ImportError:
        return False
    truststore.inject_into_ssl()
    return True
