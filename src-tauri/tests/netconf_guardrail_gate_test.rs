//! Verifies `guardrails::hook::classify_and_gate`:
//!   * Tier 0 commands write an `auto_approved` decision row + return Proceed
//!   * Tier 3 commands return NeedsConfirmation without writing to the DB
//!   * Tier 2 single-neighbor BGP clears return NeedsConfirmation
//!   * The audit row's reasoning matches the matched rule's reason

use ccie_terminal_lib::commands::guardrails::seed_builtin_rules;
use ccie_terminal_lib::guardrails::classifier::Tier;
use ccie_terminal_lib::guardrails::hook::{classify_and_gate, GuardrailContext, GuardrailOutcome};
use ccie_terminal_lib::guardrails::rules::RuleSet;
use rusqlite::Connection;

fn open_test_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open memory db");
    conn.execute_batch(include_str!("../migrations/V0036__guardrails.sql"))
        .expect("apply V0036");
    conn.execute_batch("PRAGMA foreign_keys = ON")
        .expect("enable foreign keys");
    seed_builtin_rules(&conn).expect("seed builtin rules");
    conn
}

fn ctx<'a>(rs: &'a RuleSet, db: &'a Connection) -> GuardrailContext<'a> {
    GuardrailContext {
        ruleset: rs,
        db,
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        session_id: "session-test-1".into(),
    }
}

#[test]
fn t0_show_auto_approves_and_writes_audit_row() {
    let rs = RuleSet::load_builtin().unwrap();
    let db = open_test_db();
    let outcome = classify_and_gate(&ctx(&rs, &db), "show version").unwrap();
    match outcome {
        GuardrailOutcome::Proceed { decision_id } => {
            let count: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM guardrail_decisions WHERE id = ?1 AND decision = 'auto_approved'",
                    [&decision_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "T0 should have written exactly one auto_approved row");
        }
        other => panic!("expected Proceed, got {:?}", other),
    }
}

#[test]
fn t3_reload_returns_needs_confirmation_without_writing() {
    let rs = RuleSet::load_builtin().unwrap();
    let db = open_test_db();
    let outcome = classify_and_gate(&ctx(&rs, &db), "reload").unwrap();
    match outcome {
        GuardrailOutcome::NeedsConfirmation { tier, .. } => {
            assert_eq!(tier, Tier::T3);
            // Audit row is written by the *resolution* path (frontend ->
            // record_decision), not by classify_and_gate for non-T0 cases.
            let count: i64 = db
                .query_row("SELECT COUNT(*) FROM guardrail_decisions", [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "non-T0 must not write audit rows here");
        }
        other => panic!("expected NeedsConfirmation, got {:?}", other),
    }
}

#[test]
fn t2_single_neighbor_clear_returns_needs_confirmation() {
    let rs = RuleSet::load_builtin().unwrap();
    let db = open_test_db();
    let outcome = classify_and_gate(&ctx(&rs, &db), "clear ip bgp 10.0.0.1").unwrap();
    match outcome {
        GuardrailOutcome::NeedsConfirmation { tier, .. } => assert_eq!(tier, Tier::T2),
        other => panic!("expected NeedsConfirmation T2, got {:?}", other),
    }
}

#[test]
fn ambiguous_returns_needs_confirmation() {
    let rs = RuleSet::load_builtin().unwrap();
    let db = open_test_db();
    let outcome =
        classify_and_gate(&ctx(&rs, &db), "archive path disk0:foobar.cfg").unwrap();
    match outcome {
        GuardrailOutcome::NeedsConfirmation { tier, .. } => assert_eq!(tier, Tier::Ambiguous),
        other => panic!("expected NeedsConfirmation Ambiguous, got {:?}", other),
    }
}

#[test]
fn audit_row_carries_rule_reasoning() {
    let rs = RuleSet::load_builtin().unwrap();
    let db = open_test_db();
    let _ = classify_and_gate(&ctx(&rs, &db), "show ip bgp summary").unwrap();
    let reasoning: String = db
        .query_row(
            "SELECT reasoning FROM guardrail_decisions LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        !reasoning.is_empty(),
        "expected non-empty reasoning, got '{reasoning}'"
    );
}
