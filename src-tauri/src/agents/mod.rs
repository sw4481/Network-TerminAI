mod loader;
mod types;

pub use loader::AgentsLoader;
pub use types::{Agent, AttachedTool, ModelOverride};

use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;

pub fn default_agents_dir() -> Result<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Could not determine home directory"))?;
    Ok(home.join(".ccie-terminal").join("agents"))
}

pub fn create_loader() -> Result<Arc<AgentsLoader>> {
    let dir = default_agents_dir()?;
    Ok(Arc::new(AgentsLoader::new(dir)))
}
