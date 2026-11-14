use super::*;

#[tokio::test]
async fn failed_initialization_does_not_trap_the_telemetry_tab() {
    let service = Err(Diagnostic::new(
        "builtin_hash",
        "Compiled template checksum mismatch",
        "synthetic-template",
    ));
    assert!(close_workspace(service, "failed-workspace").await.is_ok());
}

#[tokio::test]
async fn healthy_service_close_still_waits_for_backend_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let db = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
    let service = create_service(db, root.path().to_path_buf()).unwrap();
    service.establish("healthy-workspace").await.unwrap();
    close_workspace(Ok(service.clone()), "healthy-workspace")
        .await
        .unwrap();
    assert_eq!(
        service
            .snapshot("healthy-workspace")
            .await
            .unwrap_err()
            .code,
        "workspace_unknown"
    );
    service.shutdown().await.unwrap();
    assert!(close_workspace(Ok(service), "healthy-workspace")
        .await
        .is_err());
}
