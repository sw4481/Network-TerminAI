"""Shared device-connect helper.

All verbs connect through `ensure_connected()` so connection behavior is
consistent and robust against the most common real-world failure: unicon's
first-connect prompt-matching race on legacy Cisco IOS/IOS-XE devices.

The bare `device.connect()` unicon defaults assume the testbed device name
matches the device's actual CLI prompt hostname and that the init handshake
(`terminal length 0`, etc.) completes cleanly. On older devices with banners,
paging, or a prompt that differs from the testbed name, the connect hangs
until a prompt timeout fires ("Prompt timeout occured, please check the
hostname"). The settings below make connect tolerant:

- ``learn_hostname=True``  — adapt to whatever prompt the device actually
  presents instead of requiring it to equal the testbed name.
- ``connection_timeout``   — give the handshake more headroom than the default.
- ``init_exec_commands`` / ``init_config_commands`` left at defaults via
  device settings (see ROBUST_SETTINGS) so paging is still disabled but the
  connect doesn't fail if one init command is slow.
"""

from typing import Any


# Per-device unicon settings applied before connect. Tunable in one place.
CONNECTION_TIMEOUT_SECS = 60
EXEC_TIMEOUT_SECS = 60


def ensure_connected(device: Any) -> None:
    """Connect ``device`` if not already connected, with robust settings.

    Idempotent: a no-op if the device is already connected. Raises the
    underlying unicon error on genuine failure (auth/unreachable) so callers
    can surface it in their error envelope.
    """
    if device.is_connected():
        return

    # Apply tolerant settings before connecting. Guard each assignment so a
    # unicon version that lacks a given setting doesn't break the connect.
    settings = getattr(device, "settings", None)
    if settings is not None:
        try:
            settings.CONNECTION_TIMEOUT = CONNECTION_TIMEOUT_SECS
        except Exception:
            pass
        try:
            settings.EXEC_TIMEOUT = EXEC_TIMEOUT_SECS
        except Exception:
            pass

    device.connect(
        log_stdout=False,
        learn_hostname=True,
        connection_timeout=CONNECTION_TIMEOUT_SECS,
    )
