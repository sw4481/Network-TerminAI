//! Plan 09 SCOPE GUARD — local PTY paths must NEVER classify commands.
//!
//! The user typing `rm -rf /tmp/foo` in a local shell tab must hit the wire
//! verbatim, with no decision row written and no modal raised. We enforce
//! this two ways:
//!  1. By forbidding `crate::guardrails` imports in any file that handles
//!     local shell input. (Source-text scan — fast, offline, deterministic.)
//!  2. By verifying the AppState classify path is never invoked from a PTY
//!     write — exercised by the Playwright E2E `e2e/guardrails-local-shell.spec.ts`.
//!
//! If you genuinely need to call into `guardrails::` from a file listed
//! below, FIRST update `src-tauri/src/guardrails/hook_points.md` and add an
//! explicit allow-listed reason. Otherwise the bypass invariant is broken.

use std::fs;
use std::path::PathBuf;

const FORBIDDEN_FILES: &[&str] = &[
    "src/pty.rs",
    "src/pty_runner.rs",
    "src/shell_integration.rs",
];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn local_shell_files_do_not_import_guardrails() {
    let root = manifest_dir();
    for rel in FORBIDDEN_FILES {
        let p = root.join(rel);
        let body = fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("could not read {}: {}", rel, e));
        assert!(
            !body.contains("crate::guardrails"),
            "{rel} imports crate::guardrails — local PTY scope guard violated. \
             Local shell tabs must NEVER classify commands. See \
             src-tauri/src/guardrails/hook_points.md.",
        );
        assert!(
            !body.contains("use ccie_terminal_lib::guardrails"),
            "{rel} imports ccie_terminal_lib::guardrails — local PTY scope guard violated.",
        );
    }
}

#[test]
fn classifier_is_not_invoked_for_arbitrary_local_strings() {
    // Defensive: even if someone *did* call classify on a local shell command,
    // commands that don't look like network CLI fall through to Ambiguous,
    // not T0. This protects against accidental T0 auto-approval should the
    // scope guard ever break.
    use ccie_terminal_lib::guardrails::classifier::{classify, Tier};
    use ccie_terminal_lib::guardrails::rules::RuleSet;
    let rs = RuleSet::load_builtin().expect("builtin rules load");

    // Local shell command that incidentally starts with "show" should still
    // not be auto-T0'd against an unknown vendor — but this is moot because
    // the scope guard forbids classify being called in this code path at all.
    let d = classify(&rs, "linux", "bash", "rm -rf /tmp/foo");
    assert_eq!(d.tier, Tier::Ambiguous);

    let d = classify(&rs, "linux", "bash", "sudo systemctl restart nginx");
    assert_eq!(d.tier, Tier::Ambiguous);
}
