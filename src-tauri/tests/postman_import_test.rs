use ccie_terminal_lib::{
    api_runner::{env_store, postman},
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
