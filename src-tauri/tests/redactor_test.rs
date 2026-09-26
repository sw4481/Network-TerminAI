use ccie_terminal_lib::recording::redactor::{Redactor, RedactorError, UserPattern};

const REDTEAM_CORPUS: &[u8] = include_bytes!("fixtures/redactor_redteam.txt");

#[test]
fn redteam_corpus_is_100_percent_redacted() {
    let mut r = Redactor::new(&[]).unwrap();
    let mut corpus = REDTEAM_CORPUS.to_vec();
    corpus.extend_from_slice(b" AWS Access Key ID: ");
    corpus.extend_from_slice(b"AKIA");
    corpus.extend_from_slice(b"EXAMPLE000000000");
    let redacted = r.feed(&corpus);
    // Length-preserving invariant.
    assert_eq!(redacted.len(), corpus.len());

    // Credentials that MUST NOT appear verbatim in the output.
    const MUST_BE_GONE: &[&[u8]] = &[
        b"EXAMPLE_ENABLE_SECRET",
        b"EXAMPLE_USER_PASSWORD",
        b"A0B1C2D3E4F5",
        b"EXAMPLE_PRIVATE_COMMUNITY",
        b"EXAMPLE_COMMUNITY",
        b"EXAMPLE_BEARER_TOKEN",
        b"EXAMPLE_API_KEY_1",
        b"EXAMPLE000000000",
        b"EXAMPLE_NETCONF_PASSWORD",
        b"EXAMPLE_SSH_PASSWORD",
    ];
    for needle in MUST_BE_GONE {
        assert!(
            !redacted.windows(needle.len()).any(|w| w == *needle),
            "LEAK: {:?} still present in redacted output",
            std::str::from_utf8(needle).unwrap_or("<bin>"),
        );
    }

    // Audit log must show non-zero hits across the major categories.
    let audit = r.drain_audit();
    let names: std::collections::HashSet<_> =
        audit.iter().map(|s| s.pattern_id.clone()).collect();
    for req in [
        "cisco_enable_secret",
        "cisco_username_password",
        "cisco_type7_password",
        "snmp_community",
        "bearer_token",
        "aws_access_key",
        "netconf_password_xml",
        "ssh_password_prompt",
    ] {
        assert!(
            names.contains(req),
            "pattern {req} did not fire on red-team corpus; saw {names:?}"
        );
    }
}

#[test]
fn invalid_user_regex_returns_compile_error_not_panic() {
    let user = vec![UserPattern {
        id: "bad".into(),
        regex: "(unclosed".into(),
    }];
    let err = Redactor::new(&user).unwrap_err();
    assert!(matches!(err, RedactorError::Compile(_)));
}

#[test]
fn empty_user_pattern_is_rejected() {
    let user = vec![UserPattern {
        id: "empty".into(),
        regex: "".into(),
    }];
    assert!(Redactor::new(&user).is_err());
}

#[test]
fn user_pattern_redacts_alongside_builtins() {
    let user = vec![UserPattern {
        id: "secret_label".into(),
        regex: r"MYSECRET-[A-Z0-9]+".into(),
    }];
    let mut r = Redactor::new(&user).unwrap();
    let redacted = r.feed(b"prefix MYSECRET-ABC123 suffix");
    assert_eq!(redacted.len(), b"prefix MYSECRET-ABC123 suffix".len());
    assert!(!redacted.windows(15).any(|w| w == b"MYSECRET-ABC123"));
    let audit = r.drain_audit();
    assert!(audit.iter().any(|m| m.pattern_id == "secret_label"));
}

#[test]
fn output_length_equals_input_length_for_random_bytes() {
    let mut r = Redactor::new(&[]).unwrap();
    let payload = b"the quick brown fox jumps over the lazy dog";
    let redacted = r.feed(payload);
    assert_eq!(redacted.len(), payload.len());
}

#[test]
fn cross_chunk_pattern_match_via_holdback() {
    let mut r = Redactor::new(&[]).unwrap();
    let part1 = b"some prefix enable secret 5 $1$abcde";
    let part2 = b"fghij$XYZ trailing";
    let mut combined = Vec::new();
    combined.extend_from_slice(&r.feed(part1));
    combined.extend_from_slice(&r.feed(part2));
    let total_len = part1.len() + part2.len();
    assert_eq!(combined.len(), total_len);
    let audit = r.drain_audit();
    assert!(
        audit.iter().any(|m| m.pattern_id == "cisco_enable_secret"),
        "cross-chunk match must be detected via holdback; audit={audit:?}"
    );
}

#[test]
fn ssh_password_prompt_masks_subsequent_bytes() {
    let mut r = Redactor::new(&[]).unwrap();
    let payload = b"User connected\r\nPassword: EXAMPLE_SSH_PASSWORD\r\nshell$ ls\r\n";
    let redacted = r.feed(payload);
    assert_eq!(redacted.len(), payload.len());
    assert!(!redacted
        .windows("EXAMPLE_SSH_PASSWORD".len())
        .any(|w| w == b"EXAMPLE_SSH_PASSWORD"));
    // Post-newline content remains visible.
    assert!(redacted.windows(2).any(|w| w == b"ls"));
}

#[test]
fn audit_counts_increment_per_match() {
    let mut r = Redactor::new(&[]).unwrap();
    let first = format!("{}{}{}", "AKIA", "EXAMPLE", "000000000");
    let second = format!("{}{}{}", "AKIA", "EXAMPLE", "000000001");
    let payload = format!("{first} and {second} done");
    let _ = r.feed(payload.as_bytes());
    let audit = r.drain_audit();
    let aws = audit
        .iter()
        .find(|m| m.pattern_id == "aws_access_key")
        .unwrap();
    assert_eq!(aws.matches, 2);
}
