"""Run with python3 -I src-tauri/telemetry/check_windows_checkout.py.

Exercise Git's Windows CRLF checkout conversion, not Python universal-newline I/O.
Only copies bundled assets and root attributes into a disposable repository.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def git(root, *args):
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True, capture_output=True
    ).stdout


def check(root):
    assets = root / "src-tauri/telemetry"
    manifest = json.loads((assets / "catalog.json").read_bytes())
    for binding in manifest["templates"]:
        text = (assets / binding["path"]).read_bytes()
        assert hashlib.sha256(text).hexdigest() == binding["sha256"], (
            f"Compiled template checksum mismatch: {binding['id']}"
        )
        # JSON transport to the worker must preserve the exact UTF-8 bytes.
        wire_text = json.loads(json.dumps(text.decode("utf-8")))
        assert hashlib.sha256(wire_text.encode("utf-8")).hexdigest() == binding["sha256"]
        assert hashlib.sha256(text + b"# tampered\n").hexdigest() != binding["sha256"]
    return len(manifest["templates"])


def main():
    source = Path(__file__).resolve().parents[2]
    count = check(source)
    with tempfile.TemporaryDirectory(prefix="telemetry-checkout-") as temporary:
        root = Path(temporary)
        git(root, "init", "-q")
        git(root, "config", "core.autocrlf", "true")
        git(root, "config", "core.safecrlf", "false")
        destination = root / "src-tauri/telemetry"
        shutil.copytree(source / "src-tauri/telemetry", destination)
        attributes = source / ".gitattributes"
        if attributes.exists():
            shutil.copyfile(attributes, root / ".gitattributes")
            git(root, "add", ".gitattributes")
        # Control proves conversion is active even when the host is not Windows.
        (root / "control.txt").write_bytes(b"control\n")
        git(root, "add", "src-tauri/telemetry", "control.txt")
        shutil.rmtree(root / "src-tauri")
        (root / "control.txt").unlink()
        git(root, "checkout-index", "--all", "--force")
        assert (root / "control.txt").read_bytes() == b"control\r\n"
        assert check(root) == count
    print(f"PASS: {count} bundled bindings survive core.autocrlf=true checkout; raw UTF-8/JSON hashes agree; tampering rejected")


if __name__ == "__main__":
    main()
