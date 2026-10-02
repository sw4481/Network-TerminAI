# Sanitization Report: Network-TerminAI

- Date: 2026-10-01
- Auditor: ECC open-source sanitizer workflow, fresh release-gate scan
- Version checked: v1.1.6 release candidate
- Base commit: `c24056ca86ad0cbaf7615b5bb6437cbf063b9888` (v1.1.5)
- Verdict: **PASS WITH WARNINGS**

## Summary

| Category | Status | Findings |
|---|---:|---|
| Secrets | PASS | 0 high-confidence token/private-key patterns in scanned worktree or history; 45 generic assignment candidates reviewed in the worktree and 53 in history as test/example/vendor templates. The six-file v1.1.6 release diff adds 0 high-confidence matches. |
| PII | PASS WITH WARNINGS | 48 email-shaped matches overall; 35 non-example-domain matches occur across 34 locations. Private review classified 20 as intentional public project/upstream/platform references, 13 as synthetic fixtures, and 2 as asset-filename false positives. No email values or matching source lines are reproduced here. Also 586 RFC1918 address examples. |
| Internal references | PASS WITH WARNINGS | 0 `shaunwhi` matches and 0 SSH/SCP/SFTP URL matches; 3 generic home-path patterns and 5 private-looking domain patterns remain in documentation/examples. |
| Dangerous files | PASS WITH SCOPE LIMIT | No dangerous filename patterns among scanned tracked/unignored paths; `.env.example` is present. Eleven sensitive-looking paths were skipped by the local path-safety rule. |
| Configuration completeness | WARN | `.env.example` exists. Heuristic source scan found 135 environment-variable reads: 79 names are listed in `.env.example`, 56 are not. This includes optional integrations and build/test variables. |
| Git history | PASS WITH WARNINGS | 32 reachable commits and 2,259 unique text blobs scanned; 0 high-confidence secret patterns. Generic assignment candidates are described above. |

## Scan scope and method

Scanned 2,155 current tracked and unignored text files, including the six uncommitted v1.1.6 release-candidate changes. Also scanned 2,259 unique reachable text blobs across all 32 Git-reachable commits. File paths were enumerated with `git ls-files -co --exclude-standard`; history blobs were enumerated with `git rev-list --all --objects` and read with `git cat-file --batch`.

The scan used a local Python 3.14.6 standard-library pattern scanner for common private-key headers, AWS/GitHub/Slack token formats, generic credential assignments, email-shaped strings, home paths, private-looking domains, RFC1918 addresses, dangerous filenames, and source environment-variable reads. Dependencies, generated build directories, binary files, and 11 sensitive-looking paths were excluded. No credential values were printed. `gitleaks`, `trufflehog`, and `detect-secrets` were not installed, so this was not a vendor-tool scan.

## Warning review

- The 586 RFC1918 matches are network-engineering examples and test fixtures; the v1.1.6 release diff adds none.
- The 35 non-example-domain matches were reviewed privately: 20 are intentional public project/upstream/platform references, 13 are synthetic fixtures, and 2 are asset-filename false positives. No personal contact data was identified; no values or source lines are reproduced here.
- The three home-path and five private-looking-domain matches are documentation/example patterns. The v1.1.6 release diff adds none.
- The 56 environment-variable names absent from `.env.example` are heuristic candidates; review the optional integration and test/build entries when improving setup documentation.
- Generic credential-assignment matches are test fixtures, sample configuration/documentation, or bundled vendor request templates; none matched the high-confidence token/private-key rules.

## Critical findings

None identified by the scans described above.

## Recommendation

The v1.1.6 candidate passes the high-confidence secret checks with documentation/example warnings retained. All email-shaped matches were classified as intentional public references, synthetic fixtures, or asset-filename false positives.
