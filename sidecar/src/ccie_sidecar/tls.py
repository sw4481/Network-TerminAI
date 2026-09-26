"""TLS bootstrap for provider clients.

``truststore`` bridges Python's SSL context to the operating system trust
store. That matters on managed macOS systems where the corporate inspection
root is trusted in Keychain but absent from certifi's bundled CA file.
"""

import ssl

from requests import Session
from requests.adapters import HTTPAdapter
from urllib3.contrib.pyopenssl import PyOpenSSLContext


class _UnverifiedTlsAdapter(HTTPAdapter):
    """HTTPS adapter that stays unverified even after truststore monkeypatching."""

    @staticmethod
    def _context():
        context = PyOpenSSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return context

    def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
        pool_kwargs["ssl_context"] = self._context()
        return super().init_poolmanager(connections, maxsize, block=block, **pool_kwargs)

    def proxy_manager_for(self, proxy, **proxy_kwargs):
        proxy_kwargs["ssl_context"] = self._context()
        return super().proxy_manager_for(proxy, **proxy_kwargs)


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
