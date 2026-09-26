use super::types::{Agent, AgentFrontmatter};
use anyhow::{Context, Result};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub struct AgentsLoader {
    agents_dir: PathBuf,
    agents: RwLock<HashMap<String, Agent>>,
}

impl AgentsLoader {
    const TOPOLOGRAPH_ROUTING_METADATA: &'static str =
        "execution-mode: react-code\nengine: deepagents\n";

    pub fn new(agents_dir: PathBuf) -> Self {
        Self {
            agents_dir,
            agents: RwLock::new(HashMap::new()),
        }
    }

    pub fn agents_dir(&self) -> &Path {
        &self.agents_dir
    }

    /// Load all agents from the agents directory.
    ///
    /// This is a pure read: it does NOT copy bundled agents into the user
    /// directory (that write-side-effect lived here historically and made a
    /// read method mutate the filesystem). Call
    /// [`AgentsLoader::initialize_bundled_agents`] once at boot before the
    /// first `load_all`.
    pub fn load_all(&self) -> Result<Vec<Agent>> {
        let mut loaded = Vec::new();

        if !self.agents_dir.exists() {
            fs::create_dir_all(&self.agents_dir).context("Failed to create agents directory")?;
            return Ok(loaded);
        }

        let entries = fs::read_dir(&self.agents_dir).context("Failed to read agents directory")?;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let id = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string());
                if let Some(id) = id {
                    match self.load_agent(&id, &path) {
                        Ok(agent) => loaded.push(agent),
                        Err(e) => {
                            eprintln!("Warning: Failed to load agent '{}': {}", id, e);
                            continue;
                        }
                    }
                }
            }
        }

        let mut map = self.agents.write();
        map.clear();
        for agent in &loaded {
            map.insert(agent.id.clone(), agent.clone());
        }

        Ok(loaded)
    }

    pub fn get(&self, id: &str) -> Option<Agent> {
        self.agents.read().get(id).cloned()
    }

    pub fn list(&self) -> Vec<Agent> {
        self.agents.read().values().cloned().collect()
    }

    pub fn reload_agent(&self, id: &str) -> Result<()> {
        let path = self.agents_dir.join(id);
        if !path.exists() {
            anyhow::bail!("Agent directory '{}' not found", id);
        }
        let agent = self.load_agent(id, &path)?;
        let mut map = self.agents.write();
        map.insert(id.to_string(), agent);
        Ok(())
    }

    /// Create a new agent on disk from frontmatter fields + optional body.
    /// Returns the created agent.
    pub fn create(
        &self,
        id: &str,
        name: &str,
        description: &str,
        system_prompt: &str,
        model_override: Option<(String, String)>,
        execution_mode: Option<String>,
        engine: Option<String>,
        attached_skills: Vec<String>,
        attached_mcp_servers: Vec<String>,
        attached_tools: Vec<super::types::AttachedTool>,
        allowed_commands: Vec<String>,
        body: &str,
    ) -> Result<Agent> {
        if !self.agents_dir.exists() {
            fs::create_dir_all(&self.agents_dir).context("Failed to create agents directory")?;
        }
        let dir = self.agents_dir.join(id);
        if dir.exists() {
            anyhow::bail!("Agent '{}' already exists", id);
        }
        fs::create_dir_all(&dir).context("Failed to create agent directory")?;

        let md = serialize_agent_md(
            name,
            description,
            system_prompt,
            model_override.as_ref(),
            execution_mode.as_ref(),
            engine.as_ref(),
            &attached_skills,
            &attached_mcp_servers,
            &attached_tools,
            &allowed_commands,
            body,
        );
        fs::write(dir.join("AGENT.md"), md).context("Failed to write AGENT.md")?;

        self.reload_agent(id)?;
        self.get(id)
            .ok_or_else(|| anyhow::anyhow!("Failed to load created agent"))
    }

    /// Update an existing agent on disk.
    /// Returns the updated agent after reloading.
    pub fn update(
        &self,
        id: &str,
        name: &str,
        description: &str,
        system_prompt: &str,
        model_override: Option<(String, String)>,
        execution_mode: Option<String>,
        engine: Option<String>,
        attached_skills: Vec<String>,
        attached_mcp_servers: Vec<String>,
        attached_tools: Vec<super::types::AttachedTool>,
        allowed_commands: Vec<String>,
        body: &str,
    ) -> Result<Agent> {
        let dir = self.agents_dir.join(id);
        if !dir.exists() {
            anyhow::bail!("Agent '{}' not found", id);
        }

        let md = serialize_agent_md(
            name,
            description,
            system_prompt,
            model_override.as_ref(),
            execution_mode.as_ref(),
            engine.as_ref(),
            &attached_skills,
            &attached_mcp_servers,
            &attached_tools,
            &allowed_commands,
            body,
        );

        // Atomic write: temp file + rename
        let tmp_path = dir.join("AGENT.md.tmp");
        fs::write(&tmp_path, &md).context("Failed to write temporary AGENT.md")?;
        fs::rename(&tmp_path, dir.join("AGENT.md"))
            .context("Failed to rename temporary file to AGENT.md")?;

        self.reload_agent(id)?;
        self.get(id)
            .ok_or_else(|| anyhow::anyhow!("Failed to reload updated agent"))
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let path = self.agents_dir.join(id);
        if !path.exists() {
            anyhow::bail!("Agent '{}' not found", id);
        }
        fs::remove_dir_all(&path).context("Failed to remove agent directory")?;
        self.agents.write().remove(id);
        Ok(())
    }

    fn load_agent(&self, id: &str, path: &Path) -> Result<Agent> {
        let md = path.join("AGENT.md");
        if !md.exists() {
            anyhow::bail!("AGENT.md not found in {}", path.display());
        }
        let content = fs::read_to_string(&md).context("Failed to read AGENT.md")?;
        let (fm, body) = parse_agent_content(&content)?;

        // Validate and convert attached_tools
        let attached_tools = validate_attached_tools(&fm.attached_tools, id, path);

        Ok(Agent {
            id: id.to_string(),
            name: fm.name,
            description: fm.description,
            system_prompt: fm.system_prompt,
            model_override: fm.model_override.map(Into::into),
            execution_mode: fm.execution_mode,
            engine: fm.engine,
            attached_skills: fm.attached_skills,
            attached_mcp_servers: fm.attached_mcp_servers,
            attached_tools,
            allowed_commands: fm.allowed_commands,
            body,
            path: path.to_path_buf(),
        })
    }

    /// Initialize bundled agents by copying them to user directory on first run.
    /// Only copies if the agent doesn't already exist in user directory.
    ///
    /// Call this once at startup (it performs filesystem writes). It is
    /// deliberately separate from [`AgentsLoader::load_all`] so that loading
    /// agents stays a side-effect-free read.
    pub fn initialize_bundled_agents(&self) -> Result<()> {
        let bundled_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Failed to get parent directory"))?
            .join("bundled-agents");

        if !bundled_dir.exists() {
            // No bundled agents directory, skip
            return Ok(());
        }

        for entry in fs::read_dir(&bundled_dir)? {
            let entry = entry?;
            let bundled_path = entry.path();

            if bundled_path.is_dir() {
                let agent_id = bundled_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| anyhow::anyhow!("Invalid agent directory name"))?;

                let user_path = self.agents_dir.join(agent_id);

                if agent_id == "topolograph" && user_path.is_dir() {
                    Self::refresh_legacy_topolograph_agent(&bundled_path, &user_path)?;
                }

                // Only copy if doesn't exist (don't overwrite user customizations)
                if !user_path.exists() {
                    fs::create_dir_all(&user_path)?;

                    // Copy every regular file in the bundled agent dir — AGENT.md,
                    // tools.json, and any companion files (e.g. SOUL*.md persona
                    // files the sidecar appends to the system prompt). Copying the
                    // whole dir keeps future companion files working without
                    // touching this list again.
                    for f in fs::read_dir(&bundled_path)? {
                        let f = f?;
                        let fpath = f.path();
                        if fpath.is_file() {
                            if let Some(fname) = fpath.file_name() {
                                fs::copy(&fpath, user_path.join(fname))?;
                            }
                        }
                    }

                    tracing::info!("Initialized bundled agent: {}", agent_id);
                }
            }
        }

        Ok(())
    }

    fn refresh_legacy_topolograph_agent(bundled_path: &Path, user_path: &Path) -> Result<()> {
        let bundled_agent_path = bundled_path.join("AGENT.md");
        let installed_agent_path = user_path.join("AGENT.md");
        let bundled = fs::read_to_string(&bundled_agent_path)
            .context("Failed to read bundled Topolograph AGENT.md")?;

        if !bundled.contains(Self::TOPOLOGRAPH_ROUTING_METADATA) {
            return Ok(());
        }

        let legacy = bundled.replacen(Self::TOPOLOGRAPH_ROUTING_METADATA, "", 1);
        if fs::read(&installed_agent_path).ok().as_deref() == Some(legacy.as_bytes()) {
            fs::write(&installed_agent_path, bundled.as_bytes())
                .context("Failed to refresh legacy Topolograph AGENT.md")?;
            tracing::info!("Refreshed legacy bundled agent: topolograph");
        }

        Ok(())
    }
}

/// Validate attached-tools and filter out invalid entries
fn validate_attached_tools(
    tools: &[super::types::AttachedToolFrontmatter],
    agent_id: &str,
    agent_path: &Path,
) -> Vec<super::types::AttachedTool> {
    use super::types::AttachedTool;

    tools
        .iter()
        .filter_map(|tool| {
            // Validate blast-radius tier
            let valid_tiers = ["low", "medium", "high", "destructive"];
            if !valid_tiers.contains(&tool.default_blast_radius_allowed.as_str()) {
                eprintln!(
                    "Warning: Agent '{}' attached-tool '{}' has invalid blast-radius '{}'. Expected one of: {}. Skipping tool.",
                    agent_id, tool.id, tool.default_blast_radius_allowed,
                    valid_tiers.join(", ")
                );
                return None;
            }

            // An empty vault-entry is valid: it means the tool needs no vault
            // secrets (e.g. pyATS reads SSH creds from its testbed .env). All
            // downstream consumers guard on `vault_entry.is_empty()`, so we keep
            // the tool rather than dropping it.

            // Expand tilde or resolve relative path
            let catalog_path = if tool.catalog.starts_with("~/") {
                // Tilde expansion
                if let Some(home) = dirs::home_dir() {
                    home.join(&tool.catalog[2..]).to_string_lossy().to_string()
                } else {
                    eprintln!(
                        "Warning: Agent '{}' attached-tool '{}' catalog path '{}' contains ~ but home directory not found. Skipping tool.",
                        agent_id, tool.id, tool.catalog
                    );
                    return None;
                }
            } else if tool.catalog.starts_with('/') {
                // Absolute path
                tool.catalog.clone()
            } else {
                // Relative path - resolve relative to agent directory
                agent_path.join(&tool.catalog).to_string_lossy().to_string()
            };

            // Validate catalog file exists
            if !std::path::Path::new(&catalog_path).exists() {
                eprintln!(
                    "Warning: Agent '{}' attached-tool '{}' catalog file not found: {}. Skipping tool.",
                    agent_id, tool.id, catalog_path
                );
                return None;
            }

            Some(AttachedTool {
                id: tool.id.clone(),
                catalog: catalog_path,
                default_blast_radius_allowed: tool.default_blast_radius_allowed.clone(),
                vault_entry: tool.vault_entry.clone(),
            })
        })
        .collect()
}

/// Parse AGENT.md into frontmatter + body.
fn parse_agent_content(content: &str) -> Result<(AgentFrontmatter, String)> {
    let content = content.trim();
    if !content.starts_with("---") {
        anyhow::bail!("AGENT.md must start with '---' frontmatter marker");
    }
    let rest = &content[3..];
    let end = rest
        .find("\n---")
        .context("Missing closing '---' frontmatter marker")?;
    let fm_str = rest[..end].trim();
    let body = rest[end + 4..].trim().to_string();
    let fm: AgentFrontmatter =
        serde_yaml::from_str(fm_str).context("Failed to parse YAML frontmatter")?;
    Ok((fm, body))
}

/// Serialize agent fields into AGENT.md content.
fn serialize_agent_md(
    name: &str,
    description: &str,
    system_prompt: &str,
    model_override: Option<&(String, String)>,
    execution_mode: Option<&String>,
    engine: Option<&String>,
    attached_skills: &[String],
    attached_mcp_servers: &[String],
    attached_tools: &[super::types::AttachedTool],
    allowed_commands: &[String],
    body: &str,
) -> String {
    let mut s = String::new();
    s.push_str("---\n");
    s.push_str(&format!("name: {}\n", yaml_escape(name)));
    s.push_str(&format!("description: {}\n", yaml_escape(description)));
    s.push_str("system-prompt: |\n");
    for line in system_prompt.lines() {
        s.push_str(&format!("  {}\n", line));
    }
    if let Some((prov, model)) = model_override {
        s.push_str("model-override:\n");
        s.push_str(&format!("  provider: {}\n", yaml_escape(prov)));
        s.push_str(&format!("  model: {}\n", yaml_escape(model)));
    }
    if let Some(em) = execution_mode {
        s.push_str(&format!("execution-mode: {}\n", yaml_escape(em)));
    }
    if let Some(eng) = engine {
        s.push_str(&format!("engine: {}\n", yaml_escape(eng)));
    }
    if !attached_skills.is_empty() {
        s.push_str("attached-skills:\n");
        for id in attached_skills {
            s.push_str(&format!("  - {}\n", yaml_escape(id)));
        }
    }
    if !attached_mcp_servers.is_empty() {
        s.push_str("attached-mcp-servers:\n");
        for id in attached_mcp_servers {
            s.push_str(&format!("  - {}\n", yaml_escape(id)));
        }
    }
    if !attached_tools.is_empty() {
        s.push_str("attached-tools:\n");
        for tool in attached_tools {
            s.push_str(&format!("  - id: {}\n", yaml_escape(&tool.id)));
            s.push_str(&format!("    catalog: {}\n", yaml_escape(&tool.catalog)));
            s.push_str(&format!(
                "    default-blast-radius-allowed: {}\n",
                yaml_escape(&tool.default_blast_radius_allowed)
            ));
            s.push_str(&format!(
                "    vault-entry: {}\n",
                yaml_escape(&tool.vault_entry)
            ));
        }
    }
    if !allowed_commands.is_empty() {
        s.push_str("allowed-commands:\n");
        for cmd in allowed_commands {
            s.push_str(&format!("  - {}\n", yaml_escape(cmd)));
        }
    }
    s.push_str("---\n\n");
    s.push_str(body);
    if !body.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// Quote YAML scalars when they contain chars that would confuse the parser.
fn yaml_escape(v: &str) -> String {
    if v.is_empty()
        || v.contains(':')
        || v.contains('#')
        || v.contains('\'')
        || v.contains('"')
        || v.contains('\n')
        || v.starts_with(' ')
        || v.ends_with(' ')
    {
        format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        v.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_parse_agent_content_full() {
        let content = r#"---
name: bgp-debugger
description: BGP troubleshooting specialist
system-prompt: |
  You are an expert BGP engineer.
  Diagnose routing issues step by step.
model-override:
  provider: openai
  model: gpt-4-turbo
attached-skills:
  - bgp-troubleshoot
attached-mcp-servers:
  - netbox
allowed-commands:
  - "^show "
  - "^ping "
---

# Playbook body
"#;
        let (fm, body) = parse_agent_content(content).unwrap();
        assert_eq!(fm.name, "bgp-debugger");
        assert_eq!(fm.attached_skills, vec!["bgp-troubleshoot"]);
        assert_eq!(fm.allowed_commands.len(), 2);
        assert!(fm.model_override.is_some());
        assert!(body.contains("Playbook body"));
    }

    #[test]
    fn test_parse_bundled_stealthwatch_agent() {
        // Regression: the stealthwatch AGENT.md previously omitted the required
        // `default-blast-radius-allowed` field on its attached tool, which made
        // serde_yaml reject the whole frontmatter ("Failed to parse YAML frontmatter").
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../bundled-agents/stealthwatch/AGENT.md");
        let content = std::fs::read_to_string(&path).unwrap();
        let (fm, _body) = parse_agent_content(&content).unwrap();
        assert_eq!(fm.name, "stealthwatch");
        assert_eq!(fm.attached_tools.len(), 1);
        assert_eq!(fm.attached_tools[0].default_blast_radius_allowed, "low");
    }

    #[test]
    fn test_parse_bundled_ise_agent() {
        // Guard the ISE AGENT.md frontmatter parses and declares its single tool.
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../bundled-agents/ise/AGENT.md");
        let content = std::fs::read_to_string(&path).unwrap();
        let (fm, _body) = parse_agent_content(&content).unwrap();
        assert_eq!(fm.name, "ise");
        assert_eq!(fm.attached_tools.len(), 1);
        assert_eq!(fm.attached_tools[0].id, "ise");
        assert_eq!(fm.attached_tools[0].default_blast_radius_allowed, "low");
    }

    #[test]
    fn test_parse_bundled_topolograph_agent() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../bundled-agents/topolograph/AGENT.md");
        let content = std::fs::read_to_string(&path).unwrap();
        let (fm, _body) = parse_agent_content(&content).unwrap();
        assert_eq!(fm.name, "topolograph");
        assert_eq!(fm.execution_mode.as_deref(), Some("react-code"));
        assert_eq!(fm.engine.as_deref(), Some("deepagents"));
        assert_eq!(fm.attached_tools.len(), 1);
        assert_eq!(fm.attached_tools[0].id, "topolograph");
        assert_eq!(
            fm.attached_tools[0].default_blast_radius_allowed,
            "destructive"
        );
    }

    const TOPOLOGRAPH_ROUTING_METADATA: &str =
        "execution-mode: react-code\nengine: deepagents\n";

    fn desired_topolograph_template() -> String {
        let bundled = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../bundled-agents/topolograph/AGENT.md"),
        )
        .unwrap();

        if bundled.contains(TOPOLOGRAPH_ROUTING_METADATA) {
            bundled
        } else {
            bundled.replacen(
                "description: Topolograph network graph, LSDB, BGP, VRF, path, event, and LSP specialist\n",
                &format!(
                    "description: Topolograph network graph, LSDB, BGP, VRF, path, event, and LSP specialist\n{}",
                    TOPOLOGRAPH_ROUTING_METADATA
                ),
                1,
            )
        }
    }

    #[test]
    fn initialize_bundled_agents_refreshes_exact_legacy_topolograph_template() {
        let tmp = TempDir::new().unwrap();
        let topolograph_dir = tmp.path().join("topolograph");
        std::fs::create_dir(&topolograph_dir).unwrap();

        let desired = desired_topolograph_template();
        let legacy = desired.replacen(TOPOLOGRAPH_ROUTING_METADATA, "", 1);
        std::fs::write(topolograph_dir.join("AGENT.md"), legacy).unwrap();

        AgentsLoader::new(tmp.path().to_path_buf())
            .initialize_bundled_agents()
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(topolograph_dir.join("AGENT.md")).unwrap(),
            desired
        );
    }

    #[test]
    fn initialize_bundled_agents_preserves_modified_topolograph_template() {
        let tmp = TempDir::new().unwrap();
        let topolograph_dir = tmp.path().join("topolograph");
        std::fs::create_dir(&topolograph_dir).unwrap();

        let desired = desired_topolograph_template();
        let legacy = desired.replacen(TOPOLOGRAPH_ROUTING_METADATA, "", 1);
        let customized = format!("{}\n<!-- user customization -->\n", legacy);
        std::fs::write(topolograph_dir.join("AGENT.md"), &customized).unwrap();

        AgentsLoader::new(tmp.path().to_path_buf())
            .initialize_bundled_agents()
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(topolograph_dir.join("AGENT.md")).unwrap(),
            customized
        );
    }

    #[test]
    fn test_create_and_load_agent_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let loader = AgentsLoader::new(tmp.path().to_path_buf());
        let agent = loader
            .create(
                "test-agent",
                "Test Agent",
                "A test agent",
                "You are a helpful assistant.\nBe concise.",
                Some(("vllm".to_string(), "gemma".to_string())),
                None,
                None,
                vec!["skill-a".to_string()],
                vec![],
                vec![],
                vec!["^show ".to_string()],
                "# Notes\n\nSome body text.",
            )
            .unwrap();
        assert_eq!(agent.id, "test-agent");
        assert_eq!(agent.name, "Test Agent");
        assert_eq!(agent.attached_skills, vec!["skill-a"]);
        assert_eq!(agent.allowed_commands, vec!["^show "]);
        let model = agent.model_override.unwrap();
        assert_eq!(model.provider, "vllm");
        assert_eq!(model.model, "gemma");

        // Reload
        let all = loader.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "test-agent");

        // Delete
        loader.delete("test-agent").unwrap();
        let all2 = loader.load_all().unwrap();
        assert_eq!(all2.len(), 0);
    }

    #[test]
    fn load_all_does_not_copy_bundled_agents() {
        // load_all must be a pure read: it must not initialize bundled agents
        // into the directory as a side-effect (that's initialize_bundled_agents,
        // an explicit boot-time call). An empty agents dir must load empty.
        let tmp = TempDir::new().unwrap();
        let loader = AgentsLoader::new(tmp.path().to_path_buf());

        let all = loader.load_all().unwrap();
        assert_eq!(
            all.len(),
            0,
            "load_all must not auto-populate bundled agents"
        );
    }

    #[test]
    fn test_update_agent() {
        let tmp = TempDir::new().unwrap();
        let loader = AgentsLoader::new(tmp.path().to_path_buf());

        // Create initial agent
        let agent = loader
            .create(
                "test-agent",
                "Test Agent",
                "A test agent",
                "You are helpful.",
                Some(("anthropic".to_string(), "claude-3".to_string())),
                None,
                None,
                vec!["skill-a".to_string()],
                vec![],
                vec![],
                vec!["^show ".to_string()],
                "# Notes\n\nOriginal body.",
            )
            .unwrap();
        assert_eq!(agent.name, "Test Agent");
        assert_eq!(agent.description, "A test agent");

        // Update agent
        let updated = loader
            .update(
                "test-agent",
                "Updated Name",
                "Updated description",
                "You are very helpful.",
                Some(("openai".to_string(), "gpt-4".to_string())),
                None,
                None,
                vec!["skill-b".to_string(), "skill-c".to_string()],
                vec!["mcp-server-1".to_string()],
                vec![],
                vec!["^ping ".to_string(), "^traceroute ".to_string()],
                "# Updated\n\nNew body.",
            )
            .unwrap();

        assert_eq!(updated.id, "test-agent"); // ID unchanged
        assert_eq!(updated.name, "Updated Name");
        assert_eq!(updated.description, "Updated description");
        assert_eq!(updated.system_prompt, "You are very helpful.\n");
        assert_eq!(updated.attached_skills, vec!["skill-b", "skill-c"]);
        assert_eq!(updated.attached_mcp_servers, vec!["mcp-server-1"]);
        assert_eq!(updated.allowed_commands, vec!["^ping ", "^traceroute "]);
        assert!(updated.body.contains("New body"));

        let model = updated.model_override.unwrap();
        assert_eq!(model.provider, "openai");
        assert_eq!(model.model, "gpt-4");

        // Reload and verify persistence
        let all = loader.load_all().unwrap();
        // Filter to only our test agent, since bundled agents may also be loaded
        let test_agent = all.iter().find(|a| a.id == "test-agent").unwrap();
        assert_eq!(test_agent.name, "Updated Name");
    }

    #[test]
    fn test_update_nonexistent_agent() {
        let tmp = TempDir::new().unwrap();
        let loader = AgentsLoader::new(tmp.path().to_path_buf());

        let result = loader.update(
            "nonexistent",
            "Name",
            "Desc",
            "Prompt",
            None,
            None,
            None,
            vec![],
            vec![],
            vec![],
            vec![],
            "Body",
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not found"));
    }

    #[test]
    fn test_parse_agent_missing_frontmatter() {
        let content = "# No frontmatter";
        assert!(parse_agent_content(content).is_err());
    }

    #[test]
    fn test_parse_agent_with_attached_tools() {
        use std::fs;

        let tmp = TempDir::new().unwrap();
        let catalog_path = tmp.path().join("test-catalog.json");
        fs::write(&catalog_path, "[]").unwrap();

        let content = format!(
            r#"---
name: meraki-expert
description: Meraki dashboard expert
system-prompt: |
  You are a Meraki expert.
attached-tools:
  - id: meraki
    catalog: {}
    default-blast-radius-allowed: low
    vault-entry: meraki_default
---

# Playbook
"#,
            catalog_path.display()
        );

        let (fm, body) = parse_agent_content(&content).unwrap();
        assert_eq!(fm.name, "meraki-expert");
        assert_eq!(fm.attached_tools.len(), 1);
        assert_eq!(fm.attached_tools[0].id, "meraki");
        assert_eq!(fm.attached_tools[0].default_blast_radius_allowed, "low");
        assert_eq!(fm.attached_tools[0].vault_entry, "meraki_default");
        assert!(body.contains("Playbook"));
    }

    #[test]
    fn test_validate_attached_tools_valid() {
        use super::super::types::AttachedToolFrontmatter;
        use std::fs;

        let tmp = TempDir::new().unwrap();
        let catalog_path = tmp.path().join("test-catalog.json");
        fs::write(&catalog_path, "[]").unwrap();

        let tools = vec![AttachedToolFrontmatter {
            id: "test-tool".to_string(),
            catalog: catalog_path.to_string_lossy().to_string(),
            default_blast_radius_allowed: "medium".to_string(),
            vault_entry: "test_vault".to_string(),
        }];

        let validated = validate_attached_tools(&tools, "test-agent", tmp.path());
        assert_eq!(validated.len(), 1);
        assert_eq!(validated[0].id, "test-tool");
        assert_eq!(validated[0].default_blast_radius_allowed, "medium");
    }

    #[test]
    fn test_validate_attached_tools_invalid_blast_radius() {
        use super::super::types::AttachedToolFrontmatter;
        use std::fs;

        let tmp = TempDir::new().unwrap();
        let catalog_path = tmp.path().join("test-catalog.json");
        fs::write(&catalog_path, "[]").unwrap();

        let tools = vec![AttachedToolFrontmatter {
            id: "test-tool".to_string(),
            catalog: catalog_path.to_string_lossy().to_string(),
            default_blast_radius_allowed: "invalid".to_string(),
            vault_entry: "test_vault".to_string(),
        }];

        let validated = validate_attached_tools(&tools, "test-agent", tmp.path());
        assert_eq!(validated.len(), 0); // Should be filtered out
    }

    #[test]
    fn test_validate_attached_tools_missing_catalog() {
        use super::super::types::AttachedToolFrontmatter;

        let tmp = TempDir::new().unwrap();
        let tools = vec![AttachedToolFrontmatter {
            id: "test-tool".to_string(),
            catalog: "/nonexistent/catalog.json".to_string(),
            default_blast_radius_allowed: "low".to_string(),
            vault_entry: "test_vault".to_string(),
        }];

        let validated = validate_attached_tools(&tools, "test-agent", tmp.path());
        assert_eq!(validated.len(), 0); // Should be filtered out
    }

    #[test]
    fn test_validate_attached_tools_empty_vault_entry_is_kept() {
        use super::super::types::AttachedToolFrontmatter;
        use std::fs;

        let tmp = TempDir::new().unwrap();
        let catalog_path = tmp.path().join("test-catalog.json");
        fs::write(&catalog_path, "[]").unwrap();

        let tools = vec![AttachedToolFrontmatter {
            id: "test-tool".to_string(),
            catalog: catalog_path.to_string_lossy().to_string(),
            default_blast_radius_allowed: "low".to_string(),
            vault_entry: "".to_string(),
        }];

        // Empty vault-entry is a valid "no secrets needed" state (e.g. pyATS),
        // so the tool must be kept rather than filtered out.
        let validated = validate_attached_tools(&tools, "test-agent", tmp.path());
        assert_eq!(validated.len(), 1);
        assert_eq!(validated[0].vault_entry, "");
    }

    #[test]
    fn test_serialize_agent_with_attached_tools() {
        use super::super::types::AttachedTool;

        let tools = vec![AttachedTool {
            id: "meraki".to_string(),
            catalog: "/path/to/catalog.json".to_string(),
            default_blast_radius_allowed: "high".to_string(),
            vault_entry: "meraki_prod".to_string(),
        }];

        let md = serialize_agent_md(
            "Test Agent",
            "Test description",
            "System prompt",
            None,
            None,
            None,
            &[],
            &[],
            &tools,
            &[],
            "Body content",
        );

        assert!(md.contains("attached-tools:"));
        assert!(md.contains("id: meraki"));
        assert!(md.contains("catalog: /path/to/catalog.json"));
        assert!(md.contains("default-blast-radius-allowed: high"));
        assert!(md.contains("vault-entry: meraki_prod"));
    }

    #[test]
    #[ignore] // Only run with --ignored flag, requires ~/.ccie-terminal setup
    fn test_load_meraki_readonly_expert_integration() {
        let agents_dir = dirs::home_dir()
            .expect("home dir")
            .join(".ccie-terminal/agents");

        if !agents_dir.exists() {
            eprintln!("Skipping: agents directory does not exist");
            return;
        }

        let loader = AgentsLoader::new(agents_dir);

        // Load all agents
        let agents = loader.load_all().expect("load agents");

        // Find our test agent
        let agent = agents.iter().find(|a| a.id == "meraki-readonly-expert");

        if agent.is_none() {
            eprintln!("Skipping: meraki-readonly-expert agent not found");
            return;
        }

        let agent = agent.unwrap();

        // Verify the agent structure
        assert_eq!(agent.name, "meraki-readonly-expert");
        assert_eq!(agent.description, "Cisco Meraki dashboard read-only expert");
        assert!(agent.system_prompt.contains("Meraki dashboard expert"));

        // Verify attached_tools
        assert_eq!(agent.attached_tools.len(), 1);
        assert_eq!(agent.attached_tools[0].id, "meraki");
        assert_eq!(agent.attached_tools[0].default_blast_radius_allowed, "low");
        assert_eq!(agent.attached_tools[0].vault_entry, "meraki_default");
        assert!(agent.attached_tools[0]
            .catalog
            .contains("meraki-tools.json"));

        println!("✓ Agent loaded successfully with attached-tools!");
        println!("  - ID: {}", agent.id);
        println!("  - Name: {}", agent.name);
        println!("  - Tools: {}", agent.attached_tools.len());
        println!("  - Tool catalog: {}", agent.attached_tools[0].catalog);
    }
}
