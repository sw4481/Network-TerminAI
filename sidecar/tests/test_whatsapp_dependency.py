from pathlib import Path

import tomllib


def test_neonize_pin_is_not_known_outdated_whatsapp_client():
    pyproject = Path(__file__).parents[1] / "pyproject.toml"
    data = tomllib.loads(pyproject.read_text())
    deps = data["project"]["dependencies"]

    assert "neonize==0.4.3.post0" in deps
    assert "neonize==0.3.18.post0" not in deps
