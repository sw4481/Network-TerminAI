# Sanitization Report: Network-TerminAI

**Date:** 2026-09-26
**Auditor:** opensource-sanitizer v1.0.0 rerun
**Project:** `$HOME/opensource-staging/Network-TerminAI`
**Target public repo:** `git@github.com:sw4481/Network-TerminAI.git`
**Version checked:** v1.1.2 release candidate
**Verdict:** PASS WITH WARNINGS

## Summary

| Category | Status | Findings |
|---|---:|---:|
| Secrets | PASS | 0 critical findings |
| PII | PASS WITH WARNINGS | 0 critical findings; 586 synthetic RFC1918 warnings |
| Internal References | PASS | 0 critical findings |
| Dangerous Files | PASS | 0 findings |
| Generated Artifacts | PASS | 0 findings |
| Config Completeness | WARN | 74 warnings |
| Git History | PASS WITH WARNINGS | 1 clean history-free commit at scan time; keyword-only placeholder warning |

## Critical Findings

None.

## Scan Coverage

- Text files scanned: 2,175
- Binary files skipped: 17
- Sensitive-looking paths skipped by policy: 4
- Git internals were not directly inspected; git history was audited through `git` commands.

Sensitive-looking paths skipped by policy:

1. `.git/`
2. `meraki_cli/tests/test_credentials.py`
3. `meraki_cli/src/terminai_meraki/credentials.py`
4. `src-tauri/migrations/V0091__topolograph_direct_api_key.sql`

## Secrets Scan

PASS. No critical matches were found in scanned text or git history for secret-shaped API keys, AWS keys, database URLs with credentials, JWTs, private key blocks, GitHub tokens, Google OAuth secrets, Slack webhooks, SendGrid keys, or Mailgun keys.

History keyword warnings were limited to placeholder names in `.env.example`, such as empty `*_PASSWORD=`, `*_TOKEN=`, and `*_API_KEY=` variables. No full secret values were displayed or detected by critical secret regexes.

## PII Re-evaluation

No critical personal email, SSH connection string, or real private infrastructure identity findings were found in scanned text.

The sanitizer found 586 RFC1918/private-IP occurrences and classified them as warnings because they are synthetic documentation, demo, test, or network-tooling examples for a network-engineering product. No sampled RFC1918 hit was paired with a real private customer/device identity.

Representative warning-only locations:

- `src/lib/subnetCalculations.test.ts`
- `src-tauri/tests/topology_ingest_test.rs`
- `src-tauri/tests/change_verify_report_test.rs`
- `src-tauri/tests/device_lookup_test.rs`
- `src/lib/fanoutOutliers.test.ts`
- `docs/CHANGE_VERIFICATION.md`
- `sidecar/tests/fixtures/show_ip_ospf_neighbor_iosxe.txt`
- `src/lib/subnetCalculations.ts`
- `bundled-agents/meraki/tools.json`

The four initially reviewed private-IP hits below were reclassified as synthetic unit/test examples:

- `src-tauri/src/tftp/server.rs`
- `src/windows/TftpSettingsTab.test.tsx`

## Internal References Scan

PASS. No critical internal home-directory paths or internal secret-file references were found in release source.

## Dangerous Files and Generated Artifacts Check

PASS. No blocked dangerous files, generated artifact directories, or runtime dependency trees were found.

Confirmed absent at scan time:

- `.env`, `.env.local`, `.env.production`, `.env.*.local`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`
- `credentials.json`, `service-account*.json`
- private secret/session directories
- `.claude/settings.json`
- `*.map`
- `node_modules/`
- `__pycache__/`
- `.venv/`, `venv/`
- generated `dist/` output
- generated `target/` output

## Configuration Completeness

WARN. `.env.example` exists and contains 79 integration placeholders.

Scanner-detected referenced variables not present in `.env.example` include provider/user-configurable candidates plus many CI/build/runtime/test variables. Relevant optional/user-configurable variables to consider documenting later:

- `ANTHROPIC_API_KEY`
- `GOOGLE_API_KEY`
- `NVIDIA_API_KEY`
- `OPENAI_API_KEY`
- `LMSTUDIO_ENDPOINT`
- `LANGCHAIN_OPENAI_STREAM_CHUNK_TIMEOUT_S`
- `MERAKI_API_KEY`
- `VLLM_API_KEY`
- `VLLM_MODEL`

Many other scanner-detected names are CI, build, platform, test-only, or internal child-process variables and should not automatically be added to `.env.example`.

## Git History Audit

PASS WITH WARNINGS.

- Repository has exactly 1 commit at scan time.
- Secret-pattern scan across git history found 0 critical findings.
- History keyword scan found placeholder names in `.env.example`, not secret-shaped values.
- No `.git` internals were inspected directly.

## Warnings

1. Four sensitive-looking paths were intentionally not content-inspected due policy; manually review or authorize targeted inspection before final publication.
2. RFC1918/private-IP examples remain throughout source/docs/tests as synthetic network-engineering examples.
3. `.env.example` is present but does not list every scanner-detected environment variable reference.

## Recommendation

Project passes critical sanitization checks for the v1.1.2 open-source release candidate with documented warnings. Keep generated artifacts out of the release candidate.
