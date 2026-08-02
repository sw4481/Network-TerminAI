use anyhow::{Context, Result};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProfile {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub profiles: HashMap<String, ModelProfile>,
}

impl Default for Config {
    fn default() -> Self {
        let mut profiles = HashMap::new();
        profiles.insert(
            "fast".to_string(),
            ModelProfile {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            },
        );
        profiles.insert(
            "smart".to_string(),
            ModelProfile {
                provider: "anthropic".to_string(),
                model: "claude-opus-4-7".to_string(),
            },
        );
        Config { profiles }
    }
}

pub struct ConfigManager {
    config: Arc<RwLock<Config>>,
    env_vars: Arc<RwLock<HashMap<String, String>>>,
    config_dir: PathBuf,
    _watcher: Option<RecommendedWatcher>,
}

impl ConfigManager {
    pub fn new() -> Result<Self> {
        Self::new_in(get_config_dir()?)
    }

    fn new_in(config_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&config_dir).context("create config dir")?;

        let config_path = config_dir.join("config.toml");
        let env_path = config_dir.join(".env");

        // Load or create default config
        let config = if config_path.exists() {
            let content = std::fs::read_to_string(&config_path)?;
            toml::from_str(&content).context("parse config.toml")?
        } else {
            let default_config = Config::default();
            let toml_str = toml::to_string_pretty(&default_config)?;
            std::fs::write(&config_path, toml_str)?;
            default_config
        };

        // Load .env or create empty
        let env_vars = if env_path.exists() {
            load_env_file(&env_path)?
        } else {
            create_secure_env_file(&env_path)?;
            HashMap::new()
        };

        let config_arc = Arc::new(RwLock::new(config));
        let env_arc = Arc::new(RwLock::new(env_vars));

        // Set up file watcher
        let watcher = setup_watcher(
            config_dir.clone(),
            Arc::clone(&config_arc),
            Arc::clone(&env_arc),
        )?;

        Ok(ConfigManager {
            config: config_arc,
            env_vars: env_arc,
            config_dir,
            _watcher: Some(watcher),
        })
    }

    pub fn get_config(&self) -> Config {
        self.config.read().clone()
    }

    pub fn get_profile(&self, name: &str) -> Option<ModelProfile> {
        self.config.read().profiles.get(name).cloned()
    }

    pub fn save_profile(&self, name: String, profile: ModelProfile) -> Result<()> {
        // Keep the write lock while persisting so the watcher cannot reload a
        // partially-written file and clobber the in-memory value.
        let mut config = self.config.write();
        config.profiles.insert(name, profile);
        let config_path = self.config_dir.join("config.toml");
        let toml_str = toml::to_string_pretty(&*config)?;
        std::fs::write(&config_path, toml_str)?;

        Ok(())
    }

    pub fn get_env_var(&self, key: &str) -> Option<String> {
        self.env_vars.read().get(key).cloned()
    }

    pub fn set_env_var(&self, key: String, value: String) -> Result<()> {
        // Keep the write lock while persisting so the watcher cannot reload a
        // partially-written file and clobber the in-memory value.
        let mut env_vars = self.env_vars.write();
        env_vars.insert(key, value);
        let env_path = self.config_dir.join(".env");
        write_env_file(&env_path, &env_vars)?;

        Ok(())
    }
}

fn get_config_dir() -> Result<PathBuf> {
    let dir = dirs::config_dir()
        .context("could not determine OS config dir")?
        .join("ccie-terminal");
    Ok(dir)
}

/// User-added API target manifests (YAML). Populated at runtime by the
/// credentials/targets settings UI; hot-reload is wired in Step 4.
pub fn api_targets_dir() -> Result<PathBuf> {
    let dir = get_config_dir()?.join("api-targets");
    std::fs::create_dir_all(&dir).context("create api-targets dir")?;
    Ok(dir)
}

/// Built-in manifests shipped with the app, copied into the user's config
/// dir on first run so they can be hand-edited without a rebuild.
pub fn api_targets_builtin_dir() -> Result<PathBuf> {
    let dir = get_config_dir()?.join("api-targets-builtin");
    std::fs::create_dir_all(&dir).context("create api-targets-builtin dir")?;
    Ok(dir)
}

/// Cache for downloaded OpenAPI specs (populated by Step 3).
pub fn api_openapi_cache_dir() -> Result<PathBuf> {
    let dir = get_config_dir()?.join("api-cache").join("openapi");
    std::fs::create_dir_all(&dir).context("create api-cache/openapi dir")?;
    Ok(dir)
}

/// Per-environment `.env` files (one per Lab/Staging/Prod/etc.). Written by
/// the GUI Credentials Panel; never hand-edited.
pub fn api_environments_dir() -> Result<PathBuf> {
    let dir = get_config_dir()?.join("environments");
    std::fs::create_dir_all(&dir).context("create environments dir")?;
    Ok(dir)
}

fn load_env_file(path: &PathBuf) -> Result<HashMap<String, String>> {
    let content = std::fs::read_to_string(path)?;
    let mut vars = HashMap::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            vars.insert(key.trim().to_string(), value.trim().to_string());
        }
    }

    Ok(vars)
}

fn write_env_file(path: &PathBuf, vars: &HashMap<String, String>) -> Result<()> {
    let mut lines: Vec<String> = vars.iter().map(|(k, v)| format!("{}={}", k, v)).collect();
    lines.sort();
    let content = lines.join("\n") + "\n";

    std::fs::write(path, content)?;
    set_secure_permissions(path)?;

    Ok(())
}

fn create_secure_env_file(path: &PathBuf) -> Result<()> {
    std::fs::write(path, "# API keys and secrets\n")?;
    set_secure_permissions(path)?;
    Ok(())
}

#[cfg(unix)]
fn set_secure_permissions(path: &PathBuf) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_secure_permissions(_path: &PathBuf) -> Result<()> {
    // Windows doesn't use Unix permissions
    Ok(())
}

fn setup_watcher(
    config_dir: PathBuf,
    config_arc: Arc<RwLock<Config>>,
    env_arc: Arc<RwLock<HashMap<String, String>>>,
) -> Result<RecommendedWatcher> {
    let config_path = config_dir.join("config.toml");
    let env_path = config_dir.join(".env");

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            for path in event.paths {
                if path == config_path {
                    let mut config = config_arc.write();
                    if let Ok(content) = std::fs::read_to_string(&config_path) {
                        if let Ok(new_config) = toml::from_str::<Config>(&content) {
                            *config = new_config;
                        }
                    }
                } else if path == env_path {
                    let mut env_vars = env_arc.write();
                    if let Ok(new_env) = load_env_file(&env_path) {
                        *env_vars = new_env;
                    }
                }
            }
        }
    })?;

    watcher.watch(&config_dir, RecursiveMode::NonRecursive)?;

    Ok(watcher)
}

// Tauri commands
#[tauri::command]
pub fn get_profiles(state: State<ConfigManager>) -> Result<HashMap<String, ModelProfile>, String> {
    Ok(state.get_config().profiles)
}

#[tauri::command]
pub fn get_profile(
    state: State<ConfigManager>,
    name: String,
) -> Result<Option<ModelProfile>, String> {
    Ok(state.get_profile(&name))
}

#[tauri::command]
pub fn save_profile(
    state: State<ConfigManager>,
    name: String,
    profile: ModelProfile,
) -> Result<(), String> {
    state.save_profile(name, profile).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_env_var(state: State<ConfigManager>, key: String) -> Result<Option<String>, String> {
    Ok(state.get_env_var(&key))
}

#[tauri::command]
pub fn set_env_var(state: State<ConfigManager>, key: String, value: String) -> Result<(), String> {
    state.set_env_var(key, value).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_config_dir() -> TempDir {
        TempDir::new().unwrap()
    }

    #[test]
    fn test_default_config() {
        let config = Config::default();
        assert_eq!(config.profiles.len(), 2);
        assert!(config.profiles.contains_key("fast"));
        assert!(config.profiles.contains_key("smart"));

        let fast = &config.profiles["fast"];
        assert_eq!(fast.provider, "anthropic");
        assert_eq!(fast.model, "claude-sonnet-4-6");
    }

    #[test]
    fn test_env_file_security() {
        let temp_dir = setup_test_config_dir();
        let env_path = temp_dir.path().join(".env");

        create_secure_env_file(&env_path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(&env_path).unwrap();
            let permissions = metadata.permissions();
            assert_eq!(permissions.mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn test_load_and_save_env() {
        let temp_dir = setup_test_config_dir();
        let env_path = temp_dir.path().join(".env");

        // Write test data
        let mut vars = HashMap::new();
        vars.insert(
            "ANTHROPIC_API_KEY".to_string(),
            "sk-ant-test123".to_string(),
        );
        vars.insert("OPENAI_API_KEY".to_string(), "sk-test456".to_string());

        write_env_file(&env_path, &vars).unwrap();

        // Read back
        let loaded = load_env_file(&env_path).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded.get("ANTHROPIC_API_KEY").unwrap(), "sk-ant-test123");
        assert_eq!(loaded.get("OPENAI_API_KEY").unwrap(), "sk-test456");
    }

    #[test]
    fn test_parse_config_toml() {
        let toml_str = r#"
[profiles.fast]
provider = "anthropic"
model = "claude-sonnet-4-6"

[profiles.smart]
provider = "anthropic"
model = "claude-opus-4-7"
"#;

        let config: Config = toml::from_str(toml_str).unwrap();
        assert_eq!(config.profiles.len(), 2);
        assert_eq!(config.profiles["fast"].model, "claude-sonnet-4-6");
        assert_eq!(config.profiles["smart"].model, "claude-opus-4-7");
    }

    #[test]
    fn test_env_file_ignores_comments() {
        let temp_dir = setup_test_config_dir();
        let env_path = temp_dir.path().join(".env");

        let content = r#"
# This is a comment
ANTHROPIC_API_KEY=sk-ant-test123

# Another comment
OPENAI_API_KEY=sk-test456
"#;
        std::fs::write(&env_path, content).unwrap();

        let loaded = load_env_file(&env_path).unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(loaded.contains_key("ANTHROPIC_API_KEY"));
        assert!(loaded.contains_key("OPENAI_API_KEY"));
    }

    #[test]
    fn test_config_manager_save_and_get() {
        let temp_dir = setup_test_config_dir();
        let manager = ConfigManager::new_in(temp_dir.path().join("ccie-terminal")).unwrap();

        // Test default profiles exist
        let fast_profile = manager.get_profile("fast").unwrap();
        assert_eq!(fast_profile.provider, "anthropic");
        assert_eq!(fast_profile.model, "claude-sonnet-4-6");

        // Save a new profile
        let custom_profile = ModelProfile {
            provider: "openai".to_string(),
            model: "gpt-4".to_string(),
        };
        manager
            .save_profile("custom".to_string(), custom_profile.clone())
            .unwrap();

        // Verify it was saved
        let retrieved = manager.get_profile("custom").unwrap();
        assert_eq!(retrieved.provider, "openai");
        assert_eq!(retrieved.model, "gpt-4");
    }

    #[test]
    fn test_env_var_operations() {
        let temp_dir = setup_test_config_dir();
        let manager = ConfigManager::new_in(temp_dir.path().join("ccie-terminal")).unwrap();

        // Set an env var
        manager
            .set_env_var("TEST_KEY".to_string(), "test_value".to_string())
            .unwrap();

        // The file watcher runs asynchronously. Repeatedly verify that a
        // delayed filesystem event cannot clobber the value we just saved.
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(10));
            assert_eq!(
                manager.get_env_var("TEST_KEY").as_deref(),
                Some("test_value")
            );
        }

        // Verify it was written to file
        let env_path = manager.config_dir.join(".env");
        let loaded = load_env_file(&env_path).unwrap();
        assert_eq!(loaded.get("TEST_KEY").unwrap(), "test_value");
    }
}
