use ccie_terminal_lib::commands::workflows::{
    workflow_delete_impl, workflow_get_impl, workflow_list_impl, workflow_upsert_impl, Workflow,
    WorkflowParam, WorkflowStep,
};
use rusqlite::Connection;

fn schema() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    // Apply just the core tables, skipping the ALTER on command_blocks
    // (it doesn't exist in this in-memory test schema).
    conn.execute_batch(
        r#"
        CREATE TABLE workflows (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          vendor TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        CREATE TABLE workflow_steps (
          workflow_id TEXT NOT NULL, idx INTEGER NOT NULL,
          command_template TEXT NOT NULL,
          PRIMARY KEY (workflow_id, idx)
        );
        CREATE TABLE workflow_params (
          workflow_id TEXT NOT NULL, name TEXT NOT NULL,
          type TEXT NOT NULL, default_value TEXT, required INTEGER NOT NULL DEFAULT 1,
          description TEXT NOT NULL DEFAULT '', enum_values TEXT,
          PRIMARY KEY (workflow_id, name)
        );
        CREATE TABLE workflow_runs (
          id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, tab_id TEXT NOT NULL,
          params_json TEXT NOT NULL DEFAULT '{}',
          started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), ended_at INTEGER
        );
    "#,
    )
    .unwrap();
    conn
}

#[test]
fn crud_roundtrip() {
    let conn = schema();

    let wf = Workflow {
        id: "wf-1".into(),
        name: "Show interface counters".into(),
        description: "Per-interface counter dump".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        tags: vec!["counters".into()],
        steps: vec![WorkflowStep {
            idx: 0,
            command_template: "show interface {{ intf }} counters".into(),
        }],
        params: vec![WorkflowParam {
            name: "intf".into(),
            r#type: "interface".into(),
            default_value: None,
            required: true,
            description: "Interface name (e.g. Gi0/0/0)".into(),
            enum_values: None,
        }],
        created_at: 0,
        updated_at: 0,
    };

    workflow_upsert_impl(&conn, &wf).unwrap();
    let got = workflow_get_impl(&conn, "wf-1").unwrap().unwrap();
    assert_eq!(got.name, "Show interface counters");
    assert_eq!(got.steps.len(), 1);
    assert_eq!(got.params.len(), 1);
    assert_eq!(got.params[0].r#type, "interface");
    assert_eq!(got.tags, vec!["counters".to_string()]);

    let list = workflow_list_impl(&conn, Some("cisco"), Some("iosxe"), None).unwrap();
    assert_eq!(list.len(), 1);

    workflow_delete_impl(&conn, "wf-1").unwrap();
    assert!(workflow_get_impl(&conn, "wf-1").unwrap().is_none());
}

#[test]
fn list_filters_include_generic_vendor() {
    let conn = schema();

    for (id, name, vendor, platform) in [
        ("a", "A", "cisco", "iosxe"),
        ("b", "B", "juniper", "junos"),
        ("c", "C", "generic", "generic"),
        ("d", "D", "cisco", ""),
    ] {
        let wf = Workflow {
            id: id.into(),
            name: name.into(),
            description: "".into(),
            vendor: vendor.into(),
            platform: platform.into(),
            tags: vec![],
            steps: vec![],
            params: vec![],
            created_at: 0,
            updated_at: 0,
        };
        workflow_upsert_impl(&conn, &wf).unwrap();
    }

    // Cisco/iosxe scope must include 'generic' vendor and platform-empty rows.
    let list = workflow_list_impl(&conn, Some("cisco"), Some("iosxe"), None).unwrap();
    let names: Vec<String> = list.into_iter().map(|w| w.name).collect();
    assert!(names.contains(&"A".to_string())); // cisco/iosxe
    assert!(names.contains(&"C".to_string())); // generic/generic
    assert!(names.contains(&"D".to_string())); // cisco/'' platform
    assert!(!names.contains(&"B".to_string())); // juniper filtered out
}

#[test]
fn name_prefix_filter() {
    let conn = schema();
    for (id, name) in [("1", "Show BGP summary"), ("2", "Show OSPF neighbor")] {
        let wf = Workflow {
            id: id.into(),
            name: name.into(),
            description: "".into(),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
            tags: vec![],
            steps: vec![],
            params: vec![],
            created_at: 0,
            updated_at: 0,
        };
        workflow_upsert_impl(&conn, &wf).unwrap();
    }
    let list = workflow_list_impl(&conn, None, None, Some("Show BGP")).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "Show BGP summary");
}

#[test]
fn upsert_replaces_steps_and_params() {
    let conn = schema();
    let mut wf = Workflow {
        id: "z".into(),
        name: "Z".into(),
        description: "".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        tags: vec![],
        steps: vec![
            WorkflowStep { idx: 0, command_template: "old".into() },
            WorkflowStep { idx: 1, command_template: "old2".into() },
        ],
        params: vec![WorkflowParam {
            name: "a".into(),
            r#type: "string".into(),
            default_value: None,
            required: true,
            description: "".into(),
            enum_values: None,
        }],
        created_at: 0,
        updated_at: 0,
    };
    workflow_upsert_impl(&conn, &wf).unwrap();

    wf.steps = vec![WorkflowStep { idx: 0, command_template: "new".into() }];
    wf.params = vec![];
    workflow_upsert_impl(&conn, &wf).unwrap();

    let got = workflow_get_impl(&conn, "z").unwrap().unwrap();
    assert_eq!(got.steps.len(), 1);
    assert_eq!(got.steps[0].command_template, "new");
    assert!(got.params.is_empty());
}
