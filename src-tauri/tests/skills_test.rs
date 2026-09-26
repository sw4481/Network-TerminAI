use std::fs;
use std::path::Path;
use tempfile::TempDir;

// Helper to create test skill directory structure
fn create_test_skill(skills_dir: &Path, skill_id: &str, frontmatter: &str, body: &str) {
    let skill_dir = skills_dir.join(skill_id);
    fs::create_dir_all(&skill_dir).unwrap();

    let skill_md = skill_dir.join("SKILL.md");
    let content = format!("---\n{}\n---\n\n{}", frontmatter, body);
    fs::write(skill_md, content).unwrap();
}

#[test]
fn test_parse_skill_frontmatter() {
    let temp_dir = TempDir::new().unwrap();
    let skills_dir = temp_dir.path().to_path_buf();

    let frontmatter = r#"
name: bgp-troubleshoot
description: Diagnose BGP peering and convergence issues on Cisco IOS/IOS-XE
when-to-use: User asks about BGP problems, peer states, missing routes, or convergence
scripts:
  - check_bgp.sh
  - parse_adj_rib.py
allowed-commands:
  - show bgp
  - show ip bgp"#;

    let body = "# BGP Troubleshooting Playbook\n\nCheck peer status first.";

    create_test_skill(&skills_dir, "bgp-troubleshoot", frontmatter, body);

    let loader = ccie_terminal_lib::skills::SkillsLoader::new(skills_dir);
    let skills = loader.load_all().unwrap();

    assert_eq!(skills.len(), 1);
    let skill = &skills[0];
    assert_eq!(skill.id, "bgp-troubleshoot");
    assert_eq!(skill.name, "bgp-troubleshoot");
    assert_eq!(
        skill.description,
        "Diagnose BGP peering and convergence issues on Cisco IOS/IOS-XE"
    );
    assert_eq!(
        skill.when_to_use,
        "User asks about BGP problems, peer states, missing routes, or convergence"
    );
    assert_eq!(skill.scripts.len(), 2);
    assert_eq!(skill.scripts[0], "check_bgp.sh");
    assert_eq!(skill.scripts[1], "parse_adj_rib.py");
    assert_eq!(skill.allowed_commands.len(), 2);
    assert_eq!(skill.allowed_commands[0], "show bgp");
    assert_eq!(
        skill.body,
        "# BGP Troubleshooting Playbook\n\nCheck peer status first."
    );
}

#[test]
fn test_load_multiple_skills() {
    let temp_dir = TempDir::new().unwrap();
    let skills_dir = temp_dir.path().to_path_buf();

    create_test_skill(
        &skills_dir,
        "skill-one",
        "name: skill-one\ndescription: First skill\nwhen-to-use: Test one",
        "Body one",
    );

    create_test_skill(
        &skills_dir,
        "skill-two",
        "name: skill-two\ndescription: Second skill\nwhen-to-use: Test two",
        "Body two",
    );

    let loader = ccie_terminal_lib::skills::SkillsLoader::new(skills_dir);
    let mut skills = loader.load_all().unwrap();
    skills.sort_by(|a, b| a.id.cmp(&b.id));

    assert_eq!(skills.len(), 2);
    assert_eq!(skills[0].id, "skill-one");
    assert_eq!(skills[1].id, "skill-two");
}

#[test]
fn test_get_skill_by_id() {
    let temp_dir = TempDir::new().unwrap();
    let skills_dir = temp_dir.path().to_path_buf();

    create_test_skill(
        &skills_dir,
        "test-skill",
        "name: test-skill\ndescription: Test\nwhen-to-use: Testing",
        "Test body",
    );

    let loader = ccie_terminal_lib::skills::SkillsLoader::new(skills_dir);
    loader.load_all().unwrap();

    let skill = loader.get("test-skill").unwrap();
    assert_eq!(skill.id, "test-skill");
    assert_eq!(skill.body, "Test body");
}

#[test]
fn test_missing_skill() {
    let temp_dir = TempDir::new().unwrap();
    let skills_dir = temp_dir.path().to_path_buf();

    let loader = ccie_terminal_lib::skills::SkillsLoader::new(skills_dir);
    loader.load_all().unwrap();

    let result = loader.get("non-existent");
    assert!(result.is_none());
}

#[test]
fn test_skill_optional_fields() {
    let temp_dir = TempDir::new().unwrap();
    let skills_dir = temp_dir.path().to_path_buf();

    // Minimal skill with no scripts or allowed-commands
    create_test_skill(
        &skills_dir,
        "minimal",
        "name: minimal\ndescription: Minimal skill\nwhen-to-use: Testing minimal",
        "Minimal body",
    );

    let loader = ccie_terminal_lib::skills::SkillsLoader::new(skills_dir);
    let skills = loader.load_all().unwrap();

    assert_eq!(skills.len(), 1);
    let skill = &skills[0];
    assert_eq!(skill.scripts.len(), 0);
    assert_eq!(skill.allowed_commands.len(), 0);
}

#[test]
fn test_skip_invalid_skills() {
    let temp_dir = TempDir::new().unwrap();
    let skills_dir = temp_dir.path().to_path_buf();

    // Valid skill
    create_test_skill(
        &skills_dir,
        "valid",
        "name: valid\ndescription: Valid\nwhen-to-use: Valid test",
        "Valid",
    );

    // Invalid skill (no SKILL.md)
    let invalid_dir = skills_dir.join("invalid");
    fs::create_dir_all(&invalid_dir).unwrap();

    let loader = ccie_terminal_lib::skills::SkillsLoader::new(skills_dir);
    let skills = loader.load_all().unwrap();

    // Should only load the valid skill
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].id, "valid");
}

#[test]
fn test_reload_skill() {
    let temp_dir = TempDir::new().unwrap();
    let skills_dir = temp_dir.path().to_path_buf();

    create_test_skill(
        &skills_dir,
        "test",
        "name: test\ndescription: Original\nwhen-to-use: Test",
        "Original body",
    );

    let loader = ccie_terminal_lib::skills::SkillsLoader::new(skills_dir.clone());
    loader.load_all().unwrap();

    let skill = loader.get("test").unwrap();
    assert_eq!(skill.description, "Original");

    // Update the skill
    create_test_skill(
        &skills_dir,
        "test",
        "name: test\ndescription: Updated\nwhen-to-use: Test",
        "Updated body",
    );

    // Reload
    loader.reload_skill("test").unwrap();

    let skill = loader.get("test").unwrap();
    assert_eq!(skill.description, "Updated");
    assert_eq!(skill.body, "Updated body");
}
