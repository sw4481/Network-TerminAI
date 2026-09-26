use ccie_terminal_lib::drift::presence::match_intent_presence;
use ccie_terminal_lib::drift::diff::DriftSeverity;

const RUNNING: &str = "\
hostname R1
!
router eigrp 10
 metric weights 0 100 100 150 125 200
 bfd all-interfaces
 network 10.0.0.0
!
interface Gi0/0
 ip address 10.0.0.1 255.255.255.0
!
";

#[test]
fn all_intended_lines_present_is_in_sync() {
    let intent = "router eigrp 10\n metric weights 0 100 100 150 125 200\n bfd all-interfaces\n";
    let p = match_intent_presence(intent, RUNNING);
    assert_eq!(p.status, "in_sync", "blocks={:?}", p.blocks);
    assert_eq!(p.severity, DriftSeverity::None);
}

#[test]
fn missing_intended_line_is_destructive() {
    // 'passive-interface default' is not on the device.
    let intent = "router eigrp 10\n passive-interface default\n";
    let p = match_intent_presence(intent, RUNNING);
    assert_eq!(p.status, "drift");
    assert_eq!(p.severity, DriftSeverity::Destructive);
    let joined: Vec<&str> = p.blocks.iter().flat_map(|b| b.changes.iter().map(|c| c.line())).collect();
    assert!(joined.iter().any(|l| l.contains("passive-interface default")));
}

#[test]
fn changed_value_is_reported() {
    // Same command, different metric weights → Changed, not Missing.
    let intent = "router eigrp 10\n metric weights 0 1 2 3 4 5\n";
    let p = match_intent_presence(intent, RUNNING);
    assert_eq!(p.status, "drift");
    // A changed value counts as a deletion (intended value differs).
    assert!(p.stats.deletions >= 1, "expected a Changed delta, got {:?}", p.blocks);
}

#[test]
fn device_extra_config_is_ignored() {
    // Intent only mentions the eigrp block; hostname/interface on the device
    // must NOT appear as drift.
    let intent = "router eigrp 10\n bfd all-interfaces\n";
    let p = match_intent_presence(intent, RUNNING);
    assert_eq!(p.status, "in_sync", "extra device config leaked: {:?}", p.blocks);
}

#[test]
fn ambiguous_pairing_falls_back_to_missing() {
    // A brand-new command with no prefix match anywhere → Missing, never Changed.
    let intent = "router eigrp 10\n stub connected summary\n";
    let p = match_intent_presence(intent, RUNNING);
    assert_eq!(p.severity, DriftSeverity::Destructive);
    assert!(p.stats.additions >= 1, "expected Missing (Insert) delta");
}
