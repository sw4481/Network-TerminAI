use super::LspConfig;

pub fn get_python_lsp_config() -> LspConfig {
    LspConfig {
        language: "python".to_string(),
        command: "pylsp".to_string(),
        args: vec![],
    }
}

pub fn check_pylsp_installed() -> bool {
    std::process::Command::new("which")
        .arg("pylsp")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
