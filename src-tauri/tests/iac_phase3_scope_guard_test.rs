//! Phase 3 must not intercept user-typed terminal commands. Assert pty.rs /
//! pty_runner.rs gained no IaC/guardrail/drift imports.

use std::fs;

#[test]
fn pty_layer_has_no_iac_or_drift_imports() {
    for f in ["src/pty.rs", "src/pty_runner.rs"] {
        let src = fs::read_to_string(f).unwrap_or_default();
        assert!(
            !src.is_empty(),
            "could not read {f} - path may be incorrect"
        );
        assert!(
            !src.contains("iac::")
                && !src.to_lowercase().contains("drift_checker")
                && !src.contains("crate::guardrails"),
            "{f} must not import IaC/drift/guardrail logic (scope-guard invariant)",
        );
    }
}
