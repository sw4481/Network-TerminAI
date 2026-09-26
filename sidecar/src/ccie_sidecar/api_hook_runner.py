"""Loader + dispatcher for user-authored API auth hooks.

Hooks live in ``~/.ccie-terminal/api-hooks/<module>.py`` and expose one or
more top-level functions with the signature::

    def sign_request(request: dict, env: dict) -> dict:
        ...

They are used by the API Runner when a target declares ``auth: type: hook``.
The Rust orchestrator passes the current request + env var map; the function
returns a mutated request dict (typically with new headers/body/url).

Security posture:
    * Hooks run inside the main sidecar interpreter -- no subprocess.
    * Module resolution is restricted to the hooks dir; relative paths and
      absolute paths outside that dir are rejected.
    * Certain well-known-dangerous stdlib modules are blocked at import time
      (``subprocess``, ``ctypes``, ``socket.bind`` via socket, etc.). The
      block is defence-in-depth — the user's real defence is not installing
      hostile hooks.
    * A 10 s watchdog aborts runaway functions (see Rust side; this module
      just runs the function synchronously and relies on the caller's
      timeout handling when spawning the sidecar).
"""
from __future__ import annotations

import builtins
import importlib.util
import os
import pathlib
import sys
from typing import Any, Callable


class HookError(Exception):
    """Raised when a hook can't be loaded or fails to execute cleanly."""


# Modules we never want a hook to import. The list isn't exhaustive — it's
# meant to trip obvious footguns (spawning subprocesses, binding sockets,
# calling raw syscalls). A determined attacker can always get around it;
# the real defence is user-curated hooks.
_BANNED_MODULES = frozenset(
    {
        "subprocess",
        "ctypes",
        "multiprocessing",
        "pty",
        "signal",
    }
)


def _hooks_dir() -> pathlib.Path:
    """Return ``~/.ccie-terminal/api-hooks`` (created if missing)."""
    home = pathlib.Path.home()
    d = home / ".ccie-terminal" / "api-hooks"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _resolve_module_path(module_name: str) -> pathlib.Path:
    """Return the filesystem path for ``module_name`` inside the hooks dir.

    Raises ``HookError`` when the name would escape the hooks dir.
    """
    if not module_name or module_name.startswith((".", "/", "\\")):
        raise HookError(f"invalid hook module name: {module_name!r}")
    # Strip optional ``.py`` suffix; keep only the basename to prevent
    # traversal like ``../../etc/passwd``.
    stem = module_name.removesuffix(".py")
    if pathlib.Path(stem).name != stem:
        raise HookError(
            f"hook module name must be a bare filename: {module_name!r}"
        )
    path = _hooks_dir() / f"{stem}.py"
    if not path.is_file():
        raise HookError(f"hook module not found: {path}")
    return path


class _BlockingFinder:
    """``sys.meta_path`` finder that refuses to import banned modules."""

    def find_spec(self, fullname, path=None, target=None):  # noqa: D401
        top = fullname.split(".")[0]
        if top in _BANNED_MODULES:
            raise HookError(f"hook attempted to import banned module: {fullname}")
        return None


def _load_module(path: pathlib.Path, qualname: str) -> Any:
    spec = importlib.util.spec_from_file_location(qualname, path)
    if spec is None or spec.loader is None:
        raise HookError(f"cannot load hook from {path}")
    module = importlib.util.module_from_spec(spec)
    # Install the blocking finder before executing module code so the
    # module's own ``import`` statements are screened.
    finder = _BlockingFinder()
    sys.meta_path.insert(0, finder)
    try:
        spec.loader.exec_module(module)
    except HookError:
        raise
    except Exception as exc:  # pragma: no cover - defensive
        raise HookError(f"hook module failed to load: {exc}") from exc
    finally:
        try:
            sys.meta_path.remove(finder)
        except ValueError:
            pass
    return module


def call_hook(module_name: str, function_name: str, request: dict, env: dict | None = None) -> dict:
    """Execute ``module_name.function_name(request, env)`` and return the result.

    Validates that the function exists, is callable, and returned a dict.
    Every error path raises :class:`HookError` with a message suitable for
    surfacing back to the user.
    """
    if not function_name or not function_name.isidentifier():
        raise HookError(f"invalid hook function name: {function_name!r}")

    path = _resolve_module_path(module_name)
    qualname = f"ccie_api_hook_{pathlib.Path(module_name).stem}"
    module = _load_module(path, qualname)

    fn: Callable | None = getattr(module, function_name, None)
    if fn is None:
        raise HookError(
            f"hook module {module_name!r} has no function {function_name!r}"
        )
    if not callable(fn):
        raise HookError(f"{module_name}.{function_name} is not callable")

    result = fn(request, env or {})
    if not isinstance(result, dict):
        raise HookError(
            f"hook {module_name}.{function_name} must return a dict, got {type(result).__name__}"
        )
    return result
