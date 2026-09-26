"""Regression tests for two proxmox-agent failures in the legacy react_code loop:

1. The execute_python_code tool description never mentioned the injected
   `proxmox` module, so the model groped for docker/terraform/env-vars.
2. Code-exec output was fed back to the model with no size cap, so an
   os.walk() dump blew past the model's context window (2.7M tokens).
"""
from ccie_sidecar.agents import react_code


def test_client_section_mentions_proxmox_when_available():
    # Bare sandbox (no vendor client) but proxmox IS injected — the proxmox
    # agent's case. The tool description must point the model at the module.
    section = react_code._build_client_section(
        cli_package=None,
        sandbox_globals={"proxmox": object(), "requests": object()},
        meraki_client_ready=False,
    )
    assert "proxmox" in section
    assert "proxmox.help()" in section


def test_client_section_bare_when_no_proxmox():
    section = react_code._build_client_section(
        cli_package=None,
        sandbox_globals={"requests": object()},
        meraki_client_ready=False,
    )
    assert "proxmox" not in section.lower()


def test_client_section_still_prefers_meraki_when_bound():
    section = react_code._build_client_section(
        cli_package="meraki",
        sandbox_globals={"meraki": object(), "proxmox": object()},
        meraki_client_ready=True,
    )
    # Meraki agents keep their dedicated guidance, not the proxmox blurb.
    assert "meraki" in section.lower()


def test_truncate_output_caps_long_text():
    big = "x" * 100_000
    out = react_code._truncate_output(big, limit=20_000)
    assert len(out) < 25_000  # cap + a short notice
    assert "truncated" in out.lower()


def test_truncate_output_passes_short_text_unchanged():
    s = "3 nodes online"
    assert react_code._truncate_output(s, limit=20_000) == s
