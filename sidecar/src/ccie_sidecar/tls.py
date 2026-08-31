"""TLS bootstrap for provider clients.

``truststore`` bridges Python's SSL context to the operating system trust
store. That matters on managed macOS systems where the corporate inspection
root is trusted in Keychain but absent from certifi's bundled CA file.
"""


def install_system_trust_store() -> bool:
    """Install the OS trust store for subsequent HTTPS clients when available."""
    try:
        import truststore
    except ImportError:
        return False
    truststore.inject_into_ssl()
    return True
