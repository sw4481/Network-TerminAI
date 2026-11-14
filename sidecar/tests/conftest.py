from unittest.mock import patch

import pytest


@pytest.fixture(autouse=True)
def isolate_whatsapp_startup():
    # NDJSON unit tests must not reconnect the operator's configured account.
    with patch("ccie_sidecar.whatsapp_bridge.maybe_autostart"):
        yield
