//! Connection descriptor shared by the packet-capture transport pieces.
//!
//! Historically this module also held russh-based `exec_lines` / `exec_and_poll`
//! helpers that ran capture commands over per-command `exec` channels. Cisco
//! IOS/IOS-XE devices reject those russh `exec` requests with an immediate
//! "Disconnected", so command execution now goes through the shared
//! `crate::ssh_exec` helper (system `ssh` via `sshpass`) — see
//! `pcap::live_executor`. The `.pcap` SFTP pull still uses russh-sftp in
//! `pcap::sftp`, which is a subsystem request these devices accept.
//!
//! Only the connection descriptor remains here; both the SFTP module and the
//! live executor build their transport from it.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceConn {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}
