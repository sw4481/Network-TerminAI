use ccie_terminal_lib::drift::diff::{diff_intent_vs_running, DriftSeverity, LineChange};

#[test]
fn equal_configs_are_in_sync() {
    let cfg = "hostname x\n!\ninterface Lo0\n ip address 10.0.0.1 255.255.255.255\n";
    let p = diff_intent_vs_running(cfg, cfg);
    assert_eq!(p.status, "in_sync");
    assert_eq!(p.severity, DriftSeverity::None);
    assert_eq!(p.stats.additions, 0);
    assert_eq!(p.stats.deletions, 0);
    assert!(p.blocks.is_empty());
}

#[test]
fn intent_has_extra_line_is_additive() {
    let intent = "hostname x\n!\nip domain-name example.com\nntp server 1.1.1.1\n";
    let running = "hostname x\n!\nip domain-name example.com\n";
    let p = diff_intent_vs_running(intent, running);
    assert_eq!(p.status, "drift");
    assert_eq!(p.severity, DriftSeverity::Additive);
    assert_eq!(p.stats.additions, 1);
    assert_eq!(p.stats.deletions, 0);
    assert!(p
        .blocks
        .iter()
        .flat_map(|b| &b.changes)
        .any(|c| matches!(c, LineChange::Insert { line } if line.contains("ntp server"))));
}

#[test]
fn running_has_extra_line_is_destructive() {
    let intent = "hostname x\n!\nip domain-name example.com\n";
    let running = "hostname x\n!\nip domain-name example.com\nip name-server 8.8.8.8\n";
    let p = diff_intent_vs_running(intent, running);
    assert_eq!(p.severity, DriftSeverity::Destructive);
    assert!(p.stats.deletions >= 1);
    assert!(p
        .blocks
        .iter()
        .flat_map(|b| &b.changes)
        .any(|c| matches!(c, LineChange::Delete { line } if line.contains("ip name-server"))));
}

#[test]
fn changed_line_is_destructive() {
    let intent = "interface Lo0\n description WAN\n ip address 10.0.0.1 255.255.255.255\n";
    let running = "interface Lo0\n description LAN\n ip address 10.0.0.1 255.255.255.255\n";
    let p = diff_intent_vs_running(intent, running);
    assert_eq!(p.severity, DriftSeverity::Destructive);
    // The change touches the interface block
    assert!(p
        .blocks
        .iter()
        .any(|b| b.block_path == "interface Lo0"));
}

#[test]
fn block_path_resolves_to_nearest_iosxe_header() {
    let intent = "router bgp 65001\n bgp router-id 10.0.0.1\n neighbor 1.1.1.1 remote-as 100\n";
    let running = "router bgp 65001\n bgp router-id 10.0.0.1\n";
    let p = diff_intent_vs_running(intent, running);
    let added: Vec<&str> = p
        .blocks
        .iter()
        .flat_map(|b| &b.changes)
        .filter_map(|c| match c {
            LineChange::Insert { line } => Some(line.as_str()),
            _ => None,
        })
        .collect();
    assert!(added.iter().any(|l| l.contains("neighbor 1.1.1.1")));
    assert!(p
        .blocks
        .iter()
        .any(|b| b.block_path == "router bgp 65001"));
}

#[test]
fn empty_intent_vs_real_running_marks_destructive() {
    let intent = "";
    let running = "hostname r\n!\n";
    let p = diff_intent_vs_running(intent, running);
    assert_eq!(p.severity, DriftSeverity::Destructive);
    assert_eq!(p.stats.additions, 0);
    assert!(p.stats.deletions >= 1);
}

#[test]
fn large_diff_groups_clamp_to_a_bounded_count() {
    // 1000 lines, single difference at the end → grouped_ops should isolate.
    let mut intent = String::with_capacity(20_000);
    let mut running = String::with_capacity(20_000);
    for i in 0..1000 {
        intent.push_str(&format!("line {i}\n"));
        running.push_str(&format!("line {i}\n"));
    }
    intent.push_str("intent-only-tail\n");
    let p = diff_intent_vs_running(&intent, &running);
    assert_eq!(p.severity, DriftSeverity::Additive);
    // grouped_ops with 2 lines of context: a single change ⇒ 1 block.
    assert_eq!(p.stats.blocks_changed, 1);
    assert_eq!(p.stats.additions, 1);
}

#[test]
fn json_roundtrip() {
    let intent = "hostname a\n";
    let running = "hostname b\n";
    let p = diff_intent_vs_running(intent, running);
    let json = serde_json::to_string(&p).unwrap();
    let back: ccie_terminal_lib::drift::diff::DriftPatch =
        serde_json::from_str(&json).unwrap();
    assert_eq!(back.status, p.status);
    assert_eq!(back.severity, p.severity);
    assert_eq!(back.blocks.len(), p.blocks.len());
}
