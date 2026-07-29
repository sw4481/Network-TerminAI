use super::LspConfig;

pub fn get_yaml_lsp_config() -> LspConfig {
    LspConfig {
        language: "yaml".to_string(),
        command: "yaml-language-server".to_string(),
        args: vec!["--stdio".to_string()],
    }
}

pub fn check_yaml_ls_installed() -> bool {
    std::process::Command::new("which")
        .arg("yaml-language-server")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
