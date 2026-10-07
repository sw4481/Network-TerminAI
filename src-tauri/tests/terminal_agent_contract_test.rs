use ccie_terminal_lib::guardrails::rules::RuleSet;
use ccie_terminal_lib::terminal_agent::{
    FixBatch, InvestigationPlan, TerminalAgentManager, TerminalAttachment,
};

fn attachment(pty: &str) -> TerminalAttachment {
    TerminalAttachment {
        backend_pty_id: pty.to_string(),
        terminal_id: format!("terminal-{pty}"),
        source: "saved_ssh".to_string(),
        connection_id: Some("connection-1".to_string()),
        display_name: Some("Access switch".to_string()),
        vendor: Some("cisco".to_string()),
        platform: Some("iosxe".to_string()),
    }
}

fn plan() -> InvestigationPlan {
    InvestigationPlan {
        objective: "Find why RADIUS is down".to_string(),
        hypotheses: vec![
            "reachability".to_string(),
            "shared configuration".to_string(),
        ],
        steps: vec!["Inspect AAA state".to_string()],
        success_criteria: vec!["Root cause tied to command evidence".to_string()],
    }
}

#[test]
fn capability_is_bound_to_agent_turn_target_and_expiry() {
    let manager = TerminalAgentManager::default();
    let grant = manager
        .issue("network-architect", "turn-1", attachment("pty-1"), 100, 60)
        .unwrap();

    assert!(manager
        .require(&grant.capability, "network-architect", "turn-1", 159)
        .is_ok());
    assert!(manager
        .require(&grant.capability, "network-architect", "turn-2", 159)
        .is_err());
    assert!(manager
        .require(&grant.capability, "ise", "turn-1", 159)
        .is_err());
    assert!(manager
        .require(&grant.capability, "network-architect", "turn-1", 160)
        .is_err());
    assert_eq!(grant.target.backend_pty_id, "pty-1");
}

#[test]
fn diagnostics_require_a_plan_and_only_allow_distinct_tier_zero_commands() {
    let manager = TerminalAgentManager::default();
    let rules = RuleSet::load_builtin().unwrap();
    let grant = manager
        .issue("network-architect", "turn-1", attachment("pty-1"), 100, 60)
        .unwrap();

    let error = manager
        .authorize_diagnostic(&grant.capability, "show aaa servers", "same", 101, &rules)
        .unwrap_err();
    assert!(error.contains("investigation plan"));

    manager
        .begin_investigation(&grant.capability, plan(), 101)
        .unwrap();
    for index in 0..30 {
        let command = format!("show radius statistics | include probe-{index}");
        manager
            .authorize_diagnostic(&grant.capability, &command, "same", 102, &rules)
            .unwrap();
        manager
            .record_diagnostic_evidence(&grant.capability, &command, "same", 102)
            .unwrap();
    }

    let duplicate = manager
        .authorize_diagnostic(
            &grant.capability,
            "show radius statistics | include probe-0",
            "same",
            103,
            &rules,
        )
        .unwrap_err();
    assert!(duplicate.contains("unchanged evidence"));
    assert!(manager
        .authorize_diagnostic(
            &grant.capability,
            "show radius statistics | include probe-0",
            "changed",
            103,
            &rules,
        )
        .is_ok());

    assert!(manager
        .authorize_diagnostic(
            &grant.capability,
            "configure terminal",
            "changed",
            103,
            &rules
        )
        .is_err());
    assert!(manager
        .authorize_diagnostic(
            &grant.capability,
            "show version ; reload",
            "changed",
            103,
            &rules,
        )
        .is_err());
    assert!(manager
        .authorize_diagnostic(
            &grant.capability,
            "show version\r\nreload",
            "changed",
            103,
            &rules,
        )
        .is_err());
}

#[test]
fn fix_approval_is_an_exact_digest_and_user_takeover_revokes_the_lease() {
    let manager = TerminalAgentManager::default();
    let rules = RuleSet::load_builtin().unwrap();
    let grant = manager
        .issue("network-architect", "turn-1", attachment("pty-1"), 100, 60)
        .unwrap();
    manager
        .begin_investigation(&grant.capability, plan(), 101)
        .unwrap();

    let batch = FixBatch {
        summary: "Correct the RADIUS source interface".to_string(),
        commands: vec![
            "configure terminal".to_string(),
            "ip radius source-interface Vlan10".to_string(),
            "end".to_string(),
        ],
        verification_commands: vec!["show aaa servers".to_string()],
        rollback_commands: vec![
            "configure terminal".to_string(),
            "no ip radius source-interface Vlan10".to_string(),
            "end".to_string(),
        ],
    };
    let preview = manager
        .preview_fix(&grant.capability, batch.clone(), 102, &rules)
        .unwrap();
    assert_eq!(preview.target.backend_pty_id, "pty-1");
    assert!(!preview.digest.is_empty());
    assert!(!preview.per_command_tiers.is_empty());

    let mut edited = batch.clone();
    edited.commands[1] = "ip radius source-interface Vlan20".to_string();
    assert!(manager
        .approve_fix(&grant.capability, &preview.digest, &edited, 103)
        .is_err());
    manager
        .approve_fix(&grant.capability, &preview.digest, &batch, 103)
        .unwrap();

    manager.revoke_for_pty("pty-1", "user takeover");
    assert!(manager
        .require(&grant.capability, "network-architect", "turn-1", 104)
        .is_err());
}

#[test]
fn credential_bearing_fix_commands_are_rejected() {
    let manager = TerminalAgentManager::default();
    let rules = RuleSet::load_builtin().unwrap();
    let grant = manager
        .issue("network-architect", "turn-1", attachment("pty-1"), 100, 60)
        .unwrap();
    manager
        .begin_investigation(&grant.capability, plan(), 101)
        .unwrap();
    let batch = FixBatch {
        summary: "Rotate RADIUS key".to_string(),
        commands: vec!["radius server ISE key 0 plaintext-secret".to_string()],
        verification_commands: vec!["show aaa servers".to_string()],
        rollback_commands: vec![],
    };

    let error = manager
        .preview_fix(&grant.capability, batch, 102, &rules)
        .unwrap_err();
    assert!(error.contains("credential"));
}

#[test]
fn legacy_and_standalone_shared_keys_are_rejected() {
    let manager = TerminalAgentManager::default();
    let rules = RuleSet::load_builtin().unwrap();
    let grant = manager
        .issue("network-architect", "turn-1", attachment("pty-1"), 100, 60)
        .unwrap();
    manager
        .begin_investigation(&grant.capability, plan(), 101)
        .unwrap();

    for command in [
        "key plaintext-secret",
        "radius-server key plaintext-secret",
        "tacacs-server key 7 encoded-secret",
        "snmp-server host 192.0.2.10 version 2c private-community",
        "snmp-server host 192.0.2.10 traps default-community",
        "snmp-server user monitor NMS v3 auth sha auth-password priv aes 128 priv-password",
    ] {
        let batch = FixBatch {
            summary: "Unsafe shared-key change".to_string(),
            commands: vec![command.to_string()],
            verification_commands: vec!["show aaa servers".to_string()],
            rollback_commands: vec![],
        };
        let error = manager
            .preview_fix(&grant.capability, batch, 102, &rules)
            .unwrap_err();
        assert!(
            error.contains("credential"),
            "unexpected error for {command}: {error}"
        );
    }
}

#[test]
fn fix_requires_a_nonblank_tier_zero_verification_command() {
    let manager = TerminalAgentManager::default();
    let rules = RuleSet::load_builtin().unwrap();
    let grant = manager
        .issue("network-architect", "turn-1", attachment("pty-1"), 100, 60)
        .unwrap();
    manager
        .begin_investigation(&grant.capability, plan(), 101)
        .unwrap();

    for verification_commands in [vec![], vec!["   ".to_string()]] {
        let batch = FixBatch {
            summary: "Change a safe setting".to_string(),
            commands: vec!["hostname access-1".to_string()],
            verification_commands,
            rollback_commands: vec![],
        };
        let error = manager
            .preview_fix(&grant.capability, batch, 102, &rules)
            .unwrap_err();
        assert!(error.contains("verification"), "unexpected error: {error}");
    }
}

#[test]
fn saved_ssh_binding_is_process_generation_aware() {
    let manager = TerminalAgentManager::default();
    manager.bind_saved_ssh("pty-1", "connection-1", 4100);

    assert_eq!(
        manager.saved_ssh_binding("pty-1", 4100).as_deref(),
        Some("connection-1")
    );
    assert!(manager.saved_ssh_binding("pty-1", 4101).is_none());

    manager.clear_saved_ssh_binding("pty-1");
    assert!(manager.saved_ssh_binding("pty-1", 4100).is_none());
}

#[test]
fn managed_ssh_requires_post_auth_and_live_pty_generation() {
    let manager = TerminalAgentManager::default();
    manager.begin_managed_ssh("pty-1", "connection-1", "generation-1", 4100, "secret-1");
    assert!(manager
        .managed_ssh_binding("pty-1", "generation-1", 4100)
        .is_none());
    assert!(manager
        .complete_managed_ssh("pty-1", "generation-1", 4100, "wrong")
        .is_err());
    assert!(manager
        .complete_managed_ssh("pty-1", "generation-2", 4100, "secret-1")
        .is_err());
    assert!(manager
        .complete_managed_ssh("pty-1", "generation-1", 4100, "secret-1")
        .is_ok());
    assert_eq!(
        manager
            .managed_ssh_binding("pty-1", "generation-1", 4100)
            .as_deref(),
        Some("connection-1")
    );
    assert!(manager
        .managed_ssh_binding("pty-1", "generation-2", 4100)
        .is_none());
    assert!(manager
        .managed_ssh_binding("pty-1", "generation-1", 4101)
        .is_none());

    manager.revoke_for_pty("pty-1", "user takeover");
    assert!(manager
        .managed_ssh_binding("pty-1", "generation-1", 4100)
        .is_some());
    manager.clear_managed_ssh("pty-1");
    assert!(manager
        .managed_ssh_binding("pty-1", "generation-1", 4100)
        .is_none());
    assert!(manager
        .complete_managed_ssh("pty-1", "generation-1", 4100, "secret-1")
        .is_err());
}

#[test]
fn late_managed_ssh_callback_cannot_authenticate_replacement() {
    let manager = TerminalAgentManager::default();
    manager.begin_managed_ssh("pty-1", "old", "generation-1", 4100, "old-secret");
    manager.begin_managed_ssh("pty-1", "new", "generation-2", 4100, "new-secret");
    assert!(manager
        .complete_managed_ssh("pty-1", "generation-1", 4100, "old-secret")
        .is_err());
    assert!(manager
        .complete_managed_ssh("pty-1", "generation-2", 4100, "new-secret")
        .is_ok());
    manager.clear_managed_ssh_generation("pty-1", "generation-1");
    assert_eq!(
        manager
            .managed_ssh_binding("pty-1", "generation-2", 4100)
            .as_deref(),
        Some("new")
    );
}

#[test]
fn old_exit_after_replacement_does_not_revoke_new_lease_or_binding() {
    use ccie_terminal_lib::pty::PtyEvent;
    let manager = TerminalAgentManager::default();
    manager.begin_managed_ssh("pty-1", "connection-1", "old", 4100, "old-nonce");
    manager
        .complete_managed_ssh("pty-1", "old", 4100, "old-nonce")
        .unwrap();
    let (_, old_identity) = manager
        .authenticated_managed_ssh("pty-1", "old", 4100)
        .unwrap();
    let _old = manager
        .issue_managed_ssh(
            "network-architect",
            "old-turn",
            attachment("pty-1"),
            old_identity,
            100,
            60,
        )
        .unwrap();

    // The old event passed the event-loop generation check before this replacement.
    manager.begin_managed_ssh("pty-1", "connection-1", "new", 4200, "new-nonce");
    manager
        .complete_managed_ssh("pty-1", "new", 4200, "new-nonce")
        .unwrap();
    let (_, new_identity) = manager
        .authenticated_managed_ssh("pty-1", "new", 4200)
        .unwrap();
    let fresh = manager
        .issue_managed_ssh(
            "network-architect",
            "new-turn",
            attachment("pty-1"),
            new_identity,
            100,
            60,
        )
        .unwrap();
    assert!(!manager.on_managed_pty_exit("pty-1", "old"));
    assert!(manager
        .require(&fresh.capability, "network-architect", "new-turn", 101)
        .is_ok());
    assert!(manager.managed_ssh_binding("pty-1", "new", 4200).is_some());
    assert!(manager.on_managed_pty_event(
        "pty-1",
        "new",
        &PtyEvent::Output {
            bytes: b"live".to_vec()
        }
    ));
    assert!(manager.on_managed_pty_exit("pty-1", "new"));
    assert!(manager
        .require(&fresh.capability, "network-architect", "new-turn", 101)
        .is_err());
}

#[test]
fn validated_identity_cannot_issue_or_write_after_close_takeover_and_replacement() {
    let manager = TerminalAgentManager::default();
    manager.begin_managed_ssh("pty-1", "connection-1", "old", 4100, "old-nonce");
    manager
        .complete_managed_ssh("pty-1", "old", 4100, "old-nonce")
        .unwrap();
    let (_, validated) = manager
        .authenticated_managed_ssh("pty-1", "old", 4100)
        .unwrap();
    let active = manager
        .issue_managed_ssh(
            "network-architect",
            "turn-1",
            attachment("pty-1"),
            validated.clone(),
            100,
            60,
        )
        .unwrap();

    // A keystroke on the SAME authenticated child invalidates a pre-takeover snapshot.
    manager.revoke_for_pty("pty-1", "user takeover");
    assert!(manager
        .issue_managed_ssh(
            "network-architect",
            "turn-2",
            attachment("pty-1"),
            validated.clone(),
            101,
            60
        )
        .is_err());
    assert!(manager
        .require(&active.capability, "network-architect", "turn-1", 101)
        .is_err());

    // Close then re-authenticate the same saved connection under the same tab id.
    manager.clear_managed_ssh("pty-1");
    manager.begin_managed_ssh("pty-1", "connection-1", "new", 4200, "new-nonce");
    manager
        .complete_managed_ssh("pty-1", "new", 4200, "new-nonce")
        .unwrap();
    assert!(manager
        .authenticated_managed_ssh("pty-1", "old", 4100)
        .is_none());
    assert!(manager
        .issue_managed_ssh(
            "network-architect",
            "late-turn",
            attachment("pty-1"),
            validated,
            102,
            60
        )
        .is_err());
    assert!(manager
        .require(&active.capability, "network-architect", "turn-1", 102)
        .is_err());
}

#[test]
fn line_breaks_are_rejected_in_fix_verification_and_rollback_commands() {
    let manager = TerminalAgentManager::default();
    let rules = RuleSet::load_builtin().unwrap();
    let grant = manager
        .issue("network-architect", "turn-1", attachment("pty-1"), 100, 60)
        .unwrap();
    manager
        .begin_investigation(&grant.capability, plan(), 101)
        .unwrap();

    for batch in [
        FixBatch {
            summary: "Injected fix".into(),
            commands: vec!["hostname safe\nreload".into()],
            verification_commands: vec!["show aaa servers".into()],
            rollback_commands: vec![],
        },
        FixBatch {
            summary: "Injected verification".into(),
            commands: vec!["hostname safe".into()],
            verification_commands: vec!["show aaa servers\rwrite erase".into()],
            rollback_commands: vec![],
        },
        FixBatch {
            summary: "Injected rollback".into(),
            commands: vec!["hostname safe".into()],
            verification_commands: vec!["show aaa servers".into()],
            rollback_commands: vec!["no hostname safe\nreload".into()],
        },
    ] {
        assert!(manager
            .preview_fix(&grant.capability, batch, 102, &rules)
            .is_err());
    }
}
