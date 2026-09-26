//! Argon2id KDF for vault envelope passphrases.

use crate::vault::errors::VaultError;
use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub m_cost: u32, // KiB
    pub t_cost: u32, // iterations
    pub p_cost: u32, // parallelism
}

impl Default for KdfParams {
    fn default() -> Self {
        // Interactive defaults: ~64 MiB, 3 iterations, 1 lane.
        Self {
            m_cost: 65536,
            t_cost: 3,
            p_cost: 1,
        }
    }
}

/// Derive a 32-byte AES-256 key from `passphrase` and `salt` using Argon2id.
///
/// `salt` must be at least 8 bytes; the returned key is wrapped in
/// `Zeroizing` so the buffer is wiped on drop.
pub fn derive_key(
    passphrase: &Zeroizing<Vec<u8>>,
    salt: &[u8],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    if salt.len() < 8 {
        return Err(VaultError::WeakSalt);
    }
    let argon_params = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(32))
        .map_err(|e| VaultError::Kdf(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(passphrase.as_slice(), salt, out.as_mut())
        .map_err(|e| VaultError::Kdf(e.to_string()))?;
    Ok(out)
}
