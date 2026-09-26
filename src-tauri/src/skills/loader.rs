use super::types::{Skill, SkillFrontmatter};
use anyhow::{Context, Result};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub struct SkillsLoader {
    skills_dir: PathBuf,
    skills: RwLock<HashMap<String, Skill>>,
}

impl SkillsLoader {
    pub fn new(skills_dir: PathBuf) -> Self {
        Self {
            skills_dir,
            skills: RwLock::new(HashMap::new()),
        }
    }

    /// Load all skills from the skills directory
    pub fn load_all(&self) -> Result<Vec<Skill>> {
        let mut loaded_skills = Vec::new();

        // Ensure skills directory exists
        if !self.skills_dir.exists() {
            fs::create_dir_all(&self.skills_dir).context("Failed to create skills directory")?;
            return Ok(loaded_skills);
        }

        // Read all subdirectories
        let entries = fs::read_dir(&self.skills_dir).context("Failed to read skills directory")?;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let skill_id = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string());

                if let Some(id) = skill_id {
                    match self.load_skill(&id, &path) {
                        Ok(skill) => loaded_skills.push(skill),
                        Err(e) => {
                            eprintln!("Warning: Failed to load skill '{}': {}", id, e);
                            continue;
                        }
                    }
                }
            }
        }

        // Update internal cache
        let mut skills_map = self.skills.write();
        skills_map.clear();
        for skill in &loaded_skills {
            skills_map.insert(skill.id.clone(), skill.clone());
        }

        Ok(loaded_skills)
    }

    /// Get a skill by ID
    pub fn get(&self, id: &str) -> Option<Skill> {
        self.skills.read().get(id).cloned()
    }

    /// Reload a specific skill by ID
    pub fn reload_skill(&self, id: &str) -> Result<()> {
        let skill_path = self.skills_dir.join(id);
        if !skill_path.exists() {
            anyhow::bail!("Skill directory '{}' not found", id);
        }

        let skill = self.load_skill(id, &skill_path)?;

        let mut skills_map = self.skills.write();
        skills_map.insert(id.to_string(), skill);

        Ok(())
    }

    /// Load a single skill from its directory
    fn load_skill(&self, id: &str, path: &Path) -> Result<Skill> {
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            anyhow::bail!("SKILL.md not found in {}", path.display());
        }

        let content = fs::read_to_string(&skill_md).context("Failed to read SKILL.md")?;

        let (frontmatter, body) = parse_skill_content(&content)?;

        Ok(Skill {
            id: id.to_string(),
            name: frontmatter.name,
            description: frontmatter.description,
            when_to_use: frontmatter.when_to_use,
            scripts: frontmatter.scripts,
            allowed_commands: frontmatter.allowed_commands,
            body,
            path: path.to_path_buf(),
        })
    }
}

/// Parse SKILL.md content into frontmatter and body
fn parse_skill_content(content: &str) -> Result<(SkillFrontmatter, String)> {
    let content = content.trim();

    // Check for frontmatter markers
    if !content.starts_with("---") {
        anyhow::bail!("SKILL.md must start with '---' frontmatter marker");
    }

    // Find the closing frontmatter marker
    let rest = &content[3..]; // Skip first "---"
    let end_marker = rest
        .find("\n---")
        .context("Missing closing '---' frontmatter marker")?;

    let frontmatter_str = &rest[..end_marker].trim();
    let body = rest[end_marker + 4..].trim().to_string(); // Skip "\n---"

    // Parse YAML frontmatter
    let frontmatter: SkillFrontmatter =
        serde_yaml::from_str(frontmatter_str).context("Failed to parse YAML frontmatter")?;

    Ok((frontmatter, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_skill_content() {
        let content = r#"---
name: test-skill
description: A test skill
when-to-use: For testing
scripts:
  - script1.sh
  - script2.py
allowed-commands:
  - cmd1
  - cmd2
---

# Test Body

This is the body."#;

        let (frontmatter, body) = parse_skill_content(content).unwrap();
        assert_eq!(frontmatter.name, "test-skill");
        assert_eq!(frontmatter.description, "A test skill");
        assert_eq!(frontmatter.when_to_use, "For testing");
        assert_eq!(frontmatter.scripts.len(), 2);
        assert_eq!(frontmatter.allowed_commands.len(), 2);
        assert!(body.contains("# Test Body"));
    }

    #[test]
    fn test_parse_skill_content_minimal() {
        let content = r#"---
name: minimal
description: Minimal
when-to-use: Testing
---

Body"#;

        let (frontmatter, body) = parse_skill_content(content).unwrap();
        assert_eq!(frontmatter.name, "minimal");
        assert_eq!(frontmatter.scripts.len(), 0);
        assert_eq!(frontmatter.allowed_commands.len(), 0);
        assert_eq!(body, "Body");
    }

    #[test]
    fn test_parse_skill_content_no_frontmatter() {
        let content = "# No frontmatter here";
        let result = parse_skill_content(content);
        assert!(result.is_err());
    }
}
