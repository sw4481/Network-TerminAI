use super::types::{IaCCommand, IaCTool};
use regex::Regex;
use std::path::Path;
use std::sync::OnceLock;

static TERRAFORM_PATTERN: OnceLock<Regex> = OnceLock::new();
static ANSIBLE_PLAYBOOK_PATTERN: OnceLock<Regex> = OnceLock::new();
static ANSIBLE_ADHOC_PATTERN: OnceLock<Regex> = OnceLock::new();

const TERRAFORM_MUTATING_SUBCOMMANDS: &[&str] = &[
    "apply", "destroy", "import", "taint", "untaint"
];

fn get_terraform_pattern() -> &'static Regex {
    TERRAFORM_PATTERN.get_or_init(|| {
        Regex::new(r"^(terraform|tf)\s+(\S+)(.*)$").expect("Failed to compile terraform regex")
    })
}

fn get_ansible_playbook_pattern() -> &'static Regex {
    ANSIBLE_PLAYBOOK_PATTERN.get_or_init(|| {
        Regex::new(r"^ansible-playbook\s+(.*)$").expect("Failed to compile ansible-playbook regex")
    })
}

fn get_ansible_adhoc_pattern() -> &'static Regex {
    ANSIBLE_ADHOC_PATTERN.get_or_init(|| {
        Regex::new(r"^ansible\s+(.+?)\s+-m\s+(\S+)(.*)$")
            .expect("Failed to compile ansible ad-hoc regex")
    })
}

/// Parse flags and args from a command string.
/// Returns (flags, args) where:
/// - flags: tokens starting with `-` or `--`, including their values if space-separated
/// - args: positional arguments (tokens that don't start with `-` and aren't flag values)
///
/// This handles common flag patterns like:
/// - `-var-file=prod.tfvars` (flag with = separator)
/// - `-i production` (flag with space-separated value)
/// - `deploy.yml` (positional argument)
fn parse_flags_and_args(remainder: &str) -> (Vec<String>, Vec<String>) {
    let mut flags = Vec::new();
    let mut args = Vec::new();
    let mut tokens = remainder.split_whitespace().peekable();

    while let Some(token) = tokens.next() {
        if token.starts_with('-') {
            // This is a flag
            if token.contains('=') {
                // Flag with embedded value like -var-file=prod.tfvars
                flags.push(token.to_string());
            } else {
                // Flag might have a space-separated value
                // Peek at next token to see if it's a value or another flag/arg
                if let Some(next) = tokens.peek() {
                    if !next.starts_with('-') && !next.ends_with(".yml") && !next.ends_with(".yaml")
                        && !next.ends_with(".tf") && !next.ends_with(".json") {
                        // Next token looks like a flag value, consume it
                        let value = tokens.next().unwrap();
                        flags.push(format!("{} {}", token, value));
                    } else {
                        // Next token is another flag or a file argument
                        flags.push(token.to_string());
                    }
                } else {
                    // No next token, just a standalone flag
                    flags.push(token.to_string());
                }
            }
        } else {
            // This is a positional argument
            args.push(token.to_string());
        }
    }

    (flags, args)
}

pub fn detect_iac_command(cmd: &str, working_dir: &Path) -> Option<IaCCommand> {
    let cmd = cmd.trim();

    // Try terraform pattern (terraform or tf alias)
    if let Some(caps) = get_terraform_pattern().captures(cmd) {
        let subcommand = caps.get(2)?.as_str().to_string();
        let remainder = caps.get(3).map(|m| m.as_str()).unwrap_or("");
        let (flags, args) = parse_flags_and_args(remainder);

        let is_mutating = TERRAFORM_MUTATING_SUBCOMMANDS.contains(&subcommand.as_str());

        return Some(IaCCommand {
            tool: IaCTool::Terraform,
            subcommand,
            flags,
            args,
            working_dir: working_dir.to_path_buf(),
            is_mutating,
        });
    }

    // Try ansible-playbook pattern
    if let Some(caps) = get_ansible_playbook_pattern().captures(cmd) {
        let remainder = caps.get(1)?.as_str();
        let (flags, args) = parse_flags_and_args(remainder);

        return Some(IaCCommand {
            tool: IaCTool::Ansible,
            subcommand: "playbook".to_string(),
            flags,
            args,
            working_dir: working_dir.to_path_buf(),
            is_mutating: true, // ansible-playbook is always mutating
        });
    }

    // Try ansible ad-hoc pattern
    if let Some(caps) = get_ansible_adhoc_pattern().captures(cmd) {
        let target = caps.get(1)?.as_str();
        let module = caps.get(2)?.as_str();
        let remainder = caps.get(3).map(|m| m.as_str()).unwrap_or("");
        let (flags, mut args) = parse_flags_and_args(remainder);

        // Prepend target and module to args
        args.insert(0, target.to_string());
        args.insert(1, module.to_string());

        return Some(IaCCommand {
            tool: IaCTool::Ansible,
            subcommand: "adhoc".to_string(),
            flags,
            args,
            working_dir: working_dir.to_path_buf(),
            is_mutating: true, // ansible ad-hoc is always mutating
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_detect_terraform_apply() {
        let cmd = "terraform apply -var-file=prod.tfvars";
        let cwd = PathBuf::from("/test/project");

        let result = detect_iac_command(cmd, &cwd);
        assert!(result.is_some());

        let iac_cmd = result.unwrap();
        assert_eq!(iac_cmd.tool, IaCTool::Terraform);
        assert_eq!(iac_cmd.subcommand, "apply");
        assert_eq!(iac_cmd.flags, vec!["-var-file=prod.tfvars"]);
        assert!(iac_cmd.is_mutating);
    }

    #[test]
    fn test_detect_terraform_plan() {
        let cmd = "terraform plan";
        let cwd = PathBuf::from("/test/project");

        let result = detect_iac_command(cmd, &cwd);
        assert!(result.is_some());

        let iac_cmd = result.unwrap();
        assert_eq!(iac_cmd.subcommand, "plan");
        assert!(!iac_cmd.is_mutating);
    }

    #[test]
    fn test_detect_terraform_alias() {
        let cmd = "tf apply";
        let cwd = PathBuf::from("/test/project");

        let result = detect_iac_command(cmd, &cwd);
        assert!(result.is_some());
        assert_eq!(result.unwrap().tool, IaCTool::Terraform);
    }

    #[test]
    fn test_detect_ansible_playbook() {
        let cmd = "ansible-playbook -i production deploy.yml";
        let cwd = PathBuf::from("/test/ansible");

        let result = detect_iac_command(cmd, &cwd);
        assert!(result.is_some());

        let iac_cmd = result.unwrap();
        assert_eq!(iac_cmd.tool, IaCTool::Ansible);
        assert_eq!(iac_cmd.subcommand, "playbook");
        assert_eq!(iac_cmd.args, vec!["deploy.yml"]);
        assert!(iac_cmd.is_mutating);
    }

    #[test]
    fn test_no_detection_for_other_commands() {
        let cmd = "ls -la";
        let cwd = PathBuf::from("/test");

        let result = detect_iac_command(cmd, &cwd);
        assert!(result.is_none());
    }
}
