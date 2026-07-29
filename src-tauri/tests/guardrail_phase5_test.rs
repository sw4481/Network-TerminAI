//! Phase 5 — LLM merge policy + impact heuristics

use ccie_terminal_lib::guardrails::ambiguity::{merge, SecondOpinion};
use ccie_terminal_lib::guardrails::classifier::Tier;
use ccie_terminal_lib::guardrails::impact::summarize;
use rusqlite::Connection;

fn empty_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(include_str!("../migrations/V0036__guardrails.sql"))
        .unwrap();
    conn
}

#[test]
fn llm_can_raise_above_rule_tier() {
    let llm = SecondOpinion {
        tier: 3,
        reasoning: "actually a maintenance-class command".into(),
    };
    assert_eq!(merge(Tier::T1, &llm), Tier::T3);
}

#[test]
fn llm_cannot_lower_below_rule_tier() {
    let llm = SecondOpinion {
        tier: 0,
        reasoning: "I think this is harmless".into(),
    };
    assert_eq!(merge(Tier::T2, &llm), Tier::T2);
    assert_eq!(merge(Tier::T3, &llm), Tier::T3);
}

#[test]
fn ambiguous_safety_floor_is_t2() {
    // LLM says T0/T1 but rule engine is Ambiguous — must NOT auto-approve.
    let llm = SecondOpinion {
        tier: 0,
        reasoning: "harmless".into(),
    };
    assert_eq!(merge(Tier::Ambiguous, &llm), Tier::T2);
    let llm = SecondOpinion {
        tier: 1,
        reasoning: "minor".into(),
    };
    assert_eq!(merge(Tier::Ambiguous, &llm), Tier::T2);
}

#[test]
fn ambiguous_t3_honored() {
    let llm = SecondOpinion {
        tier: 3,
        reasoning: "blast radius".into(),
    };
    assert_eq!(merge(Tier::Ambiguous, &llm), Tier::T3);
}

#[test]
fn t0_stays_t0_even_if_llm_says_higher() {
    // Once a builtin rule has marked something T0 (e.g., `show version`),
    // the LLM cannot escalate. T0 is sacred.
    let llm = SecondOpinion {
        tier: 3,
        reasoning: "paranoid".into(),
    };
    assert_eq!(merge(Tier::T0, &llm), Tier::T0);
}

#[test]
fn impact_falls_back_when_topology_missing() {
    let conn = empty_db();
    let s = summarize(&conn, "cisco", "iosxe", "show version");
    assert!(!s.topology_available);
    assert!(s.notes.iter().any(|n| n.contains("Topology data not available")));
}

#[test]
fn impact_predicts_reload_disruption() {
    let conn = empty_db();
    let s = summarize(&conn, "cisco", "iosxe", "reload");
    assert!(s.notes.iter().any(|n| n.to_lowercase().contains("reboot")));
}

#[test]
fn impact_predicts_no_router_bgp_blast_radius() {
    let conn = empty_db();
    let s = summarize(&conn, "cisco", "iosxe", "no router bgp 64512");
    assert!(s.notes.iter().any(|n| n.contains("BGP sessions in ASN 64512")));
}

#[test]
fn impact_predicts_clear_bgp_soft_churn() {
    let conn = empty_db();
    let s = summarize(&conn, "cisco", "iosxe", "clear ip bgp * soft out");
    assert!(s
        .notes
        .iter()
        .any(|n| n.to_lowercase().contains("refreshed inbound")));
}

#[test]
fn impact_predicts_iface_shutdown() {
    let conn = empty_db();
    let s = summarize(&conn, "cisco", "iosxe", "shutdown");
    assert!(
        s.notes
            .iter()
            .any(|n| n.to_lowercase().contains("admin down")),
        "expected admin-down note, got {:?}",
        s.notes
    );
}

#[test]
fn impact_predicts_junos_commit_immediate() {
    let conn = empty_db();
    let s = summarize(&conn, "juniper", "junos", "commit");
    assert!(s.notes.iter().any(|n| n.contains("apply immediately")));
}

#[test]
fn topology_available_returns_true_when_table_exists() {
    let conn = empty_db();
    conn.execute_batch("CREATE TABLE topology_graphs (id INTEGER)")
        .unwrap();
    let s = summarize(&conn, "cisco", "iosxe", "reload");
    assert!(s.topology_available);
}
