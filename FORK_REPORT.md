# Fork Report: Network-TerminAI

**Source:** `$HOME/Network-TerminAI`
**Target:** `$HOME/opensource-staging/Network-TerminAI`
**Date:** 2026-09-22
**License:** MIT
**Intended repository:** `git@github.com:sw4481/Network-TerminAI.git`

## Result

A history-free staging copy was created without modifying the source repository or pushing to GitHub.

- Source program/test/doc files copied: 2,182
- Files in staging including `LICENSE` and this report: 2,184
- Existing staged files modified for release sanitization or public-repository cleanup: 37
- New files added: `LICENSE` and `FORK_REPORT.md`
- `.env.example`: preserved with placeholders/blank secret values only
- High-confidence embedded secret patterns found after sanitization: 0

## Files Excluded

The source inventory contained 421,545 files. The following 419,363 files were excluded from the public staging copy:

- 419,227 files under Git metadata, build/dependency directories, caches, generated output, local plans, archived material, or other local directories
- 96 logs, databases, runtime files, credential-like files, local inventories, source maps, packet captures, or environment variants
- 18 downloaded/generated build assets, including the local RAG model and Whisper model
- 12 generated Python package metadata files (`*.egg-info`)
- 4 local instruction/scratch files (`AGENTS.md`, `claude.md`, `notes.md`, `.vscode` content)
- 2 macOS metadata files (`.DS_Store`)
- 2 local agent artifact files under `docs/superpowers/`
- 1 runtime data directory (`sidecar/data`)
- 1 local test-results report (`docs/TEST_RESULTS.md`)

Notable exclusions include `.git`, `.claude`, `.worktrees`, `node_modules`, `dist`, Rust/Python build output, virtual environments, `__pycache__`, logs, local databases, graphify output, `Plans/`, `archive/`, cached models, runtime result JSON files under `src-tauri`, `test-iac-integration/inventory.ini`, and local WhatsApp/chat state.

## Secrets Extracted -> `.env.example`

- None. No embedded high-confidence API keys, access tokens, JWTs, private keys, database credentials, webhooks, or provider secrets were found in the staged files.
- The existing `.env.example` was retained and contains blank or localhost-only placeholders.
- Credential-bearing tests use environment variables or dummy test values; no live credential values were copied.

## Internal References Replaced

- Old repository references for `sw4481/Network-TerminAI` and `sw4481/Network-TerminAI` were changed to `sw4481/Network-TerminAI` (10 occurrences).
- Personal absolute source paths were changed to `$HOME/Network-TerminAI` (18 occurrences).
- Project-specific contact addresses were changed to `you@your-domain.com` (3 occurrences).
- Known lab endpoint examples were replaced with `your-server-ip`, `proxmox.example.test`, or `*.example.test` placeholders (71 occurrences).
- The README clone instructions now use the new repository and directory name.
- Historical `ccie-terminal` application identifiers and data roots remain where needed for upgrade compatibility; these are runtime compatibility identifiers, not repository references.

## Verification

- No forbidden files remain in the staging tree.
- No old repository URL remains in product files; the report records the requested source and target paths.
- No personal source path remains in product files; the report records the source path as required.
- No high-confidence secret pattern remains in staged text files.
- The source working tree was not modified.
- GitHub was not contacted and nothing was pushed.

## Warnings

- `public/drawio/viewer-static.min.js` contains one public OAuth client identifier from the bundled vendor asset. It is an identifier, not a secret, and was retained to avoid breaking the vendor viewer. Review vendor licensing and OAuth behavior before distribution.
- RFC1918 addresses remain in synthetic network fixtures and subnet examples where they are part of test semantics; known environment-specific endpoint examples were replaced.
- Full application, Rust, Python, and browser test suites were not run in the sanitized copy because dependencies and generated build artifacts were intentionally excluded. Run the normal dependency installation and CI checks before the first public release.
- Pre-existing trailing whitespace in `bundled-agents/meraki/AGENT.md` causes `git diff --check` findings; it was not reformatted because it is unrelated to sanitization.

## Next Step

Next step: run opensource-sanitizer
