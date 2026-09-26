# TerminAI Release Process

TerminAI publishes native installers and signed Tauri updater artifacts from an
explicit annotated `vX.Y.Z` tag. Ordinary pushes and pull requests run CI; they
never publish a release.

## Supported release targets

| Target | Runner | Public installer | Updater artifact |
| --- | --- | --- | --- |
| macOS 15+, Apple Silicon | `macos-15` (arm64) | unsigned/unnotarized `.dmg` + SHA-256 | `.app.tar.gz` + `.sig` |
| Windows 11, x64 | `windows-2025` | unsigned NSIS `-setup.exe` + SHA-256 | NSIS updater + `.sig` |
| Linux x64 | `ubuntu-22.04` | `.AppImage` and `.deb` | matching AppImage and Debian updater signatures |

Intel Mac, Windows ARM64, Linux ARM64, app stores, and background periodic
checks are not part of the 1.1 release contract.

The package name, `com.ccie.terminal` identifier, deep-link scheme, keyring
service, and `ccie-terminal` data directories are deliberately unchanged. A
TerminAI upgrade must preserve existing sessions, credentials, vault content,
RAG data, agents, and configuration.

## Publishing model

1. CI runs on every push to `main` and every pull request.
2. Only a pushed annotated `vX.Y.Z` tag starts `.github/workflows/release.yml`.
3. The workflow validates the tag, manifests, locks, changelog, repository
   visibility, required configuration, and updater keypair before creating a
   draft.
4. Native jobs build and inspect the portable sidecar and installers. Matrix
   uploads are serialized so `tauri-action` can merge all three platforms into
   one deterministic `latest.json`.
5. A final job checks every installer, updater archive, updater signature,
   release-note body, required `latest.json` platform record, and generated
   `SHA256SUMS.txt`.
6. The draft is published only if every gate succeeds. A partial or failed
   release remains a draft and is not visible to installed apps as `latest`.

Installed builds check
`https://github.com/sw4481/Network-TerminAI/releases/latest/download/latest.json` on
launch and when the user selects **Settings → Updates → Check now**. There is
no timer-based background polling in this release.

## One-time GitHub setup

The repository must be public before the pilot tag is pushed. Anonymous
installed clients cannot download updater assets from a private GitHub release.

Configure these GitHub Actions secrets without printing them in workflow logs:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Configure this repository variable:

- `TERMINAI_GITHUB_CLIENT_ID`

### GitHub OAuth App and repository variable

TerminAI uses GitHub's device flow so the desktop app never embeds a client
secret and users never paste a personal access token into it. Create the
public client ID once:

1. On GitHub, select your profile picture, then **Settings**.
2. Select **Developer settings → OAuth Apps → New OAuth App**. If this is the
   first OAuth App on the account, GitHub labels the button **Register a new
   application**.
3. Fill in the registration form:
   - **Application name:** `TerminAI Desktop` — the name users see when GitHub
     asks them to authorize the app.
   - **Homepage URL:** `https://github.com/sw4481/Network-TerminAI` — the public project
     page GitHub associates with the app.
   - **Application description:** `GitHub device login for the TerminAI desktop application.`
     — optional public context for users.
   - **Authorization callback URL:** `https://github.com/sw4481/Network-TerminAI` —
     GitHub requires this field when registering an OAuth App, but TerminAI's
     device flow does not redirect to it.
   - Select **Enable Device Flow** — this is the login method TerminAI actually
     uses.
4. Select **Register application** and copy the displayed **Client ID**. The
   client ID is a public application identifier, not a password. Do not create
   or copy a client secret; TerminAI does not use one.
5. Return to the TerminAI repository and select **Settings → Secrets and
   variables → Actions → Variables → New repository variable**.
6. Enter `TERMINAI_GITHUB_CLIENT_ID` for **Name**, paste the Client ID for
   **Value**, and select **Add variable**. A repository variable is used here
   because the client ID is intentionally public; the updater private key and
   password remain in the separate **Secrets** tab.

The release preflight checks only that this variable exists; it never prints
its value. Release builds embed the public ID at Rust compile time.

### Tauri updater key

`src-tauri/tauri.conf.json` contains the public updater key. The corresponding
private key is a long-lived release identity: losing or replacing it prevents
installed builds from accepting future updates.

Before `v1.0.0`, set the final private key in GitHub and let the release
preflight sign a probe and verify it with the committed public key. If that
check fails and no matching private key can be recovered, generate the final
keypair before distributing any pilot install:

```bash
bun tauri signer generate -w /secure/offline/location/terminai.key
```

Store the private key and password in the Actions secrets, back them up in an
approved offline secret store, and commit only the generated public key. Never
rotate this key as incidental maintenance.

### Zero-cost operating-system trust model

The permanent Tauri updater key remains mandatory. It proves that an update
was produced by the TerminAI release workflow before the installed app accepts
it. The release also generates `SHA256SUMS.txt` from the final public
installers and uploads it before the draft can be published.

Those controls do **not** replace paid operating-system publisher identities:

- The macOS DMG is not Developer ID signed or notarized. After verifying its
  SHA-256 value, a user must attempt one launch and then use **System Settings
  → Privacy & Security → Open Anyway**. Managed Macs can forbid that override.
- The Windows NSIS installer is not Authenticode signed. After verifying its
  SHA-256 value, a user can use **More info → Run anyway** when standard
  SmartScreen offers it. Smart App Control or organization policy can block it
  without an override.
- Linux packages use the same checksum manifest and signed Tauri updater feed;
  no paid publisher certificate is required by the release contract.

Do not describe these installers as Apple-notarized, Authenticode-signed, or
warning-free. If paid signing becomes available later, add it as a separately
reviewed hardening change without rotating the Tauri updater key.

## Automated gates

CI and the release workflow collectively require:

- Action/YAML validation with `actionlint`
- ShellCheck for release and launch scripts
- strict semantic version and manifest consistency
- a frozen `bun.lock`, `src-tauri/Cargo.lock`, and `sidecar/uv.lock`
- `uv lock --check`
- frontend tests, including the updater store, and a TypeScript/Vite build
- full sidecar tests from `uv sync --frozen`
- full Cargo tests with `--locked`
- `cargo clippy --all-targets --locked -- -D warnings`
- Rust formatting for only files changed by the push or pull request
- portable-sidecar JSON protocol validation (startup heartbeat/version and
  successful `pong`)
- Mach-O inspection that rejects native sidecar libraries requiring newer than
  the advertised macOS 15 floor
- installer extraction and a `pong` from the Python and `ccie_sidecar` package
  actually contained in every built bundle
- final `latest.json`, installer-specific App/NSIS/AppImage/Debian updater
  records, updater signatures, checksum manifest, and release-note validation

The portable Python distribution and model downloads are cached by immutable
target/version keys. Installed virtual environments are never cached.

## Version bump and release checklist

1. Update `CHANGELOG.md` with a non-empty `## [X.Y.Z]` section. This exact
   section becomes both the GitHub release body and the in-app update notes.
2. Synchronize all manifests and `Cargo.lock`:

   ```bash
   scripts/bump-version.sh X.Y.Z
   ```

3. Review the diff and run the local gates:

   ```bash
   python3 scripts/release_preflight.py check --no-git
   cd sidecar && uv lock --check && uv run --frozen --extra dev pytest -v && cd ..
   bun install --frozen-lockfile
   bun run test
   bun run build:relaxed
   cargo test --manifest-path src-tauri/Cargo.toml --locked
   cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
   ```

4. Run TerminAI through `./run.sh` and verify the release invariant:
   - `target/debug/TerminAI` is running.
   - Its child is `sidecar/.venv/.../python -m ccie_sidecar`.
   - The warmup ping succeeds.
   - `sidecar_status.last_seen` advances with fresh timestamps.
   - The footer leaves `starting` and shows the sidecar version.
5. Commit the exact release candidate.
6. Create an **annotated** tag on that commit:

   ```bash
   git tag -a vX.Y.Z -m "TerminAI vX.Y.Z"
   ```

7. Run the tagged preflight locally:

   ```bash
   python3 scripts/release_preflight.py check --tag vX.Y.Z
   ```

8. Push only the intended tag:

   ```bash
   git push origin vX.Y.Z
   ```

   Never use `git push --tags`; local archive and phase tags are intentionally
   not publication triggers.
9. Watch the Release workflow. On failure, inspect and repair the retained
   draft. Do not publish assets manually around a failed gate.
10. Download and test the resulting installers before linking users to the
    Downloads page. Verify the SHA-256 value and the documented first-launch
    warning flow on macOS and Windows.

## Pilot and update canary

The old local `v1.0.0` belonged to legacy history and must never be pushed to
the TerminAI repository. Preserve its target under an unpushed archive tag,
remove the ambiguous local release tag, and create the new annotated `v1.0.0`
only on the accepted pilot commit:

```bash
git tag -a archive/legacy-ccie-terminal-v1.0.0 <legacy-commit> \
  -m "Archive legacy CCIE Terminal v1.0.0"
git tag -d v1.0.0
# After the pilot commit is accepted:
git tag -a v1.0.0 -m "TerminAI v1.0.0"
git push origin v1.0.0
```

Do not push the `archive/...` tag.

Use this acceptance order:

1. Publish an unannounced `v1.0.0` pilot after the repository is public.
2. Install it on clean macOS Apple Silicon, Windows 11 x64, Ubuntu 22.04, and
   Ubuntu 24.04 systems.
3. On each system verify launch, terminal operation, reported app version,
   historical user-data location, and uninstall/reinstall behavior.
4. Verify the TerminAI process, bundled `python -m ccie_sidecar` child, warmup
   ping, fresh `sidecar_status.last_seen`, and footer version chip.
5. Record any canary changes in `## [1.0.1]`, bump manifests to `1.0.1`, and
   publish the annotated `v1.0.1` tag.
6. From every `v1.0.0` installation, verify detection, meaningful release
   notes, signature verification, download, install, relaunch as `v1.0.1`, and
   preservation of sessions, vaults, RAG data, credentials, and migration
   backups.
7. Repeat the sidecar health checks after relaunch.

Do not announce TerminAI or direct users to Downloads until the complete
`v1.0.0 → v1.0.1` platform matrix passes.

## Troubleshooting

- **Tag preflight fails:** run `scripts/bump-version.sh` and ensure the exact
  changelog section exists. Release tags must be annotated and point at HEAD.
- **Updater key check fails:** restore the private key matching the committed
  public key. Do not publish a build with a casually regenerated key.
- **macOS launch is blocked:** verify the checksum, try one launch, then use
  **Privacy & Security → Open Anyway**. A managed policy may prevent it.
- **Windows launch is blocked:** verify the checksum and use **More info → Run
  anyway** only when offered. Smart App Control or enterprise policy may not
  permit unsigned software.
- **`latest.json` is incomplete:** keep the release in draft. All three matrix
  jobs and their updater signatures must exist before publication.
- **Sidecar bundle check fails:** inspect the extracted installer's `python`
  resource. A passing source-tree sidecar test is not a substitute for the
  packaged `pong` check.
