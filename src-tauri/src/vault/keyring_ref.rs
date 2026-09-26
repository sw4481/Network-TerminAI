//! Stable keyring reference helpers. Format:
//! `ccie-terminal.vault.<envelope_id>.<secret_id>` (or `__canary__`).

pub const SERVICE: &str = "ccie-terminal";
pub const CANARY_LABEL: &str = "__canary__";

pub fn secret_key(envelope_id: &str, secret_id: &str) -> String {
    format!("ccie-terminal.vault.{envelope_id}.{secret_id}")
}

pub fn canary_key(envelope_id: &str) -> String {
    format!("ccie-terminal.vault.{envelope_id}.__canary__")
}
