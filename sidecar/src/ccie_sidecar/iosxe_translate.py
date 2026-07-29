"""Cisco IOS-XE CLI <-> NETCONF/XML translation helper.

Bound into a code-exec sandbox as an `iosxe` object. Translation is graded by
an explicit accuracy tier so the agent never over-claims:

- Tier A (device-verified): push CLI / native XML at a real device and read back
  the result, then diff. The only authoritative path -- this is what Cisco
  YANGSuite does. Methods: cli_to_native, native_to_cli.
- Tier B (model-grounded, NOT device-verified): parse the downloaded Cisco YANG
  with pyang so paths/namespaces are checked against real containers/leaves,
  never invented. Methods: models, schema_tree, validate_native.
- Tier C (cli-rpc envelope): wrap CLI verbatim in Cisco-IOS-XE-cli-rpc. This is
  transport, NOT native-model translation. Method: cli_to_rpc. (Port of the
  Rust netconf_runner::cli_wrapper so offline output matches the NETCONF panel.)

Reuses existing infrastructure: the YANG cache populated by the YANG browser
(~/.ccie-terminal/yang-cache/cisco/xe/<release>/), sidecar pyang, the pyATS
testbed via build_pyats_client(), and `requests` (already in the sandbox) for
RESTCONF. No new dependency is added.
"""

import os
import subprocess
import sys
import types
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ccie_sidecar.yang_downloader import parse_yang_metadata

# CLI verbs that are operational (exec), not configuration. IOS-XE NETCONF has
# no generic show/exec RPC, so these cannot be wrapped -- matches the reject
# behaviour of netconf_runner::cli_wrapper::wrap_iosxe.
_EXEC_PREFIXES = (
    "show ", "display ", "ping ", "traceroute ",
    "telnet ", "ssh ", "debug ", "undebug ",
)

_NATIVE_MODULE = "Cisco-IOS-XE-native"
_NATIVE_NS = "http://cisco.com/ns/yang/Cisco-IOS-XE-native"


def _ok(op: str, data: Any, tier: str, blast: str = "low") -> Dict[str, Any]:
    return {"ok": True, "op": op, "data": data, "error": None,
            "tier": tier, "blast_radius": blast}


def _err(op: str, msg: str, tier: str = "n/a", blast: str = "low") -> Dict[str, Any]:
    return {"ok": False, "op": op, "data": None, "error": msg,
            "tier": tier, "blast_radius": blast}


def _is_exec(cli: str) -> bool:
    low = cli.strip().lower()
    return any(low.startswith(p) for p in _EXEC_PREFIXES)


def _escape_xml(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&apos;"))


def _pyang_bin() -> str:
    """Locate pyang next to the running interpreter, else fall back to PATH."""
    cand = os.path.join(os.path.dirname(sys.executable), "pyang")
    if os.path.exists(cand):
        return cand
    import shutil
    return shutil.which("pyang") or "pyang"


def _cache_base() -> Path:
    return Path.home() / ".ccie-terminal" / "yang-cache" / "cisco" / "xe"


_AUGMENT_RE = None  # compiled lazily to keep import cheap


def _norm_augment_target(target: str) -> str:
    """Normalize a YANG augment target to prefix-free /a/b/c form.

    e.g. '/ios:native/ios:router' -> '/native/router'.
    """
    segs = [s.split(":")[-1] for s in target.strip("/").split("/") if s]
    return "/" + "/".join(segs)


def _augmenters_for_path(rel: Path, path: str) -> List[str]:
    """Filenames of modules whose augments feed the native data `path`.

    Cisco splits native into feature modules that `augment "/ios:native/..."`.
    To render a scoped subtree we must load the modules that augment that exact
    path or a descendant. Some nodes (router/eigrp, router/ospf, ...) are
    introduced by an augment on the PARENT, so when nothing augments the path
    directly we fall back to the immediate-parent augmenters. Purely factual --
    it reads the real augment statements, it never guesses a module name.
    """
    import re
    global _AUGMENT_RE
    if _AUGMENT_RE is None:
        _AUGMENT_RE = re.compile(r'augment\s+"([^"]+)"')

    want = "/" + path.strip("/")
    parent = want.rsplit("/", 1)[0] if want.count("/") > 1 else None
    target, parent_only = [], []
    for yf in sorted(rel.glob("*.yang")):
        if yf.name.startswith(_NATIVE_MODULE):
            continue
        try:
            txt = yf.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if "native" not in txt:
            continue
        targets = [_norm_augment_target(m.group(1)) for m in _AUGMENT_RE.finditer(txt)]
        if any(t == want or t.startswith(want + "/") for t in targets):
            target.append(yf.name)
        elif parent and any(t == parent for t in targets):
            parent_only.append(yf.name)
    return target or parent_only


def _added_lines(before: str, after: str) -> List[str]:
    """Lines present in `after` but not `before` (set diff, order-independent)."""
    before_set = set(before.splitlines())
    return [ln for ln in after.splitlines() if ln not in before_set]


class IosxeTranslate:
    """Sandbox-facing IOS-XE translation helper."""

    def __init__(self, pyats_client=None):
        self._pyats = pyats_client
        self._ns_index: Optional[Dict[str, str]] = None  # namespace -> module

    # -- release / cache resolution -------------------------------------------

    def _release_dir(self, release: Optional[str] = None) -> Optional[Path]:
        base = _cache_base()
        if not base.exists():
            return None
        if release:
            d = base / release
            return d if d.is_dir() else None
        subs = sorted((p for p in base.iterdir() if p.is_dir()),
                      key=lambda p: p.name, reverse=True)
        for p in subs:  # prefer a release that actually has the native model
            if (p / f"{_NATIVE_MODULE}.yang").exists():
                return p
        return subs[0] if subs else None

    # -- Tier B: model-grounded ------------------------------------------------

    def models(self, release: Optional[str] = None,
               filter: Optional[str] = None) -> Dict[str, Any]:
        """List downloaded Cisco XE YANG modules (optionally name-filtered)."""
        rel = self._release_dir(release)
        if rel is None:
            return _err("models",
                        "No Cisco XE YANG downloaded. Use the YANG browser "
                        "(NETCONF tab) to download a release first.", tier="B")
        names = sorted(p.name[:-5] for p in rel.glob("*.yang"))
        if filter:
            f = filter.lower()
            names = [n for n in names if f in n.lower()]
        return _ok("models",
                   {"release": rel.name, "count": len(names), "modules": names},
                   tier="B")

    def schema_tree(self, module: str, path: Optional[str] = None,
                    depth: int = 3, release: Optional[str] = None) -> Dict[str, Any]:
        """Render a pyang tree for `module`, optionally scoped to a data path.

        This is the reusable YANGSuite grounding: real container/leaf/key names
        and the module namespace, straight from the downloaded model.

        Much of Cisco-IOS-XE-native is populated by AUGMENTS from feature
        modules (e.g. router/eigrp comes from Cisco-IOS-XE-eigrp, not native
        itself). When scoping into native with a `path`, we auto-load the
        modules that augment that path so those subtrees actually render
        instead of dead-ending at an empty container.
        """
        rel = self._release_dir(release)
        if rel is None:
            return _err("schema_tree", "No Cisco XE YANG downloaded.", tier="B")
        mod_file = rel / f"{module}.yang"
        if not mod_file.exists():
            return _err("schema_tree",
                        f"Module '{module}' not in {rel.name}. Call iosxe.models() "
                        "to list what is downloaded.", tier="B")

        files = [mod_file.name]
        augmenters: List[str] = []
        if path and module == _NATIVE_MODULE:
            augmenters = _augmenters_for_path(rel, path)
            files += [a for a in augmenters if a != mod_file.name]

        cmd = [_pyang_bin(), "-f", "tree", f"--tree-depth={int(depth)}"]
        if path:
            cmd.append(f"--tree-path={path}")
        cmd += ["-p", str(rel)] + files
        try:
            # Timeout scales with the module count: pyang parses every listed
            # feature module (a broad path like /native/interface pulls dozens).
            proc = subprocess.run(cmd, cwd=str(rel), capture_output=True,
                                  text=True, timeout=30 + len(files))
        except subprocess.TimeoutExpired:
            return _err("schema_tree",
                        "pyang timed out. Use a more specific `path` "
                        "(e.g. native/router/eigrp) to load fewer modules.", tier="B")
        if not proc.stdout.strip():
            return _err("schema_tree",
                        proc.stderr.strip() or "pyang produced no output.", tier="B")
        meta = parse_yang_metadata(str(mod_file)) or {}
        return _ok("schema_tree", {
            "module": module,
            "namespace": meta.get("namespace"),
            "revision": meta.get("revision"),
            "tree": proc.stdout,
            "augmented_by": [a[:-5] for a in augmenters] or None,
            "warnings": proc.stderr.strip() or None,
        }, tier="B")

    def _namespace_index(self, rel: Path) -> Dict[str, str]:
        if self._ns_index is None:
            idx: Dict[str, str] = {}
            for yf in rel.glob("*.yang"):
                meta = parse_yang_metadata(str(yf))
                if meta and meta.get("namespace"):
                    idx[meta["namespace"]] = meta["name"]
            self._ns_index = idx
        return self._ns_index

    def validate_native(self, native_xml: str,
                        release: Optional[str] = None) -> Dict[str, Any]:
        """Structural (not semantic) check of a native-XML payload.

        Confirms the XML is well-formed and every namespace it uses belongs to a
        downloaded module. Does NOT prove the element nesting is valid against
        the schema -- only a device round-trip (Tier A) can do that.
        """
        try:
            import xml.etree.ElementTree as ET
            root = ET.fromstring(native_xml)
        except Exception as e:
            return _err("validate_native", f"Malformed XML: {e}", tier="B")
        rel = self._release_dir(release)
        if rel is None:
            return _err("validate_native", "No Cisco XE YANG downloaded.", tier="B")
        ns_index = self._namespace_index(rel)
        used, unknown = set(), set()
        for el in root.iter():
            tag = el.tag
            if tag.startswith("{"):
                ns = tag[1:tag.index("}")]
                used.add(ns)
                if ns not in ns_index:
                    unknown.add(ns)
        errors = [f"Unknown namespace (no downloaded module declares it): {ns}"
                  for ns in sorted(unknown)]
        return _ok("validate_native", {
            "valid": not errors and bool(used),
            "namespaces": sorted(used),
            "modules": sorted({ns_index[n] for n in used if n in ns_index}),
            "errors": errors or (["No namespaced elements found."] if not used else []),
            "note": "Structural namespace check only; nesting is not schema-validated.",
        }, tier="B")

    # -- Tier C: cli-rpc envelope ---------------------------------------------

    def cli_to_rpc(self, cli_text: str) -> Dict[str, Any]:
        """Wrap config CLI in Cisco-IOS-XE-cli-rpc (transport, not native YANG).

        Port of netconf_runner::cli_wrapper::wrap_iosxe: config-only, rejects
        show/exec. Returns the RPC inner content (no <rpc> wrapper).
        """
        cli = (cli_text or "").strip()
        if not cli:
            return _err("cli_to_rpc", "CLI text is empty.", tier="C")
        if _is_exec(cli):
            return _err("cli_to_rpc",
                        "IOS-XE does not support show/exec over NETCONF. Run "
                        "operational commands over SSH (e.g. pyATS). Only "
                        "configuration commands work here.", tier="C")
        xml = (
            '<config-ios-cli-rpc xmlns="http://cisco.com/ns/yang/Cisco-IOS-XE-cli-rpc">\n'
            "  <config-clis>\n"
            f"{_escape_xml(cli)}\n"
            "  </config-clis>\n"
            "</config-ios-cli-rpc>"
        )
        return _ok("cli_to_rpc", {"xml": xml}, tier="C")

    # -- Tier A: device-verified round-trips ----------------------------------

    def _device(self, name: str):
        """Resolve (device, host, user, password) from the pyATS testbed."""
        if self._pyats is None:
            return None, "No pyATS testbed. Configure devices in Settings -> pyATS."
        try:
            tb = self._pyats.testbed
            if name not in tb.devices:
                return None, (f"Device '{name}' not in testbed. Available: "
                              f"{', '.join(tb.devices) or '(none)'}")
            dev = tb.devices[name]
            host = str(dev.connections.cli.ip)
            cred = dev.credentials["default"]
            pw = cred.password
            pw = pw.plaintext if hasattr(pw, "plaintext") else str(pw)
            return (dev, host, str(cred.username), pw), None
        except Exception as e:
            return None, f"Could not resolve device '{name}': {e}"

    def _restconf_url(self, host: str, path: str) -> str:
        path = (path or "").lstrip("/")
        # Bare /native/... -> qualify with the native module (proper RESTCONF).
        if path.startswith("native") and ":" not in path.split("/")[0]:
            path = f"{_NATIVE_MODULE}:{path}"
        return f"https://{host}/restconf/data/{path}"

    def _restconf(self, method: str, host: str, user: str, pw: str,
                  path: str, body: Optional[str] = None):
        import requests
        try:
            requests.packages.urllib3.disable_warnings()  # type: ignore[attr-defined]
        except Exception:
            pass
        headers = {"Accept": "application/yang-data+xml"}
        if body is not None:
            headers["Content-Type"] = "application/yang-data+xml"
        return requests.request(method, self._restconf_url(host, path),
                                auth=(user, pw), headers=headers, data=body,
                                verify=False, timeout=30)

    def cli_to_native(self, device: str, cli_text: str,
                      restconf_path: str) -> Dict[str, Any]:
        """Tier A: apply CLI on a device, read back the native subtree, diff.

        `restconf_path` scopes the read (e.g. 'native/interface/Loopback=199').
        Returns the native XML the CLI actually produced.
        """
        resolved, err = self._device(device)
        if resolved is None:
            return _err("cli_to_native", err, tier="A", blast="high")
        dev, host, user, pw = resolved
        try:
            from terminai_pyats.connect import ensure_connected
            before = self._restconf("GET", host, user, pw, restconf_path)
            before_xml = before.text
            ensure_connected(dev)
            output = dev.configure(cli_text)
            after = self._restconf("GET", host, user, pw, restconf_path)
        except Exception as e:
            return _err("cli_to_native", str(e), tier="A", blast="high")
        return _ok("cli_to_native", {
            "device": device,
            "cli": cli_text,
            "before_xml": before_xml,
            "after_xml": after.text,
            "added_native_xml_lines": _added_lines(before_xml, after.text),
            "configure_output": output,
            "restconf_status": after.status_code,
        }, tier="A", blast="high")

    def native_to_cli(self, device: str, native_xml: str, restconf_path: str,
                      method: str = "PATCH") -> Dict[str, Any]:
        """Tier A: PATCH/PUT native XML on a device, diff show running-config.

        Returns the CLI the native edit actually rendered to.
        """
        resolved, err = self._device(device)
        if resolved is None:
            return _err("native_to_cli", err, tier="A", blast="high")
        dev, host, user, pw = resolved
        method = (method or "PATCH").upper()
        if method not in ("PATCH", "PUT"):
            return _err("native_to_cli", "method must be PATCH or PUT.",
                        tier="A", blast="high")
        try:
            from terminai_pyats.connect import ensure_connected
            ensure_connected(dev)
            before = dev.execute("show running-config")
            resp = self._restconf(method, host, user, pw, restconf_path, body=native_xml)
            after = dev.execute("show running-config")
        except Exception as e:
            return _err("native_to_cli", str(e), tier="A", blast="high")
        return _ok("native_to_cli", {
            "device": device,
            "restconf_status": resp.status_code,
            "restconf_response": resp.text or None,
            "cli_diff": _added_lines(before, after),
        }, tier="A", blast="high")


def install_iosxe_translate(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> IosxeTranslate:
    """Bind an `iosxe` translation helper into a sandbox globals dict.

    Mirrors install_gnmi: the helper is an object with methods. Device
    connectivity comes from the pyATS testbed (same inventory as Settings ->
    pyATS); `emit` is accepted for parity with the other installers.
    """
    try:
        from ccie_sidecar.pyats.bridge import build_pyats_client
        pyats_client = build_pyats_client()
    except Exception:
        pyats_client = None

    helper = IosxeTranslate(pyats_client=pyats_client)
    globals_dict["iosxe"] = helper

    mod = types.ModuleType("iosxe_api")
    mod.iosxe = helper  # type: ignore[attr-defined]
    sys.modules["iosxe_api"] = mod

    return helper
