# Sanitization Report: Network-TerminAI

**Date:** 2026-09-26
**Auditor:** opensource-sanitizer v1.0.0 rerun
**Project:** `$HOME/opensource-staging/Network-TerminAI`
**Target public repo:** `git@github.com:sw4481/Network-TerminAI.git`
**Verdict:** PASS WITH WARNINGS

## Summary

| Category | Status | Findings |
|---|---:|---:|
| Secrets | PASS | 0 critical findings |
| PII | PASS/WARN | 548 RFC1918/private-IP fixture hits reclassified as synthetic network-engineering examples |
| Internal References | PASS | 0 critical findings |
| Dangerous Files | PASS | 0 critical findings |
| Config Completeness | WARN | `.env.example` exists; source env coverage has non-critical gaps, many system/test/tooling references |
| Git History | PASS | 1 clean history-free commit at scan time; 0 secret-regex hits |

## Critical Findings

None.

## PII Re-evaluation

Initial scan found RFC1918/private-IP literals across docs, tests, fixtures, UI placeholders, subnet tooling, topology examples, and bundled network-agent descriptions. These were re-evaluated as intentional synthetic network-engineering fixtures, not live inventory.

No private-IP occurrence was found paired with real customer/device identity or other leaked sensitive context. Personal email and SSH connection-string scans found 0 critical hits.

Highest-volume reviewed fixture files:

- `src/lib/subnetCalculations.test.ts` — subnet-calculation examples and assertions
- `src-tauri/tests/topology_ingest_test.rs` — topology ingest fixtures
- `src-tauri/tests/device_lookup_test.rs` — device lookup fixtures
- `src-tauri/tests/change_verify_report_test.rs` — change-verification report fixtures
- `src-tauri/tests/change_verify_classifier_test.rs` — change-verification classifier fixtures

## Reviewed Warnings

1. RFC1918/private IP literals remain in docs, tests, fixtures, UI placeholders, subnet tooling, topology examples, and network-agent tool descriptions. These are intentional synthetic examples for a network-engineering product, not live inventory.
2. Empty API-key-style environment variable assignments in `.env.example` and configuration docs are placeholders, not leaked values.
3. GitHub Actions secret and variable references are configuration names only and do not contain secret values.
4. Source env coverage found referenced environment names not listed in `.env.example`; reviewed as configuration-completeness warnings, not secret leaks.
5. `TERMINAI_WHISPER_MODEL` appears in `.env.example` and may be retained as an optional placeholder.

## Dangerous Files Check

PASS. No blocked dangerous files/directories found:

- No `.env`, `.env.local`, `.env.production`, or `.env.*.local`
- No private-key/certificate bundle suffixes found: `.pem`, `.key`, `.p12`, `.pfx`, `.jks`
- No `credentials.json` or `service-account*.json`
- No `.secrets/`, `secrets/`, `sessions/`
- No `.claude/settings.json`
- No source maps
- No `node_modules/`, `__pycache__/`, `.venv/`, or `venv/`

## Git History Audit

PASS.

- Repository has exactly 1 commit at scan time.
- Secret-pattern scan across git history found 0 critical findings.
- No `.git` internals were inspected directly.

## Sensitive-File Safety

Sensitive-named credential/token/password/API-key/private-key files were not content-inspected. Dangerous-file existence checks were still performed where applicable.

## Recommendation

Project passes critical sanitization checks and is clear for open-source release with the documented synthetic-network-fixture and configuration-completeness warnings. Do not publish without rerunning release gates after any further changes.
