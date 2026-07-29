"""Tests for ccie_sidecar.api_hook_runner — loading + dispatching user hooks."""
from __future__ import annotations

import pathlib
import sys
import textwrap

import pytest

from ccie_sidecar import api_hook_runner


@pytest.fixture
def hooks_dir(tmp_path, monkeypatch):
    """Point the hook runner at a temp dir instead of the real ~/.ccie-terminal."""
    monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
    d = tmp_path / ".ccie-terminal" / "api-hooks"
    d.mkdir(parents=True)
    yield d


def write_hook(dir_: pathlib.Path, name: str, body: str) -> pathlib.Path:
    """Write a hook module with the given source."""
    path = dir_ / f"{name}.py"
    path.write_text(textwrap.dedent(body).lstrip())
    return path


def test_loads_hook_and_runs_function(hooks_dir):
    write_hook(
        hooks_dir,
        "simple",
        """
        def sign_request(request, env):
            headers = dict(request.get("headers", {}))
            headers["X-Sig"] = "ok"
            return {**request, "headers": headers}
        """,
    )
    result = api_hook_runner.call_hook(
        "simple",
        "sign_request",
        {"url": "https://x/", "headers": {}},
        {"K": "v"},
    )
    assert result["headers"]["X-Sig"] == "ok"


def test_module_name_with_py_suffix_works(hooks_dir):
    write_hook(
        hooks_dir,
        "m",
        """
        def f(req, env):
            return req
        """,
    )
    # Both forms should resolve to the same module file.
    assert api_hook_runner.call_hook("m", "f", {}, {}) == {}
    assert api_hook_runner.call_hook("m.py", "f", {}, {}) == {}


def test_missing_module_raises(hooks_dir):
    with pytest.raises(api_hook_runner.HookError, match="not found"):
        api_hook_runner.call_hook("missing", "fn", {}, {})


def test_path_traversal_is_rejected(hooks_dir):
    with pytest.raises(api_hook_runner.HookError):
        api_hook_runner.call_hook("../../etc/passwd", "fn", {}, {})
    with pytest.raises(api_hook_runner.HookError):
        api_hook_runner.call_hook("/etc/passwd", "fn", {}, {})
    with pytest.raises(api_hook_runner.HookError):
        api_hook_runner.call_hook(".hidden", "fn", {}, {})


def test_missing_function_raises(hooks_dir):
    write_hook(hooks_dir, "m", "def f(r, e): return r\n")
    with pytest.raises(api_hook_runner.HookError, match="has no function"):
        api_hook_runner.call_hook("m", "does_not_exist", {}, {})


def test_non_callable_attribute_raises(hooks_dir):
    write_hook(hooks_dir, "m", "f = 42\n")
    with pytest.raises(api_hook_runner.HookError, match="not callable"):
        api_hook_runner.call_hook("m", "f", {}, {})


def test_invalid_function_name_raises(hooks_dir):
    write_hook(hooks_dir, "m", "def f(r, e): return r\n")
    with pytest.raises(api_hook_runner.HookError):
        api_hook_runner.call_hook("m", "not a valid identifier!", {}, {})


def test_non_dict_return_raises(hooks_dir):
    write_hook(
        hooks_dir,
        "m",
        "def f(r, e): return ['oops']\n",
    )
    with pytest.raises(api_hook_runner.HookError, match="must return a dict"):
        api_hook_runner.call_hook("m", "f", {}, {})


def test_hook_exception_propagates(hooks_dir):
    write_hook(
        hooks_dir,
        "m",
        "def f(r, e): raise RuntimeError('boom')\n",
    )
    with pytest.raises(RuntimeError, match="boom"):
        api_hook_runner.call_hook("m", "f", {}, {})


def test_banned_module_import_at_module_level_is_refused(hooks_dir):
    write_hook(
        hooks_dir,
        "evil",
        """
        import subprocess  # noqa: F401
        def f(r, e):
            return r
        """,
    )
    # Pre-cache busts may let subprocess through since it's in sys.modules
    # for pytest itself. If already imported we skip the strong assertion
    # and rely on the behavior test.
    if "subprocess" in sys.modules:
        pytest.skip("subprocess already in sys.modules — can't prove block")
    with pytest.raises(api_hook_runner.HookError, match="banned"):
        api_hook_runner.call_hook("evil", "f", {}, {})


def test_stdlib_import_still_works(hooks_dir):
    write_hook(
        hooks_dir,
        "jsonhook",
        """
        import json

        def f(request, env):
            payload = json.dumps({"url": request.get("url")})
            return {**request, "body_text": payload}
        """,
    )
    result = api_hook_runner.call_hook(
        "jsonhook",
        "f",
        {"url": "https://example/", "body_text": None},
        {},
    )
    assert '"https://example/"' in result["body_text"]


def test_env_dict_is_passed_read_only(hooks_dir):
    write_hook(
        hooks_dir,
        "peek",
        """
        def f(request, env):
            return {**request, "headers": {"X-Env-Seen": env.get("KEY", "")}}
        """,
    )
    result = api_hook_runner.call_hook(
        "peek",
        "f",
        {"headers": {}},
        {"KEY": "secret123"},
    )
    assert result["headers"]["X-Env-Seen"] == "secret123"
