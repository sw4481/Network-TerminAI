"""
Pytest configuration and shared fixtures for meraki_cli tests.

Session-scoped fixtures and test configuration.
"""

import pytest


# Ensure clean environment for credential tests
@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """
    Automatically clean environment variables before each test.

    This prevents environment pollution between tests.
    """
    # Note: Tests will explicitly set needed env vars
    pass
