use crate::guardrails::{
    classifier::{classify, Tier},
    rules::RuleSet,
    shell_split::split_for_classification,
};
use parking_lot::Mutex;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tokio::sync::mpsc;
use uuid::Uuid;

pub mod gateway;

pub const DEFAULT_COMMAND_TIMEOUT_SECONDS: u64 = 90;
pub const MAX_COMMAND_TIMEOUT_SECONDS: u64 = 300;
pub const MAX_CAPTURE_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachment {
    pub backend_pty_id: String,
    pub terminal_id: String,
    pub source: String,
    pub connection_id: Option<String>,
    pub display_name: Option<String>,
    pub vendor: Option<String>,
    pub platform: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InvestigationPlan {
    pub objective: String,
    pub hypotheses: Vec<String>,
    pub steps: Vec<String>,
    pub success_criteria: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FixBatch {
    pub summary: String,
    pub commands: Vec<String>,
    pub verification_commands: Vec<String>,
    pub rollback_commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandTier {
    pub command: String,
    pub tier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FixPreview {
    pub lease_id: String,
    pub digest: String,
    pub target: TerminalAttachment,
    pub summary: String,
    pub commands: Vec<String>,
    pub verification_commands: Vec<String>,
    pub rollback_commands: Vec<String>,
    pub highest_tier: String,
    pub per_command_tiers: Vec<CommandTier>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeaseGrant {
    pub lease_id: String,
    pub capability: String,
    pub target: TerminalAttachment,
    pub expires_at: i64,
}

#[derive(Debug, Clone)]
struct Lease {
    lease_id: String,
    agent_id: String,
    turn_id: String,
    target: TerminalAttachment,
    expires_at: i64,
    revoked_reason: Option<String>,
    plan: Option<InvestigationPlan>,
    evidence_by_command: HashMap<String, String>,
    pending_fix_digest: Option<String>,
    approved_fix: Option<FixBatch>,
}

#[derive(Debug, Clone)]
struct SavedSshBinding {
    connection_id: String,
    process_group_id: i32,
}

#[derive(Debug)]
pub struct TerminalAgentManager {
    leases: Mutex<HashMap<String, Lease>>,
    captures: Mutex<HashMap<String, mpsc::UnboundedSender<CaptureSignal>>>,
    saved_ssh_launches: Mutex<HashMap<String, String>>,
    saved_ssh_bindings: Mutex<HashMap<String, SavedSshBinding>>,
    gateway_base_url: RwLock<Option<String>>,
}

#[derive(Debug, Clone)]
pub(crate) enum CaptureSignal {
    Output(Vec<u8>),
    CommandEnd(Option<i32>),
}

impl Default for TerminalAgentManager {
    fn default() -> Self {
        Self {
            leases: Mutex::new(HashMap::new()),
            captures: Mutex::new(HashMap::new()),
            saved_ssh_launches: Mutex::new(HashMap::new()),
            saved_ssh_bindings: Mutex::new(HashMap::new()),
            gateway_base_url: RwLock::new(None),
        }
    }
}

impl TerminalAgentManager {
    pub fn issue(
        &self,
        agent_id: &str,
        turn_id: &str,
        target: TerminalAttachment,
        now: i64,
        ttl_seconds: i64,
    ) -> Result<LeaseGrant, String> {
        if agent_id != "network-architect" {
            return Err("terminal capability is restricted to Network Architect".to_string());
        }
        if turn_id.trim().is_empty() || target.backend_pty_id.trim().is_empty() {
            return Err("terminal capability requires a turn and backend PTY".to_string());
        }
        let capability = Uuid::new_v4().to_string();
        let lease_id = Uuid::new_v4().to_string();
        let expires_at = now.saturating_add(ttl_seconds.max(1));
        self.leases.lock().insert(
            capability.clone(),
            Lease {
                lease_id: lease_id.clone(),
                agent_id: agent_id.to_string(),
                turn_id: turn_id.to_string(),
                target: target.clone(),
                expires_at,
                revoked_reason: None,
                plan: None,
                evidence_by_command: HashMap::new(),
                pending_fix_digest: None,
                approved_fix: None,
            },
        );
        Ok(LeaseGrant {
            lease_id,
            capability,
            target,
            expires_at,
        })
    }

    pub fn require(
        &self,
        capability: &str,
        agent_id: &str,
        turn_id: &str,
        now: i64,
    ) -> Result<TerminalAttachment, String> {
        let leases = self.leases.lock();
        let lease = leases
            .get(capability)
            .ok_or_else(|| "terminal capability is invalid".to_string())?;
        validate_lease(lease, agent_id, turn_id, now)?;
        Ok(lease.target.clone())
    }

    pub(crate) fn target(&self, capability: &str, now: i64) -> Result<TerminalAttachment, String> {
        let mut leases = self.leases.lock();
        Ok(active_lease_mut(&mut leases, capability, now)?.target.clone())
    }

    pub fn begin_investigation(
        &self,
        capability: &str,
        plan: InvestigationPlan,
        now: i64,
    ) -> Result<(), String> {
        if plan.objective.trim().is_empty()
            || plan.steps.is_empty()
            || plan.success_criteria.is_empty()
        {
            return Err("investigation plan requires objective, steps, and success criteria".into());
        }
        let mut leases = self.leases.lock();
        let lease = active_lease_mut(&mut leases, capability, now)?;
        lease.plan = Some(plan);
        Ok(())
    }

    pub fn update_investigation(
        &self,
        capability: &str,
        plan: InvestigationPlan,
        now: i64,
    ) -> Result<(), String> {
        self.begin_investigation(capability, plan, now)
    }

    pub fn authorize_diagnostic(
        &self,
        capability: &str,
        command: &str,
        current_evidence_hash: &str,
        now: i64,
        rules: &RuleSet,
    ) -> Result<(), String> {
        let mut leases = self.leases.lock();
        let lease = active_lease_mut(&mut leases, capability, now)?;
        if lease.plan.is_none() {
            return Err("terminal diagnostics require an investigation plan first".into());
        }
        validate_single_tier_zero(
            rules,
            lease.target.vendor.as_deref().unwrap_or("generic"),
            lease.target.platform.as_deref().unwrap_or("generic"),
            command,
        )?;
        if lease
            .evidence_by_command
            .get(command.trim())
            .is_some_and(|previous| previous == current_evidence_hash)
        {
            return Err("duplicate diagnostic blocked: unchanged evidence".into());
        }
        Ok(())
    }

    pub fn record_diagnostic_evidence(
        &self,
        capability: &str,
        command: &str,
        evidence_hash: &str,
        now: i64,
    ) -> Result<(), String> {
        let mut leases = self.leases.lock();
        let lease = active_lease_mut(&mut leases, capability, now)?;
        lease
            .evidence_by_command
            .insert(command.trim().to_string(), evidence_hash.to_string());
        Ok(())
    }

    pub fn preview_fix(
        &self,
        capability: &str,
        batch: FixBatch,
        now: i64,
        rules: &RuleSet,
    ) -> Result<FixPreview, String> {
        let mut leases = self.leases.lock();
        let lease = active_lease_mut(&mut leases, capability, now)?;
        if lease.plan.is_none() {
            return Err("a fix cannot be proposed before an investigation plan".into());
        }
        if batch.summary.trim().is_empty() || batch.commands.is_empty() {
            return Err("fix proposal requires a summary and at least one command".into());
        }
        if batch.verification_commands.is_empty()
            || batch
                .verification_commands
                .iter()
                .any(|command| command.trim().is_empty())
        {
            return Err(
                "fix proposal requires at least one nonblank Tier-0 verification command".into(),
            );
        }
        let vendor = lease.target.vendor.as_deref().unwrap_or("generic");
        let platform = lease.target.platform.as_deref().unwrap_or("generic");
        let mut per_command_tiers = Vec::with_capacity(batch.commands.len());
        let mut highest = Tier::T0;
        for command in &batch.commands {
            reject_credentials(command)?;
            reject_chained(command)?;
            let decision = classify(rules, vendor, platform, command);
            if tier_rank(decision.tier) > tier_rank(highest) {
                highest = decision.tier;
            }
            per_command_tiers.push(CommandTier {
                command: command.clone(),
                tier: decision.tier.as_str().to_string(),
            });
        }
        for command in &batch.verification_commands {
            validate_single_tier_zero(rules, vendor, platform, command)?;
        }
        for command in &batch.rollback_commands {
            reject_credentials(command)?;
            reject_chained(command)?;
        }
        let digest = fix_digest(&lease.target, &batch)?;
        lease.pending_fix_digest = Some(digest.clone());
        lease.approved_fix = None;
        Ok(FixPreview {
            lease_id: lease.lease_id.clone(),
            digest,
            target: lease.target.clone(),
            summary: batch.summary.clone(),
            commands: batch.commands.clone(),
            verification_commands: batch.verification_commands.clone(),
            rollback_commands: batch.rollback_commands.clone(),
            highest_tier: highest.as_str().to_string(),
            per_command_tiers,
        })
    }

    pub fn approve_fix(
        &self,
        capability: &str,
        digest: &str,
        batch: &FixBatch,
        now: i64,
    ) -> Result<(), String> {
        let mut leases = self.leases.lock();
        let lease = active_lease_mut(&mut leases, capability, now)?;
        let expected = fix_digest(&lease.target, batch)?;
        if lease.pending_fix_digest.as_deref() != Some(digest) || expected != digest {
            return Err("fix approval does not match the exact reviewed target and commands".into());
        }
        lease.approved_fix = Some(batch.clone());
        Ok(())
    }

    pub fn take_approved_fix(
        &self,
        capability: &str,
        batch: &FixBatch,
        now: i64,
    ) -> Result<FixBatch, String> {
        let mut leases = self.leases.lock();
        let lease = active_lease_mut(&mut leases, capability, now)?;
        let approved = lease
            .approved_fix
            .take()
            .ok_or_else(|| "fix has not been approved".to_string())?;
        if approved != *batch {
            return Err("fix execution payload differs from the approved batch".into());
        }
        Ok(approved)
    }

    pub fn preview_fix_by_lease_id(
        &self,
        lease_id: &str,
        batch: FixBatch,
        now: i64,
        rules: &RuleSet,
    ) -> Result<FixPreview, String> {
        let capability = self.capability_for_lease_id(lease_id)?;
        self.preview_fix(&capability, batch, now, rules)
    }

    pub fn approve_fix_by_lease_id(
        &self,
        lease_id: &str,
        digest: &str,
        batch: &FixBatch,
        now: i64,
    ) -> Result<(), String> {
        let capability = self.capability_for_lease_id(lease_id)?;
        self.approve_fix(&capability, digest, batch, now)
    }

    fn capability_for_lease_id(&self, lease_id: &str) -> Result<String, String> {
        self.leases
            .lock()
            .iter()
            .find_map(|(capability, lease)| {
                (lease.lease_id == lease_id).then(|| capability.clone())
            })
            .ok_or_else(|| "terminal lease is invalid".to_string())
    }

    #[cfg(test)]
    pub(crate) fn begin_capture(
        &self,
        backend_pty_id: &str,
    ) -> Result<mpsc::UnboundedReceiver<CaptureSignal>, String> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut captures = self.captures.lock();
        if captures.contains_key(backend_pty_id) {
            return Err("another terminal-agent command is already active on this PTY".into());
        }
        captures.insert(backend_pty_id.to_string(), sender);
        Ok(receiver)
    }

    pub(crate) fn begin_capture_and_write<F>(
        &self,
        capability: &str,
        backend_pty_id: &str,
        now: i64,
        write: F,
    ) -> Result<mpsc::UnboundedReceiver<CaptureSignal>, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        // Keep the lease lock through the write. Operator takeover takes this
        // same lock before revoking and writing, so the two paths cannot cross.
        let mut leases = self.leases.lock();
        let lease = active_lease_mut(&mut leases, capability, now)?;
        if lease.target.backend_pty_id != backend_pty_id {
            return Err("terminal capability does not match the target PTY".into());
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        {
            let mut captures = self.captures.lock();
            if captures.contains_key(backend_pty_id) {
                return Err("another terminal-agent command is already active on this PTY".into());
            }
            captures.insert(backend_pty_id.to_string(), sender);
        }
        if let Err(error) = write() {
            self.captures.lock().remove(backend_pty_id);
            return Err(error);
        }
        Ok(receiver)
    }

    pub(crate) fn write_if_active<F>(
        &self,
        capability: &str,
        backend_pty_id: &str,
        now: i64,
        write: F,
    ) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let mut leases = self.leases.lock();
        let lease = active_lease_mut(&mut leases, capability, now)?;
        if lease.target.backend_pty_id != backend_pty_id {
            return Err("terminal capability does not match the target PTY".into());
        }
        write()
    }

    pub(crate) fn end_capture(&self, backend_pty_id: &str) {
        self.captures.lock().remove(backend_pty_id);
    }

    pub fn on_pty_event(&self, backend_pty_id: &str, event: &crate::pty::PtyEvent) {
        if matches!(event, crate::pty::PtyEvent::Exit { .. }) {
            self.revoke_for_pty(backend_pty_id, "PTY disconnected");
            self.clear_saved_ssh_binding(backend_pty_id);
            return;
        }
        let signal = match event {
            crate::pty::PtyEvent::Output { bytes } => CaptureSignal::Output(bytes.clone()),
            crate::pty::PtyEvent::CommandEnd { exit_code } => CaptureSignal::CommandEnd(*exit_code),
            crate::pty::PtyEvent::Exit { .. } => unreachable!(),
            _ => return,
        };
        if let Some(sender) = self.captures.lock().get(backend_pty_id) {
            let _ = sender.send(signal);
        }
    }

    pub fn set_gateway_base_url(&self, value: String) {
        *self.gateway_base_url.write() = Some(value);
    }

    pub fn gateway_base_url(&self) -> Option<String> {
        self.gateway_base_url.read().clone()
    }

    pub fn revoke_for_pty(&self, backend_pty_id: &str, reason: &str) {
        self.saved_ssh_launches.lock().remove(backend_pty_id);
        for lease in self.leases.lock().values_mut() {
            if lease.target.backend_pty_id == backend_pty_id && lease.revoked_reason.is_none() {
                lease.revoked_reason = Some(reason.to_string());
            }
        }
        self.captures.lock().remove(backend_pty_id);
    }

    pub fn revoke_for_turn(&self, turn_id: &str, reason: &str) {
        let affected = {
            let mut leases = self.leases.lock();
            leases
                .values_mut()
                .filter_map(|lease| {
                    if lease.turn_id == turn_id && lease.revoked_reason.is_none() {
                        lease.revoked_reason = Some(reason.to_string());
                        Some(lease.target.backend_pty_id.clone())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
        };
        let mut captures = self.captures.lock();
        for backend_pty_id in affected {
            captures.remove(&backend_pty_id);
        }
    }

    pub fn revoke(&self, capability: &str, reason: &str) {
        let backend_pty_id = {
            let mut leases = self.leases.lock();
            leases.get_mut(capability).map(|lease| {
                if lease.revoked_reason.is_none() {
                    lease.revoked_reason = Some(reason.to_string());
                }
                lease.target.backend_pty_id.clone()
            })
        };
        if let Some(backend_pty_id) = backend_pty_id {
            self.captures.lock().remove(&backend_pty_id);
        }
    }

    pub fn revoke_by_lease_id(&self, lease_id: &str, reason: &str) -> Result<(), String> {
        let capability = self.capability_for_lease_id(lease_id)?;
        self.revoke(&capability, reason);
        Ok(())
    }

    pub fn revoke_all(&self, reason: &str) {
        for lease in self.leases.lock().values_mut() {
            if lease.revoked_reason.is_none() {
                lease.revoked_reason = Some(reason.to_string());
            }
        }
        self.captures.lock().clear();
    }

    pub fn bind_saved_ssh(
        &self,
        backend_pty_id: &str,
        connection_id: &str,
        process_group_id: i32,
    ) {
        self.saved_ssh_bindings.lock().insert(
            backend_pty_id.to_string(),
            SavedSshBinding {
                connection_id: connection_id.to_string(),
                process_group_id,
            },
        );
    }

    pub fn begin_saved_ssh_launch_and_write<F, T>(
        &self,
        backend_pty_id: &str,
        write: F,
    ) -> Result<(String, T), String>
    where
        F: FnOnce() -> Result<T, String>,
    {
        let mut launches = self.saved_ssh_launches.lock();
        let nonce = Uuid::new_v4().to_string();
        launches.insert(backend_pty_id.to_string(), nonce.clone());
        self.clear_saved_ssh_binding(backend_pty_id);
        match write() {
            Ok(value) => Ok((nonce, value)),
            Err(error) => {
                launches.remove(backend_pty_id);
                Err(error)
            }
        }
    }

    pub fn cancel_saved_ssh_launch_and_write<F, T, E>(
        &self,
        backend_pty_id: &str,
        write: F,
    ) -> Result<T, E>
    where
        F: FnOnce() -> Result<T, E>,
    {
        let mut launches = self.saved_ssh_launches.lock();
        launches.remove(backend_pty_id);
        write()
    }

    pub fn cancel_saved_ssh_launch(&self, backend_pty_id: &str) {
        self.saved_ssh_launches.lock().remove(backend_pty_id);
    }

    pub fn complete_saved_ssh_launch(
        &self,
        backend_pty_id: &str,
        nonce: &str,
        connection_id: &str,
        process_group_id: i32,
    ) -> Result<(), String> {
        let mut launches = self.saved_ssh_launches.lock();
        if launches.get(backend_pty_id).map(String::as_str) != Some(nonce) {
            return Err("saved SSH launch was cancelled by terminal input".into());
        }
        launches.remove(backend_pty_id);
        self.bind_saved_ssh(backend_pty_id, connection_id, process_group_id);
        Ok(())
    }

    pub fn saved_ssh_binding(
        &self,
        backend_pty_id: &str,
        live_process_group_id: i32,
    ) -> Option<String> {
        self.saved_ssh_bindings
            .lock()
            .get(backend_pty_id)
            .filter(|binding| binding.process_group_id == live_process_group_id)
            .map(|binding| binding.connection_id.clone())
    }

    pub fn clear_saved_ssh_binding(&self, backend_pty_id: &str) {
        self.saved_ssh_bindings.lock().remove(backend_pty_id);
    }
}

fn validate_lease(lease: &Lease, agent_id: &str, turn_id: &str, now: i64) -> Result<(), String> {
    if let Some(reason) = &lease.revoked_reason {
        return Err(format!("terminal capability ended: {reason}"));
    }
    if now >= lease.expires_at {
        return Err("terminal capability expired".into());
    }
    if lease.agent_id != agent_id || lease.turn_id != turn_id {
        return Err("terminal capability is not valid for this agent turn".into());
    }
    Ok(())
}

fn active_lease_mut<'a>(
    leases: &'a mut HashMap<String, Lease>,
    capability: &str,
    now: i64,
) -> Result<&'a mut Lease, String> {
    let lease = leases
        .get_mut(capability)
        .ok_or_else(|| "terminal capability is invalid".to_string())?;
    if let Some(reason) = &lease.revoked_reason {
        return Err(format!("terminal capability ended: {reason}"));
    }
    if now >= lease.expires_at {
        return Err("terminal capability expired".into());
    }
    Ok(lease)
}

fn validate_single_tier_zero(
    rules: &RuleSet,
    vendor: &str,
    platform: &str,
    command: &str,
) -> Result<(), String> {
    reject_credentials(command)?;
    reject_chained(command)?;
    let decision = classify(rules, vendor, platform, command);
    if decision.tier != Tier::T0 {
        return Err(format!(
            "automatic diagnostics require Tier-0; command classified {}",
            decision.tier.as_str()
        ));
    }
    Ok(())
}

fn reject_chained(command: &str) -> Result<(), String> {
    if command.chars().any(char::is_control) {
        return Err("terminal commands cannot contain control characters or line breaks".into());
    }
    if split_for_classification(command).len() != 1 {
        return Err("chained terminal commands are not accepted; submit distinct commands".into());
    }
    Ok(())
}

fn reject_credentials(command: &str) -> Result<(), String> {
    let lower = command.trim().to_lowercase();
    if lower.starts_with("show ") || lower.starts_with("display ") || lower.starts_with("more ") {
        return Ok(());
    }
    let credential_markers = [
        " password ",
        " secret ",
        " community ",
        " pre-shared-key ",
        " preshared-key ",
        " key 0 ",
        " key 7 ",
    ];
    let padded = format!(" {lower} ");
    let first_word = lower.split_whitespace().next().unwrap_or_default();
    if first_word == "key"
        || lower.starts_with("radius-server key ")
        || lower.starts_with("tacacs-server key ")
        || lower.starts_with("snmp-server community ")
        || lower.starts_with("snmp-server host ")
        || lower.starts_with("snmp-server user ")
        || credential_markers.iter().any(|marker| padded.contains(marker))
        || (padded.contains(" radius ") && padded.contains(" key "))
        || (padded.contains(" tacacs ") && padded.contains(" key "))
    {
        return Err("credential-bearing terminal commands require a manual operator step".into());
    }
    Ok(())
}

fn fix_digest(target: &TerminalAttachment, batch: &FixBatch) -> Result<String, String> {
    let serialized = serde_json::to_vec(&(target, batch)).map_err(|error| error.to_string())?;
    Ok(hex::encode(Sha256::digest(serialized)))
}

fn tier_rank(tier: Tier) -> u8 {
    match tier {
        Tier::T0 => 0,
        Tier::T1 | Tier::Ambiguous => 1,
        Tier::T2 => 2,
        Tier::T3 => 3,
    }
}

#[cfg(test)]
mod capture_tests {
    use super::{CaptureSignal, TerminalAgentManager, TerminalAttachment};
    use crate::pty::PtyEvent;

    #[tokio::test]
    async fn capture_receives_only_the_locked_pty_event_stream() {
        let manager = TerminalAgentManager::default();
        let mut capture = manager.begin_capture("ios-pty-1").unwrap();

        manager.on_pty_event(
            "other-pty",
            &PtyEvent::Output { bytes: b"wrong device".to_vec() },
        );
        manager.on_pty_event(
            "ios-pty-1",
            &PtyEvent::Output { bytes: b"RADIUS server ISE-1 DOWN\r\n".to_vec() },
        );
        manager.on_pty_event(
            "ios-pty-1",
            &PtyEvent::CommandEnd { exit_code: Some(0) },
        );

        match capture.recv().await.unwrap() {
            CaptureSignal::Output(bytes) => {
                assert_eq!(bytes, b"RADIUS server ISE-1 DOWN\r\n")
            }
            signal => panic!("unexpected capture signal: {signal:?}"),
        }
        assert!(matches!(
            capture.recv().await.unwrap(),
            CaptureSignal::CommandEnd(Some(0))
        ));
    }


    #[tokio::test]
    async fn revocation_terminates_the_active_capture() {
        let manager = TerminalAgentManager::default();
        let mut capture = manager.begin_capture("ios-pty-1").unwrap();

        manager.revoke_for_pty("ios-pty-1", "user takeover");

        assert!(capture.recv().await.is_none());
    }

    #[test]
    fn revoked_or_expired_capability_cannot_reach_the_write_boundary() {
        let manager = TerminalAgentManager::default();
        let target = TerminalAttachment {
            backend_pty_id: "ios-pty-1".into(),
            terminal_id: "terminal-1".into(),
            source: "saved_ssh".into(),
            connection_id: Some("connection-1".into()),
            display_name: None,
            vendor: Some("cisco".into()),
            platform: Some("iosxe".into()),
        };
        let revoked = manager
            .issue("network-architect", "turn-1", target.clone(), 100, 60)
            .unwrap();
        manager.revoke(&revoked.capability, "user takeover");
        let mut wrote = false;
        assert!(manager
            .begin_capture_and_write(&revoked.capability, "ios-pty-1", 101, || {
                wrote = true;
                Ok(())
            })
            .is_err());
        assert!(!wrote);

        let expired = manager
            .issue("network-architect", "turn-2", target, 100, 1)
            .unwrap();
        assert!(manager
            .write_if_active(&expired.capability, "ios-pty-1", 101, || {
                wrote = true;
                Ok(())
            })
            .is_err());
        assert!(!wrote);
    }

    #[test]
    fn saved_ssh_launch_is_cancelled_by_competing_input_before_binding() {
        let manager = TerminalAgentManager::default();
        let mut wrote = false;
        let (launch, ()) = manager
            .begin_saved_ssh_launch_and_write("ios-pty-1", || {
                wrote = true;
                Ok(())
            })
            .unwrap();
        assert!(wrote);

        manager
            .cancel_saved_ssh_launch_and_write("ios-pty-1", || Ok::<_, String>(()))
            .unwrap();
        assert!(manager
            .complete_saved_ssh_launch("ios-pty-1", &launch, "connection-1", 4401)
            .is_err());
        assert!(manager.saved_ssh_binding("ios-pty-1", 4401).is_none());
    }

    #[test]
    fn saved_ssh_launch_binds_only_while_its_nonce_is_active() {
        let manager = TerminalAgentManager::default();
        let (launch, ()) = manager
            .begin_saved_ssh_launch_and_write("ios-pty-1", || Ok(()))
            .unwrap();

        manager
            .complete_saved_ssh_launch("ios-pty-1", &launch, "connection-1", 4401)
            .unwrap();
        assert_eq!(
            manager.saved_ssh_binding("ios-pty-1", 4401).as_deref(),
            Some("connection-1")
        );
        assert!(manager
            .complete_saved_ssh_launch("ios-pty-1", &launch, "connection-1", 4401)
            .is_err());
    }
}
