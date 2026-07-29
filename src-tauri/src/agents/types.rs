use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOverride {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedTool {
    pub id: String,
    pub catalog: String,  // path to JSON catalog file
    pub default_blast_radius_allowed: String,  // "low"|"medium"|"high"|"destructive"
    pub vault_entry: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String, // agent directory name
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    #[serde(default)]
    pub model_override: Option<ModelOverride>,
    #[serde(default)]
    pub execution_mode: Option<String>,  // "code" | "react" (default: react)
    #[serde(default)]
    pub engine: Option<String>,  // "deepagents" | "legacy" (default: legacy)
    #[serde(default)]
    pub attached_skills: Vec<String>,
    #[serde(default)]
    pub attached_mcp_servers: Vec<String>,
    #[serde(default)]
    pub attached_tools: Vec<AttachedTool>,
    #[serde(default)]
    pub allowed_commands: Vec<String>,
    pub body: String,      // markdown playbook after frontmatter
    pub path: PathBuf,     // agent directory path
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct AgentFrontmatter {
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    #[serde(default)]
    pub model_override: Option<AgentFrontmatterModelOverride>,
    #[serde(default, rename = "execution-mode")]
    pub execution_mode: Option<String>,
    #[serde(default)]
    pub engine: Option<String>,  // "deepagents" | "legacy"
    #[serde(default)]
    pub attached_skills: Vec<String>,
    #[serde(default)]
    pub attached_mcp_servers: Vec<String>,
    #[serde(default)]
    pub attached_tools: Vec<AttachedToolFrontmatter>,
    #[serde(default)]
    pub allowed_commands: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct AgentFrontmatterModelOverride {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct AttachedToolFrontmatter {
    pub id: String,
    pub catalog: String,
    pub default_blast_radius_allowed: String,
    /// Optional: name of the vault envelope holding this tool's secrets.
    /// Empty/absent means the tool needs no vault secrets (e.g. pyATS, which
    /// reads SSH creds from its testbed .env). All consumers guard on
    /// `is_empty()`, so an empty default is a fully valid state.
    #[serde(default)]
    pub vault_entry: String,
}

impl From<AgentFrontmatterModelOverride> for ModelOverride {
    fn from(f: AgentFrontmatterModelOverride) -> Self {
        ModelOverride {
            provider: f.provider,
            model: f.model,
        }
    }
}

impl From<AttachedToolFrontmatter> for AttachedTool {
    fn from(f: AttachedToolFrontmatter) -> Self {
        AttachedTool {
            id: f.id,
            catalog: f.catalog,
            default_blast_radius_allowed: f.default_blast_radius_allowed,
            vault_entry: f.vault_entry,
        }
    }
}
