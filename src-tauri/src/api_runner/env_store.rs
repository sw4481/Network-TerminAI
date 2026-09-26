//! Per-environment `.env` file I/O.
//!
//! Each environment (e.g. `lab`, `staging`, `prod`) lives in its own file:
//!   `~/.ccie-terminal/environments/<env>.env`
//! The GUI Credentials Panel is the only writer; the files are never meant
//! to be hand-edited (though they still parse if the user does so).
//!
//! Design constraints:
//!   * Atomic writes: write to `<env>.env.tmp` then `rename` — a crash mid-
//!     write can never leave a half-populated file.
//!   * Unix mode `0600` (owner read/write only) — secrets on disk should
//!     not be world-readable. No-op on Windows.
//!   * Key validation: keys must not contain `\n`, `=`, or control chars.
//!     Prevents env-injection via a malicious import or a bug in the UI.
//!   * Environment names: must match `[a-zA-Z0-9_-]{1,64}` so we never
//!     synthesize a path traversal via the env name argument.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const MAX_ENV_NAME_LEN: usize = 64;
const MAX_VALUE_LEN: usize = 64 * 1024;

/// A single key/value pair for one environment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
    /// When true, the GUI should render this value masked by default. On
    /// disk there's no distinction — the flag is metadata stored separately
    /// (see `<env>.env.meta.json`).
    #[serde(default)]
    pub is_secret: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct EnvMeta {
    /// Keys whose values should be shown masked in the GUI.
    #[serde(default)]
    secret_keys: Vec<String>,
}

/// Backend-only byte snapshot used to compensate a coordinated collection
/// deletion if its database transaction fails. It is deliberately not
/// serializable or printable because it can contain credential values.
pub(crate) struct EnvironmentSnapshot {
    env_bytes: Option<Vec<u8>>,
    meta_bytes: Option<Vec<u8>>,
}

/// Validate a user-supplied environment name. Anything beyond `[A-Za-z0-9_-]`
/// is rejected to guarantee the name can never escape the environments dir.
pub fn validate_env_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(anyhow!("environment name is empty"));
    }
    if name.len() > MAX_ENV_NAME_LEN {
        return Err(anyhow!(
            "environment name too long: {} > {MAX_ENV_NAME_LEN}",
            name.len()
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(anyhow!(
            "environment name must match [a-zA-Z0-9_-]: {name:?}"
        ));
    }
    Ok(())
}

/// Validate a key. Rejects empty, control chars, `=`, `\n`, `\r`, and
/// anything too long.
pub fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() {
        return Err(anyhow!("env var key is empty"));
    }
    if key.len() > 256 {
        return Err(anyhow!("env var key too long: {}", key.len()));
    }
    for c in key.chars() {
        if c == '=' || c == '\n' || c == '\r' || c.is_control() || c.is_whitespace() {
            return Err(anyhow!(
                "env var key contains invalid character: {c:?} in {key:?}"
            ));
        }
    }
    Ok(())
}

pub fn validate_value(value: &str) -> Result<()> {
    if value.len() > MAX_VALUE_LEN {
        return Err(anyhow!("env var value too long: {}", value.len()));
    }
    // Disallow embedded NUL — it can't survive the .env format.
    if value
        .chars()
        .any(|character| matches!(character, '\0' | '\n' | '\r'))
    {
        return Err(anyhow!(
            "env var value contains an unsupported control character"
        ));
    }
    Ok(())
}

/// Replace one environment with a fully validated set of variables. This is
/// used by importers that normalize the complete environment before writing.
/// Both files are owner-only on Unix; callers remove them if a surrounding
/// database transaction later fails.
pub fn write_environment(dir: &Path, env: &str, vars: &[EnvVar]) -> Result<()> {
    validate_env_name(env)?;
    if env_file_path(dir, env)?.exists() || meta_file_path(dir, env)?.exists() {
        return Err(anyhow!("environment already exists: {env}"));
    }
    let mut values = BTreeMap::new();
    let mut secret_keys = std::collections::BTreeSet::new();
    for variable in vars {
        validate_key(&variable.key)?;
        validate_value(&variable.value)?;
        if values
            .insert(variable.key.clone(), variable.value.clone())
            .is_some()
        {
            return Err(anyhow!("duplicate env var key: {}", variable.key));
        }
        if variable.is_secret {
            secret_keys.insert(variable.key.clone());
        }
    }
    write_all(dir, env, &values)?;
    if let Err(error) = save_meta(
        dir,
        env,
        &EnvMeta {
            secret_keys: secret_keys.into_iter().collect(),
        },
    ) {
        let _ = delete_environment(dir, env);
        return Err(error.context("write imported environment metadata"));
    }
    Ok(())
}

fn env_file_path(dir: &Path, env: &str) -> Result<PathBuf> {
    validate_env_name(env)?;
    Ok(dir.join(format!("{env}.env")))
}

fn meta_file_path(dir: &Path, env: &str) -> Result<PathBuf> {
    validate_env_name(env)?;
    Ok(dir.join(format!("{env}.env.meta.json")))
}

/// List all environment names that exist on disk, sorted alphabetically.
pub fn list_environments(dir: &Path) -> Result<Vec<String>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).context("read environments dir")? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if let Some(stem) = name.strip_suffix(".env") {
            // Guard against `.env.meta.json` siblings leaking in.
            if validate_env_name(stem).is_ok() {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// Create an empty environment if it doesn't already exist. Returns true if
/// the file was freshly created.
pub fn create_environment(dir: &Path, env: &str) -> Result<bool> {
    std::fs::create_dir_all(dir).context("create environments dir")?;
    let path = env_file_path(dir, env)?;
    if path.exists() {
        return Ok(false);
    }
    atomic_write(&path, b"")?;
    // Also write an empty meta file for symmetry.
    let meta = meta_file_path(dir, env)?;
    if !meta.exists() {
        atomic_write(&meta, b"{\"secret_keys\":[]}")?;
    }
    Ok(true)
}

/// Delete an environment and its secret-keys metadata. Succeeds silently
/// if the environment doesn't exist.
pub fn delete_environment(dir: &Path, env: &str) -> Result<()> {
    let env_path = env_file_path(dir, env)?;
    let meta_path = meta_file_path(dir, env)?;
    if env_path.exists() {
        std::fs::remove_file(&env_path).context("remove env file")?;
    }
    if meta_path.exists() {
        std::fs::remove_file(&meta_path).context("remove env metadata")?;
    }
    Ok(())
}

/// Capture an environment without parsing or exposing its values. Keeping the
/// exact bytes also preserves comments and metadata if a later DB operation
/// forces us to restore the files.
pub(crate) fn snapshot_environment(dir: &Path, env: &str) -> Result<EnvironmentSnapshot> {
    let env_path = env_file_path(dir, env)?;
    let meta_path = meta_file_path(dir, env)?;
    Ok(EnvironmentSnapshot {
        env_bytes: read_optional_file(&env_path)?,
        meta_bytes: read_optional_file(&meta_path)?,
    })
}

/// Restore a backend-only environment snapshot after a coordinated operation
/// fails. Files that did not exist at snapshot time are removed.
pub(crate) fn restore_environment(
    dir: &Path,
    env: &str,
    snapshot: &EnvironmentSnapshot,
) -> Result<()> {
    restore_optional_file(&env_file_path(dir, env)?, snapshot.env_bytes.as_deref())?;
    restore_optional_file(&meta_file_path(dir, env)?, snapshot.meta_bytes.as_deref())?;
    Ok(())
}

fn read_optional_file(path: &Path) -> Result<Option<Vec<u8>>> {
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read(path)
        .map(Some)
        .with_context(|| format!("read {}", path.display()))
}

fn restore_optional_file(path: &Path, bytes: Option<&[u8]>) -> Result<()> {
    match bytes {
        Some(bytes) => atomic_write(path, bytes),
        None if path.exists() => {
            std::fs::remove_file(path).with_context(|| format!("remove {}", path.display()))
        }
        None => Ok(()),
    }
}

/// Load all variables for one environment. Non-existent env → empty map.
pub fn load_env(dir: &Path, env: &str) -> Result<Vec<EnvVar>> {
    let path = env_file_path(dir, env)?;
    let meta = load_meta(dir, env)?;
    let secret_set: std::collections::HashSet<&str> =
        meta.secret_keys.iter().map(|s| s.as_str()).collect();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let mut out = Vec::new();
    for (line_no, line) in raw.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (k, v) = match trimmed.split_once('=') {
            Some(kv) => kv,
            None => {
                tracing::warn!(
                    path = %path.display(),
                    line = line_no + 1,
                    "skipping malformed env line (missing '=')"
                );
                continue;
            }
        };
        let key = k.trim().to_string();
        if validate_key(&key).is_err() {
            tracing::warn!(
                path = %path.display(),
                line = line_no + 1,
                "skipping env line with bad key"
            );
            continue;
        }
        let value = v.to_string();
        let is_secret = secret_set.contains(key.as_str());
        out.push(EnvVar {
            key,
            value,
            is_secret,
        });
    }
    out.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(out)
}

fn load_meta(dir: &Path, env: &str) -> Result<EnvMeta> {
    let path = meta_file_path(dir, env)?;
    if !path.exists() {
        return Ok(EnvMeta::default());
    }
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_meta(dir: &Path, env: &str, meta: &EnvMeta) -> Result<()> {
    let path = meta_file_path(dir, env)?;
    let json = serde_json::to_string(meta).context("serialize env meta")?;
    atomic_write(&path, json.as_bytes())?;
    Ok(())
}

/// Set (upsert) one key. Creates the environment file if missing.
pub fn set_var(dir: &Path, env: &str, key: &str, value: &str, is_secret: bool) -> Result<()> {
    validate_key(key)?;
    validate_value(value)?;
    // Start from current contents so we preserve other keys.
    let mut current: BTreeMap<String, String> = load_env(dir, env)?
        .into_iter()
        .map(|v| (v.key, v.value))
        .collect();
    current.insert(key.to_string(), value.to_string());
    write_all(dir, env, &current)?;

    // Update secret-keys metadata.
    let mut meta = load_meta(dir, env)?;
    let set: std::collections::BTreeSet<String> = meta.secret_keys.iter().cloned().collect();
    let mut set = set;
    if is_secret {
        set.insert(key.to_string());
    } else {
        set.remove(key);
    }
    meta.secret_keys = set.into_iter().collect();
    save_meta(dir, env, &meta)?;
    Ok(())
}

/// Delete one key from an environment. No-op if missing.
pub fn delete_var(dir: &Path, env: &str, key: &str) -> Result<()> {
    validate_key(key)?;
    let mut current: BTreeMap<String, String> = load_env(dir, env)?
        .into_iter()
        .map(|v| (v.key, v.value))
        .collect();
    if current.remove(key).is_some() {
        write_all(dir, env, &current)?;
    }
    // Also drop it from the secret list if it was there.
    let mut meta = load_meta(dir, env)?;
    meta.secret_keys.retain(|k| k != key);
    save_meta(dir, env, &meta)?;
    Ok(())
}

fn write_all(dir: &Path, env: &str, vars: &BTreeMap<String, String>) -> Result<()> {
    let path = env_file_path(dir, env)?;
    let mut body = String::new();
    for (k, v) in vars {
        body.push_str(k);
        body.push('=');
        body.push_str(v);
        body.push('\n');
    }
    atomic_write(&path, body.as_bytes())?;
    Ok(())
}

/// Write bytes to `path` atomically via a sibling temp file + rename, and
/// set Unix mode 0600 (no-op on Windows).
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent).context("create parent dir")?;

    // Unique per-call temp name to avoid two concurrent writers racing on the
    // same `.tmp`. pid + nanosecond ticks is enough — this path is only hit
    // from the GUI credentials panel, not hot.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(
        ".{}.tmp.{}.{}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("env"),
        std::process::id(),
        nanos
    ));

    std::fs::write(&tmp, bytes).with_context(|| format!("write {}", tmp.display()))?;
    set_secure_perms(&tmp)?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    // Also tighten the final file in case `rename` preserved broader perms
    // from a pre-existing destination.
    set_secure_perms(path)?;
    Ok(())
}

#[cfg(unix)]
fn set_secure_perms(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    std::fs::set_permissions(path, perms)
        .with_context(|| format!("chmod 600 {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_secure_perms(_path: &Path) -> Result<()> {
    // Windows doesn't support POSIX permission bits. The ACL inheritance
    // from the parent dir is assumed to be user-private (%APPDATA%).
    Ok(())
}
