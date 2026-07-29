use serde::Serialize;

/// Wire-stable channel name. Frontend listens via `listen<FanoutEvent>("fanout://event")`.
pub const CHANNEL: &str = "fanout://event";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Timeout,
    Auth,
    Connect,
    Protocol,
    Parse,
    /// The command (or one of its shell-split chunks) classified above
    /// Tier-0 by the guardrail engine. The dispatch was refused before
    /// reaching the wire. See `Plan 09 — AI Guardrails`.
    BlockedByGuardrail,
    Other,
}

impl FailureKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            FailureKind::Timeout => "timeout",
            FailureKind::Auth => "auth",
            FailureKind::Connect => "connect",
            FailureKind::Protocol => "protocol",
            FailureKind::Parse => "parse",
            FailureKind::BlockedByGuardrail => "blocked_by_guardrail",
            FailureKind::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FanoutEvent {
    RunStarted {
        run_id: String,
        total: usize,
        command: String,
        group_id: Option<String>,
    },
    DeviceQueued {
        run_id: String,
        device_id: String,
        device_kind: String,
        display_name: String,
        attempt: i64,
    },
    DeviceStarted {
        run_id: String,
        device_id: String,
        device_kind: String,
        attempt: i64,
    },
    DeviceProgress {
        run_id: String,
        device_id: String,
        device_kind: String,
        bytes: u64,
    },
    DeviceSucceeded {
        run_id: String,
        device_id: String,
        device_kind: String,
        attempt: i64,
        block_id: String,
        parsed_output_id: Option<String>,
        duration_ms: u64,
    },
    DeviceFailed {
        run_id: String,
        device_id: String,
        device_kind: String,
        attempt: i64,
        error: String,
        duration_ms: u64,
        #[serde(rename = "failure_kind")]
        failure_kind: FailureKind,
    },
    DeviceCancelled {
        run_id: String,
        device_id: String,
        device_kind: String,
        attempt: i64,
    },
    RunCompleted {
        run_id: String,
        succeeded: usize,
        failed: usize,
        cancelled: usize,
        duration_ms: u64,
    },
}
