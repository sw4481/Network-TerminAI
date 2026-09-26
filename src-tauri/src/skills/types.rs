use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String, // skill directory name
    pub name: String,
    pub description: String,
    pub when_to_use: String,
    #[serde(default)]
    pub scripts: Vec<String>,
    #[serde(default)]
    pub allowed_commands: Vec<String>,
    pub body: String,  // markdown playbook
    pub path: PathBuf, // skill directory path
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct SkillFrontmatter {
    pub name: String,
    pub description: String,
    pub when_to_use: String,
    #[serde(default)]
    pub scripts: Vec<String>,
    #[serde(default)]
    pub allowed_commands: Vec<String>,
}
