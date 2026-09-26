use ccie_terminal_lib::{
    api_runner::{env_store, history, postman},
    db,
};
use serde_json::json;
use tempfile::TempDir;

fn fixture(dir: &TempDir) -> std::path::PathBuf {
    let path = dir.path().join("network.postman_collection.json");
    let collection = json!({
      "info": {"name": "Network API", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
      "variable": [
        {"key": "baseUrl", "value": "https://api.example.test"},
        {"key": "token", "value": "literal-secret", "type": "secret"}
      ],
      "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{token}}"}]},
      "item": [{"name": "Devices", "item": [{"name": "List", "request": {
        "method": "GET", "url": "{{baseUrl}}/devices"
      }}]}]
    });
    std::fs::write(&path, serde_json::to_vec(&collection).unwrap()).unwrap();
    path
}

#[test]
fn commit_creates_collision_free_collection_environment_and_placeholder_rows() {
    let dir = TempDir::new().unwrap();
    let database_path = dir.path().join("app.db");
    let environment_dir = dir.path().join("environments");
    env_store::create_environment(&environment_dir, "network_api").unwrap();
    let source = fixture(&dir);
    let preview = postman::preview_file(&source).unwrap();
    let mut conn = db::open_and_migrate(&database_path).unwrap();

    let first =
        postman::commit_file(&mut conn, &environment_dir, &source, &preview.fingerprint).unwrap();
    assert_eq!(first.collection_name, "Network API");
    assert_eq!(first.environment, "network_api-2");
    assert_eq!(first.imported_count, 1);
    let stored: (String, String, String, String, String) = conn
        .query_row(
            "SELECT name, display_name, folder_path, url, auth_json
               FROM api_saved_requests WHERE collection_id = ?1",
            [&first.collection_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_ne!(stored.0, stored.1);
    assert_eq!(stored.1, "List");
    assert_eq!(stored.2, "Devices");
    assert!(stored.3.contains("${env:BASEURL}"));
    assert!(stored.4.contains("${env:TOKEN}"));
    assert!(!format!("{}{}", stored.3, stored.4).contains("literal-secret"));
    let variables = env_store::load_env(&environment_dir, &first.environment).unwrap();
    assert!(variables.iter().any(|variable| {
        variable.key == "TOKEN" && variable.value == "literal-secret" && variable.is_secret
    }));

    let second =
        postman::commit_file(&mut conn, &environment_dir, &source, &preview.fingerprint).unwrap();
    assert_eq!(second.collection_name, "Network API (2)");
    assert_eq!(second.environment, "network_api-3");
    let request_names: Vec<String> = {
        let mut statement = conn
            .prepare("SELECT name FROM api_saved_requests ORDER BY name")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(request_names.len(), 2);
    assert_ne!(request_names[0], request_names[1]);
}

#[test]
fn database_commit_failure_rolls_back_all_rows_and_environment_artifacts() {
    let dir = TempDir::new().unwrap();
    let database_path = dir.path().join("app.db");
    let environment_dir = dir.path().join("environments");
    let source = fixture(&dir);
    let preview = postman::preview_file(&source).unwrap();
    let mut conn = db::open_and_migrate(&database_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE postman_commit_sabotage (
           collection_id TEXT REFERENCES api_request_collections(id) DEFERRABLE INITIALLY DEFERRED
         );
         CREATE TRIGGER sabotage_postman_commit
           AFTER INSERT ON api_request_collections
         BEGIN
           INSERT INTO postman_commit_sabotage(collection_id) VALUES ('missing-collection');
         END;",
    )
    .unwrap();

    assert!(
        postman::commit_file(&mut conn, &environment_dir, &source, &preview.fingerprint,).is_err()
    );
    let collections: i64 = conn
        .query_row("SELECT COUNT(*) FROM api_request_collections", [], |row| {
            row.get(0)
        })
        .unwrap();
    let requests: i64 = conn
        .query_row("SELECT COUNT(*) FROM api_saved_requests", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(collections, 0);
    assert_eq!(requests, 0);
    assert!(!environment_dir.join("network_api.env").exists());
}

#[test]
fn collection_readers_show_existing_imports_and_isolate_details() {
    let dir = TempDir::new().unwrap();
    let database_path = dir.path().join("app.db");
    let environment_dir = dir.path().join("environments");
    let source = fixture(&dir);
    let preview = postman::preview_file(&source).unwrap();
    let mut conn = db::open_and_migrate(&database_path).unwrap();
    let first =
        postman::commit_file(&mut conn, &environment_dir, &source, &preview.fingerprint).unwrap();
    let second =
        postman::commit_file(&mut conn, &environment_dir, &source, &preview.fingerprint).unwrap();

    let collections = postman::list_collections(&conn).unwrap();
    assert_eq!(collections.len(), 2);
    assert_eq!(collections[0].id, first.collection_id);
    assert_eq!(collections[0].name, "Network API");
    assert_eq!(collections[0].request_count, 1);
    assert_eq!(collections[1].id, second.collection_id);
    assert_eq!(collections[1].request_count, 1);

    let detail = postman::get_collection(&conn, &first.collection_id)
        .unwrap()
        .unwrap();
    assert_eq!(detail.collection.id, first.collection_id);
    assert_eq!(detail.requests.len(), 1);
    assert!(detail
        .requests
        .iter()
        .all(|request| request.collection_id.as_deref() == Some(first.collection_id.as_str())));
    assert!(detail.requests[0].auth_json.contains("${env:TOKEN}"));
    assert!(postman::get_collection(&conn, "missing-collection")
        .unwrap()
        .is_none());
}

#[test]
fn deleting_collection_cascades_requests_and_removes_generated_environment() {
    let dir = TempDir::new().unwrap();
    let database_path = dir.path().join("app.db");
    let environment_dir = dir.path().join("environments");
    let source = fixture(&dir);
    let preview = postman::preview_file(&source).unwrap();
    let mut conn = db::open_and_migrate(&database_path).unwrap();
    let imported =
        postman::commit_file(&mut conn, &environment_dir, &source, &preview.fingerprint).unwrap();

    let deleted =
        postman::delete_collection(&mut conn, &environment_dir, &imported.collection_id).unwrap();
    assert_eq!(deleted.id, imported.collection_id);
    assert_eq!(deleted.name, imported.collection_name);
    assert_eq!(deleted.environment, imported.environment);
    assert_eq!(deleted.request_count, imported.imported_count);
    let collection_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM api_request_collections", [], |row| {
            row.get(0)
        })
        .unwrap();
    let request_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM api_saved_requests", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(collection_count, 0);
    assert_eq!(request_count, 0);
    assert!(!environment_dir
        .join(format!("{}.env", imported.environment))
        .exists());
    assert!(!environment_dir
        .join(format!("{}.env.meta.json", imported.environment))
        .exists());
}

#[test]
fn deletion_refuses_an_environment_referenced_outside_the_collection() {
    let dir = TempDir::new().unwrap();
    let database_path = dir.path().join("app.db");
    let environment_dir = dir.path().join("environments");
    let source = fixture(&dir);
    let preview = postman::preview_file(&source).unwrap();
    let mut conn = db::open_and_migrate(&database_path).unwrap();
    let imported =
        postman::commit_file(&mut conn, &environment_dir, &source, &preview.fingerprint).unwrap();
    history::save_request(
        &conn,
        history::NewSavedRequest {
            name: "outside-copy",
            target_id: None,
            environment: Some(&imported.environment),
            method: "GET",
            url: "https://api.example.test/copied",
            headers_json: "{}",
            query_json: "{}",
            body_kind: "none",
            body_text: None,
        },
    )
    .unwrap();

    let error = postman::delete_collection(&mut conn, &environment_dir, &imported.collection_id)
        .unwrap_err()
        .to_string();
    assert!(error.contains("outside the collection"));
    assert!(postman::get_collection(&conn, &imported.collection_id)
        .unwrap()
        .is_some());
    assert!(environment_dir
        .join(format!("{}.env", imported.environment))
        .exists());
}

#[test]
fn failed_database_deletion_restores_environment_and_collection_rows() {
    let dir = TempDir::new().unwrap();
    let database_path = dir.path().join("app.db");
    let environment_dir = dir.path().join("environments");
    let source = fixture(&dir);
    let preview = postman::preview_file(&source).unwrap();
    let mut conn = db::open_and_migrate(&database_path).unwrap();
    let imported =
        postman::commit_file(&mut conn, &environment_dir, &source, &preview.fingerprint).unwrap();
    let env_path = environment_dir.join(format!("{}.env", imported.environment));
    let meta_path = environment_dir.join(format!("{}.env.meta.json", imported.environment));
    let env_before = std::fs::read(&env_path).unwrap();
    let meta_before = std::fs::read(&meta_path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER sabotage_postman_delete
           BEFORE DELETE ON api_request_collections
         BEGIN
           SELECT RAISE(ABORT, 'sabotage collection deletion');
         END;",
    )
    .unwrap();

    let error = postman::delete_collection(&mut conn, &environment_dir, &imported.collection_id)
        .unwrap_err()
        .to_string();
    assert!(error.contains("delete imported collection rows"));
    assert!(std::fs::read(&env_path).unwrap() == env_before);
    assert!(std::fs::read(&meta_path).unwrap() == meta_before);
    let detail = postman::get_collection(&conn, &imported.collection_id)
        .unwrap()
        .unwrap();
    assert_eq!(detail.requests.len(), 1);
}

#[test]
fn deleting_an_unknown_collection_is_rejected_without_touching_environments() {
    let dir = TempDir::new().unwrap();
    let database_path = dir.path().join("app.db");
    let environment_dir = dir.path().join("environments");
    env_store::create_environment(&environment_dir, "keep_me").unwrap();
    let mut conn = db::open_and_migrate(&database_path).unwrap();

    let error = postman::delete_collection(&mut conn, &environment_dir, "missing")
        .unwrap_err()
        .to_string();
    assert!(error.contains("not found"));
    assert!(environment_dir.join("keep_me.env").exists());
}
