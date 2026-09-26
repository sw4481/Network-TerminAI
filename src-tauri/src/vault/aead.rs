//! AES-256-GCM seal/open with AAD binding.
//!
//! Wire format: NONCE(12) || CIPHERTEXT+TAG. Each call to `seal` generates
//! a fresh nonce via `OsRng`. The AAD is bound to the envelope_id so that
//! a ciphertext sealed under env-A cannot be decrypted into env-B even if
//! the keys happened to match.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use rand_core::{OsRng, RngCore};
use thiserror::Error;
use zeroize::Zeroizing;

#[derive(Debug, Error)]
pub enum AeadError {
    #[error("encryption failed")]
    Encrypt,
    #[error("decryption or auth failed")]
    Decrypt,
    #[error("invalid ciphertext envelope")]
    Malformed,
}

pub fn seal(
    key: &Zeroizing<[u8; 32]>,
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, AeadError> {
    let cipher = Aes256Gcm::new(key.as_ref().into());
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad })
        .map_err(|_| AeadError::Encrypt)?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn open(
    key: &Zeroizing<[u8; 32]>,
    envelope: &[u8],
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AeadError> {
    if envelope.len() < 12 + 16 {
        return Err(AeadError::Malformed);
    }
    let (nonce_bytes, ct) = envelope.split_at(12);
    let cipher = Aes256Gcm::new(key.as_ref().into());
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), Payload { msg: ct, aad })
        .map_err(|_| AeadError::Decrypt)?;
    Ok(Zeroizing::new(pt))
}
