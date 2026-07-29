use ccie_terminal_lib::commands::workflows::workflow_list_impl;
use ccie_terminal_lib::commands::workflows_seed::{seed_builtin_from_yaml, SEED_YAML};
use rusqlite::Connection;

fn schema() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(
        r#"
        CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '',
          vendor TEXT, platform TEXT DEFAULT '', tags TEXT DEFAULT '[]',
          created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
        CREATE TABLE workflow_steps (workflow_id TEXT, idx INTEGER, command_template TEXT, PRIMARY KEY(workflow_id, idx));
        CREATE TABLE workflow_params (workflow_id TEXT, name TEXT, type TEXT, default_value TEXT,
          required INTEGER DEFAULT 1, description TEXT DEFAULT '', enum_values TEXT,
          PRIMARY KEY(workflow_id, name));
        CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT, tab_id TEXT,
          params_json TEXT DEFAULT '{}', started_at INTEGER DEFAULT 0, ended_at INTEGER);
    "#,
    )
    .unwrap();
    // app_flags is created on demand by the seeder when missing.
    c
}

#[test]
fn seeds_at_least_30_workflows_exactly_once() {
    let c = schema();
    let n1 = seed_builtin_from_yaml(&c, SEED_YAML).unwrap();
    assert!(n1 >= 30, "expected >=30 seeds, got {}", n1);
    let list = workflow_list_impl(&c, None, None, None).unwrap();
    assert!(list.len() >= 30);

    // Second call should be a no-op (already seeded flag set).
    let n2 = seed_builtin_from_yaml(&c, SEED_YAML).unwrap();
    assert_eq!(n2, 0);
}

#[test]
fn seed_includes_expected_vendor_mix() {
    let c = schema();
    seed_builtin_from_yaml(&c, SEED_YAML).unwrap();
    let cisco = workflow_list_impl(&c, Some("cisco"), None, None).unwrap();
    let juniper = workflow_list_impl(&c, Some("juniper"), None, None).unwrap();
    let arista = workflow_list_impl(&c, Some("arista"), None, None).unwrap();
    // Cisco filter also pulls in 'generic' (per workflow_list_impl semantics).
    assert!(cisco.len() >= 18 + 4, "cisco+generic count: {}", cisco.len());
    assert!(juniper.len() >= 3 + 4, "juniper+generic: {}", juniper.len());
    assert!(arista.len() >= 3 + 4, "arista+generic: {}", arista.len());
}

#[test]
fn seed_workflow_template_renders_with_user_value() {
    use ccie_terminal_lib::commands::workflows::workflow_run_impl;
    use std::collections::HashMap;

    let c = schema();
    seed_builtin_from_yaml(&c, SEED_YAML).unwrap();

    // 'cisco-iosxe-show-interface-counters' takes one required `intf` param.
    let mut values = HashMap::new();
    values.insert("intf".to_string(), "Gi0/0/0".to_string());
    let (_run_id, rendered) = workflow_run_impl(
        &c,
        "cisco-iosxe-show-interface-counters",
        "tab-test",
        &values,
    )
    .unwrap();
    assert_eq!(rendered, vec!["show interface Gi0/0/0 counters".to_string()]);
}
