"""Regression checks for the development launcher dependency contract."""

from pathlib import Path


RUN_SH = Path(__file__).resolve().parents[2] / "run.sh"


def test_dev_launcher_installs_tracked_pyats_wrapper_when_missing():
    """A healthy sidecar also requires the tracked terminai_pyats package."""
    text = RUN_SH.read_text(encoding="utf-8")

    assert 'import ccie_sidecar, debugpy' in text
    assert 'import terminai_pyats' in text
    assert 'pip install -e ../pyats_cli' in text
