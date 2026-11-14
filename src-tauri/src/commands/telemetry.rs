//! Private request/reply telemetry IPC; the single service owns every workspace.
use super::AppState;
use crate::telemetry::{
    config::TelemetryConfigRepository,
    model::*,
    parser::TelemetryParser,
    policy::CommandPolicy,
    service::{LocalCollectorFactory, TelemetryClock, TelemetryService, TelemetrySshFactory},
    ssh::{saved_target_metadata, SavedTargetMetadata},
};
use parking_lot::Mutex;
use std::{path::PathBuf, sync::Arc};
use tauri::State;

pub(crate) fn create_service(
    db: Arc<Mutex<rusqlite::Connection>>,
    root: PathBuf,
) -> Result<Arc<TelemetryService>, Diagnostic> {
    let parser = Arc::new(TelemetryParser::new());
    let repository = TelemetryConfigRepository::load(root, Catalog::builtin()?, parser.clone())?;
    let known_hosts = dirs::home_dir()
        .ok_or_else(|| {
            Diagnostic::new(
                "ssh_known_hosts",
                "Cannot resolve the SSH trust path",
                "telemetry",
            )
        })?
        .join(".ssh")
        .join("known_hosts");
    Ok(Arc::new(TelemetryService::new(
        repository,
        LocalCollectorFactory::default(),
        TelemetrySshFactory::new(db, known_hosts),
        parser,
        TelemetryClock::default(),
    )))
}
fn owner(state: &AppState) -> Result<Arc<TelemetryService>, Diagnostic> {
    state.telemetry.clone()
}
async fn admit(
    db: Arc<Mutex<rusqlite::Connection>>,
    targets: Vec<TargetRef>,
) -> Result<Vec<SavedTargetMetadata>, Diagnostic> {
    if targets.len() > 10 {
        return Err(Diagnostic::new(
            "target_limit",
            "A workspace supports at most ten network targets",
            "targets",
        ));
    }
    tokio::task::spawn_blocking(move || {
        let db = db.lock();
        targets
            .into_iter()
            .map(|target| saved_target_metadata(&db, target))
            .collect()
    })
    .await
    .map_err(|_| {
        Diagnostic::new(
            "saved_metadata",
            "Saved target metadata worker failed",
            "targets",
        )
    })?
}
#[tauri::command]
pub async fn telemetry_establish(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<TelemetrySnapshot, Diagnostic> {
    owner(&state)?.establish(&workspace_id).await
}
#[tauri::command]
pub async fn telemetry_start(
    state: State<'_, AppState>,
    request: StartRequest,
) -> Result<TelemetrySnapshot, Diagnostic> {
    let service = owner(&state)?;
    service.snapshot(&request.workspace_id).await?;
    let targets = admit(state.db.clone(), request.targets.clone()).await?;
    service.start_admitted(request, targets).await
}
#[tauri::command]
pub async fn telemetry_select(
    state: State<'_, AppState>,
    workspace_id: String,
    target: TargetRef,
) -> Result<TelemetrySnapshot, Diagnostic> {
    let service = owner(&state)?;
    service.snapshot(&workspace_id).await?;
    let mut targets = admit(state.db.clone(), vec![target]).await?;
    service.select(&workspace_id, targets.remove(0)).await
}
#[tauri::command]
pub async fn telemetry_stop(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), Diagnostic> {
    owner(&state)?.stop(&workspace_id).await
}
#[tauri::command]
pub async fn telemetry_close(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), Diagnostic> {
    close_workspace(owner(&state), &workspace_id).await
}
async fn close_workspace(
    service: Result<Arc<TelemetryService>, Diagnostic>,
    workspace_id: &str,
) -> Result<(), Diagnostic> {
    match service {
        Ok(service) => service.close(workspace_id).await,
        // Initialization failed before any workspace or collector could be created.
        Err(_) => Ok(()),
    }
}
#[tauri::command]
pub async fn telemetry_snapshot(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<TelemetrySnapshot, Diagnostic> {
    owner(&state)?.snapshot(&workspace_id).await
}
#[tauri::command]
pub async fn telemetry_catalog(
    state: State<'_, AppState>,
    workspace_id: String,
    scope: ConfigScope,
) -> Result<TelemetryRead<AuthoringCatalog>, Diagnostic> {
    owner(&state)?.catalog(&workspace_id, scope).await
}
#[tauri::command]
pub async fn telemetry_validate(
    state: State<'_, AppState>,
    workspace_id: String,
    draft: ConfigDraft,
) -> Result<TelemetryRead<ValidationReport>, Diagnostic> {
    owner(&state)?.validate(&workspace_id, draft).await
}
#[tauri::command]
pub async fn telemetry_preview(
    state: State<'_, AppState>,
    workspace_id: String,
    draft: ConfigDraft,
) -> Result<TelemetryRead<PreviewReport>, Diagnostic> {
    owner(&state)?.preview_read(&workspace_id, &draft).await
}
#[tauri::command]
pub async fn telemetry_apply(
    state: State<'_, AppState>,
    workspace_id: String,
    draft: ConfigDraft,
    token: PreviewToken,
) -> Result<TelemetryRead<ApplyResult>, Diagnostic> {
    owner(&state)?.apply_read(&workspace_id, draft, token).await
}
#[tauri::command]
pub async fn telemetry_widget(
    state: State<'_, AppState>,
    query: WidgetQuery,
) -> Result<TelemetryRead<WidgetPage>, Diagnostic> {
    owner(&state)?.widget_read(query).await
}
#[tauri::command]
pub async fn telemetry_series(
    state: State<'_, AppState>,
    query: SeriesQuery,
) -> Result<TelemetryRead<SeriesPage>, Diagnostic> {
    owner(&state)?.series_read(query).await
}
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CaptureSampleRequest {
    Current {
        target: TargetRef,
        command: String,
        parser_id: String,
        revision: Revision,
    },
    Draft {
        target: TargetRef,
        draft: ConfigDraft,
        parser_id: String,
    },
}
#[tauri::command]
pub async fn telemetry_capture_sample(
    state: State<'_, AppState>,
    workspace_id: String,
    request: CaptureSampleRequest,
) -> Result<TelemetryRead<Capture>, Diagnostic> {
    let service = owner(&state)?;
    service.snapshot(&workspace_id).await?;
    match request {
        CaptureSampleRequest::Current {
            target,
            command,
            parser_id,
            revision,
        } => {
            admit(state.db.clone(), vec![target.clone()]).await?;
            let request = CaptureRequest {
                command: CommandPolicy::admit(target.platform, &command)?,
                parser_id,
                revision,
            };
            service.capture_read(&workspace_id, target, request).await
        }
        CaptureSampleRequest::Draft {
            target,
            draft,
            parser_id,
        } => {
            admit(state.db.clone(), vec![target.clone()]).await?;
            service
                .capture_draft_read(&workspace_id, target, &draft, &parser_id)
                .await
        }
    }
}
#[tauri::command]
pub async fn telemetry_test_template(
    state: State<'_, AppState>,
    workspace_id: String,
    capture_id: String,
    template: TemplateAsset,
) -> Result<TelemetryRead<ParsedInterpretation>, Diagnostic> {
    owner(&state)?
        .test_template(&workspace_id, &capture_id, template)
        .await
}
#[tauri::command]
pub async fn telemetry_import(
    state: State<'_, AppState>,
    workspace_id: String,
    scope: ConfigScope,
    yaml: String,
) -> Result<TelemetryRead<ImportReport>, Diagnostic> {
    owner(&state)?.import(&workspace_id, scope, yaml).await
}
#[tauri::command]
pub async fn telemetry_reset(
    state: State<'_, AppState>,
    workspace_id: String,
    scope: ConfigScope,
    asset: ResetAsset,
) -> Result<TelemetryRead<ConfigDraft>, Diagnostic> {
    owner(&state)?.reset(&workspace_id, scope, asset).await
}

#[cfg(test)]
#[path = "telemetry_failed_init_tests.rs"]
mod failed_init_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::Arc;

    #[tokio::test]
    async fn commands_telemetry_establish_is_stopped_unknown_reads_and_reopen_are_empty() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        let service = create_service(db, root.path().to_path_buf()).unwrap();
        assert_eq!(
            service.snapshot("unknown").await.unwrap_err().code,
            "workspace_unknown"
        );
        let first = service.establish("one").await.unwrap();
        assert!(!first.running);
        assert!(first.widgets.is_empty() && first.series.is_empty());
        assert_eq!(first, service.establish("one").await.unwrap());
        service
            .start(StartRequest {
                workspace_id: "one".into(),
                targets: vec![],
                local_enabled: false,
                monitored_interfaces: Default::default(),
            })
            .await
            .unwrap();
        service.close("one").await.unwrap();
        assert_eq!(
            service.snapshot("one").await.unwrap_err().code,
            "workspace_unknown"
        );
        let reopened = service.establish("one").await.unwrap();
        assert!(!reopened.running);
        assert!(reopened.widgets.is_empty() && reopened.series.is_empty());
        service.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn authoring_reads_require_ownership_and_keep_global_and_source_authority_distinct() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        let service = create_service(db, root.path().to_path_buf()).unwrap();
        assert_eq!(
            service
                .catalog("unknown", ConfigScope::Local)
                .await
                .unwrap_err()
                .code,
            "workspace_unknown"
        );
        service.establish("one").await.unwrap();
        let catalog = service.catalog("one", ConfigScope::Local).await.unwrap();
        assert_eq!(catalog.workspace_id, "one");
        assert_eq!(catalog.revision, catalog.value.own.expected_revision);
        assert_ne!(catalog.revision, catalog.value.effective.revision);
        assert!(
            serde_yaml::from_str::<WidgetDocument>(&catalog.value.own.widgets_yaml)
                .unwrap()
                .widgets
                .is_empty()
        );
        assert!(!catalog.value.effective.widgets.is_empty());
        assert_eq!(
            service
                .test_template(
                    "unknown",
                    "capture",
                    TemplateAsset {
                        id: "test".into(),
                        platform: Platform::Ios,
                        command: "show version".into(),
                        text: "".into(),
                        sha256: "".into()
                    }
                )
                .await
                .unwrap_err()
                .code,
            "workspace_unknown"
        );
        service.close("one").await.unwrap();
        assert_eq!(
            service
                .catalog("one", ConfigScope::Local)
                .await
                .unwrap_err()
                .code,
            "workspace_unknown"
        );
        service.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn saved_metadata_admission_needs_only_identity_columns_and_never_collects() {
        let root = tempfile::tempdir().unwrap();
        let db = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        db.lock().execute_batch("CREATE TABLE ssh_connections (id TEXT, name TEXT, platform TEXT); INSERT INTO ssh_connections VALUES ('one', 'Core switch', 'iosxe'), ('generic', 'Generic target', 'generic'), ('unsupported', 'Other', 'nxos');").unwrap();
        let service = create_service(db.clone(), root.path().to_path_buf()).unwrap();
        service.establish("one").await.unwrap();
        let target = TargetRef {
            connection_id: "one".into(),
            platform: Platform::Iosxe,
        };
        let mut saved = admit(db.clone(), vec![target.clone()]).await.unwrap();
        let selected = service.select("one", saved.remove(0)).await.unwrap();
        assert!(!selected.running && selected.widgets.is_empty());
        assert_eq!(selected.targets[0].display_name, "Core switch");
        assert!(service
            .catalog("one", ConfigScope::Device("one".into()))
            .await
            .is_ok());
        let mismatch = TargetRef {
            platform: Platform::Ios,
            ..target
        };
        assert_eq!(
            admit(db.clone(), vec![mismatch]).await.err().unwrap().code,
            "ssh_platform_mismatch"
        );
        assert!(admit(
            db.clone(),
            vec![TargetRef {
                connection_id: "generic".into(),
                platform: Platform::Ios
            }]
        )
        .await
        .is_ok());
        assert_eq!(
            admit(
                db,
                vec![TargetRef {
                    connection_id: "unsupported".into(),
                    platform: Platform::Ios
                }]
            )
            .await
            .err()
            .unwrap()
            .code,
            "ssh_platform_unsupported"
        );
        service.shutdown().await.unwrap();
    }
    #[test]
    fn capture_wire_rejects_raw_authority_and_unknown_execution_variants() {
        assert!(serde_json::from_value::<CaptureSampleRequest>(serde_json::json!({ "kind": "current", "target": { "connection_id": "one", "platform": "ios" }, "command": "show version", "parser_id": "parser", "revision": "source", "raw": "caller-controlled" })).is_err());
        assert!(serde_json::from_value::<CaptureSampleRequest>(
            serde_json::json!({ "kind": "execute", "command": "show version" })
        )
        .is_err());
    }
}
