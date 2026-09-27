use super::types::{IaCMetadata, ResourceAction, ResourceEvent};
use anyhow::Result;
use regex::Regex;
use serde::Deserialize;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

// Type definitions for parsing Terraform JSON events

#[derive(Debug, Deserialize)]
struct TerraformJsonEvent {
    #[serde(rename = "type")]
    type_field: String,
    #[serde(default)]
    hook: Option<TerraformHook>,
}

#[derive(Debug, Deserialize)]
struct TerraformHook {
    resource: Option<TerraformResource>,
    action: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TerraformResource {
    addr: Option<String>,
    #[serde(rename = "type")]
    #[allow(dead_code)]
    type_field: Option<String>,
    #[allow(dead_code)]
    name: Option<String>,
    #[serde(rename = "id")]
    id: Option<String>,
}

// Type definitions for parsing Ansible JSON output

#[derive(Debug, Deserialize)]
struct AnsibleJsonOutput {
    plays: Vec<AnsiblePlay>,
    #[allow(dead_code)]
    stats: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct AnsiblePlay {
    #[allow(dead_code)]
    play: AnsiblePlayInfo,
    tasks: Vec<AnsibleTask>,
}

#[derive(Debug, Deserialize)]
struct AnsiblePlayInfo {
    #[allow(dead_code)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct AnsibleTask {
    hosts: std::collections::HashMap<String, AnsibleTaskResult>,
    task: AnsibleTaskInfo,
}

#[derive(Debug, Deserialize)]
struct AnsibleTaskInfo {
    name: String,
}

#[derive(Debug, Deserialize)]
struct AnsibleTaskResult {
    changed: bool,
    failed: Option<bool>,
    msg: Option<String>,
}

// Regex patterns for human-readable output parsing

static CREATE_REGEX: OnceLock<Regex> = OnceLock::new();
static UPDATE_REGEX: OnceLock<Regex> = OnceLock::new();
static DESTROY_REGEX: OnceLock<Regex> = OnceLock::new();

fn get_create_regex() -> &'static Regex {
    CREATE_REGEX.get_or_init(|| Regex::new(r"(?m)^([a-z_][\w.\[\]]*): Creating\.\.\.$").unwrap())
}

fn get_update_regex() -> &'static Regex {
    UPDATE_REGEX.get_or_init(|| Regex::new(r"(?m)^([a-z_][\w.\[\]]*): Modifying\.\.\.$").unwrap())
}

fn get_destroy_regex() -> &'static Regex {
    DESTROY_REGEX.get_or_init(|| Regex::new(r"(?m)^([a-z_][\w.\[\]]*): Destroying\.\.\.$").unwrap())
}

// Public API

/// Parse terraform output (JSON or human-readable)
pub fn parse_terraform_output(raw_output: &str, subcommand: &str) -> Result<IaCMetadata> {
    // Try JSON first
    match parse_terraform_json(raw_output) {
        Ok(metadata) => Ok(metadata),
        Err(_) => parse_terraform_human_readable(raw_output, subcommand),
    }
}

/// Parse ansible-playbook JSON callback output
pub fn parse_ansible_output(raw_output: &str) -> Result<IaCMetadata> {
    // Try JSON format first (ANSIBLE_STDOUT_CALLBACK=json)
    if let Ok(metadata) = parse_ansible_json(raw_output) {
        return Ok(metadata);
    }

    // Fallback to human-readable format parser
    parse_ansible_human_readable(raw_output)
}

/// Parse Ansible JSON output (ANSIBLE_STDOUT_CALLBACK=json)
fn parse_ansible_json(raw_output: &str) -> Result<IaCMetadata> {
    let ansible_output: AnsibleJsonOutput = serde_json::from_str(raw_output)?;

    let mut events = Vec::new();
    let mut failed_count = 0;
    let mut changed_count = 0;

    for play in ansible_output.plays {
        for task in play.tasks {
            let task_name = task.task.name.clone();

            for (host, result) in task.hosts {
                let action = if result.failed.unwrap_or(false) {
                    failed_count += 1;
                    ResourceAction::Failed
                } else if result.changed {
                    changed_count += 1;
                    ResourceAction::Changed
                } else {
                    ResourceAction::Ok
                };

                events.push(ResourceEvent {
                    resource_type: "ansible_task".to_string(),
                    resource_name: task_name.clone(),
                    resource_id: Some(host.clone()),
                    action,
                    timestamp: current_timestamp(),
                    duration_ms: None,
                    error: result.msg,
                });
            }
        }
    }

    let total_tasks = events.len();

    Ok(IaCMetadata {
        resources_changed: changed_count,
        resources_failed: failed_count,
        resource_events: events,
        summary: format!(
            "{} tasks executed, {} changed, {} failed",
            total_tasks, changed_count, failed_count
        ),
    })
}

/// Parse Ansible human-readable output (default/`default` stdout callback).
///
/// Walks the output line-by-line, tracking the current `TASK [name]` header and
/// emitting one `ResourceEvent` per host-result line beneath it
/// (`ok:` / `changed:` / `failed:` / `fatal:` / `skipping:` / `unreachable:`).
/// This produces the per-task, per-host detail the enriched block renders.
/// The `PLAY RECAP` section is used only to reconcile the changed/failed counts.
fn parse_ansible_human_readable(raw_output: &str) -> Result<IaCMetadata> {
    // Host-result lines, e.g.:
    //   "ok: [device.example.test]"
    //   "changed: [web-01] => {...}"
    //   "ok: [device.example.test -> localhost] => {"
    //   "fatal: [web-03]: FAILED! => {"msg": "Connection timeout"}"
    //   "skipping: [device.example.test]"
    //   "[WARNING]: ..."  (ignored)
    let status_regex =
        Regex::new(r"(?m)^(ok|changed|failed|fatal|skipping|unreachable):\s+\[([^\]]+)\](.*)$")?;
    let task_regex = Regex::new(r"(?m)^(?:TASK|RUNNING HANDLER)\s+\[(.+?)\]\s*\**\s*$")?;
    let recap_regex = Regex::new(
        r"(?m)^(.+?)\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)",
    )?;

    let mut events = Vec::new();
    let mut current_task = "task".to_string();

    for line in raw_output.lines() {
        let trimmed = line.trim_start();

        if let Some(cap) = task_regex.captures(trimmed) {
            current_task = cap
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            continue;
        }

        let Some(cap) = status_regex.captures(trimmed) else {
            continue;
        };

        let status = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        // The host token can be "host" or "host -> delegate"; keep the primary host.
        let host_raw = cap.get(2).map(|m| m.as_str()).unwrap_or("unknown");
        let host = host_raw
            .split("->")
            .next()
            .unwrap_or(host_raw)
            .trim()
            .to_string();
        let rest = cap.get(3).map(|m| m.as_str()).unwrap_or("");

        let (action, error) = match status {
            "changed" => (ResourceAction::Changed, None),
            "failed" | "fatal" | "unreachable" => {
                (ResourceAction::Failed, extract_ansible_error(rest))
            }
            "skipping" => (ResourceAction::Skipped, None),
            _ => (ResourceAction::Ok, None),
        };

        events.push(ResourceEvent {
            resource_type: "ansible_task".to_string(),
            resource_name: current_task.clone(),
            resource_id: Some(host),
            action,
            timestamp: current_timestamp(),
            duration_ms: None,
            error,
        });
    }

    // Reconcile counts. Prefer the authoritative PLAY RECAP totals when present;
    // otherwise fall back to counting the events we extracted.
    let mut recap_changed = 0u32;
    let mut recap_failed = 0u32;
    let mut recap_ok = 0u32;
    let mut have_recap = false;
    for cap in recap_regex.captures_iter(raw_output) {
        have_recap = true;
        recap_ok += cap
            .get(2)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);
        recap_changed += cap
            .get(3)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);
        recap_failed += cap
            .get(5)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0);
    }

    // If we found neither per-task lines nor a recap, this isn't ansible output.
    if events.is_empty() && !have_recap {
        return Err(anyhow::anyhow!(
            "No Ansible task results or PLAY RECAP found in output"
        ));
    }

    let (resources_changed, resources_failed) = if have_recap {
        (recap_changed, recap_failed)
    } else {
        let changed = events
            .iter()
            .filter(|e| e.action == ResourceAction::Changed)
            .count() as u32;
        let failed = events
            .iter()
            .filter(|e| e.action == ResourceAction::Failed)
            .count() as u32;
        (changed, failed)
    };

    let total_tasks = if have_recap {
        (recap_ok + recap_failed) as usize
    } else {
        events.len()
    };

    Ok(IaCMetadata {
        resources_changed,
        resources_failed,
        resource_events: events,
        summary: format!(
            "{} task results, {} changed, {} failed",
            total_tasks, resources_changed, resources_failed
        ),
    })
}

/// Best-effort extraction of a failure message from the tail of an Ansible
/// `failed:`/`fatal:` line. These usually look like:
///   `: FAILED! => {"msg": "Connection timeout", ...}`
/// Falls back to the trimmed tail when no `msg` field is present.
fn extract_ansible_error(rest: &str) -> Option<String> {
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }

    // Try to pull a JSON object out of the line and read its "msg" field.
    if let Some(start) = rest.find('{') {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&rest[start..]) {
            if let Some(msg) = val.get("msg").and_then(|m| m.as_str()) {
                if !msg.trim().is_empty() {
                    return Some(msg.trim().to_string());
                }
            }
        }
    }

    // Fall back to the human text after a leading "=>"/":" marker.
    let cleaned = rest.trim_start_matches([':', '=', '>', ' ']).trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

/// Parse terraform JSON output (terraform apply -json)
fn parse_terraform_json(json_output: &str) -> Result<IaCMetadata> {
    let mut resource_events = Vec::new();
    let mut resources_changed = 0u32;
    let resources_failed = 0u32;

    // Parse line-by-line (terraform outputs newline-delimited JSON)
    for line in json_output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Parse each JSON line
        let event: TerraformJsonEvent = match serde_json::from_str(line) {
            Ok(e) => e,
            Err(e) => {
                // Skip malformed lines (e.g., non-JSON Terraform output mixed in)
                eprintln!("Skipping malformed JSON line in Terraform output: {}", e);
                continue;
            }
        };

        // Filter for apply_complete events
        if event.type_field != "apply_complete" {
            continue;
        }

        let Some(hook) = event.hook else {
            continue;
        };
        let Some(resource) = hook.resource else {
            continue;
        };
        let Some(action_str) = hook.action else {
            continue;
        };

        // Map action string to ResourceAction enum
        let action = match action_str.to_lowercase().as_str() {
            "create" => ResourceAction::Create,
            "update" => ResourceAction::Update,
            "delete" | "destroy" => ResourceAction::Destroy,
            _ => continue,
        };

        // Extract resource details
        let addr = resource.addr.unwrap_or_default();
        let (resource_type, resource_name) = split_resource_name(&addr);

        // Count changed resources (Create + Update)
        if matches!(action, ResourceAction::Create | ResourceAction::Update) {
            resources_changed += 1;
        }

        resource_events.push(ResourceEvent {
            resource_type,
            resource_name,
            resource_id: resource.id,
            action,
            timestamp: current_timestamp(),
            duration_ms: None,
            error: None,
        });
    }

    // Build summary
    // NOTE: resources_failed is always 0 for JSON output because Terraform JSON events
    // only report successful operations (apply_complete). Failed resources appear as
    // diagnostic messages but not in apply_complete events. This limitation will be
    // addressed when we implement error event parsing in a future iteration.
    let summary = if resource_events.is_empty() {
        "No resources changed".to_string()
    } else {
        format!(
            "{} resources changed, {} failed",
            resources_changed, resources_failed
        )
    };

    Ok(IaCMetadata {
        resources_changed,
        resources_failed,
        resource_events,
        summary,
    })
}

/// Parse human-readable terraform output (fallback)
fn parse_terraform_human_readable(output: &str, _subcommand: &str) -> Result<IaCMetadata> {
    let mut resource_events = Vec::new();
    let mut resources_changed = 0u32;
    let resources_failed = 0u32;

    // Match all Creating patterns
    for cap in get_create_regex().captures_iter(output) {
        let full_name = &cap[1];
        let (resource_type, resource_name) = split_resource_name(full_name);

        resources_changed += 1;
        resource_events.push(ResourceEvent {
            resource_type,
            resource_name,
            resource_id: None,
            action: ResourceAction::Create,
            timestamp: current_timestamp(),
            duration_ms: None,
            error: None,
        });
    }

    // Match all Modifying patterns
    for cap in get_update_regex().captures_iter(output) {
        let full_name = &cap[1];
        let (resource_type, resource_name) = split_resource_name(full_name);

        resources_changed += 1;
        resource_events.push(ResourceEvent {
            resource_type,
            resource_name,
            resource_id: None,
            action: ResourceAction::Update,
            timestamp: current_timestamp(),
            duration_ms: None,
            error: None,
        });
    }

    // Match all Destroying patterns
    for cap in get_destroy_regex().captures_iter(output) {
        let full_name = &cap[1];
        let (resource_type, resource_name) = split_resource_name(full_name);

        // Note: Destroying doesn't increment resources_changed
        resource_events.push(ResourceEvent {
            resource_type,
            resource_name,
            resource_id: None,
            action: ResourceAction::Destroy,
            timestamp: current_timestamp(),
            duration_ms: None,
            error: None,
        });
    }

    // Build summary
    let summary = if resource_events.is_empty() {
        "No resources changed".to_string()
    } else {
        format!(
            "{} resources changed, {} failed",
            resources_changed, resources_failed
        )
    };

    Ok(IaCMetadata {
        resources_changed,
        resources_failed,
        resource_events,
        summary,
    })
}

// Helpers

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn split_resource_name(full_name: &str) -> (String, String) {
    // Use rsplit_once to split on the LAST dot, handling module paths correctly
    // e.g., "module.vpc.aws_subnet.private" → ("module.vpc.aws_subnet", "private")
    if let Some((resource_type, resource_name)) = full_name.rsplit_once('.') {
        (resource_type.to_string(), resource_name.to_string())
    } else {
        ("unknown".to_string(), full_name.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metadata_serializes_camelcase_for_frontend() {
        // The frontend `parseIaCExecution` reads camelCase keys
        // (resourceEvents, resourceType, resourceName). If the stored
        // metadata_json were snake_case the IaC block would render blank /
        // crash on `.resourceEvents.filter(...)`. Lock the JSON shape here.
        let metadata = IaCMetadata {
            resources_changed: 1,
            resources_failed: 0,
            resource_events: vec![ResourceEvent {
                resource_type: "ansible_host".to_string(),
                resource_name: "device.example.test".to_string(),
                resource_id: Some("device.example.test".to_string()),
                action: ResourceAction::Changed,
                timestamp: 1,
                duration_ms: None,
                error: None,
            }],
            summary: "1 changed".to_string(),
        };

        let json = serde_json::to_string(&metadata).unwrap();
        // Top-level IaCMetadata keys
        assert!(json.contains("\"resourcesChanged\""), "json: {json}");
        assert!(json.contains("\"resourceEvents\""), "json: {json}");
        assert!(!json.contains("\"resource_events\""), "json: {json}");
        // Nested ResourceEvent keys
        assert!(json.contains("\"resourceType\""), "json: {json}");
        assert!(json.contains("\"resourceName\""), "json: {json}");
        assert!(!json.contains("\"resource_type\""), "json: {json}");
        // Action enum stays PascalCase (frontend ResourceAction union)
        assert!(json.contains("\"Changed\""), "json: {json}");
    }

    #[test]
    fn test_parse_terraform_json_apply() {
        let json_output = r#"{"@level":"info","@message":"Terraform 1.5.0","@module":"terraform.ui","@timestamp":"2024-01-15T10:00:00.000000Z","terraform":"1.5.0","type":"version","ui":"1.0"}
{"@level":"info","@message":"aws_security_group.alb: Creating...","@module":"terraform.ui","@timestamp":"2024-01-15T10:00:01.000000Z","type":"apply_start","hook":{"resource":{"addr":"aws_security_group.alb","type":"aws_security_group","name":"alb"},"action":"create"}}
{"@level":"info","@message":"aws_security_group.alb: Creation complete after 2s [id=sg-abc123]","@module":"terraform.ui","@timestamp":"2024-01-15T10:00:03.000000Z","type":"apply_complete","hook":{"resource":{"addr":"aws_security_group.alb","type":"aws_security_group","name":"alb","id":"sg-abc123"},"action":"create"}}
{"@level":"info","@message":"Apply complete! Resources: 1 added, 0 changed, 0 destroyed.","@module":"terraform.ui","@timestamp":"2024-01-15T10:00:03.100000Z","type":"change_summary","changes":{"add":1,"change":0,"remove":0,"operation":"apply"}}"#;

        let result = parse_terraform_json(json_output).unwrap();

        // Verify resource counts
        assert_eq!(result.resources_changed, 1);
        assert_eq!(result.resources_failed, 0);

        // Verify we captured 1 event
        assert_eq!(result.resource_events.len(), 1);

        // Verify event details
        let event = &result.resource_events[0];
        assert_eq!(event.resource_type, "aws_security_group");
        assert_eq!(event.resource_name, "alb");
        assert_eq!(event.resource_id, Some("sg-abc123".to_string()));
        assert_eq!(event.action, ResourceAction::Create);
    }

    #[test]
    fn test_parse_terraform_human_readable_apply() {
        let output = r#"
Terraform will perform the following actions:

  # aws_security_group.alb will be created
  + resource "aws_security_group" "alb" {
      + arn                    = (known after apply)
      + id                     = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.

aws_security_group.alb: Creating...
aws_security_group.alb: Creation complete after 2s [id=sg-abc123]

Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
"#;

        let result = parse_terraform_human_readable(output, "apply").unwrap();

        assert_eq!(result.resources_changed, 1);
        assert_eq!(result.resource_events.len(), 1);

        let event = &result.resource_events[0];
        assert_eq!(event.resource_type, "aws_security_group");
        assert_eq!(event.resource_name, "alb");
        assert_eq!(event.action, ResourceAction::Create);
    }

    #[test]
    fn test_parse_terraform_human_readable_multi_action() {
        let output = r#"
aws_instance.web: Creating...
aws_security_group.lb: Modifying...
aws_instance.old: Destroying...

Apply complete! Resources: 1 added, 1 changed, 1 destroyed.
"#;

        let result = parse_terraform_human_readable(output, "apply").unwrap();

        // Only Create and Update count as "changed"
        assert_eq!(result.resources_changed, 2);
        assert_eq!(result.resource_events.len(), 3);

        let create_event = result
            .resource_events
            .iter()
            .find(|e| e.action == ResourceAction::Create)
            .unwrap();
        assert_eq!(create_event.resource_type, "aws_instance");
        assert_eq!(create_event.resource_name, "web");

        let update_event = result
            .resource_events
            .iter()
            .find(|e| e.action == ResourceAction::Update)
            .unwrap();
        assert_eq!(update_event.resource_type, "aws_security_group");
        assert_eq!(update_event.resource_name, "lb");

        let destroy_event = result
            .resource_events
            .iter()
            .find(|e| e.action == ResourceAction::Destroy)
            .unwrap();
        assert_eq!(destroy_event.resource_type, "aws_instance");
        assert_eq!(destroy_event.resource_name, "old");
    }

    #[test]
    fn test_parse_terraform_human_readable_modules() {
        let output = r#"
module.vpc.aws_subnet.private: Creating...
module.networking.module.dns.aws_route53_zone.main: Modifying...

Apply complete! Resources: 1 added, 1 changed, 0 destroyed.
"#;

        let result = parse_terraform_human_readable(output, "apply").unwrap();

        assert_eq!(result.resources_changed, 2);
        assert_eq!(result.resource_events.len(), 2);

        let subnet_event = &result.resource_events[0];
        assert_eq!(subnet_event.resource_type, "module.vpc.aws_subnet");
        assert_eq!(subnet_event.resource_name, "private");

        let route53_event = &result.resource_events[1];
        assert_eq!(
            route53_event.resource_type,
            "module.networking.module.dns.aws_route53_zone"
        );
        assert_eq!(route53_event.resource_name, "main");
    }

    #[test]
    fn test_parse_terraform_human_readable_empty() {
        let output = "No changes. Your infrastructure matches the configuration.";

        let result = parse_terraform_human_readable(output, "apply").unwrap();

        assert_eq!(result.resources_changed, 0);
        assert_eq!(result.resources_failed, 0);
        assert_eq!(result.resource_events.len(), 0);
        assert_eq!(result.summary, "No resources changed");
    }

    #[test]
    fn test_split_resource_name_edge_cases() {
        // Simple resource
        let (rtype, rname) = split_resource_name("aws_instance.web");
        assert_eq!(rtype, "aws_instance");
        assert_eq!(rname, "web");

        // Module resource
        let (rtype, rname) = split_resource_name("module.vpc.aws_subnet.private");
        assert_eq!(rtype, "module.vpc.aws_subnet");
        assert_eq!(rname, "private");

        // Deeply nested module
        let (rtype, rname) = split_resource_name("module.a.module.b.module.c.aws_s3_bucket.data");
        assert_eq!(rtype, "module.a.module.b.module.c.aws_s3_bucket");
        assert_eq!(rname, "data");

        // No dot separator
        let (rtype, rname) = split_resource_name("invalid_name");
        assert_eq!(rtype, "unknown");
        assert_eq!(rname, "invalid_name");

        // Empty string
        let (rtype, rname) = split_resource_name("");
        assert_eq!(rtype, "unknown");
        assert_eq!(rname, "");
    }

    #[test]
    fn test_parse_ansible_json_playbook() {
        let json_output = r#"
{
  "plays": [
    {
      "play": {"name": "Deploy nginx"},
      "tasks": [
        {
          "task": {"name": "Install nginx"},
          "hosts": {
            "web-01": {"changed": true, "failed": false},
            "web-02": {"changed": true, "failed": false},
            "web-03": {"changed": false, "failed": true, "msg": "Connection timeout"}
          }
        }
      ]
    }
  ],
  "stats": {}
}
"#;

        let result = parse_ansible_output(json_output).unwrap();

        assert_eq!(result.resources_changed, 2); // web-01 and web-02 changed
        assert_eq!(result.resources_failed, 1); // web-03 failed
        assert_eq!(result.resource_events.len(), 3);

        // Check web-03 failed event
        let failed_event = result
            .resource_events
            .iter()
            .find(|e| e.resource_id.as_deref() == Some("web-03"))
            .unwrap();
        assert_eq!(failed_event.action, ResourceAction::Failed);
        assert_eq!(failed_event.error.as_deref(), Some("Connection timeout"));
    }

    #[test]
    fn test_parse_ansible_human_readable_per_task() {
        // Mirrors a real `default` callback run (the push-vlan.yml output the
        // user reported). The enriched block must show per-task host results,
        // not an empty body, even on a 0-changed run.
        let output = r#"
PLAY [Push VLAN] ***************************************************************

TASK [Ensure cisco.ios collection is available] *******************************
ok: [device.example.test -> localhost] => {
    "msg": "Using Cisco IOS modules from cisco.ios collection"
}

TASK [Create VLAN 78] *********************************************************
[WARNING]: ansible-pylibssh not installed, falling back to paramiko
ok: [device.example.test]

TASK [Show VLAN creation result] **********************************************
ok: [device.example.test] => {
    "msg": "VLAN 78 already exists on device.example.test"
}

TASK [Save configuration] *****************************************************
skipping: [device.example.test]

TASK [Verify VLAN configuration] **********************************************
ok: [device.example.test]

PLAY RECAP *********************************************************************
device.example.test                 : ok=5    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
"#;

        let result = parse_ansible_output(output).unwrap();

        assert_eq!(result.resources_changed, 0);
        assert_eq!(result.resources_failed, 0);

        // 4 ok + 1 skipping = 5 events (the WARNING line is ignored)
        assert_eq!(
            result.resource_events.len(),
            5,
            "events: {:#?}",
            result.resource_events
        );

        let ok_events: Vec<_> = result
            .resource_events
            .iter()
            .filter(|e| e.action == ResourceAction::Ok)
            .collect();
        assert_eq!(ok_events.len(), 4);

        let skipped: Vec<_> = result
            .resource_events
            .iter()
            .filter(|e| e.action == ResourceAction::Skipped)
            .collect();
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].resource_name, "Save configuration");
        assert_eq!(skipped[0].resource_id.as_deref(), Some("device.example.test"));

        // Task names are captured from the TASK [...] headers
        assert!(result
            .resource_events
            .iter()
            .any(|e| e.resource_name == "Create VLAN 78"));
    }

    #[test]
    fn test_parse_ansible_human_readable_failure() {
        let output = r#"
TASK [Deploy config] **********************************************************
changed: [web-01]
fatal: [web-02]: FAILED! => {"msg": "Connection timeout", "unreachable": false}

PLAY RECAP *********************************************************************
web-01                     : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
web-02                     : ok=0    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
"#;

        let result = parse_ansible_output(output).unwrap();

        assert_eq!(result.resources_changed, 1);
        assert_eq!(result.resources_failed, 1);
        assert_eq!(result.resource_events.len(), 2);

        let failed = result
            .resource_events
            .iter()
            .find(|e| e.action == ResourceAction::Failed)
            .unwrap();
        assert_eq!(failed.resource_id.as_deref(), Some("web-02"));
        assert_eq!(failed.error.as_deref(), Some("Connection timeout"));

        let changed = result
            .resource_events
            .iter()
            .find(|e| e.action == ResourceAction::Changed)
            .unwrap();
        assert_eq!(changed.resource_id.as_deref(), Some("web-01"));
        assert_eq!(changed.resource_name, "Deploy config");
    }

    #[test]
    fn test_ansible_human_readable_serializes_skipped() {
        // The frontend ResourceAction union must receive "Skipped" verbatim.
        let metadata = IaCMetadata {
            resources_changed: 0,
            resources_failed: 0,
            resource_events: vec![ResourceEvent {
                resource_type: "ansible_task".to_string(),
                resource_name: "Save configuration".to_string(),
                resource_id: Some("device.example.test".to_string()),
                action: ResourceAction::Skipped,
                timestamp: 1,
                duration_ms: None,
                error: None,
            }],
            summary: "1 skipped".to_string(),
        };
        let json = serde_json::to_string(&metadata).unwrap();
        assert!(json.contains("\"Skipped\""), "json: {json}");
    }
}
