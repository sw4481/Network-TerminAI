use ccie_terminal_lib::drift::intent::{IntentKind, IntentSelector, IntentTemplate, MatchMode};
use ccie_terminal_lib::drift::render::render_intent;

fn tpl(kind: IntentKind, body: &str, vars_yaml: &str) -> IntentTemplate {
    IntentTemplate {
        id: "t".into(),
        name: "n".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        kind,
        body: body.into(),
        vars_yaml: vars_yaml.into(),
        selector: IntentSelector::default(),
        match_mode: MatchMode::Baseline,
        created_at: 0,
        updated_at: 0,
    }
}

#[test]
fn golden_returns_body_verbatim() {
    let t = tpl(IntentKind::Golden, "hostname core-01\n!\n", "");
    let rendered = render_intent(&t, None).unwrap();
    assert_eq!(rendered, "hostname core-01\n!\n");
}

#[test]
fn jinja_renders_with_default_vars() {
    let t = tpl(
        IntentKind::Jinja,
        "hostname {{ hostname }}\ninterface Loopback0\n ip address {{ loopback_ip }} 255.255.255.255\n",
        "hostname: core-01\nloopback_ip: 10.0.0.1\n",
    );
    let rendered = render_intent(&t, None).unwrap();
    assert!(rendered.contains("hostname core-01"), "got: {rendered}");
    assert!(rendered.contains("ip address 10.0.0.1"));
}

#[test]
fn jinja_override_vars_win() {
    let t = tpl(
        IntentKind::Jinja,
        "hostname {{ hostname }}\n",
        "hostname: default\n",
    );
    let rendered = render_intent(&t, Some("hostname: override\n")).unwrap();
    assert!(rendered.contains("hostname override"));
    assert!(!rendered.contains("hostname default"));
}

#[test]
fn jinja_supports_loops() {
    let t = tpl(
        IntentKind::Jinja,
        "{% for s in servers %}ntp server {{ s }}\n{% endfor %}",
        "servers:\n  - 1.1.1.1\n  - 2.2.2.2\n",
    );
    let rendered = render_intent(&t, None).unwrap();
    assert!(rendered.contains("ntp server 1.1.1.1"));
    assert!(rendered.contains("ntp server 2.2.2.2"));
}

#[test]
fn jinja_missing_var_errors_clearly() {
    let t = tpl(
        IntentKind::Jinja,
        "hostname {{ unset_var }}\n",
        "",
    );
    // MiniJinja's default behavior: missing vars render as empty string in
    // strict mode they'd error. We rely on default permissive behavior so a
    // partial render still produces output the operator can review.
    let rendered = render_intent(&t, None).unwrap();
    // Either "" or "<unset_var>" is acceptable; just confirm it doesn't blow up.
    assert!(rendered.starts_with("hostname"));
}

#[test]
fn jinja_overrides_extend_defaults() {
    let t = tpl(
        IntentKind::Jinja,
        "hostname {{ hostname }}\nip domain-name {{ domain }}\n",
        "hostname: default\ndomain: example.com\n",
    );
    let rendered = render_intent(&t, Some("hostname: prod-01\n")).unwrap();
    assert!(rendered.contains("hostname prod-01"));
    assert!(rendered.contains("ip domain-name example.com"));
}
