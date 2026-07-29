//! Install shell-integration scripts to the user's config dir on first launch.
//! Users then source them from their rc files when `CCIE_TERMINAL=1`.

use anyhow::{Context, Result};
use std::path::PathBuf;

const ZSH: &str = include_str!("../../shell-integration/ccie-terminal.zsh");
const BASH: &str = include_str!("../../shell-integration/ccie-terminal.bash");

pub struct IntegrationPaths {
    pub zsh: PathBuf,
    pub bash: PathBuf,
}

pub fn install() -> Result<IntegrationPaths> {
    let dir = dirs::config_dir()
        .context("config_dir")?
        .join("ccie-terminal")
        .join("shell-integration");
    std::fs::create_dir_all(&dir).context("create shell-integration dir")?;
    let zsh = dir.join("ccie-terminal.zsh");
    let bash = dir.join("ccie-terminal.bash");
    std::fs::write(&zsh, ZSH).context("write zsh integration")?;
    std::fs::write(&bash, BASH).context("write bash integration")?;
    Ok(IntegrationPaths { zsh, bash })
}
