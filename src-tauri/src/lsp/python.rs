use super::{resolve_executable, LspConfig};
use anyhow::{bail, Result};
use std::path::Path;

pub fn get_python_lsp_config(workspace_root: &Path) -> Result<LspConfig> {
    if let Some(command) = resolve_executable(
        workspace_root,
        "CCIE_PYRIGHT_LANGSERVER",
        "pyright-langserver",
    ) {
        return Ok(LspConfig {
            language: "python".to_string(),
            display_name: "Pyright".to_string(),
            command: command.to_string_lossy().into_owned(),
            args: vec!["--stdio".to_string()],
        });
    }

    if let Some(command) = resolve_executable(workspace_root, "CCIE_PYTHON_LSP_SERVER", "pylsp") {
        return Ok(LspConfig {
            language: "python".to_string(),
            display_name: "Python LSP Server".to_string(),
            command: command.to_string_lossy().into_owned(),
            args: vec![],
        });
    }

    bail!(
        "Python language server not found; install TerminAI dependencies or put pyright-langserver/pylsp on PATH"
    )
}

pub fn check_python_lsp_installed(workspace_root: &Path) -> bool {
    get_python_lsp_config(workspace_root).is_ok()
}
