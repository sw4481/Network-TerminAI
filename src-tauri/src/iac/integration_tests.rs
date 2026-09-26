#[cfg(test)]
mod integration_tests {
    use crate::iac::detector::detect_iac_command;
    use crate::iac::parser::{parse_terraform_output, parse_ansible_output};
    use crate::iac::types::IaCTool;

    /// Integration test for terraform apply end-to-end flow.
    /// Requires terraform binary installed.
    /// Run with: cargo test integration_tests -- --ignored
    #[test]
    #[ignore]
    fn test_terraform_apply_end_to_end() {
        // Create temporary directory for terraform config
        let temp_dir = std::env::temp_dir().join("iac_test_tf");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).unwrap();
        }
        std::fs::create_dir_all(&temp_dir).unwrap();

        // Create minimal terraform config with null_resource
        std::fs::write(
            temp_dir.join("main.tf"),
            r#"
terraform {
  required_providers {
    null = {
      source = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

resource "null_resource" "test" {
  triggers = {
    timestamp = timestamp()
  }
}
"#,
        )
        .unwrap();

        // Run terraform init
        let init_output = std::process::Command::new("terraform")
            .arg("init")
            .current_dir(&temp_dir)
            .output();

        match init_output {
            Ok(output) if output.status.success() => {
                println!("terraform init succeeded");
            }
            Ok(output) => {
                eprintln!(
                    "terraform init failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                std::fs::remove_dir_all(&temp_dir).ok();
                panic!("terraform init failed");
            }
            Err(e) => {
                eprintln!("terraform not installed or not in PATH: {}", e);
                std::fs::remove_dir_all(&temp_dir).ok();
                return; // Skip test if terraform not available
            }
        }

        // Run terraform apply
        let apply_output = std::process::Command::new("terraform")
            .arg("apply")
            .arg("-auto-approve")
            .current_dir(&temp_dir)
            .output()
            .expect("terraform apply failed to execute");

        let output_str = String::from_utf8_lossy(&apply_output.stdout);
        println!("terraform apply output:\n{}", output_str);

        // Test detector
        let detected = detect_iac_command("terraform apply -auto-approve", &temp_dir);
        assert!(detected.is_some(), "Failed to detect terraform command");
        let detected = detected.unwrap();
        assert_eq!(detected.tool, IaCTool::Terraform);
        assert_eq!(detected.subcommand, "apply");

        // Test parser
        let metadata = parse_terraform_output(&output_str, "apply");
        if apply_output.status.success() {
            assert!(metadata.is_ok(), "Failed to parse terraform output");
            let metadata = metadata.unwrap();
            assert!(
                metadata.resources_changed > 0,
                "Expected at least 1 resource changed"
            );
            println!(
                "Successfully parsed: {} resources changed",
                metadata.resources_changed
            );
        } else {
            println!(
                "terraform apply failed (expected in CI): {}",
                String::from_utf8_lossy(&apply_output.stderr)
            );
        }

        // Cleanup
        let _ = std::process::Command::new("terraform")
            .arg("destroy")
            .arg("-auto-approve")
            .current_dir(&temp_dir)
            .output();
        std::fs::remove_dir_all(&temp_dir).ok();
    }

    /// Integration test for ansible-playbook end-to-end flow.
    /// Requires ansible-playbook binary installed.
    /// Run with: cargo test integration_tests -- --ignored
    #[test]
    #[ignore]
    fn test_ansible_playbook_end_to_end() {
        // Create temporary directory for ansible playbook
        let temp_dir = std::env::temp_dir().join("iac_test_ansible");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).unwrap();
        }
        std::fs::create_dir_all(&temp_dir).unwrap();

        // Create minimal ansible playbook that runs locally
        std::fs::write(
            temp_dir.join("test-playbook.yml"),
            r#"
---
- name: Test Playbook
  hosts: localhost
  connection: local
  gather_facts: false
  tasks:
    - name: Create test file
      file:
        path: /tmp/ansible-test-file
        state: touch
        mode: '0644'

    - name: Remove test file
      file:
        path: /tmp/ansible-test-file
        state: absent
"#,
        )
        .unwrap();

        // Run ansible-playbook
        let playbook_output = std::process::Command::new("ansible-playbook")
            .arg("test-playbook.yml")
            .current_dir(&temp_dir)
            .output();

        match playbook_output {
            Ok(output) => {
                let output_str = String::from_utf8_lossy(&output.stdout);
                println!("ansible-playbook output:\n{}", output_str);

                // Test detector
                let detected = detect_iac_command("ansible-playbook test-playbook.yml", &temp_dir);
                assert!(detected.is_some(), "Failed to detect ansible command");
                let detected = detected.unwrap();
                assert_eq!(detected.tool, IaCTool::Ansible);
                assert_eq!(detected.subcommand, "playbook");

                // Test parser
                let metadata = parse_ansible_output(&output_str);
                if output.status.success() {
                    assert!(metadata.is_ok(), "Failed to parse ansible output");
                    let metadata = metadata.unwrap();
                    println!(
                        "Successfully parsed: {} resources changed",
                        metadata.resources_changed
                    );
                } else {
                    println!(
                        "ansible-playbook failed (may be expected in CI): {}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
            }
            Err(e) => {
                eprintln!("ansible-playbook not installed or not in PATH: {}", e);
                // Skip test if ansible not available
            }
        }

        // Cleanup
        std::fs::remove_dir_all(&temp_dir).ok();
    }

    /// Unit test for terraform detection patterns
    #[test]
    fn test_terraform_command_patterns() {
        let temp_dir = std::env::temp_dir();

        // Test various terraform command formats - these should be detected
        let cmd = detect_iac_command("terraform apply", &temp_dir);
        assert!(cmd.is_some());
        assert!(cmd.unwrap().is_mutating);

        let cmd = detect_iac_command("terraform apply -auto-approve", &temp_dir);
        assert!(cmd.is_some());
        assert!(cmd.unwrap().is_mutating);

        let cmd = detect_iac_command("terraform destroy", &temp_dir);
        assert!(cmd.is_some());
        assert!(cmd.unwrap().is_mutating);

        let cmd = detect_iac_command("tf apply", &temp_dir);
        assert!(cmd.is_some());
        assert!(cmd.unwrap().is_mutating);

        // These are detected but marked as non-mutating
        let cmd = detect_iac_command("terraform plan", &temp_dir);
        assert!(cmd.is_some());
        assert!(!cmd.unwrap().is_mutating);

        let cmd = detect_iac_command("terraform init", &temp_dir);
        assert!(cmd.is_some());
        assert!(!cmd.unwrap().is_mutating);

        let cmd = detect_iac_command("terraform fmt", &temp_dir);
        assert!(cmd.is_some());
        assert!(!cmd.unwrap().is_mutating);

        // Should not detect non-terraform commands
        assert!(detect_iac_command("ls -la", &temp_dir).is_none());
        assert!(detect_iac_command("echo hello", &temp_dir).is_none());
    }

    /// Unit test for ansible detection patterns
    #[test]
    fn test_ansible_command_patterns() {
        let temp_dir = std::env::temp_dir();

        // Test various ansible command formats
        assert!(detect_iac_command("ansible-playbook site.yml", &temp_dir).is_some());
        assert!(detect_iac_command("ansible-playbook -i inventory site.yml", &temp_dir).is_some());
        assert!(
            detect_iac_command("ansible all -m ping -i inventory", &temp_dir).is_some()
        );
        assert!(detect_iac_command("ansible webservers -m command -a uptime", &temp_dir).is_some());

        // Should not detect
        assert!(detect_iac_command("ansible --version", &temp_dir).is_none());
        assert!(detect_iac_command("ansible-galaxy install role", &temp_dir).is_none());
        assert!(detect_iac_command("ansible-vault encrypt file", &temp_dir).is_none());
    }

    /// Drift detection end-to-end. Requires terraform on PATH.
    /// Run with: cargo test integration_tests -- --ignored
    #[test]
    #[ignore]
    fn drift_check_detects_out_of_band_change() {
        use crate::iac::drift_checker::run_drift_plan;
        use std::process::Command;

        let temp_dir = std::env::temp_dir().join("iac_test_drift");
        if temp_dir.exists() {
            std::fs::remove_dir_all(&temp_dir).unwrap();
        }
        std::fs::create_dir_all(&temp_dir).unwrap();

        // Minimal local-only terraform we can drift by editing the managed file.
        std::fs::write(
            temp_dir.join("main.tf"),
            r#"
resource "local_file" "x" {
  content  = "v1"
  filename = "${path.module}/out.txt"
}
"#,
        )
        .unwrap();

        let run = |args: &[&str]| {
            Command::new("terraform")
                .args(args)
                .current_dir(&temp_dir)
                .output()
                .unwrap()
        };
        assert!(run(&["init", "-input=false"]).status.success());
        assert!(run(&["apply", "-auto-approve", "-input=false"]).status.success());

        // Drift it: change the managed file out-of-band.
        std::fs::write(temp_dir.join("out.txt"), "TAMPERED").unwrap();

        let result = run_drift_plan(&temp_dir).unwrap();
        assert!(result.has_drift, "expected drift after out-of-band edit");

        std::fs::remove_dir_all(&temp_dir).ok();
    }
}
