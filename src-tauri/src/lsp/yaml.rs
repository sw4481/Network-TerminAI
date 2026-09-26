use super::{resolve_executable, LspConfig};
use anyhow::{bail, Result};
use std::path::Path;

pub fn get_yaml_lsp_config(workspace_root: &Path) -> Result<LspConfig> {
    let Some(command) = resolve_executable(
        workspace_root,
        "CCIE_YAML_LANGUAGE_SERVER",
        "yaml-language-server",
    ) else {
        bail!(
            "YAML language server not found; install TerminAI dependencies or put yaml-language-server on PATH"
        );
    };

    Ok(LspConfig {
        language: "yaml".to_string(),
        display_name: "YAML Language Server".to_string(),
        command: command.to_string_lossy().into_owned(),
        args: vec!["--stdio".to_string()],
    })
}

pub fn check_yaml_ls_installed(workspace_root: &Path) -> bool {
    get_yaml_lsp_config(workspace_root).is_ok()
}
