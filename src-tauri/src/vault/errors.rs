use thiserror::Error;

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("salt is too short; require >= 8 bytes")]
    WeakSalt,
    #[error("kdf failure: {0}")]
    Kdf(String),
    #[error("aead failure")]
    Aead(#[from] crate::vault::aead::AeadError),
    #[error("envelope not found")]
    EnvelopeNotFound,
    #[error("envelope already exists with that name")]
    EnvelopeNameTaken,
    #[error("vault is locked")]
    Locked,
    #[error("invalid passphrase")]
    InvalidPassphrase,
    #[error("secret not found")]
    SecretNotFound,
    #[error("keyring entry missing")]
    KeyringMissing,
    #[error("keyring backend error: {0}")]
    Keyring(String),
    #[error("database error: {0}")]
    Db(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("io error: {0}")]
    Io(String),
}

impl From<rusqlite::Error> for VaultError {
    fn from(e: rusqlite::Error) -> Self {
        VaultError::Db(e.to_string())
    }
}

impl From<serde_json::Error> for VaultError {
    fn from(e: serde_json::Error) -> Self {
        VaultError::Db(format!("json: {e}"))
    }
}
