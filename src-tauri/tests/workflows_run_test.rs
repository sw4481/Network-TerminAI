use ccie_terminal_lib::commands::workflows::{
    render_template, workflow_run_impl, workflow_upsert_impl, Workflow, WorkflowParam,
    WorkflowStep,
};
use rusqlite::Connection;
use std::collections::HashMap;

fn schema() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '',
          vendor TEXT, platform TEXT DEFAULT '', tags TEXT DEFAULT '[]',
          created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
        CREATE TABLE workflow_steps (workflow_id TEXT, idx INTEGER, command_template TEXT,
          PRIMARY KEY(workflow_id, idx));
        CREATE TABLE workflow_params (workflow_id TEXT, name TEXT, type TEXT,
          default_value TEXT, required INTEGER DEFAULT 1, description TEXT DEFAULT '',
          enum_values TEXT, PRIMARY KEY(workflow_id, name));
        CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT, tab_id TEXT,
          params_json TEXT DEFAULT '{}', started_at INTEGER DEFAULT 0, ended_at INTEGER);
    "#,
    )
    .unwrap();
    conn
}

#[test]
fn render_replaces_placeholders_and_handles_whitespace() {
    let mut values = HashMap::new();
    values.insert("intf".to_string(), "Gi0/0/0".to_string());
    let out = render_template("show interface {{ intf }} counters", &values).unwrap();
    assert_eq!(out, "show interface Gi0/0/0 counters");

    let out2 = render_template("show interface {{intf}} counters", &values).unwrap();
    assert_eq!(out2, "show interface Gi0/0/0 counters");

    let err = render_template("show ip ospf neighbor {{area}}", &values).unwrap_err();
    assert!(err.to_string().contains("missing"));
    assert!(err.to_string().contains("area"));
}

#[test]
fn render_handles_repeated_placeholder() {
    let mut values = HashMap::new();
    values.insert("h".to_string(), "host1".to_string());
    let out = render_template("ping {{h}} && traceroute {{ h }}", &values).unwrap();
    assert_eq!(out, "ping host1 && traceroute host1");
}

#[test]
fn render_template_user_value_with_special_chars_is_literal() {
    // Templating must NOT recursively expand a placeholder embedded in a user value.
    let mut values = HashMap::new();
    values.insert("x".to_string(), "{{evil}}".to_string());
    let out = render_template("a {{x}} b", &values).unwrap();
    // The `{{evil}}` in the rendered output is a literal string, not a placeholder
    // expansion, because replace_all does a single pass.
    assert_eq!(out, "a {{evil}} b");
}

#[test]
fn run_returns_rendered_steps_and_records_run() {
    let conn = schema();
    let wf = Workflow {
        id: "wf-2".into(),
        name: "Two-step".into(),
        description: "".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        tags: vec![],
        created_at: 0,
        updated_at: 0,
        steps: vec![
            WorkflowStep { idx: 0, command_template: "show ip int br".into() },
            WorkflowStep {
                idx: 1,
                command_template: "show interface {{ intf }} counters".into(),
            },
        ],
        params: vec![WorkflowParam {
            name: "intf".into(),
            r#type: "interface".into(),
            default_value: None,
            required: true,
            description: "".into(),
            enum_values: None,
        }],
    };
    workflow_upsert_impl(&conn, &wf).unwrap();

    let mut values = HashMap::new();
    values.insert("intf".to_string(), "Gi0/0/0".to_string());
    let (run_id, rendered) = workflow_run_impl(&conn, "wf-2", "tab-a", &values).unwrap();
    assert_eq!(
        rendered,
        vec![
            "show ip int br".to_string(),
            "show interface Gi0/0/0 counters".to_string(),
        ]
    );
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workflow_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn run_uses_default_for_optional_param() {
    let conn = schema();
    let wf = Workflow {
        id: "wf-default".into(),
        name: "default test".into(),
        description: "".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        tags: vec![],
        created_at: 0,
        updated_at: 0,
        steps: vec![WorkflowStep {
            idx: 0,
            command_template: "show ip route vrf {{ vrf }}".into(),
        }],
        params: vec![WorkflowParam {
            name: "vrf".into(),
            r#type: "string".into(),
            default_value: Some("global".into()),
            required: false,
            description: "".into(),
            enum_values: None,
        }],
    };
    workflow_upsert_impl(&conn, &wf).unwrap();

    let (_run_id, rendered) =
        workflow_run_impl(&conn, "wf-default", "tab-a", &HashMap::new()).unwrap();
    assert_eq!(rendered, vec!["show ip route vrf global".to_string()]);
}

#[test]
fn run_errors_on_missing_required_param() {
    let conn = schema();
    let wf = Workflow {
        id: "wf-req".into(),
        name: "req".into(),
        description: "".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        tags: vec![],
        created_at: 0,
        updated_at: 0,
        steps: vec![WorkflowStep {
            idx: 0,
            command_template: "show interface {{ intf }}".into(),
        }],
        params: vec![WorkflowParam {
            name: "intf".into(),
            r#type: "interface".into(),
            default_value: None,
            required: true,
            description: "".into(),
            enum_values: None,
        }],
    };
    workflow_upsert_impl(&conn, &wf).unwrap();

    let err = workflow_run_impl(&conn, "wf-req", "tab-a", &HashMap::new()).unwrap_err();
    assert!(err.to_string().contains("missing required param"));
}

#[test]
fn run_errors_on_missing_workflow() {
    let conn = schema();
    let err = workflow_run_impl(&conn, "nope", "tab-a", &HashMap::new()).unwrap_err();
    assert!(err.to_string().contains("not found"));
}
