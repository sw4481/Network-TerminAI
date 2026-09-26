mod loader;
mod types;
mod watcher;

pub use loader::SkillsLoader;
pub use types::{Skill, SkillFrontmatter};
pub use watcher::{SkillReloadedEvent, SkillsWatcher};

use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;

/// Get the default skills directory path
pub fn default_skills_dir() -> Result<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Could not determine home directory"))?;
    Ok(home.join(".ccie-terminal").join("skills"))
}

/// Create a new skills loader with the default directory
pub fn create_loader() -> Result<Arc<SkillsLoader>> {
    let skills_dir = default_skills_dir()?;
    Ok(Arc::new(SkillsLoader::new(skills_dir)))
}
