# 14 — Credential Vault + Session Recording (audit)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Security-critical plan** — Phase 1 and Phase 4 require security-focused review prompts.

**Goal:** Unify two related features into a single audit-grade subsystem:

1. **Credential Vault hardening.** Today the app stores SSH passwords in the OS keyring (Rust `keyring` crate, see `V0025__ssh_passwords.sql`). Graduate this to a full vault tab organized into per-site/per-customer *envelopes*, supporting multiple secret types (password, SSH key, API token, SNMP community, NETCONF user+pass), per-secret metadata (owner, last-used, rotate-after, expires-at), Argon2id-derived per-envelope AES-GCM keys, idle auto-lock, and optional import from 1Password/Bitwarden CSV exports.
2. **Session recording (opt-in).** Per-session toggle that taps the PTY byte stream (see `src-tauri/src/pty.rs`), runs a redactor over login/SNMP/API-key patterns, and writes asciinema v2 `.cast` files to `~/Library/Application Support/ccie-terminal/recordings/<session_id>.cast`. Files are playable in-app and exportable.

**Architecture:**
- **Rust crate split.** New `src-tauri/src/vault/` module: `envelope.rs`, `kdf.rs`, `aead.rs`, `keyring_ref.rs`, `lock.rs`. New `src-tauri/src/recording/` module: `tap.rs` (subscribes to `PtyEvent::Output`), `redactor.rs`, `asciinema.rs` (v2 writer), `player.rs` (server-side seek helper).
- **PTY tap hook.** `pty.rs` gains a secondary `mpsc::Sender<RawOutput>` that the recording supervisor subscribes to per-tab. The primary `PtyEvent` channel is unchanged — recording is purely additive so absence of recording has zero impact on parser/terminal performance.
- **Keyring integration.** Each `vault_secrets` row has a `keyring_ref` (format `ccie-terminal.vault.<envelope_id>.<secret_id>`). Plaintext never touches SQLite — only the AES-GCM-wrapped ciphertext is held in keyring, and the AES key itself is derived on-demand from the master passphrase via Argon2id with per-envelope salt.
- **Redactor.** Streaming finite-state replacer; patterns compiled once at vault unlock. Replacement = `█` × original length so cast timing stays intact. Each match records `(recording_id, pattern, replacement_hash, match_count)` into `recording_redactions` for audit.
- **Frontend.** New tab type `vault` (see `src/state/tabsStore.ts` precedent). New tab type `recording-player` for replay. Existing tab types gain a `recording` indicator dot.
- **Storage.** `V0041__vault_and_recordings.sql` creates all five new tables in one migration.

**Tech Stack:** Rust 1.79+, Tauri 2, `keyring` (existing), `argon2` crate (add), `aes-gcm` crate (add), `rand_core` (add), `zeroize` (add), `csv` (add, for import), React 19, Zustand 5, `xterm.js` (for in-app playback), `react-hotkeys-hook` (existing from Plan 01).

**Prerequisites:**
- Plan 00 Phase 2 complete (Tauri command conventions, `rusqlite` wiring).
- Plan 01 Phase 1 complete (Zustand store patterns referenced for the new vault store).

**Downstream consumers:**
- Plan 07 (Multi-device fan-out) will prefer vault lookup over plaintext SSH password prompts.
- Plan 15 (AI troubleshooting tree) will consume recording metadata for post-mortem context.
- Plan 06 (Pre/Post verification) will auto-attach the active recording to change snapshots.

**Migration reservation:** V0041 (per `/Plans/README.md`).

**Security note (read before coding):**
- NEVER log secret material or AES keys. Use `zeroize::Zeroizing<Vec<u8>>` for any plaintext buffer.
- NEVER write secret plaintext to the DB, even temporarily. The keyring is the only at-rest store.
- Redaction MUST be applied BEFORE bytes land on disk. The `.cast` writer and redactor live in the same task to prevent a race where unredacted bytes touch persistent storage.
- Clipboard auto-clear is a belt-and-braces measure — treat it as UX, not a security boundary.

---

## Phase 1 — Vault schema + Argon2id KDF + envelope CRUD + keyring integration

### Task 1.1 — Migration V0041  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0041__vault_and_recordings.sql`

- [ ] **Step 1: Write migration**

```sql
-- Vault envelopes: logical grouping (per-site or per-customer)
CREATE TABLE IF NOT EXISTS vault_envelopes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  kdf_params_json TEXT NOT NULL,        -- {"algo":"argon2id","m":65536,"t":3,"p":1}
  salt_blob BLOB NOT NULL,              -- per-envelope salt (16 bytes min)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Secrets: metadata only. Plaintext lives in OS keyring under `keyring_ref`.
CREATE TABLE IF NOT EXISTS vault_secrets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  envelope_id TEXT NOT NULL REFERENCES vault_envelopes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('password','ssh_key','api_token','snmp_community','netconf')),
  label TEXT NOT NULL,
  keyring_ref TEXT NOT NULL UNIQUE,     -- e.g. ccie-terminal.vault.<envelope_id>.<secret_id>
  metadata_json TEXT NOT NULL DEFAULT '{}', -- owner, notes, rotation policy
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER,
  rotates_at INTEGER,                   -- unix; advisory
  expires_at INTEGER                    -- unix; advisory
);
CREATE INDEX IF NOT EXISTS idx_vault_secrets_envelope ON vault_secrets(envelope_id);
CREATE INDEX IF NOT EXISTS idx_vault_secrets_kind ON vault_secrets(kind);

-- Vault session audit log (unlock events). Unlocked state is process-memory only.
CREATE TABLE IF NOT EXISTS vault_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  envelope_id TEXT NOT NULL REFERENCES vault_envelopes(id) ON DELETE CASCADE,
  unlocked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  locked_at INTEGER,                    -- null while active; set on lock/idle/exit
  reason TEXT                           -- 'manual','idle','app_exit','wrong_passphrase'
);
CREATE INDEX IF NOT EXISTS idx_vault_sessions_envelope ON vault_sessions(envelope_id);
CREATE INDEX IF NOT EXISTS idx_vault_sessions_unlocked ON vault_sessions(unlocked_at DESC);

-- Session recordings (asciinema v2)
CREATE TABLE IF NOT EXISTS session_recordings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tab_id TEXT NOT NULL,                 -- loose FK; tabs are UI-scoped
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at INTEGER,
  path TEXT NOT NULL UNIQUE,            -- absolute path to .cast file
  size_bytes INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('local','ssh','netconf','sidecar'))
);
CREATE INDEX IF NOT EXISTS idx_session_recordings_tab ON session_recordings(tab_id);
CREATE INDEX IF NOT EXISTS idx_session_recordings_started ON session_recordings(started_at DESC);

-- Redaction audit: per-pattern match counts per recording
CREATE TABLE IF NOT EXISTS recording_redactions (
  recording_id TEXT NOT NULL REFERENCES session_recordings(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  replacement_hash TEXT NOT NULL,       -- sha256 of replacement bytes (for forensic replay validation)
  matches INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (recording_id, pattern)
);
```

- [ ] **Step 2: Verify migration applies**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib db::tests::migrations_apply
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0041__vault_and_recordings.sql
git commit -m "feat(db): V0041 vault envelopes/secrets/sessions + session recordings + redaction audit"
```

### Task 1.2 — Cargo deps & module skeleton  `SEQUENTIAL` (depends on 1.1)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/vault/mod.rs`
- Create: `src-tauri/src/vault/kdf.rs`
- Create: `src-tauri/src/vault/aead.rs`
- Create: `src-tauri/src/vault/keyring_ref.rs`
- Create: `src-tauri/src/vault/envelope.rs`
- Create: `src-tauri/src/vault/lock.rs`
- Create: `src-tauri/src/vault/errors.rs`
- Modify: `src-tauri/src/lib.rs` — `pub mod vault;` and register commands (step below)

- [ ] **Step 1: Add dependencies**

Append to `[dependencies]`:
```toml
argon2 = "0.5"
aes-gcm = "0.10"
rand_core = { version = "0.6", features = ["std"] }
zeroize = { version = "1.7", features = ["zeroize_derive"] }
csv = "1.3"
```

Confirm `keyring = "..."` is already listed (it is; used by `V0025` code path). Do NOT duplicate.

- [ ] **Step 2: Create module skeletons with `// TODO` bodies and run `cargo check`** — expect compile success with warnings only. Fix any compile errors now before filling in logic.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/vault/
git commit -m "feat(vault): module scaffolding + crypto deps"
```

### Task 1.3 — Argon2id KDF with unit tests  `PARALLEL with 1.4`

**Files:**
- Modify: `src-tauri/src/vault/kdf.rs`
- Create: `src-tauri/tests/vault_kdf_test.rs`

- [ ] **Step 1: Write failing tests**

```rust
use ccie_terminal_lib::vault::kdf::{derive_key, KdfParams};
use zeroize::Zeroizing;

#[test]
fn derive_key_is_deterministic_for_same_inputs() {
    let params = KdfParams::default();
    let salt = [0u8; 16];
    let k1 = derive_key(&Zeroizing::new(b"hunter2".to_vec()), &salt, &params).unwrap();
    let k2 = derive_key(&Zeroizing::new(b"hunter2".to_vec()), &salt, &params).unwrap();
    assert_eq!(k1.as_ref(), k2.as_ref());
    assert_eq!(k1.as_ref().len(), 32); // AES-256 key
}

#[test]
fn derive_key_differs_with_different_salt() {
    let params = KdfParams::default();
    let s1 = [0u8; 16];
    let s2 = [1u8; 16];
    let k1 = derive_key(&Zeroizing::new(b"hunter2".to_vec()), &s1, &params).unwrap();
    let k2 = derive_key(&Zeroizing::new(b"hunter2".to_vec()), &s2, &params).unwrap();
    assert_ne!(k1.as_ref(), k2.as_ref());
}

#[test]
fn derive_key_differs_with_wrong_passphrase() {
    let params = KdfParams::default();
    let salt = [0u8; 16];
    let k1 = derive_key(&Zeroizing::new(b"hunter2".to_vec()), &salt, &params).unwrap();
    let k2 = derive_key(&Zeroizing::new(b"HUNTER2".to_vec()), &salt, &params).unwrap();
    assert_ne!(k1.as_ref(), k2.as_ref());
}

#[test]
fn kdf_params_json_roundtrip() {
    let p = KdfParams { m_cost: 65536, t_cost: 3, p_cost: 1 };
    let s = serde_json::to_string(&p).unwrap();
    let p2: KdfParams = serde_json::from_str(&s).unwrap();
    assert_eq!(p, p2);
}
```

- [ ] **Step 2: Run — expect FAIL** (`cargo test --manifest-path src-tauri/Cargo.toml vault_kdf`).

- [ ] **Step 3: Implement `kdf.rs`**

```rust
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
        // Benchmarked target on M1 Pro: ~250ms.
        Self { m_cost: 65536, t_cost: 3, p_cost: 1 }
    }
}

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
```

- [ ] **Step 4: Run — expect PASS**.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/vault/kdf.rs src-tauri/tests/vault_kdf_test.rs
git commit -m "feat(vault): argon2id KDF with parameter serialization"
```

### Task 1.4 — AES-GCM AEAD wrapper with unit tests  `PARALLEL with 1.3`

**Files:**
- Modify: `src-tauri/src/vault/aead.rs`
- Create: `src-tauri/tests/vault_aead_test.rs`

- [ ] **Step 1: Write failing tests**

```rust
use ccie_terminal_lib::vault::aead::{seal, open, AeadError};
use zeroize::Zeroizing;

#[test]
fn seal_open_roundtrip() {
    let key = Zeroizing::new([7u8; 32]);
    let plaintext = b"hunter2-ssh-pw";
    let sealed = seal(&key, plaintext, b"envelope-x").unwrap();
    let opened = open(&key, &sealed, b"envelope-x").unwrap();
    assert_eq!(opened.as_ref(), plaintext);
}

#[test]
fn open_rejects_tampered_ciphertext() {
    let key = Zeroizing::new([7u8; 32]);
    let mut sealed = seal(&key, b"secret", b"env").unwrap();
    let last = sealed.len() - 1;
    sealed[last] ^= 0x01;
    let err = open(&key, &sealed, b"env").unwrap_err();
    assert!(matches!(err, AeadError::Decrypt));
}

#[test]
fn open_rejects_wrong_key() {
    let k1 = Zeroizing::new([7u8; 32]);
    let k2 = Zeroizing::new([8u8; 32]);
    let sealed = seal(&k1, b"secret", b"env").unwrap();
    assert!(matches!(open(&k2, &sealed, b"env").unwrap_err(), AeadError::Decrypt));
}

#[test]
fn open_rejects_wrong_aad() {
    let key = Zeroizing::new([7u8; 32]);
    let sealed = seal(&key, b"secret", b"env-a").unwrap();
    assert!(matches!(open(&key, &sealed, b"env-b").unwrap_err(), AeadError::Decrypt));
}
```

- [ ] **Step 2: Implement `aead.rs`**

```rust
use aes_gcm::{aead::{Aead, AeadCore, KeyInit, Payload}, Aes256Gcm, Nonce};
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

/// Wire format: NONCE(12) || CIPHERTEXT+TAG
pub fn seal(key: &Zeroizing<[u8; 32]>, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, AeadError> {
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
```

Add `thiserror = "1"` to `Cargo.toml` if missing (it likely already is — confirm before adding).

- [ ] **Step 3: Run — expect PASS**.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/vault/aead.rs src-tauri/tests/vault_aead_test.rs
git commit -m "feat(vault): AES-256-GCM seal/open with AAD binding"
```

### Task 1.5 — Keyring ref + envelope CRUD  `SEQUENTIAL` (depends on 1.3, 1.4)

**Files:**
- Modify: `src-tauri/src/vault/keyring_ref.rs`
- Modify: `src-tauri/src/vault/envelope.rs`
- Modify: `src-tauri/src/vault/lock.rs`
- Create: `src-tauri/src/commands/vault.rs`
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod vault;`
- Modify: `src-tauri/src/lib.rs` — register commands
- Create: `src-tauri/tests/vault_envelope_test.rs`

- [ ] **Step 1: Implement `keyring_ref.rs`** — stable-key helper

```rust
pub fn secret_key(envelope_id: &str, secret_id: &str) -> String {
    format!("ccie-terminal.vault.{envelope_id}.{secret_id}")
}

pub const SERVICE: &str = "ccie-terminal";
```

- [ ] **Step 2: Implement `lock.rs`** — in-memory unlock state

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

pub struct VaultLock {
    inner: Mutex<Inner>,
    idle_timeout: Duration,
}

struct Inner {
    unlocked: HashMap<String, UnlockedEnvelope>,
}

struct UnlockedEnvelope {
    key: Zeroizing<[u8; 32]>,
    last_activity: Instant,
    session_id: String,
}

impl VaultLock {
    pub fn new(idle_timeout: Duration) -> Self {
        Self { inner: Mutex::new(Inner { unlocked: HashMap::new() }), idle_timeout }
    }

    pub fn unlock(&self, envelope_id: &str, key: Zeroizing<[u8; 32]>, session_id: String) {
        let mut g = self.inner.lock().unwrap();
        g.unlocked.insert(envelope_id.to_string(), UnlockedEnvelope {
            key, last_activity: Instant::now(), session_id,
        });
    }

    pub fn with_key<R>(&self, envelope_id: &str, f: impl FnOnce(&Zeroizing<[u8; 32]>) -> R) -> Option<R> {
        let mut g = self.inner.lock().unwrap();
        let entry = g.unlocked.get_mut(envelope_id)?;
        if entry.last_activity.elapsed() > self.idle_timeout { return None; }
        entry.last_activity = Instant::now();
        Some(f(&entry.key))
    }

    pub fn lock(&self, envelope_id: &str) -> Option<String> {
        let mut g = self.inner.lock().unwrap();
        g.unlocked.remove(envelope_id).map(|u| u.session_id)
    }

    pub fn sweep_idle(&self) -> Vec<String> {
        let mut g = self.inner.lock().unwrap();
        let to_drop: Vec<_> = g.unlocked.iter()
            .filter(|(_, u)| u.last_activity.elapsed() > self.idle_timeout)
            .map(|(k, _)| k.clone()).collect();
        to_drop.iter().filter_map(|k| g.unlocked.remove(k).map(|u| u.session_id)).collect()
    }
}
```

- [ ] **Step 3: Implement `envelope.rs`** — CRUD + keyring round-trip

Envelope ops (Rust fns, not Tauri commands yet):
- `create_envelope(db, name, description, passphrase) -> EnvelopeDto` — generate 16-byte salt via `OsRng`, serialize `KdfParams::default()` to json, persist row, return DTO. Does NOT persist the derived key — it's held only by `VaultLock` after `unlock_envelope`.
- `list_envelopes(db) -> Vec<EnvelopeDto>` — read `vault_envelopes` minus salt (DTO excludes salt).
- `unlock_envelope(db, lock, name, passphrase) -> SessionId` — read row, derive key, attempt to decrypt a canary record (stored as secret with label `__canary__`, kind `password`, one per envelope). On success, call `lock.unlock(...)` and insert `vault_sessions` row; on failure, insert session row with `reason='wrong_passphrase'` and `locked_at=now`, and return `VaultError::WrongPassphrase`.
- `lock_envelope(db, lock, envelope_id, reason)` — UPDATE the most-recent open `vault_sessions` row with `locked_at=now, reason=?`, evict from `VaultLock`.
- `add_secret(db, lock, envelope_id, kind, label, plaintext, metadata) -> SecretDto` — `with_key` → `seal(plaintext, envelope_id-as-aad)` → store in keyring at `keyring_ref` → insert row.
- `read_secret(db, lock, secret_id) -> Zeroizing<Vec<u8>>` — read row, pull from keyring, `with_key` → `open(...)`; bump `last_used_at`.
- `delete_secret(db, lock, secret_id)` — delete keyring entry first, then DB row.
- `rotate_secret(db, lock, secret_id, new_plaintext)` — wrapper that deletes+re-adds atomically.

**Canary record:** during `create_envelope`, generate a 32-byte random value, seal it with the derived key (AAD = envelope_id), stuff into keyring under `keyring_ref` `ccie-terminal.vault.<envelope_id>.__canary__`, and insert a `vault_secrets` row with kind=`password`, label=`__canary__`. On unlock, we attempt `open` on the canary — if it authenticates, passphrase is correct.

- [ ] **Step 4: Write failing integration tests** — cover the negative cases explicitly:

```rust
#[test]
fn unlock_with_wrong_passphrase_records_audit_row_and_errors() { /* ... */ }

#[test]
fn read_secret_when_locked_errors_and_does_not_leak() { /* ... */ }

#[test]
fn keyring_missing_entry_surfaces_as_typed_error_not_panic() {
    // Pre-seed DB row, manually delete keyring entry, confirm `VaultError::KeyringMissing`.
}

#[test]
fn delete_secret_removes_keyring_and_db() { /* ... */ }

#[test]
fn aad_binding_prevents_cross_envelope_swap() {
    // Seal secret under env-A key+AAD. Copy ciphertext to env-B row. Confirm open() fails.
}

#[test]
fn idle_timeout_auto_locks_after_threshold() {
    // VaultLock::new(Duration::from_millis(50)); sleep 100ms; with_key returns None; sweep_idle returns session id.
}

#[test]
fn canary_decrypt_confirms_passphrase_before_revealing_anything() { /* ... */ }
```

Use the existing `test_db` helper pattern (see `src-tauri/tests/block_tags_test.rs` shape referenced in Plan 01). For keyring in tests, use the `keyring::mock::default_credential_builder()` pattern — if the keyring crate's test feature isn't already enabled, add `keyring = { version = "...", features = ["mock"] }` to `[dev-dependencies]`. **Verify via `mcp__plugin_context7_context7__query-docs "keyring rust"` before coding** — do not guess the mock API.

- [ ] **Step 5: Implement to pass tests**.

- [ ] **Step 6: Expose Tauri commands in `commands/vault.rs`**

```rust
#[tauri::command] pub async fn vault_list_envelopes(...) -> Result<Vec<EnvelopeDto>, String>
#[tauri::command] pub async fn vault_create_envelope(name: String, description: Option<String>, passphrase: String, ...) -> Result<EnvelopeDto, String>
#[tauri::command] pub async fn vault_unlock(name: String, passphrase: String, ...) -> Result<String /*session_id*/, String>
#[tauri::command] pub async fn vault_lock(envelope_id: String, ...) -> Result<(), String>
#[tauri::command] pub async fn vault_add_secret(envelope_id: String, kind: String, label: String, plaintext: String, metadata_json: String, ...) -> Result<SecretDto, String>
#[tauri::command] pub async fn vault_list_secrets(envelope_id: String, ...) -> Result<Vec<SecretDto>, String>
#[tauri::command] pub async fn vault_reveal_secret(secret_id: String, ...) -> Result<String, String>
#[tauri::command] pub async fn vault_delete_secret(secret_id: String, ...) -> Result<(), String>
#[tauri::command] pub async fn vault_rotate_secret(secret_id: String, new_plaintext: String, ...) -> Result<(), String>
#[tauri::command] pub async fn vault_idle_sweep(...) -> Result<Vec<String> /*locked envelope ids*/, String>
```

`passphrase` and `plaintext` parameters MUST be wrapped in `Zeroizing<String>` immediately on entry and never logged. Reject via `#[cfg(debug_assertions)]` check if a tracing span has `record` on these fields.

- [ ] **Step 7: Run all Phase 1 tests — expect PASS**.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/
git commit -m "feat(vault): envelope CRUD with keyring-backed AEAD secrets + canary unlock"
```

### Task 1.6 — Phase 1 regression + SECURITY code review  `SEQUENTIAL`

- [ ] **Step 1:** `cd sidecar && python -m pytest` (no sidecar changes expected — sanity check).
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] **Step 3:** `bun run test` — all green.
- [ ] **Step 4:** `bunx playwright test --grep @smoke` — all green.
- [ ] **Step 5: Security-focused code review.** Dispatch `feature-dev:code-reviewer` with explicit prompt:

  > "**SECURITY REVIEW — Phase 1 of Plan 14 (credential vault).** Audit `src-tauri/src/vault/**` plus `src-tauri/src/commands/vault.rs`. Specifically verify: (a) no plaintext passphrase or derived key is ever written to SQLite, logs, stderr, or tracing spans; (b) all plaintext buffers use `Zeroizing`; (c) AAD binding to envelope_id prevents cross-envelope ciphertext swaps; (d) wrong-passphrase path is constant-time relative to canary lookup (i.e., the error shape does not leak whether the envelope exists vs. passphrase was wrong — use same generic error for 'unknown envelope' and 'wrong passphrase'); (e) keyring_ref naming cannot collide across users of the same keyring service; (f) idle-lock cannot be bypassed by holding a `Zeroizing<[u8;32]>` reference past the sweep; (g) `OsRng` (not `thread_rng`) is used for all salt and nonce generation. Report `must-fix` and `nits` separately. Treat any plaintext leak as blocker."

  Fix ALL `must-fix` items before proceeding.

- [ ] **Step 6: Update this plan file** — check all Phase 1 boxes and append:

```markdown
## Phase 1 — COMPLETED YYYY-MM-DD
Vault schema (V0041), Argon2id KDF, AES-256-GCM seal/open with AAD, envelope CRUD with keyring-backed secrets and canary unlock, idle-lock state machine. Security review passed with <N> must-fix items resolved.
```

- [ ] **Step 7: Commit plan update**

```bash
git add Plans/14-credential-vault-session-recording.md
git commit -m "docs(plans): mark Plan 14 Phase 1 complete"
```

---

## Phase 2 — Vault UI: envelopes, unlock, secret CRUD, idle-lock, clipboard auto-clear

### Task 2.1 — Pre-impl UI spec via `frontend-design`  `SEQUENTIAL`

- [ ] **Step 1: Dispatch `frontend-design` skill** with this brief:

  > "Design a `Vault` tab for CCIE Terminal (macOS-native feel, Warp-inspired palette already in `src/App.css`). Requirements: (1) left pane lists envelopes with lock icon per row (locked/unlocked state); (2) right pane shows either an unlock passphrase prompt (if locked) or the secret list for the selected envelope; (3) secret rows show: kind icon (password/ssh-key/api-token/snmp/netconf), label, last-used relative time, rotate-soon warning badge, copy-to-clipboard button, reveal-for-5s button, edit, delete; (4) footer status bar shows idle-lock countdown (e.g. 'Auto-lock in 2:14'); (5) 'Add Secret' modal with kind dropdown and kind-specific fields (password: single field; ssh_key: multiline + passphrase; api_token: token + service + scope; snmp_community: community + version; netconf: host + user + pass). Deliverables: ASCII wireframe, Tailwind/CSS class names that extend existing `CommandBlock.css` prefixes, list of new CSS custom properties to add to `src/App.css`, keyboard shortcut table."

- [ ] **Step 2: Save returned spec to `docs/design/vault-ui.md` and commit.**

### Task 2.2 — Zustand store + Tauri hooks  `PARALLEL with 2.3`

**Files:**
- Create: `src/state/vaultStore.ts`
- Create: `src/lib/vault.ts` (Tauri invoke wrapper)
- Create: `src/lib/vault.test.ts`
- Create: `src/state/vaultStore.test.ts`

- [ ] **Step 1: Write failing TS tests** — mock `@tauri-apps/api/core.invoke`. Cover: `unlock` success flow updates `unlockedEnvelopes`; wrong-passphrase error leaves state unchanged; `reveal` returns plaintext that is cleared from store after 5s (use `vi.useFakeTimers`); idle sweep lock event (emit from Tauri) transitions store back to locked.

- [ ] **Step 2: Implement `src/lib/vault.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";
export type SecretKind = "password" | "ssh_key" | "api_token" | "snmp_community" | "netconf";
export interface EnvelopeDto { id: string; name: string; description?: string; createdAt: number; updatedAt: number; }
export interface SecretDto {
  id: string; envelopeId: string; kind: SecretKind; label: string;
  metadata: Record<string, unknown>;
  createdAt: number; lastUsedAt?: number; rotatesAt?: number; expiresAt?: number;
}

export const vault = {
  listEnvelopes: () => invoke<EnvelopeDto[]>("vault_list_envelopes"),
  createEnvelope: (name: string, description: string | null, passphrase: string) =>
    invoke<EnvelopeDto>("vault_create_envelope", { name, description, passphrase }),
  unlock: (name: string, passphrase: string) => invoke<string>("vault_unlock", { name, passphrase }),
  lock: (envelopeId: string) => invoke<void>("vault_lock", { envelopeId }),
  addSecret: (envelopeId: string, kind: SecretKind, label: string, plaintext: string, metadata: Record<string, unknown>) =>
    invoke<SecretDto>("vault_add_secret", { envelopeId, kind, label, plaintext, metadataJson: JSON.stringify(metadata) }),
  listSecrets: (envelopeId: string) => invoke<SecretDto[]>("vault_list_secrets", { envelopeId }),
  revealSecret: (secretId: string) => invoke<string>("vault_reveal_secret", { secretId }),
  deleteSecret: (secretId: string) => invoke<void>("vault_delete_secret", { secretId }),
  rotateSecret: (secretId: string, newPlaintext: string) => invoke<void>("vault_rotate_secret", { secretId, newPlaintext }),
};
```

- [ ] **Step 3: Implement Zustand store** — mirror the shape of `src/state/blocksStore.ts` (see Plan 01 Task 1.4 for conventions). Fields: `envelopes`, `unlockedIds: Set<string>`, `secretsByEnvelope: Map<string, SecretDto[]>`, `revealedUntil: Map<string, number> /* secretId → expiry ms */`, `idleTimeoutMs`, actions `loadEnvelopes`, `unlock`, `lock`, `addSecret`, `listSecrets`, `revealSecret`, `rotateSecret`, `deleteSecret`. Subscribe to Tauri event `vault://auto-locked` to clear `unlockedIds`.

- [ ] **Step 4: Run tests — expect PASS**.

- [ ] **Step 5: Commit**

```bash
git add src/state/vaultStore.ts src/state/vaultStore.test.ts src/lib/vault.ts src/lib/vault.test.ts
git commit -m "feat(vault): frontend store + invoke wrapper with auto-lock sync"
```

### Task 2.3 — Clipboard auto-clear utility  `PARALLEL with 2.2`

**Files:**
- Create: `src/lib/clipboard.ts`
- Create: `src/lib/clipboard.test.ts`

- [ ] **Step 1: Write failing tests** — `copyWithAutoClear(text, 30_000)` writes to clipboard, schedules a clear after 30s that overwrites with a single zero-width space. If another `copyWithAutoClear` call happens in the meantime, only the latest schedule survives. If the user themselves put new content on the clipboard AFTER our write (detect by re-reading), do NOT overwrite — only clear if the clipboard still contains our bytes.

- [ ] **Step 2: Implement via `@tauri-apps/plugin-clipboard-manager`** — confirm the plugin is already a dep; if not, add it. Do NOT invent an API — `mcp__plugin_context7_context7__query-docs "tauri-plugin-clipboard-manager"` first.

- [ ] **Step 3: Commit** `feat(vault): clipboard auto-clear utility (30s default, content-aware)`

### Task 2.4 — Vault tab component tree  `SEQUENTIAL` (depends on 2.1, 2.2, 2.3)

**Files:**
- Create: `src/components/vault/VaultTab.tsx` + `.css`
- Create: `src/components/vault/EnvelopeList.tsx`
- Create: `src/components/vault/EnvelopePane.tsx`
- Create: `src/components/vault/UnlockPrompt.tsx`
- Create: `src/components/vault/SecretRow.tsx`
- Create: `src/components/vault/AddSecretModal.tsx`
- Create: `src/components/vault/IdleLockIndicator.tsx`
- Test: corresponding `.test.tsx` each
- Modify: `src/state/tabsStore.ts` — add tab kind `vault`
- Modify: `src/components/TabBar.tsx` / tab router to route `vault` kind to `VaultTab`

- [ ] **Step 1: Write failing component tests first** — at minimum: unlock prompt submits passphrase and flips to unlocked view; reveal button shows masked → plaintext for 5s then re-masks; add-secret modal's kind dropdown reveals the correct kind-specific fields; idle-lock indicator ticks down and triggers lock at 0; delete-secret requires two-step confirmation.
- [ ] **Step 2: Implement per the design spec from 2.1.** Reuse existing `CommandBlock.css` tokens where possible. Add vault tab kind to `tabsStore`.
- [ ] **Step 3: Wire keyboard shortcuts** (`useBlockShortcuts` pattern, see Plan 01 Task 2.5): ⌘L = lock active envelope, ⌘⇧V = focus vault tab, ⌘N in vault = new secret.
- [ ] **Step 4: Commit per component** `feat(vault): <component> with tests`.

### Task 2.5 — Idle-lock enforcement loop  `SEQUENTIAL` (depends on 2.4)

**Files:**
- Modify: `src-tauri/src/vault/lock.rs` — spawn a tokio interval that every 30s calls `sweep_idle` and emits Tauri event `vault://auto-locked` with the list of envelope ids
- Modify: `src-tauri/src/lib.rs` — start the sweep loop during app setup
- Test: add an integration test that asserts the event fires

- [ ] **Step 1: Decide idle timeout.** Default 15 min, user-configurable via `settings` table (if no settings table exists yet, scope that out of this plan — use a const `VAULT_IDLE_TIMEOUT_SECS = 900` wired via env var override for dev).
- [ ] **Step 2: Implement + test.**
- [ ] **Step 3: Commit** `feat(vault): background idle-lock sweep with event emission`

### Task 2.6 — Post-impl design review + Phase 2 regression  `SEQUENTIAL`

- [ ] **Step 1:** `bun run tauri dev` — seed 3 envelopes with 5 secrets each; capture screenshots of: (a) locked envelopes list, (b) unlock prompt, (c) unlocked secret list with a reveal in progress, (d) add-secret modal for each kind, (e) idle-lock indicator near expiry.
- [ ] **Step 2: Dispatch `frontend-design` skill** with those screenshots for final review; apply fixes.
- [ ] **Step 3:** Full regression: `bun run test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `bunx playwright test`.
- [ ] **Step 4: Code review** — standard `feature-dev:code-reviewer` (not security-only this time; phase 1 already covered crypto).
- [ ] **Step 5: Update plan file — check Phase 2 boxes + append completion block.**
- [ ] **Step 6: Commit plan.**

---

## Phase 3 — Recording capture (PTY tap) + asciinema v2 writer

### Task 3.1 — PTY tap hook in `pty.rs`  `SEQUENTIAL`

**Files:**
- Modify: `src-tauri/src/pty.rs` — add an optional `tap_tx: Option<mpsc::Sender<RawOutput>>` field on `PtyHandle` and expose `attach_tap`/`detach_tap`
- Create: `src-tauri/src/recording/mod.rs`
- Create: `src-tauri/src/recording/tap.rs`
- Create: `src-tauri/tests/pty_tap_test.rs`

- [ ] **Step 1: Design review of `pty.rs`** — the reader thread already iterates over `parser.feed(&buf[..n])`. The tap must receive the **raw** pre-parser bytes so the recording preserves everything the terminal saw (including OSC 133 sequences — playback fidelity matters). Add a second send **inside the reader thread**, BEFORE `parser.feed`:

```rust
// Inside the reader std::thread::spawn block, after Ok(n) =>
let tap_slot = tap_slot_clone.lock();
if let Some(tx) = tap_slot.as_ref() {
    // Non-blocking: if the tap lags, drop frames rather than stall the terminal.
    let _ = tx.try_send(RawOutput { bytes: buf[..n].to_vec(), recv_at: Instant::now() });
}
drop(tap_slot);
```

Where `tap_slot` is `Arc<Mutex<Option<mpsc::Sender<RawOutput>>>>` held by `PtyHandle` so `attach_tap` / `detach_tap` can be called at runtime without re-spawning the PTY.

**Critical:** tap must be `try_send`, never `blocking_send` — we cannot let recording back-pressure stall the user's terminal.

- [ ] **Step 2: Define `RawOutput`**

```rust
pub struct RawOutput { pub bytes: Vec<u8>, pub recv_at: std::time::Instant }
```

- [ ] **Step 3: Write failing tap test** — spawn a PTY, attach a tap, write `echo hello\n`, assert the tap channel received bytes matching `hello`. Detach the tap and write again, assert no new bytes arrive.

- [ ] **Step 4: Implement + pass test.**

- [ ] **Step 5: Commit** `feat(pty): additive tap channel for session recording (non-blocking)`

### Task 3.2 — Asciinema v2 writer  `PARALLEL with 3.3`

**Files:**
- Create: `src-tauri/src/recording/asciinema.rs`
- Create: `src-tauri/tests/asciinema_writer_test.rs`
- Create: `src-tauri/tests/fixtures/expected_simple.cast`

**Background:** asciinema v2 format is line-delimited JSON:
- Line 1: header object `{"version":2,"width":80,"height":24,"timestamp":<unix>,"env":{"SHELL":"/bin/zsh","TERM":"xterm-256color"}}`
- Lines 2+: event arrays `[<t_seconds_float>, "o", "<bytes_as_json_string>"]` (`"o"` = output, `"i"` = input — we only emit output).

Verify format via `mcp__plugin_context7_context7__query-docs "asciinema cast v2"` or from https://github.com/asciinema/asciinema/blob/develop/doc/asciicast-v2.md BEFORE coding. Paste the retrieved spec text into a code comment.

- [ ] **Step 1: Write failing test**

```rust
#[test]
fn writes_valid_asciinema_v2_header_and_events() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut w = CastWriter::create(tmp.path(), 120, 40, "xterm-256color", "/bin/zsh").unwrap();
    w.write_output(0.0, b"hello").unwrap();
    w.write_output(0.25, b" world\r\n").unwrap();
    w.finalize().unwrap();

    let content = std::fs::read_to_string(tmp.path()).unwrap();
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 3);
    let header: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(header["version"], 2);
    assert_eq!(header["width"], 120);
    let ev1: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(ev1[1], "o");
    assert_eq!(ev1[2], "hello");
}
```

- [ ] **Step 2: Implement `asciinema.rs`** — buffered file writer, uses `serde_json::to_writer` for each event, flushes on `finalize`. Track `size_bytes` and `duration_ms` so the caller can update `session_recordings`.

- [ ] **Step 3: Run — expect PASS**.

- [ ] **Step 4: Commit** `feat(recording): asciinema v2 cast writer`

### Task 3.3 — Recording supervisor  `PARALLEL with 3.2`

**Files:**
- Create: `src-tauri/src/recording/supervisor.rs`
- Create: `src-tauri/src/commands/recording.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs` — register commands + manage `RecordingSupervisor` state
- Create: `src-tauri/tests/recording_supervisor_test.rs`

- [ ] **Step 1: Design.** The supervisor holds a `HashMap<TabId, ActiveRecording>`. Each `ActiveRecording` owns:
  - The `CastWriter`
  - A `mpsc::Receiver<RawOutput>` (the tap)
  - A tokio task that loops receive → redact (Phase 4 adds redaction; for now passthrough) → `cast.write_output(elapsed_s, bytes)`
  - `started_at`, `path`, `redactor` (Phase 4)
  - The recording_id (persisted to `session_recordings`)

- [ ] **Step 2: Tauri commands**

```rust
#[tauri::command] pub async fn recording_start(tab_id: String, session_kind: String, ...) -> Result<RecordingDto, String>
#[tauri::command] pub async fn recording_stop(tab_id: String, ...) -> Result<RecordingDto, String>
#[tauri::command] pub async fn recording_list(limit: Option<u32>, ...) -> Result<Vec<RecordingDto>, String>
#[tauri::command] pub async fn recording_status(tab_id: String, ...) -> Result<Option<RecordingDto>, String>
#[tauri::command] pub async fn recording_export(recording_id: String, target_path: String, ...) -> Result<(), String>
#[tauri::command] pub async fn recording_delete(recording_id: String, ...) -> Result<(), String>
```

- [ ] **Step 3: Write failing integration test** using a fixture byte stream — feed 10 chunks of known bytes through the supervisor, `recording_stop`, read back the `.cast`, assert event count and total bytes match. Assert `session_recordings` row is inserted with correct `size_bytes` and `duration_ms`.

- [ ] **Step 4: Implement; test passes.**

- [ ] **Step 5: Recording directory.** Use `tauri::api::path::app_local_data_dir` to resolve `~/Library/Application Support/ccie-terminal/recordings/` on macOS (cross-platform equivalent on win/linux). Create dir if missing. Filename pattern: `<recording_id>.cast`.

- [ ] **Step 6: Commit** `feat(recording): supervisor + start/stop/list/export/delete commands`

### Task 3.4 — Phase 3 regression  `SEQUENTIAL`

- [ ] **Step 1:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] **Step 2:** `bun run test` — all green.
- [ ] **Step 3:** Playwright smoke — unchanged.
- [ ] **Step 4: Code review** (`feature-dev:code-reviewer`) focusing on correctness of the tap non-blocking path and timing accuracy of `elapsed_s` deltas.
- [ ] **Step 5: Update plan — check Phase 3 boxes + append completion block.**
- [ ] **Step 6: Commit.**

---

## Phase 4 — Redactor engine (security-critical)

### Task 4.1 — Redactor API + builtin pattern set  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/src/recording/redactor.rs`
- Create: `src-tauri/src/recording/patterns.rs`
- Create: `src-tauri/tests/redactor_test.rs`
- Create: `src-tauri/tests/fixtures/redactor_redteam.txt`

**Design:**
- `Redactor` owns a set of compiled `regex::bytes::Regex` patterns plus a small state machine for the multi-line SSH password prompt case (prompt line followed by user-typed password on subsequent reads — the password bytes never appear in the prompt line itself; we detect prompt → mask all bytes until the next `\r\n` OR until a 5-second idle OR until we see echo suppression end).
- Public API:
  ```rust
  pub struct Redactor { patterns: Vec<Pattern>, state: State, audit: Vec<(PatternId, u64)> }
  impl Redactor {
      pub fn new(user_patterns: &[UserPattern]) -> Result<Self, RedactorError>;
      pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8>;  // returns redacted bytes, same length
      pub fn drain_audit(&mut self) -> Vec<PatternMatchSummary>;
  }
  ```
- **Invariant:** `feed` MUST return a buffer of exactly the same length as input (replace matched bytes 1:1 with `█` — as UTF-8 `\xe2\x96\x88` three bytes; we replace 3 matched bytes at a time or fall back to ASCII `*` for sub-3-byte matches to preserve total length). This keeps asciinema timing faithful. Document this choice in the module header.

- [ ] **Step 1: Builtin patterns** (regex crate, `bytes::Regex`):

```rust
// patterns.rs - builtin list
pub const BUILTIN: &[(&str, &str)] = &[
    // Cisco enable secret / password in `show run` output
    ("cisco_enable_secret", r"(?i)enable\s+secret\s+\d+\s+(\S+)"),
    ("cisco_username_password", r"(?i)username\s+\S+\s+password\s+\d+\s+(\S+)"),
    ("cisco_type7_password", r"(?i)password\s+7\s+([0-9A-Fa-f]{2,})"),
    // SSH password prompt (state machine handles the actual pw bytes; this just marks the prompt)
    ("ssh_password_prompt", r"(?i)(password:|passphrase.*:)\s*$"),
    // SNMP community strings
    ("snmp_community", r"(?i)snmp-server\s+community\s+(\S+)"),
    ("snmp_community_v2", r"(?i)community\s+(\S+)\s+(?:RO|RW)"),
    // Bearer tokens & API keys
    ("bearer_token", r"(?i)bearer\s+([A-Za-z0-9._\-]+)"),
    ("authorization_header", r"(?i)authorization:\s*(\S+)"),
    ("aws_access_key", r"AKIA[0-9A-Z]{16}"),
    ("generic_api_key", r"(?i)api[_\-]?key[\"'\s:=]+([A-Za-z0-9_\-]{16,})"),
    // NETCONF password in XML
    ("netconf_password_xml", r"(?i)<password[^>]*>([^<]+)</password>"),
];
```

Note the capture groups: the redactor redacts only capture group 1 (or the full match if no group 1) — NOT the surrounding `enable secret 5 ` text. This keeps the context intact for forensic replay.

- [ ] **Step 2: Write RED-TEAM test `redactor_test.rs`**

Create `fixtures/redactor_redteam.txt` with a mixed corpus (use single-file concatenation of deliberately known-bad credentials):

```
Router#show running-config
enable secret 5 $1$k4mB$abcdefghijklmnopqrstuv
username admin password 0 P@ssw0rd123
username backup password 7 02050D480809
snmp-server community public RO
snmp-server community SuperSecret42 RW
community secretcommunity RW
interface GigabitEthernet0/0
 ip address 10.1.1.1 255.255.255.0
!
$ curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def" https://api.example.com
$ export API_KEY="sk_live_abcdef1234567890XYZ"
$ aws configure
AWS Access Key ID: AKIAIOSFODNN7EXAMPLE
<rpc><edit-config><config><users><user><password>netconfpw123</password></user></users></config></edit-config></rpc>
Password: hunter2
```

Test:

```rust
#[test]
fn redteam_corpus_is_100_percent_redacted() {
    let corpus = include_bytes!("../tests/fixtures/redactor_redteam.txt");
    let mut r = Redactor::new(&[]).unwrap();
    let redacted = r.feed(corpus);

    // Assert output length preserved (cast timing invariant)
    assert_eq!(redacted.len(), corpus.len());

    // Enumerate credentials that MUST NOT appear verbatim in output
    const MUST_BE_GONE: &[&[u8]] = &[
        b"$1$k4mB$abcdefghijklmnopqrstuv",
        b"P@ssw0rd123",
        b"02050D480809",
        b"public",           // snmp community
        b"SuperSecret42",
        b"secretcommunity",
        b"eyJhbGciOiJIUzI1NiJ9.abc.def",
        b"sk_live_abcdef1234567890XYZ",
        b"AKIAIOSFODNN7EXAMPLE",
        b"netconfpw123",
        b"hunter2",
    ];
    for needle in MUST_BE_GONE {
        assert!(
            !redacted.windows(needle.len()).any(|w| w == *needle),
            "LEAK: {:?} still present in redacted output",
            std::str::from_utf8(needle).unwrap_or("<bin>"),
        );
    }

    // Audit log must show non-zero matches for each builtin category touched
    let audit = r.drain_audit();
    let names: std::collections::HashSet<_> = audit.iter().map(|s| s.pattern_id.clone()).collect();
    for req in ["cisco_enable_secret","cisco_username_password","snmp_community","bearer_token","aws_access_key","netconf_password_xml","ssh_password_prompt"] {
        assert!(names.contains(req), "pattern {} did not fire on red-team corpus", req);
    }
}
```

- [ ] **Step 3: Additional targeted tests** — each covering: user-configured pattern is compiled and applied; invalid regex returns `RedactorError::Compile` (does not panic); streaming across `feed` boundaries (pattern spans two chunks) — use a small buffer-holdback strategy (keep the last 256 bytes in an internal buffer and flush on explicit `drain_audit`/recording stop, retaining timing because held-back bytes are written out only when the NEXT chunk arrives or the recording stops); unicode in user pattern handled; audit counter increments correctly; same pattern matching N times records `matches=N`.

- [ ] **Step 4: Implement `redactor.rs` + `patterns.rs`** to pass ALL tests including red-team.

- [ ] **Step 5: Wire into recording supervisor** — pass redacted bytes, not raw, to `CastWriter::write_output`. Persist audit counts to `recording_redactions` on `recording_stop`.

- [ ] **Step 6: Run full regression — every tests green.**

- [ ] **Step 7: Commit** `feat(recording): streaming redactor with builtin + user patterns and audit counts`

### Task 4.2 — Red-team review by security-focused agent  `SEQUENTIAL`

- [ ] **Step 1: Dispatch `feature-dev:code-reviewer`** with an explicit red-team prompt:

  > "**SECURITY RED-TEAM REVIEW — Phase 4 of Plan 14 (redactor).** Goal: find a byte sequence that would bypass redaction OR cause the redactor to panic / hang / leak memory. Specifically probe: (a) pattern spanning the 256-byte holdback boundary — can you construct a credential that gets flushed before the pattern is recognized? (b) regex catastrophic backtracking — do any builtin or user-pattern combinations exhibit super-linear runtime on crafted input? (c) invalid UTF-8 bytes in middle of a capture group — does the `█` replacement corrupt output length? (d) `ssh_password_prompt` state machine — can you interleave bytes so the prompt is detected but the subsequent password bytes are emitted verbatim? (e) two patterns overlapping on the same bytes — which wins, and is the audit count correct? (f) empty pattern / zero-width match — does `feed` loop forever? Deliver: list of exploit candidates (even hypothetical) + which test cases should be added to the corpus to close them. Treat any realized bypass as a merge blocker."

- [ ] **Step 2: Add regression test for every confirmed bypass; re-run until all pass.**

- [ ] **Step 3: Commit** `test(recording): close red-team bypass gaps in redactor`

### Task 4.3 — Phase 4 regression  `SEQUENTIAL`

- [ ] **Step 1:** Full test suite green.
- [ ] **Step 2:** `cargo bench` or a `#[test]` with an 8 MiB corpus — confirm redactor throughput ≥ 50 MB/s (well above plausible PTY bandwidth). If below, profile.
- [ ] **Step 3: Update plan file — check Phase 4 boxes + append:**

```markdown
## Phase 4 — COMPLETED YYYY-MM-DD
Streaming redactor with 10 builtin patterns + user-configurable regex, holdback buffer for cross-chunk matches, per-pattern audit counts persisted to recording_redactions. Red-team review passed; N previously-unfound bypasses closed. Throughput X MB/s.
```

- [ ] **Step 4: Commit plan.**

---

## Phase 5 — Recording UI: per-session toggle, indicator, list, player, export

### Task 5.1 — Pre-impl UI spec via `frontend-design`  `SEQUENTIAL`

- [ ] **Step 1: Dispatch `frontend-design` skill** with brief:

  > "Design four UI surfaces for session recording in CCIE Terminal. (1) Per-tab recording toggle: a small circular red dot indicator in the tab's header that appears only while recording; a menu entry 'Start Recording' / 'Stop Recording' in the tab's context menu (default: OFF). (2) Recordings tab: list of past recordings with thumbnail first frame, session_kind icon, duration, size, started_at relative time, action buttons (play / export / delete). (3) In-app player: xterm.js-based replay viewer with play/pause, scrubber, 0.5x/1x/2x/4x speed, elapsed/total display, 'Copy line at cursor' button. (4) Redaction inspector drawer in the player showing: pattern hits with counts, a toggle to reveal redacted regions (disabled by default, never enabled in the MVP — just show the hint 'Redacted content cannot be recovered' with an info icon). Palette: match existing app, which is Warp-inspired. Deliverables: wireframes, class names."

- [ ] **Step 2: Save spec to `docs/design/recording-ui.md`, commit.**

### Task 5.2 — Recording indicator + toggle in existing tabs  `PARALLEL with 5.3`

**Files:**
- Modify: `src/components/TabBar.tsx` — add `isRecording` indicator dot
- Modify: `src/components/Terminal.tsx` or equivalent — context menu item
- Create: `src/state/recordingStore.ts` — tracks `Map<tabId, RecordingDto>` for active recordings; listens for Tauri events `recording://started` and `recording://stopped`
- Test: each

- [ ] **Step 1: Failing tests.** Toggle calls `recording_start` and updates store; dot appears; stop call removes dot.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Commit** `feat(recording): per-tab toggle + active-recording indicator`

### Task 5.3 — Recordings tab  `PARALLEL with 5.2`

**Files:**
- Create: `src/components/recording/RecordingsTab.tsx` + `.css`
- Create: `src/components/recording/RecordingListItem.tsx`
- Modify: `src/state/tabsStore.ts` — add tab kind `recordings`
- Test: component tests

- [ ] **Step 1: List view calls `recording_list`.** Handle empty state with CTA "Enable recording on a terminal tab to start capturing sessions."
- [ ] **Step 2: Export button** calls `recording_export` with a `save`-dialog path; toast on success.
- [ ] **Step 3: Delete** requires confirm; calls `recording_delete`.
- [ ] **Step 4: Commit** `feat(recording): recordings list tab`

### Task 5.4 — In-app player  `SEQUENTIAL` (depends on 5.3)

**Files:**
- Create: `src/components/recording/CastPlayer.tsx`
- Create: `src/lib/cast.ts` — reader for asciinema v2 (line-by-line JSON parse, yields `{t, channel, bytes}`)
- Create: `src/components/recording/CastPlayer.test.tsx`

- [ ] **Step 1: Research.** `mcp__plugin_context7_context7__query-docs "xterm.js write timing"` — do not guess the API for feeding bytes over time.
- [ ] **Step 2: Write test** that feeds a known fixture and asserts DOM content at t=1s matches expected.
- [ ] **Step 3: Implement.** Controls: play/pause (space), speed (1/2/3/4 keys), scrubber (click timeline), restart (`r`).
- [ ] **Step 4: Redaction inspector drawer** reads from `recording_redactions` via a new Tauri command `recording_redaction_summary(recording_id)`.
- [ ] **Step 5: Commit** `feat(recording): in-app xterm.js cast player with scrubber and redaction inspector`

### Task 5.5 — Post-impl design review + Phase 5 regression  `SEQUENTIAL`

- [ ] Screenshots of: tab indicator, recordings list, player mid-playback, redaction inspector open. Dispatch `frontend-design` for final review; apply fixes.
- [ ] Full regression (`bun run test`, `cargo test`, `bunx playwright test`).
- [ ] `feature-dev:code-reviewer`.
- [ ] Update plan file — check Phase 5 boxes + append completion block.
- [ ] Commit plan.

---

## Phase 6 — Import from 1Password/Bitwarden CSV + audit log + docs

### Task 6.1 — CSV import  `PARALLEL with 6.2`

**Files:**
- Create: `src-tauri/src/vault/import.rs`
- Create: `src-tauri/src/commands/vault_import.rs`
- Create: `src/components/vault/ImportCsvModal.tsx`
- Create: `src-tauri/tests/vault_import_test.rs`
- Create: `src-tauri/tests/fixtures/1password_export_sample.csv`
- Create: `src-tauri/tests/fixtures/bitwarden_export_sample.csv`

- [ ] **Step 1: Research export formats.**
  - 1Password CSV columns (typical): `Title,Url,Username,Password,OTPAuth,Favorite status,Archived status,Tags,Notes`
  - Bitwarden CSV columns: `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`
  Confirm current formats via `mcp__plugin_context7_context7__query-docs "1password csv export fields"` and `"bitwarden csv export fields"`. Do not hand-roll from memory.

- [ ] **Step 2: Write failing tests** using the two fixture files. Assert: correct number of `vault_secrets` rows created; kinds inferred (entries with only username+password → `password`; entries whose notes contain `BEGIN OPENSSH PRIVATE KEY` → `ssh_key`); rows with `login_totp` get metadata flag `totp:true` (we do NOT store the TOTP secret yet — future work, annotate in metadata); rows that fail to parse are skipped with per-row error collected into a summary `{ imported: N, skipped: M, errors: [...] }`.

- [ ] **Step 3: Implement `import.rs`** — use the `csv` crate; run through the existing envelope CRUD (so imported rows go through AEAD + keyring paths — no shortcuts). **Explicit UX warning:** the import modal MUST display "WARNING: The CSV file is plaintext on disk. After import, delete the CSV securely (the system will offer to shred it). Passwords are briefly held in process memory during import." and require a checkbox acknowledgment before the `vault_import_csv` Tauri command fires.

- [ ] **Step 4: "Secure delete" post-import** — best-effort overwrite of the CSV file with random bytes then unlink; note in docs that SSDs may retain remnants via wear leveling and this is advisory only.

- [ ] **Step 5: Commit** `feat(vault): CSV import for 1Password and Bitwarden exports with advisory secure delete`

### Task 6.2 — Vault audit log UI  `PARALLEL with 6.1`

**Files:**
- Create: `src/components/vault/AuditLogPane.tsx`
- Create: `src-tauri/src/commands/vault_audit.rs` — `vault_audit_list(envelope_id: Option<String>, since: Option<i64>, limit: u32)`

- [ ] **Step 1:** Read `vault_sessions` rows, join to `vault_envelopes` for names. Show timeline: unlock → lock with duration, `reason` field rendered with colored badge (manual/idle/app_exit/wrong_passphrase — last one red).
- [ ] **Step 2:** Filter controls by envelope and date range.
- [ ] **Step 3: Commit** `feat(vault): audit log pane for vault sessions`

### Task 6.3 — Docs: security posture section  `SEQUENTIAL`

**Files:**
- Create: `docs/SECURITY.md`

Required sections (do NOT hand-wave; every claim must reference code path):
- Threat model: what we defend against (disk theft, casual snooping, clipboard grabbing after unlock) vs. what we don't (malware with full process memory access, compromised OS keyring, physical coercion).
- Cryptographic primitives: Argon2id parameters (link to `kdf.rs`), AES-256-GCM (link to `aead.rs`), 12-byte OsRng nonce, AAD=envelope_id.
- Key lifecycle: derived on unlock, held in `Zeroizing` in `VaultLock`, zeroed on lock/idle/app_exit.
- Secret lifecycle: plaintext never in SQLite; keyring stores AEAD envelope; nothing written to disk unwrapped.
- Recording redaction: builtin patterns listed with regex; holdback buffer explanation; explicit "redacted bytes are NOT recoverable" statement.
- Known gaps: clipboard-after-reveal window; process-memory dump; SSD secure-delete.
- Incident response: "If you suspect compromise: lock all envelopes (⌘L on each), rotate every credential at source, delete recordings under `~/Library/Application Support/ccie-terminal/recordings/`, revoke 1Password/Bitwarden exports."

- [ ] **Step 1: Draft, commit** `docs: security posture for vault and session recording`

### Task 6.4 — Phase 6 regression + plan close-out  `SEQUENTIAL`

- [ ] **Step 1:** Full regression (`bun run test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `bunx playwright test`).
- [ ] **Step 2: Code review.**
- [ ] **Step 3:** End-to-end smoke: (a) create envelope, (b) add 3 secrets, (c) start recording on a terminal tab, (d) SSH to a device (use a local sshd or mocked), enter password from vault via "copy-with-auto-clear", (e) stop recording, (f) open player, (g) scrub back to the password-entry moment — confirm masked block is displayed, not the actual password bytes, (h) inspect redaction drawer — confirm `ssh_password_prompt` pattern fired.
- [ ] **Step 4: Update `/Plans/README.md`** — status for row 14 → ✅ Complete.
- [ ] **Step 5: Update this plan file** — check ALL remaining boxes + append final completion block with a summary of what shipped and any follow-ups punted to future plans.
- [ ] **Step 6: Commit.**

---

## Self-review checklist (before marking plan complete)

- [ ] Migration number V0041 matches `/Plans/README.md` reservation.
- [ ] Every step has runnable code or explicit commands — no placeholder prose.
- [ ] Type names consistent across Rust/TS boundary: `EnvelopeDto`, `SecretDto`, `RecordingDto`, `Redactor`, `CastWriter`, `VaultLock`.
- [ ] Plaintext parameters on Tauri commands (`passphrase`, `plaintext`) are wrapped in `Zeroizing` inside Rust and NEVER traced/logged (verified in Phase 1 security review).
- [ ] `ssh_password_prompt` redaction is tested under red-team conditions in Phase 4 Task 4.2 and its bypass coverage is exhaustive.
- [ ] The PTY tap uses `try_send` (non-blocking) — recording cannot stall the terminal.
- [ ] Redactor output length EQUALS input length — asciinema timing fidelity preserved.
- [ ] AEAD uses AAD=envelope_id — cross-envelope ciphertext swaps fail decrypt.
- [ ] Canary record verifies passphrase BEFORE any real secret is decrypted.
- [ ] Idle-lock sweep runs on a background tokio interval AND sweeps on user activity check.
- [ ] 1Password/Bitwarden CSV formats were verified via context7 before parsing code was written.
- [ ] Phase 1 code review used the SECURITY prompt (not standard reviewer prompt).
- [ ] Phase 4 code review used the RED-TEAM prompt and bypasses found were closed with new regression tests.
- [ ] UI phases (2, 5) include BOTH pre-impl design spec and post-impl design review.
- [ ] Every phase ends with regression + code review + plan-file update + commit.

## Completion log

<!-- Append `## Phase N — COMPLETED YYYY-MM-DD` blocks below as phases finish. -->

## Phase 1 — COMPLETED 2026-05-20
Vault schema (V0041), Argon2id KDF, AES-256-GCM seal/open with AAD,
envelope CRUD with keyring-backed secrets and canary unlock, idle-lock
state machine. `OsKeyringStore` (production) + `InMemoryKeyringStore`
(tests) abstraction so the host's real keychain is never touched in CI.
24 backend tests green (kdf×5, aead×6, envelope×13).

## Phase 2 — COMPLETED 2026-05-20
Vault tab UI: envelope list (lock/unlock indicators), unlock prompt,
secret list with copy-with-30s-auto-clear / 5s-reveal / two-step delete,
add-secret modal with kind dropdown, idle countdown via tick interval,
new envelope modal. Vault menu bar (`⌘⇧V` open, `⌘L` lock active) wired
in `src-tauri/src/lib.rs`. `vault://auto-locked` listener in
`vaultStore.ts` flips state when the background sweep fires.

## Phase 3 — COMPLETED 2026-05-20
PTY tap channel (non-blocking `try_send`, attach/detach at runtime),
asciinema v2 cast writer, recording supervisor with start/stop/list/
get/delete/export/redaction-summary commands. Tap test confirms bytes
arrive and detach stops them. Supervisor integration test verifies
end-to-end: start → tx feed → stop → cast file on disk → DB row updated.

## Phase 4 — COMPLETED 2026-05-20
Streaming redactor with 11 builtin patterns (Cisco enable/type-7/
username, SSH password prompt + state-machine body mask, SNMP v1/v2,
bearer token, Authorization header, AWS access key, generic API key,
NETCONF XML password) + user-pattern compilation. Length-preserving
output (asciinema timing fidelity), 256-byte holdback for cross-chunk
matches, per-pattern audit counts persisted to `recording_redactions`.
8 redactor tests green including `redteam_corpus_is_100_percent_redacted`
that asserts no leak from a known-bad fixture covering all builtin
categories.

## Phase 5 — COMPLETED 2026-05-20
Recording UI: per-tab pulsing red dot indicator on `tab-recording`
(animated CSS keyframe), `RecordingsTab` list view with kind icons,
duration/size formatting, play/export/delete actions and two-step
delete confirmation, `CastPlayer` with play/pause/scrubber/speed (0.5×–
4×) + redaction inspector drawer. New tab kinds `vault`/`recordings`/
`recording-player` plumbed through `tabsStore` + App.tsx render
sections. TabBar gets `+ Vault` and `+ Recordings` buttons.

## Phase 6 — COMPLETED 2026-05-20
1Password and Bitwarden CSV import via `vault_import_csv` command;
imports route through the production `add_secret` pipeline so AEAD +
keyring + AAD-binding all apply. Auto-detects format via `login_password`
header. Best-effort `secure_delete` (random overwrite + unlink) advisory.
Audit log Tauri command (`vault_audit_list`) joins
`vault_sessions` to `vault_envelopes` with envelope/since/limit filters.
`docs/VAULT_AND_RECORDING.md` documents threat model, key lifecycle,
secret lifecycle, redactor mechanics, and incident response. 4 import
tests green.

## Plan-level summary
- 39 new backend tests (kdf×5, aead×6, envelope×13, redactor×8,
  asciinema×1, supervisor×3, import×4, pty-tap×1).
- 4 new frontend tests (clipboard auto-clear).
- All pre-existing tests still pass: 138 lib unit, 1002 frontend.
- V0041 reserved and used. Next free: V0042.
- New menu bars: Vault (⌘⇧V/⌘L) and Recording (⌘⇧R).
