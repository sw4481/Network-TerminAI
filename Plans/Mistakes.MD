# Local Mistakes Log

## 2026-09-10: WhatsApp bridge reported linked after its socket died

- Issue: Heartbeat executions completed, but their WhatsApp alerts were not
  arriving.
- Root cause analysis: The neonize client returned after a stream replacement
  or EOF, while the bridge kept the stale client and `linked` state. The live
  sidecar had only `CLOSE_WAIT` sockets even though DNS and WhatsApp HTTPS
  reachability were healthy. Failed native group sends also wrote a
  `SendMessage` error to the sidecar's stdout NDJSON channel, producing
  `bad json from sidecar`. The native heartbeat sender discarded the sidecar's
  `ok: false` result and consumed its cooldown, hiding the failure.
- How addressed: Recovered the live sidecar without restarting TerminAI,
  added bounded reconnect with explicit non-linked state during recovery,
  isolated native stdout, required an explicit successful send result before
  retaining cooldown, and added warning logs plus regression coverage.

## 2026-09-10: Release branch regressed both heartbeat integrations

- Issue: The PyATS and Meraki heartbeats stopped working even though the live
  device and Dashboard APIs were healthy.
- Root cause analysis: The public-release branch retained the stale Meraki
  catalog snapshot (`/assurances`, `/healths`, and mangled `/devicess` routes)
  after the real-path correction was left out. The launcher also checked only
  `ccie_sidecar` and `debugpy`, so it reported a ready sidecar without
  installing the tracked `pyats_cli` wrapper; the saved PyATS heartbeat also
  called the removed `show-command` verb instead of `run-show-command`.
- How addressed: Restored the current Meraki REST paths, made `run.sh` install
  `pyats_cli` when absent, corrected the saved heartbeat verb, and added
  focused regression tests for the launcher and catalog contracts.

## 2026-09-08: Sanitized Bitwarden fixture dropped TOTP coverage

- Issue: The first sanitized Bitwarden CSV sample left the TOTP column empty,
  causing the importer test to fail because `totp` metadata was absent.
- Root cause analysis: The fixture rewrite focused on replacing credential-like
  values and accidentally removed a required non-secret test field.
- How addressed: Restored the TOTP column with an explicit example-only value;
  the focused importer tests are being rerun.

## 2026-09-08: Staging wrapper used the wrong working directory

- Issue: A command attempted to stage the repository-root `.gitignore` while
  running from `src-tauri`, so Git reported that the path did not exist.
- Root cause analysis: The command combined a root-relative Git path with a
  subdirectory working directory.
- How addressed: No files were changed by the failed command; the retry runs
  from the repository root with explicit paths.

## 2026-09-08: Test wrapper ran Cargo from the repository root

- Issue: The retry staged correctly but invoked Cargo from the repository root,
  which has no `Cargo.toml`.
- Root cause analysis: The staging path correction was applied without also
  changing the test command to use the `src-tauri` manifest.
- How addressed: No source files were changed; the next run uses
  `--manifest-path src-tauri/Cargo.toml`.
