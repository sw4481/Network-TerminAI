from __future__ import annotations

import importlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
MAGICS = (
    b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
    b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
)


class MacResourceSignerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue((ROOT / "scripts/sign_macos_resources.py").is_file(),
                        "native resource signer is not implemented")
        self.module = importlib.import_module("scripts.sign_macos_resources")
        self.temp = tempfile.TemporaryDirectory(prefix="sign resources ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "real python"
        self.root.mkdir()

    def native(self, name: str, magic: bytes = MAGICS[3]) -> Path:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(magic + b"fixture")
        return path

    def test_discovers_all_native_magic_inside_out_and_deduplicates_links(self) -> None:
        expected = [self.native(f"lib/deep/native {i}", magic)
                    for i, magic in enumerate(MAGICS)]
        executable = self.native("bin/python3.12")
        expected.append(executable)
        (self.root / "bin/python3").symlink_to("python3.12")
        (self.root / "alias dir").symlink_to("lib", target_is_directory=True)
        (self.root / "source.so").write_text("not native")
        top_link = self.root.parent / "python"
        top_link.symlink_to(self.root, target_is_directory=True)
        signer = self.module.MacResourceSigner(top_link)
        self.assertEqual(signer.native_files(), expected)

    def test_rejects_escaping_native_link_before_any_signing(self) -> None:
        self.native("bin/python3")
        outside = self.root.parent / "outside library"
        outside.write_bytes(MAGICS[0])
        (self.root / "escape").symlink_to(outside)
        with patch.object(self.module.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "escape"):
                self.module.MacResourceSigner(self.root).sign()
            run.assert_not_called()

    def test_does_not_traverse_escaping_directory_links(self) -> None:
        outside = self.root.parent / "outside dir"
        outside.mkdir()
        (self.root / "escape dir").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "escape"):
            self.module.MacResourceSigner(self.root).native_files()

    def test_harmless_internal_data_symlink_is_not_signed(self) -> None:
        native = self.native("bin/python")
        data = self.root / "readme.txt"
        data.write_text("ordinary data")
        (self.root / "data link").symlink_to(data)
        self.assertEqual(self.module.MacResourceSigner(self.root).native_files(), [native])

    def test_escaping_data_link_is_rejected_without_reading_target(self) -> None:
        outside = self.root.parent / "outside.txt"
        outside.write_text("ordinary data")
        (self.root / "data escape").symlink_to(outside)
        with patch.object(Path, "open", side_effect=AssertionError("external target read")):
            with self.assertRaisesRegex(ValueError, "escape"):
                self.module.MacResourceSigner(self.root).native_files()

    def test_sign_then_strict_verify_each_native_without_deep_or_runtime(self) -> None:
        deep = self.native("lib/deep/lib.1")
        executable = self.native("bin/python")
        with patch.object(self.module.subprocess, "run") as run:
            self.module.MacResourceSigner(self.root).sign()
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            ["codesign", "--force", "--sign", "-", "--options", "0", str(deep)],
            ["codesign", "--verify", "--strict", str(deep)],
            ["codesign", "--force", "--sign", "-", "--options", "0", str(executable)],
            ["codesign", "--verify", "--strict", str(executable)],
        ])
        self.assertTrue(all(call.kwargs == {"check": True} for call in run.call_args_list))

    def test_sign_and_verify_errors_stop_processing(self) -> None:
        self.native("lib/deep/lib")
        self.native("bin/python")
        for fail_on in (1, 2):
            with self.subTest(fail_on=fail_on):
                calls = []

                def fail(command: list[str], **kwargs: object) -> None:
                    calls.append(command)
                    if len(calls) == fail_on:
                        raise subprocess.CalledProcessError(1, command)

                with patch.object(self.module.subprocess, "run", side_effect=fail):
                    with self.assertRaises(subprocess.CalledProcessError):
                        self.module.MacResourceSigner(self.root).sign()
                self.assertEqual(len(calls), fail_on)

    def test_verify_only_never_signs_and_empty_tree_fails(self) -> None:
        with self.assertRaisesRegex(ValueError, "no Mach-O"):
            self.module.MacResourceSigner(self.root).verify()
        native = self.native("extensionless")
        with patch.object(self.module.subprocess, "run") as run:
            self.module.MacResourceSigner(self.root).verify()
        run.assert_called_once_with(["codesign", "--verify", "--strict", str(native)], check=True)

    def test_nonmac_cli_skips_without_accessing_root_or_codesign(self) -> None:
        for platform in ("win32", "linux"):
            with self.subTest(platform=platform), \
                 patch.object(self.module.sys, "platform", platform), \
                 patch.object(sys, "argv", ["sign_macos_resources.py", str(self.root / "missing")]), \
                 patch.object(self.module.subprocess, "run") as run:
                self.assertEqual(self.module.main(), 0)
                run.assert_not_called()


@unittest.skipIf(os.name == "nt", "shell artifact verifier runs in bash")
class MacArtifactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="mac artifact ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "tools"
        self.bin.mkdir()
        self.log = self.root / "commands.jsonl"
        self.env = dict(os.environ, PATH=f"{self.bin}{os.pathsep}{os.environ['PATH']}",
                        PYTHON=sys.executable, TEST_LOG=str(self.log))
        self.app = self.root / "source/Termin AI.app"
        self.python = self.app / "Contents/Resources/python"
        (self.python / "bin").mkdir(parents=True)
        (self.python / "bin/python3.12").write_bytes(MAGICS[3] + b"fixture")
        (self.python / "bin/python3").symlink_to("python3.12")
        (self.python / "lib").mkdir()
        (self.python / "lib/native.1").write_bytes(MAGICS[0])
        (self.python / "smoke-data.txt").write_text("sealed")
        self.tool("codesign", """
import json, os, sys
from pathlib import Path
with open(os.environ['TEST_LOG'], 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
if os.environ.get('FAIL_CODESIGN') in ('all', 'native'):
    if os.environ['FAIL_CODESIGN'] == 'all' or not sys.argv[-1].endswith('.app'):
        raise SystemExit(7)
target = Path(sys.argv[-1])
if target.name.endswith('.app'):
    if (target / 'Contents/Resources/python/smoke-data.txt').read_text() != 'sealed':
        raise SystemExit(7)
elif target.name == 'native.1' and target.read_bytes() != bytes.fromhex('feedface'):
    raise SystemExit(7)
""")
        # Only the external interpreter is faked. The real verifier still finds,
        # extracts, checks symlinks and discovers every native-content fixture.
        self.tool("host-python", """
import os, subprocess, sys
if any(arg.endswith('smoke_portable_sidecar.py') for arg in sys.argv):
    if os.environ.get('PYTHONDONTWRITEBYTECODE') != '1':
        raise SystemExit('smoke would mutate signed resources')
    with open(os.environ['TEST_LOG'], 'a') as log:
        log.write('"smoke"\\n')
    from pathlib import Path
    root = Path(sys.argv[sys.argv.index('--expected-root') + 1])
    if os.environ.get('MUTATE_ON_SMOKE') == 'outer':
        (root / 'smoke-data.txt').write_text('changed')
    elif os.environ.get('MUTATE_ON_SMOKE') == 'native':
        with (root / 'lib/native.1').open('ab') as file:
            file.write(b'changed')
else:
    raise SystemExit(subprocess.call([os.environ['REAL_PYTHON'], *sys.argv[1:]]))
""")
        self.env.update(PYTHON=str(self.bin / "host-python"), REAL_PYTHON=sys.executable)

    def tool(self, name: str, source: str) -> None:
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\n" + source)
        path.chmod(0o755)

    def archive(self) -> Path:
        archive = self.root / "Termin AI.app.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(self.app, arcname=self.app.name)
        return archive

    def verify(self, artifact: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(ROOT / "scripts/verify-bundled-sidecar.sh"),
                               "macos", str(artifact)], env=self.env,
                              capture_output=True, text=True, cwd=ROOT)

    def commands(self) -> list:
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_updater_checks_outer_and_each_native_before_nonmutating_smoke(self) -> None:
        result = self.verify(self.archive())
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.commands()
        self.assertEqual(commands[0][:-1], ["--verify", "--deep", "--strict"])
        self.assertTrue(commands[0][-1].endswith("Termin AI.app"))
        self.assertEqual(len(commands), 7)
        self.assertEqual(commands[3], "smoke")
        self.assertEqual(commands[:3], commands[4:])
        self.assertEqual([command[:-1] for command in commands[1:3]],
                         [["--verify", "--strict"], ["--verify", "--strict"]])
        self.assertTrue(commands[1][-1].endswith("/bin/python3.12"))
        self.assertTrue(commands[2][-1].endswith("/lib/native.1"))

    def test_post_smoke_outer_and_native_mutations_fail_artifact_verification(self) -> None:
        archive = self.archive()
        for mutation in ("outer", "native"):
            with self.subTest(mutation=mutation):
                self.log.unlink(missing_ok=True)
                self.env["MUTATE_ON_SMOKE"] = mutation
                result = self.verify(archive)
                self.assertNotEqual(result.returncode, 0)
                commands = self.commands()
                self.assertEqual(commands[3], "smoke")
                self.assertEqual(commands[4][:-1], ["--verify", "--deep", "--strict"])
                if mutation == "native":
                    self.assertEqual(commands[-1][:-1], ["--verify", "--strict"])
                    self.assertTrue(commands[-1][-1].endswith("/lib/native.1"))

    def dmg(self) -> Path:
        self.tool("hdiutil", """
import os, shutil, sys
from pathlib import Path
if sys.argv[1] == 'attach':
    mount = Path(sys.argv[sys.argv.index('-mountpoint') + 1])
    shutil.copytree(os.environ['TEST_APP'], mount / 'Termin AI.app', symlinks=True)
    print(f'/dev/disk42 Apple_HFS {mount}')
else:
    Path(os.environ['DETACHED']).write_text(sys.argv[2])
""")
        dmg = self.root / "installer.dmg"
        dmg.touch()
        self.env.update(TEST_APP=str(self.app), DETACHED=str(self.root / "detached"))
        return dmg

    def test_dmg_uses_same_signature_gate_and_detaches(self) -> None:
        result = self.verify(self.dmg())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "detached").read_text(), "/dev/disk42")
        self.assertEqual(self.commands()[0][:-1], ["--verify", "--deep", "--strict"])

    def test_app_directory_retains_upstream_support_and_checks_seals(self) -> None:
        result = self.verify(self.app)
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.commands()
        self.assertEqual(commands[0][:-1], ["--verify", "--deep", "--strict"])
        self.assertEqual(commands[3], "smoke")
        self.assertEqual(commands[:3], commands[4:])

    def test_dmg_rejects_python_root_escaping_app(self) -> None:
        outside = self.root / "external python"
        self.python.rename(outside)
        self.python.symlink_to(outside, target_is_directory=True)
        result = self.verify(self.dmg())
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("outside", result.stderr)
        self.assertFalse(self.log.exists())

    def test_outer_or_native_verify_failure_prevents_smoke(self) -> None:
        archive = self.archive()
        for failure in ("all", "native"):
            with self.subTest(failure=failure):
                self.log.unlink(missing_ok=True)
                self.env['FAIL_CODESIGN'] = failure
                result = self.verify(archive)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(self.log.exists(), result.stderr)
                self.assertNotIn("smoke", self.commands())

    def test_updater_rejects_traversal_and_escaping_symlink(self) -> None:
        for name, link in (("../outside", None), ("Termin AI.app/escape", "../../outside")):
            with self.subTest(name=name):
                archive = self.root / "bad.app.tar.gz"
                with tarfile.open(archive, "w:gz") as tar:
                    member = tarfile.TarInfo(name)
                    if link:
                        member.type = tarfile.SYMTYPE
                        member.linkname = link
                    tar.addfile(member)
                result = self.verify(archive)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.log.exists())

    def test_shell_helper_resolves_repo_and_nonmac_skips_without_python(self) -> None:
        self.tool("uname", "import os; print(os.environ['TEST_OS'])\n")
        self.tool("host-python", """
import json, os, sys
with open(os.environ['TEST_LOG'], 'w') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
raise SystemExit(8)
""")
        self.env["TEST_OS"] = "Darwin"
        helper = ROOT / "ci/sign-sidecar-macos.sh"
        result = subprocess.run(["bash", str(helper)], cwd=self.root, env=self.env)
        self.assertEqual(result.returncode, 8)
        self.assertEqual(self.commands(), [["-I", str(ROOT / "scripts/sign_macos_resources.py"),
                                           str(ROOT / "sidecar/dist/python")]])
        self.log.unlink()
        self.env.update(TEST_OS="Linux", PYTHON="does-not-exist")
        result = subprocess.run(["bash", str(helper)], cwd=self.root, env=self.env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.log.exists())

    def test_release_gate_checks_both_artifacts_and_propagates_failure(self) -> None:
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        step = workflow.split("- name: Validate unsigned macOS bundle and updater signature\n", 1)[1]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1].split("\n      - name:", 1)[0])
        checkout = self.root / "checkout"
        checkout.mkdir()
        (checkout / "scripts").symlink_to(ROOT / "scripts", target_is_directory=True)
        bundles = checkout / "src-tauri/target/aarch64-apple-darwin/release/bundle"
        (bundles / "macos").mkdir(parents=True)
        (bundles / "dmg").mkdir()
        shutil.copytree(self.app, bundles / "macos" / self.app.name, symlinks=True)
        shutil.copyfile(self.dmg(), bundles / "dmg/installer.dmg")
        updater = bundles / "macos/Termin AI.app.tar.gz"
        shutil.copyfile(self.archive(), updater)
        updater.with_suffix(updater.suffix + ".sig").touch()
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                cwd=checkout, env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.commands().count("smoke"), 2)
        self.log.unlink()
        self.env["FAIL_CODESIGN"] = "native"
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                cwd=checkout, env=self.env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("smoke", self.commands())

@unittest.skipUnless(shutil.which("bun"), "Bun is required for the Tauri hook")
class MacBundleHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="bundle hook ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "ci").mkdir()
        (self.root / "scripts").mkdir()
        self.marker = self.root / "hook called"
        self.helper = self.root / "ci/sign-sidecar-macos.sh"
        self.helper.write_text('printf called > "$TEST_MARKER"\nexit 9\n')
        hook_file = ROOT / "scripts/sign-sidecar-macos.mjs"
        if hook_file.exists():
            shutil.copyfile(hook_file, self.root / "scripts" / hook_file.name)
        self.preload = self.root / "platform.cjs"
        self.preload.write_text(
            'Object.defineProperty(process, "platform", {value: process.env.TEST_PLATFORM});\n'
        )
        self.config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
        self.hook = self.config["build"]["beforeBundleCommand"]
        self.env = dict(os.environ, TEST_MARKER=str(self.marker))
        self.bun = shutil.which("bun")

    def test_config_hook_has_no_inline_javascript_or_shell_quotes(self) -> None:
        self.assertEqual(shlex.split(self.hook, posix=False),
                         ["bun", "scripts/sign-sidecar-macos.mjs"])

    def test_config_hook_executes_helper_from_frontend_root(self) -> None:
        result = subprocess.run(self.hook, shell=True, cwd=self.root, env=self.env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 9 if sys.platform == "darwin" else 0, result.stderr)
        self.assertEqual(self.marker.exists(), sys.platform == "darwin")
        self.assertEqual(self.config["bundle"]["macOS"].get("signingIdentity"), "-")

    def test_quote_preserving_arguments_skip_nonmac_and_propagate_signer_result(self) -> None:
        # Preserve quotes as observed in the failing Windows Tauri invocation.
        arguments = shlex.split(self.hook, posix=False)
        cases = [("win32", 9), ("linux", 9)]
        if os.name != "nt" and shutil.which("bash"):
            cases.extend([("darwin", 0), ("darwin", 9)])
        for platform, exit_code in cases:
            with self.subTest(platform=platform, exit_code=exit_code):
                self.marker.unlink(missing_ok=True)
                self.helper.write_text(f'printf called > "$TEST_MARKER"\nexit {exit_code}\n')
                result = subprocess.run(
                    [self.bun, "--preload", str(self.preload), *arguments[1:]],
                    cwd=self.root, env=dict(self.env, TEST_PLATFORM=platform),
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, exit_code if platform == "darwin" else 0,
                                 result.stderr)
                self.assertEqual(self.marker.exists(), platform == "darwin")

    def test_missing_mac_signer_process_fails_closed(self) -> None:
        result = subprocess.run(
            [self.bun, "--preload", str(self.preload), *shlex.split(self.hook, posix=False)[1:]],
            cwd=self.root, env=dict(self.env, TEST_PLATFORM="darwin", PATH=str(self.root)),
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.marker.exists())


class BundledPythonChildEnvironmentTests(unittest.TestCase):
    def test_all_managed_python_boundaries_disable_bytecode_before_startup(self) -> None:
        boundaries = (
            ("bridge.rs", "Command::new(program)", ".spawn()"),
            ("bridge.rs", "Command::new(&self.program)", ".spawn()"),
            ("mcp/transport.rs", "Command::new(&self.command)", "cmd.spawn()"),
            ("dap/mod.rs", "Command::new(&adapter.command)", ".spawn()"),
            ("dap/mod.rs", "Command::new(&adapter.command)", ".status()"),
            ("commands/rag_seed.rs", "Command::new(&python)", ".spawn()"),
        )
        for file, anchor, end in boundaries:
            with self.subTest(file=file, end=end):
                source = (ROOT / "src-tauri/src" / file).read_text()
                start = source.index(anchor)
                if end == ".status()":
                    start = source.index(anchor, start + len(anchor))
                boundary = source[start:source.index(end, start)]
                self.assertIn('.env("PYTHONDONTWRITEBYTECODE", "1")', boundary)
                if file == "mcp/transport.rs":
                    self.assertGreater(boundary.index('.env("PYTHONDONTWRITEBYTECODE", "1")'),
                                       boundary.index("cmd.env(key, value)"))

    def test_child_only_env_prevents_new_bytecode_without_affecting_other_python(self) -> None:
        with tempfile.TemporaryDirectory(prefix="python child env ") as temp:
            root = Path(temp)
            (root / "sealed_fixture.py").write_text("VALUE = 42\n")
            before = {path.name: path.read_bytes() for path in root.iterdir()}
            env = {key: value for key, value in os.environ.items() if not key.startswith("PYTHON")}
            code = "import sealed_fixture, sys; print(sys.dont_write_bytecode)"
            protected = subprocess.run([sys.executable, "-c", code], cwd=root,
                                       env=dict(env, PYTHONDONTWRITEBYTECODE="1"),
                                       capture_output=True, text=True, check=True)
            self.assertEqual(protected.stdout.strip(), "True")
            self.assertEqual({path.name: path.read_bytes() for path in root.iterdir()}, before)
            ordinary = subprocess.run([sys.executable, "-c", code], cwd=root, env=env,
                                      capture_output=True, text=True, check=True)
            self.assertEqual(ordinary.stdout.strip(), "False")
            self.assertTrue(list(root.rglob("*.pyc")))


if __name__ == "__main__":
    unittest.main()
