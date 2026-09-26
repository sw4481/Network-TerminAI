"""Subprocess-layer gate for IaC mutations inside execute_python_code.

WHY: An IaC agent has two ways to mutate infrastructure — the gated `iac_apply`
tool (routes through the approval modal) and `execute_python_code` (runs
arbitrary subprocess). Gating only the former is meaningless: the model will
just `subprocess.run(['terraform','apply'])` and bypass approval entirely (which
is exactly what happened). This guard closes that hole at the action layer.

MECHANISM (and its honest limits): the code-exec sandbox runs synchronously on a
worker thread and cannot pause for an async approval round-trip. LangGraph
interrupts only happen at *tool boundaries*. So we cannot "pause in place" inside
code-exec — instead we BLOCK mutating IaC subprocess calls and raise an error
that redirects the model to the `iac_apply` tool (a separate tool call that CAN
be interrupted for approval). Same security outcome (no ungated mutation),
achievable mechanism.

THREAT MODEL: this steers a cooperative model off the easy ungated path. It is
NOT a security sandbox against an adversarial model — a shared-process exec()
cannot be one. It guards subprocess.{run,Popen,call,check_output,check_call},
os.system, os.popen, and re-imports of `subprocess`.
"""
from __future__ import annotations

import os
import subprocess
from typing import Any, Iterable


class IaCMutationBlocked(Exception):
    """Raised when code-exec attempts a mutating IaC command directly."""


_REDIRECT_MSG = (
    "BLOCKED: mutating Infrastructure-as-Code commands may not be run via "
    "execute_python_code — they bypass the approval gate. Use the `iac_apply` "
    "tool instead (it pauses for human approval with a blast-radius preview). "
    "Read-only commands (terraform plan/show/validate/version/init, "
    "ansible --check) are allowed here. Blocked command: {cmd}"
)

# Terraform subcommands that change real infrastructure.
_TF_MUTATING = {"apply", "destroy", "import", "taint", "untaint", "state"}
# Ansible binaries that run plays (mutating unless --check is present).
_ANSIBLE_BINS = {"ansible-playbook", "ansible"}
_IAC_BINS = {"terraform", "tf", "tofu", "opentofu"} | _ANSIBLE_BINS


def _tokens(cmd: Any) -> list[str]:
    """Normalize a subprocess command (str or argv list) to a token list."""
    if isinstance(cmd, str):
        return cmd.split()
    if isinstance(cmd, (list, tuple)):
        out: list[str] = []
        for part in cmd:
            out.extend(str(part).split() if isinstance(part, str) else [str(part)])
        return out
    return [str(cmd)]


def _basename(tok: str) -> str:
    return os.path.basename(tok).lower()


def is_mutating_iac_command(cmd: Any) -> bool:
    """True if cmd invokes a mutating terraform/tofu/ansible operation."""
    toks = _tokens(cmd)
    if not toks:
        return False
    head = _basename(toks[0])
    rest = [t for t in toks[1:] if t]

    if head in {"terraform", "tf", "tofu", "opentofu"}:
        # First non-flag token after the binary is the subcommand.
        sub = next((t for t in rest if not t.startswith("-")), "")
        return sub in _TF_MUTATING

    if head in _ANSIBLE_BINS:
        # Plays mutate unless explicitly --check (dry run).
        if "--check" in rest or "-C" in rest:
            return False
        # `ansible host -m <module>` and `ansible-playbook book.yml` both mutate.
        return head == "ansible-playbook" or "-m" in rest

    return False


def _guarded(func, what: str):
    """Wrap a subprocess/os exec function to block mutating IaC commands."""
    def wrapper(cmd, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        if is_mutating_iac_command(cmd):
            raise IaCMutationBlocked(_REDIRECT_MSG.format(cmd=cmd))
        return func(cmd, *args, **kwargs)

    wrapper.__name__ = getattr(func, "__name__", what)
    wrapper.__qualname__ = wrapper.__name__
    return wrapper


class _GuardedSubprocess:
    """A proxy that mirrors the subprocess module but guards exec entry points.

    Returned to sandbox code both as the injected `subprocess` global and from
    `import subprocess` (via the patched __import__), so either access path hits
    the guard.
    """

    def __init__(self) -> None:
        self.run = _guarded(subprocess.run, "subprocess.run")
        self.Popen = _guarded(subprocess.Popen, "subprocess.Popen")
        self.call = _guarded(subprocess.call, "subprocess.call")
        self.check_call = _guarded(subprocess.check_call, "subprocess.check_call")
        self.check_output = _guarded(subprocess.check_output, "subprocess.check_output")

    def __getattr__(self, name: str) -> Any:
        # Everything not explicitly guarded (PIPE, CalledProcessError, ...) passes
        # through to the real module.
        return getattr(subprocess, name)


def install_iac_guard(globals_dict: dict[str, Any]) -> None:
    """Install the IaC subprocess guard into a sandbox globals dict.

    Guards the injected `subprocess`/`os` globals AND patches `__import__` so
    re-imports of `subprocess` return the guarded proxy. `os.system`/`os.popen`
    are guarded; the rest of `os` is untouched.
    """
    guarded_sub = _GuardedSubprocess()
    globals_dict["subprocess"] = guarded_sub

    # Guard os.system / os.popen without mutating the real os module: expose a
    # lightweight proxy as the sandbox's `os`.
    real_os = os

    class _GuardedOs:
        # Instance-level attrs so `os.system(...)` resolves to the guarded fn
        # (class-level staticmethods are shadowed by __getattr__ inconsistently
        # and, more importantly, `import os` would bypass them entirely — the
        # __import__ patch below returns THIS proxy for `import os`).
        def __init__(self) -> None:
            self.system = _guarded(real_os.system, "os.system")
            self.popen = _guarded(real_os.popen, "os.popen")

        def __getattr__(self, name: str) -> Any:
            return getattr(real_os, name)

    guarded_os = _GuardedOs()
    globals_dict["os"] = guarded_os

    # Patch __import__ so `import subprocess` / `import os` yield the guarded
    # proxies (otherwise code that does `import os` gets the real module and
    # bypasses the guard — the injected global only helps code that never
    # imports). Submodule/`from x import y` access falls through to the real
    # module, which is fine: the exec entry points live on os/subprocess directly.
    builtins_obj = globals_dict.get("__builtins__")
    if isinstance(builtins_obj, dict):
        real_import = builtins_obj.get("__import__", __import__)
    else:
        real_import = getattr(builtins_obj, "__import__", __import__)

    def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):  # noqa: A002
        module = real_import(name, globals, locals, fromlist, level)
        # Only swap on a bare `import subprocess` / `import os` (no fromlist),
        # so `from os import path` etc. keep working against the real module.
        if not fromlist and level == 0:
            if name == "subprocess":
                return guarded_sub
            if name == "os":
                return guarded_os
        return module

    # Use a dict __builtins__ so we can override __import__ without touching the
    # shared builtins module (which would affect the whole sidecar process).
    import builtins as _b

    new_builtins = {k: getattr(_b, k) for k in dir(_b)}
    new_builtins["__import__"] = _guarded_import
    globals_dict["__builtins__"] = new_builtins
