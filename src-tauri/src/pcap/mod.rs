//! Plan 11 — Packet Capture.
//!
//! - `types`: `CaptureSpec`, `CaptureScript`, `DeviceKind`.
//! - `builder`: vendor-aware string-producer.
//! - `templates`: CRUD for `pcap_templates`.
//! - `repo`: CRUD + state machine for `pcap_captures`.
//! - `scp`, `sftp`, `ssh_exec`, `orchestrator`: capture lifecycle (Phase 2).
//! - `summarize`: bridge to sidecar `pcap.summarize` (Phase 3).

pub mod builder;
pub mod live_executor;
pub mod local;
pub mod orchestrator;
pub mod repo;
pub mod scp;
pub mod sftp;
pub mod ssh_exec;
pub mod summarize;
pub mod templates;
pub mod types;

/// Threshold above which the orchestrator emits a `pcap://size_warning` event
/// and the UI surfaces the "summarization may be slow" banner.
pub const PCAP_SIZE_WARN_BYTES: u64 = 100 * 1024 * 1024;
