from ccie_sidecar.agents.code_exec import PROXMOX_SANDBOX_BLURB


def test_blurb_is_short_and_mentions_help():
    assert "proxmox" in PROXMOX_SANDBOX_BLURB.lower()
    assert "help()" in PROXMOX_SANDBOX_BLURB
    # Keep it tiny — no giant API dump.
    assert PROXMOX_SANDBOX_BLURB.count("\n") <= 4
    assert len(PROXMOX_SANDBOX_BLURB) < 400
