//! Plan 14 — Credential vault.
//!
//! Per-envelope Argon2id-derived AES-256-GCM keys; plaintext lives only
//! in the OS keyring under a stable `keyring_ref`; idle auto-lock state
//! machine; canary-record passphrase verification.

pub mod aead;
pub mod envelope;
pub mod errors;
pub mod import;
pub mod kdf;
pub mod keyring_ref;
pub mod keyring_store;
pub mod lock;

pub use envelope::{EnvelopeDto, SecretDto, VaultStore};
pub use errors::VaultError;
pub use keyring_store::{DbKeyringStore, InMemoryKeyringStore, KeyringStore, OsKeyringStore};
pub use lock::VaultLock;
