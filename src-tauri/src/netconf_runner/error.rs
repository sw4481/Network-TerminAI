//! NETCONF error taxonomy. Mapped to String at the Tauri boundary.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum NetconfError {
    #[error("ssh transport: {0}")]
    Transport(String),

    #[error("authentication failed")]
    AuthFailed,

    #[error("netconf framing: {0}")]
    Framing(String),

    #[error("rpc error: {0}")]
    Rpc(String),

    #[error("timeout after {secs}s")]
    Timeout { secs: u64 },

    #[error("session not found: {0}")]
    SessionNotFound(String),

    #[error("hello parse: {0}")]
    Hello(String),

    #[error("database: {0}")]
    Database(String),

    #[error("keychain: {0}")]
    Keychain(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl From<rusqlite::Error> for NetconfError {
    fn from(e: rusqlite::Error) -> Self {
        NetconfError::Database(e.to_string())
    }
}

impl From<russh::Error> for NetconfError {
    fn from(e: russh::Error) -> Self {
        match e {
            russh::Error::NotAuthenticated => NetconfError::AuthFailed,
            other => NetconfError::Transport(other.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, NetconfError>;
