"""Blender sandbox helper install tests."""

from ccie_sidecar.agents.blender_helper import install_blender
from ccie_sidecar.agents.code_exec import BLENDER_SANDBOX_BLURB, _build_sandbox_globals


def test_install_registers_global():
    g = {}
    install_blender(g)
    assert "blender" in g
    assert hasattr(g["blender"], "scene_info")
    assert hasattr(g["blender"], "execute_code")
    assert hasattr(g["blender"], "help")


def test_installed_object_is_importable_as_module():
    g = {"__builtins__": __import__("builtins")}
    install_blender(g)
    exec("import blender\nresult = blender.help()", g)
    assert "scene_info" in g["result"]


def test_build_sandbox_globals_includes_blender():
    g = _build_sandbox_globals(cli_package=None, secrets={})
    assert "blender" in g


def test_blender_blurb_is_compact_and_mentions_setup():
    text = BLENDER_SANDBOX_BLURB.lower()
    assert "blender" in text
    assert "blender.status()" in BLENDER_SANDBOX_BLURB
    assert "addon" in text
    assert BLENDER_SANDBOX_BLURB.count("\n") <= 3
    assert len(BLENDER_SANDBOX_BLURB) < 450
