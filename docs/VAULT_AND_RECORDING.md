# Credential Vault & Session Recording (Plan 14)

This document covers the threat model, cryptographic primitives, key
lifecycle, and known gaps for the credential vault and session recording
features added in Plan 14. Every claim references a code path so the
posture can be verified.

For the broader project security policy, see `SECURITY.md`.

## Threat Model

**We defend against:**

- **Disk theft / drive cloning.** SQLite holds metadata only; secret
  ciphertext lives in the OS keychain (macOS Keychain, Windows
  Credential Manager, libsecret on Linux). Even given a copy of
  `sessions.db`, an attacker cannot decrypt secrets without the
  per-envelope passphrase AND access to the same keychain.
- **Casual snooping at the terminal.** Unlocked envelopes auto-lock
  after the idle timeout (default 15 min, env-overridable via
  `CCIE_VAULT_IDLE_SECS`). Secret reveals expire after 5 seconds and
  clipboard auto-clear runs after 30 seconds.
- **Accidental credential leakage in session recordings.** The redactor
  (`src-tauri/src/recording/redactor.rs`) strips Cisco enable/type-7
  passwords, SNMP communities, bearer tokens, AWS access keys, NETCONF
  XML passwords, and bytes that follow `Password:` prompts before any
  byte hits `.cast` storage.

**We do NOT defend against:**

- Malware running with full process memory access. Once an envelope is
  unlocked, the AES key lives in process memory inside `Zeroizing`. A
  privileged process or debugger can read it.
- A compromised OS keychain. We trust the platform store completely.
- Physical coercion. There is no plausible-deniability mode.
- Forensic recovery from SSDs. Wear leveling can preserve plaintext
  fragments after `secure_delete`. The CSV import "shred" path is
  advisory only.

## Cryptographic Primitives

| Primitive | Where | Notes |
|---|---|---|
| Key derivation | `src/vault/kdf.rs` | Argon2id, defaults `m=64 MiB, t=3, p=1` (interactive). 32-byte output for AES-256. Per-envelope 16-byte salt from `OsRng`. |
| Symmetric encryption | `src/vault/aead.rs` | AES-256-GCM. 12-byte nonce from `OsRng` per `seal`. Wire format: `NONCE(12) ‖ CIPHERTEXT‖TAG`. |
| AAD binding | `src/vault/envelope.rs` | AAD = `envelope_id`. Cross-envelope ciphertext swaps fail decrypt (regression test: `aad_binding_prevents_cross_envelope_swap`). |
| Passphrase verification | `src/vault/envelope.rs:unlock_envelope` | 32-byte canary record sealed at envelope creation. Unlock attempts decrypt the canary first; only on success does the key enter `VaultLock`. |
| Wrong-passphrase oracle protection | same | Single generic `InvalidPassphrase` error for unknown-envelope and wrong-passphrase paths so an attacker cannot enumerate envelope names. |

## Key Lifecycle

1. **Creation.** `create_envelope` generates a 16-byte salt, derives the
   key via Argon2id, seals the canary, drops the key. Salt is persisted
   in `vault_envelopes.salt_blob`. The key is gone from memory.
2. **Unlock.** `unlock_envelope` re-derives the key from passphrase +
   persisted salt. On canary success, the key enters `VaultLock` wrapped
   in `Zeroizing<[u8; 32]>` along with a session id.
3. **Use.** `with_key(envelope_id, |k| ...)` borrows the key read-only
   and refreshes `last_activity`. Operations that need the key
   (seal/open) live entirely inside that closure.
4. **Lock.** Manual lock, idle timeout, or app exit removes the
   `Zeroizing<[u8; 32]>` from the map. The destructor wipes the buffer
   before deallocation.

The idle sweep loop runs every 30s (`src-tauri/src/lib.rs:setup`) and
emits `vault://auto-locked` to the frontend.

## Secret Lifecycle

- **At rest:** `vault_secrets` row holds `id`, `envelope_id`, `kind`,
  `label`, `keyring_ref`, `metadata_json`. No plaintext, no ciphertext.
  Ciphertext lives in the OS keyring under `keyring_ref`
  (`ccie-terminal.vault.<envelope_id>.<secret_id>`).
- **At read:** `read_secret` pulls ciphertext from keyring, opens it
  inside `with_key`, returns `Zeroizing<Vec<u8>>` to the caller.
- **At delete:** keyring entry is deleted first, then SQL row.
  Cross-tab consistency is preserved because the SQL FK uses
  `ON DELETE CASCADE`.

## Recording & Redaction

- **PTY tap.** `pty.rs` exposes a non-blocking `mpsc::Sender<RawOutput>`
  slot. The reader thread `try_send`s every chunk before parsing.
  `try_send` cannot back-pressure the user's terminal; if the recording
  task is slow, frames are dropped (visible as gaps in the cast).
- **Redaction.** `redactor.rs` runs a regex set + state machine over the
  byte stream. Output length always equals input length so cast timing
  remains faithful. A 256-byte holdback prevents cross-chunk pattern
  evasion.
- **SSH password mask.** `ssh_password_prompt` triggers a state machine
  that replaces every byte after the prompt with `*` until CR/LF or
  4096-byte budget exhaustion.
- **Audit.** Per-pattern hit counts are written to `recording_redactions`
  on `recording_stop` (PK `(recording_id, pattern)`).
- **Inspector UI.** The replay view shows each pattern's hit count but
  cannot reveal the redacted bytes — they were overwritten before disk
  write and are not recoverable.

## CSV Import

1Password and Bitwarden CSV exports are loaded through the SAME
`add_secret` pipeline (no shortcuts), so imported entries are sealed
with AES-256-GCM, AAD-bound, and stored in keyring. The import flow
warns the user that:

- The CSV file is plaintext on disk during import.
- After import the system can attempt secure-delete (one-pass random
  overwrite + unlink). On SSDs this is advisory; wear leveling may
  preserve remnants.

## Known Gaps

- **Process-memory dumps.** Once unlocked, the AES key is recoverable
  from a core dump. We use `Zeroizing` so memory wipe happens on lock,
  but during the unlocked window the key is in RAM.
- **Clipboard window.** Auto-clear is 30s; a malicious clipboard reader
  has up to 30s after a copy.
- **SSD secure-delete.** Best-effort overwrite; not forensic-grade.
- **TOTP secrets.** Bitwarden CSV `login_totp` fields are NOT imported
  as secrets in this release — only flagged in metadata for future
  work.

## Incident Response

If you suspect compromise:

1. Lock all envelopes (`Vault → Lock All Envelopes` in the menu).
2. Rotate every credential at the source (router, IdP, API provider).
3. Delete recordings under
   `~/Library/Application Support/ccie-terminal/recordings/`.
4. Revoke the original 1Password/Bitwarden export — that file is
   plaintext.
5. Audit `vault_sessions` for unexpected unlock events:
   `SELECT * FROM vault_sessions ORDER BY unlocked_at DESC LIMIT 50;`.
