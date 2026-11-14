use parking_lot::Mutex;
use serde::Serialize;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

pub(super) const APP_SHUTDOWN_PREPARE_EVENT: &str = "app://prepare-shutdown";
const APP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);
const APP_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(30);
const APP_PREFLIGHT_EVENT: &str = "app://shutdown-preflight";
const APP_PREFLIGHT_CANCEL_EVENT: &str = "app://shutdown-preflight-canceled";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WindowCloseDisposition {
    ExitApplication,
    CloseWindowOnly,
}

pub(super) fn close_disposition(window_label: &str) -> WindowCloseDisposition {
    if window_label == "main" {
        WindowCloseDisposition::ExitApplication
    } else {
        WindowCloseDisposition::CloseWindowOnly
    }
}

fn is_shutdown_participant(window_label: &str) -> bool {
    window_label == "main" || window_label.starts_with("editor-")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum BeginShutdown {
    Started {
        request_id: u64,
        participants: Vec<String>,
    },
    InProgress {
        request_id: u64,
    },
    ReadyToExit {
        request_id: u64,
    },
    Exiting {
        request_id: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum AckShutdown {
    Waiting { remaining: Vec<String> },
    ReadyToExit { failures: Vec<String> },
    Ignored,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TimeoutShutdown {
    pub missing: Vec<String>,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExitRequestDisposition {
    Intercept,
    Allow,
}

#[derive(Debug)]
enum ShutdownPhase {
    Idle,
    Approved,
    Waiting {
        request_id: u64,
        pending: BTreeSet<String>,
        failures: Vec<String>,
    },
    Exiting {
        request_id: u64,
    },
}

#[derive(Debug)]
struct ShutdownState {
    next_request_id: u64,
    phase: ShutdownPhase,
    preflight: Option<(AppShutdownPrepare, i32)>,
    exit_code: i32,
}

impl Default for ShutdownState {
    fn default() -> Self {
        Self {
            next_request_id: 1,
            phase: ShutdownPhase::Idle,
            preflight: None,
            exit_code: 0,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(super) struct ShutdownCoordinator {
    inner: Arc<Mutex<ShutdownState>>,
}

impl ShutdownCoordinator {
    fn preflight(&self, reason: &str, exit_code: Option<i32>) -> Option<AppShutdownPrepare> {
        let mut state = self.inner.lock();
        if state.preflight.is_some() || !matches!(state.phase, ShutdownPhase::Idle) {
            return None;
        }
        let request = AppShutdownPrepare {
            request_id: state.next_request_id,
            reason: reason.into(),
            timeout_ms: APP_PREFLIGHT_TIMEOUT.as_millis() as u64,
        };
        state.next_request_id = state.next_request_id.saturating_add(1);
        state.preflight = Some((request.clone(), exit_code.unwrap_or(0)));
        Some(request)
    }
    fn decide_preflight(&self, request_id: u64, window: &str, approved: bool) -> Option<bool> {
        let mut state = self.inner.lock();
        if window != "main" || state.preflight.as_ref()?.0.request_id != request_id {
            return None;
        }
        let (_, exit_code) = state.preflight.take()?;
        if approved {
            state.exit_code = exit_code;
            state.phase = ShutdownPhase::Approved;
        }
        Some(approved)
    }
    fn cancel_preflight(&self, request_id: u64) -> bool {
        self.decide_preflight(request_id, "main", false).is_some()
    }
    fn exit_code(&self) -> i32 {
        self.inner.lock().exit_code
    }
    pub(super) fn begin<I, S>(&self, window_labels: I) -> BeginShutdown
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut state = self.inner.lock();
        match &state.phase {
            ShutdownPhase::Waiting { request_id, .. } => {
                return BeginShutdown::InProgress {
                    request_id: *request_id,
                };
            }
            ShutdownPhase::Exiting { request_id } => {
                return BeginShutdown::Exiting {
                    request_id: *request_id,
                };
            }
            ShutdownPhase::Idle | ShutdownPhase::Approved => {}
        }

        let request_id = state.next_request_id;
        state.next_request_id = state.next_request_id.saturating_add(1);
        let participants = window_labels
            .into_iter()
            .map(|label| label.as_ref().to_string())
            .filter(|label| is_shutdown_participant(label))
            .collect::<BTreeSet<_>>();

        if participants.is_empty() {
            state.phase = ShutdownPhase::Exiting { request_id };
            return BeginShutdown::ReadyToExit { request_id };
        }

        let ordered = participants.iter().cloned().collect();
        state.phase = ShutdownPhase::Waiting {
            request_id,
            pending: participants,
            failures: Vec::new(),
        };
        BeginShutdown::Started {
            request_id,
            participants: ordered,
        }
    }

    pub(super) fn acknowledge(
        &self,
        request_id: u64,
        window_label: &str,
        window_failures: Vec<String>,
    ) -> AckShutdown {
        let mut state = self.inner.lock();
        let (remaining, ready_failures) = match &mut state.phase {
            ShutdownPhase::Waiting {
                request_id: active_request_id,
                pending,
                failures,
            } => {
                if *active_request_id != request_id || !pending.remove(window_label) {
                    return AckShutdown::Ignored;
                }
                failures.extend(
                    window_failures
                        .into_iter()
                        .map(|failure| format!("{window_label}: {failure}")),
                );
                if pending.is_empty() {
                    (Vec::new(), Some(std::mem::take(failures)))
                } else {
                    (pending.iter().cloned().collect(), None)
                }
            }
            _ => return AckShutdown::Ignored,
        };

        if let Some(failures) = ready_failures {
            state.phase = ShutdownPhase::Exiting { request_id };
            AckShutdown::ReadyToExit { failures }
        } else {
            AckShutdown::Waiting { remaining }
        }
    }

    pub(super) fn timeout(&self, request_id: u64) -> Option<TimeoutShutdown> {
        let mut state = self.inner.lock();
        let report = match &mut state.phase {
            ShutdownPhase::Waiting {
                request_id: active_request_id,
                pending,
                failures,
            } if *active_request_id == request_id => TimeoutShutdown {
                missing: pending.iter().cloned().collect(),
                failures: std::mem::take(failures),
            },
            _ => return None,
        };
        state.phase = ShutdownPhase::Exiting { request_id };
        Some(report)
    }

    fn is_exiting(&self) -> bool {
        matches!(self.inner.lock().phase, ShutdownPhase::Exiting { .. })
    }
}

pub(super) fn exit_request_disposition(
    shutdown: &ShutdownCoordinator,
    exit_code: Option<i32>,
) -> ExitRequestDisposition {
    if exit_code == Some(tauri::RESTART_EXIT_CODE) || shutdown.is_exiting() {
        ExitRequestDisposition::Allow
    } else {
        ExitRequestDisposition::Intercept
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppShutdownPrepare {
    request_id: u64,
    reason: String,
    timeout_ms: u64,
}

fn request_standard_exit(app: &AppHandle, shutdown: &ShutdownCoordinator, failures: Vec<String>) {
    if failures.is_empty() {
        tracing::info!("shutdown preparation complete; requesting application exit");
    } else {
        tracing::warn!(
            failures = ?failures,
            "shutdown preparation reported failures; continuing with explicit exit"
        );
    }
    app.exit(shutdown.exit_code());
}

fn cancel_preflight(
    app: &AppHandle,
    shutdown: &ShutdownCoordinator,
    request_id: u64,
    failed: bool,
) {
    if !shutdown.cancel_preflight(request_id) {
        return;
    }
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Canceled {
        request_id: u64,
    }
    let _ = app.emit_to("main", APP_PREFLIGHT_CANCEL_EVENT, Canceled { request_id });
    if failed {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().message("The close decision could not be completed. The application remains open and Telemetry drafts are retained.").title("Application close canceled").show(|_| {});
    }
}

pub(super) fn request_shutdown_preflight(
    app: &AppHandle,
    shutdown: &ShutdownCoordinator,
    reason: &str,
    exit_code: Option<i32>,
) {
    let Some(request) = shutdown.preflight(reason, exit_code) else {
        return;
    };
    if app.get_webview_window("main").is_none()
        || app
            .emit_to("main", APP_PREFLIGHT_EVENT, request.clone())
            .is_err()
    {
        cancel_preflight(app, shutdown, request.request_id, true);
        return;
    }
    let app = app.clone();
    let shutdown = shutdown.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(APP_PREFLIGHT_TIMEOUT).await;
        cancel_preflight(&app, &shutdown, request.request_id, true);
    });
}

#[tauri::command]
pub async fn app_shutdown_preflight_decide(
    app: AppHandle,
    window: WebviewWindow,
    shutdown: State<'_, ShutdownCoordinator>,
    request_id: u64,
    approved: bool,
    failed: bool,
) -> Result<bool, String> {
    let reason = shutdown
        .inner
        .lock()
        .preflight
        .as_ref()
        .filter(|(request, _)| request.request_id == request_id)
        .map(|(request, _)| request.reason.clone());
    if !approved || failed {
        if window.label() != "main" {
            return Ok(false);
        }
        let current = reason.is_some();
        cancel_preflight(&app, &shutdown, request_id, failed);
        return Ok(current);
    }
    if shutdown.decide_preflight(request_id, window.label(), true) != Some(true) {
        return Ok(false);
    }
    let state = app.state::<crate::commands::AppState>();
    let _ = state.stp.shutdown();
    state.terminal_agent.revoke_all("application shutdown");
    request_shutdown(
        &app,
        &shutdown,
        reason.as_deref().unwrap_or("application-quit"),
    );
    Ok(true)
}

pub(super) fn request_shutdown(app: &AppHandle, shutdown: &ShutdownCoordinator, reason: &str) {
    let labels = app.webview_windows().into_keys();
    match shutdown.begin(labels) {
        BeginShutdown::Started {
            request_id,
            participants,
        } => {
            tracing::info!(
                request_id,
                reason,
                participants = ?participants,
                "starting clean application shutdown"
            );
            let payload = AppShutdownPrepare {
                request_id,
                reason: reason.to_string(),
                timeout_ms: APP_SHUTDOWN_TIMEOUT.as_millis() as u64,
            };

            for label in participants {
                let emission = if app.get_webview_window(&label).is_none() {
                    Err("window disappeared before preparation".to_string())
                } else {
                    app.emit_to(label.as_str(), APP_SHUTDOWN_PREPARE_EVENT, payload.clone())
                        .map_err(|error| error.to_string())
                };
                if let Err(error) = emission {
                    match shutdown.acknowledge(
                        request_id,
                        &label,
                        vec![format!("failed to request preparation: {error}")],
                    ) {
                        AckShutdown::ReadyToExit { failures } => {
                            request_standard_exit(app, shutdown, failures);
                        }
                        AckShutdown::Waiting { .. } | AckShutdown::Ignored => {}
                    }
                }
            }

            let app = app.clone();
            let shutdown = shutdown.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(APP_SHUTDOWN_TIMEOUT).await;
                if let Some(timeout) = shutdown.timeout(request_id) {
                    tracing::warn!(
                        request_id,
                        missing = ?timeout.missing,
                        failures = ?timeout.failures,
                        "shutdown preparation timed out; continuing with explicit exit"
                    );
                    let mut failures = timeout.failures;
                    failures.extend(
                        timeout
                            .missing
                            .into_iter()
                            .map(|label| format!("{label}: preparation acknowledgement timed out")),
                    );
                    request_standard_exit(&app, &shutdown, failures);
                }
            });
        }
        BeginShutdown::ReadyToExit { .. } => request_standard_exit(app, shutdown, Vec::new()),
        BeginShutdown::InProgress { request_id } => {
            tracing::debug!(request_id, "shutdown request already in progress");
        }
        BeginShutdown::Exiting { request_id } => {
            tracing::debug!(request_id, "application exit already requested");
        }
    }
}

#[tauri::command]
pub async fn app_shutdown_acknowledge(
    app: AppHandle,
    window: WebviewWindow,
    shutdown: State<'_, ShutdownCoordinator>,
    request_id: u64,
    failures: Vec<String>,
) -> Result<(), String> {
    match shutdown.acknowledge(request_id, window.label(), failures) {
        AckShutdown::Waiting { remaining } => {
            tracing::debug!(
                request_id,
                window = window.label(),
                remaining = ?remaining,
                "shutdown preparation acknowledged"
            );
        }
        AckShutdown::ReadyToExit { failures } => request_standard_exit(&app, &shutdown, failures),
        AckShutdown::Ignored => {
            tracing::debug!(
                request_id,
                window = window.label(),
                "ignored stale or unexpected shutdown acknowledgement"
            );
        }
    }
    Ok(())
}

pub(crate) trait ProcessExitServices {
    fn shutdown_telemetry(&self) -> Result<(), String>;
    fn shutdown_discovery(&self) -> Result<(), String>;
    fn shutdown_stp(&self) -> Result<(), String>;
    fn stop_sidecar(&self);
}

impl ProcessExitServices for crate::commands::AppState {
    fn shutdown_telemetry(&self) -> Result<(), String> {
        match &self.telemetry {
            Ok(service) => service
                .shutdown_sync(std::time::Duration::from_secs(3))
                .map_err(|error| error.message),
            Err(_) => Ok(()),
        }
    }
    fn shutdown_discovery(&self) -> Result<(), String> {
        self.topology_discovery.shutdown()
    }

    fn shutdown_stp(&self) -> Result<(), String> {
        self.stp.shutdown()
    }

    fn stop_sidecar(&self) {
        self.agent.stop();
    }
}

pub(crate) fn cleanup_process_services(services: &impl ProcessExitServices) {
    if let Err(error) = services.shutdown_telemetry() {
        tracing::warn!(error = %error, "application exit cleanup could not stop telemetry cleanly");
    }
    if let Err(error) = services.shutdown_discovery() {
        tracing::warn!(error = %error, "application exit cleanup could not stop topology discovery cleanly");
    }
    if let Err(error) = services.shutdown_stp() {
        tracing::warn!(error = %error, "application exit cleanup could not stop STP cleanly");
    }
    services.stop_sidecar();
}

pub(super) fn cleanup_before_process_exit(app: &AppHandle) {
    let state = app.state::<crate::commands::AppState>();
    state.terminal_logging.shutdown();
    cleanup_process_services(&*state);
    tracing::info!("application exit cleanup finished telemetry, topology discovery, STP and sidecar cleanup attempts");
}

#[cfg(test)]
mod tests {
    use parking_lot::Mutex;

    use super::{
        cleanup_process_services, close_disposition, exit_request_disposition, AckShutdown,
        BeginShutdown, ProcessExitServices, ShutdownCoordinator, TimeoutShutdown,
        WindowCloseDisposition,
    };

    struct RecordingExitServices {
        calls: Mutex<Vec<&'static str>>,
    }

    impl ProcessExitServices for RecordingExitServices {
        fn shutdown_telemetry(&self) -> Result<(), String> {
            self.calls.lock().push("telemetry");
            Ok(())
        }
        fn shutdown_discovery(&self) -> Result<(), String> {
            self.calls.lock().push("discovery");
            Ok(())
        }

        fn shutdown_stp(&self) -> Result<(), String> {
            self.calls.lock().push("stp");
            Err("shutdown failed".into())
        }

        fn stop_sidecar(&self) {
            self.calls.lock().push("sidecar");
        }
    }

    #[test]
    fn process_exit_stops_sidecar_after_stp_even_when_stp_shutdown_fails() {
        let services = RecordingExitServices {
            calls: Mutex::new(Vec::new()),
        };

        cleanup_process_services(&services);

        assert_eq!(
            *services.calls.lock(),
            vec!["telemetry", "discovery", "stp", "sidecar"]
        );
    }

    #[test]
    fn main_window_close_requests_application_exit() {
        assert_eq!(
            close_disposition("main"),
            WindowCloseDisposition::ExitApplication
        );
    }

    #[test]
    fn normal_quit_preflight_cancels_before_confirmed_cleanup_and_stale_approvals_fail() {
        let shutdown = ShutdownCoordinator::default();
        let first = shutdown.preflight("main-window-close", Some(0)).unwrap();
        assert!(!shutdown.is_exiting());
        assert_eq!(
            shutdown.decide_preflight(first.request_id, "editor-a", true),
            None
        );
        assert_eq!(
            shutdown.decide_preflight(first.request_id, "main", false),
            Some(false)
        );
        let next = shutdown.preflight("application-quit", Some(7)).unwrap();
        assert!(next.request_id > first.request_id);
        assert_eq!(
            shutdown.decide_preflight(first.request_id, "main", true),
            None
        );
        assert_eq!(
            shutdown.decide_preflight(next.request_id, "main", true),
            Some(true)
        );
        assert_eq!(shutdown.exit_code(), 7);
    }

    #[test]
    fn missing_preflight_response_returns_idle_and_cannot_authorize_a_later_quit() {
        let shutdown = ShutdownCoordinator::default();
        let first = shutdown.preflight("application-quit", None).unwrap();
        assert!(shutdown.cancel_preflight(first.request_id));
        assert!(!shutdown.cancel_preflight(first.request_id));
        assert_eq!(
            shutdown.decide_preflight(first.request_id, "main", true),
            None
        );
        assert!(shutdown.preflight("main-window-close", None).is_some());
        assert!(!shutdown.is_exiting());
    }

    #[test]
    fn secondary_window_closes_stay_local() {
        for label in ["editor-00000000-0000-0000-0000-000000000001", "browser-1"] {
            assert_eq!(
                close_disposition(label),
                WindowCloseDisposition::CloseWindowOnly,
                "secondary window {label} must not terminate the app"
            );
        }
    }

    #[test]
    fn shutdown_waits_only_for_main_and_detached_editor_webviews() {
        let shutdown = ShutdownCoordinator::default();

        assert_eq!(
            shutdown.begin(["browser-1", "editor-b", "main", "editor-a"]),
            BeginShutdown::Started {
                request_id: 1,
                participants: vec![
                    "editor-a".to_string(),
                    "editor-b".to_string(),
                    "main".to_string(),
                ],
            }
        );
    }

    #[test]
    fn repeated_shutdown_requests_share_the_in_flight_request() {
        let shutdown = ShutdownCoordinator::default();

        assert!(matches!(
            shutdown.begin(["main"]),
            BeginShutdown::Started { request_id: 1, .. }
        ));
        assert_eq!(
            shutdown.begin(["main", "editor-late"]),
            BeginShutdown::InProgress { request_id: 1 }
        );
    }

    #[test]
    fn exit_stays_blocked_until_every_participant_acknowledges() {
        let shutdown = ShutdownCoordinator::default();
        let BeginShutdown::Started { request_id, .. } = shutdown.begin(["main", "editor-a"]) else {
            panic!("first request must start");
        };

        assert_eq!(
            shutdown.acknowledge(request_id, "main", Vec::new()),
            AckShutdown::Waiting {
                remaining: vec!["editor-a".to_string()]
            }
        );
        assert_eq!(
            shutdown.acknowledge(request_id, "editor-a", Vec::new()),
            AckShutdown::ReadyToExit {
                failures: Vec::new()
            }
        );
        assert_eq!(
            exit_request_disposition(&shutdown, Some(0)),
            super::ExitRequestDisposition::Allow
        );
    }

    #[test]
    fn preparation_failure_is_reported_without_trapping_the_app_open() {
        let shutdown = ShutdownCoordinator::default();
        let BeginShutdown::Started { request_id, .. } = shutdown.begin(["main"]) else {
            panic!("first request must start");
        };

        assert_eq!(
            shutdown.acknowledge(
                request_id,
                "main",
                vec!["session: database unavailable".to_string()],
            ),
            AckShutdown::ReadyToExit {
                failures: vec!["main: session: database unavailable".to_string()],
            }
        );
    }

    #[test]
    fn timeout_reports_missing_windows_and_allows_the_fallback_exit_once() {
        let shutdown = ShutdownCoordinator::default();
        let BeginShutdown::Started { request_id, .. } = shutdown.begin(["main", "editor-a"]) else {
            panic!("first request must start");
        };
        assert!(matches!(
            shutdown.acknowledge(request_id, "main", Vec::new()),
            AckShutdown::Waiting { .. }
        ));

        assert_eq!(
            shutdown.timeout(request_id),
            Some(TimeoutShutdown {
                missing: vec!["editor-a".to_string()],
                failures: Vec::new(),
            })
        );
        assert_eq!(shutdown.timeout(request_id), None);
    }

    #[test]
    fn user_exit_is_intercepted_but_coordinator_exit_and_restart_are_allowed() {
        let shutdown = ShutdownCoordinator::default();
        assert_eq!(
            exit_request_disposition(&shutdown, None),
            super::ExitRequestDisposition::Intercept
        );
        assert_eq!(
            exit_request_disposition(&shutdown, Some(tauri::RESTART_EXIT_CODE)),
            super::ExitRequestDisposition::Allow
        );

        let BeginShutdown::Started { request_id, .. } = shutdown.begin(["main"]) else {
            panic!("first request must start");
        };
        assert!(matches!(
            shutdown.acknowledge(request_id, "main", Vec::new()),
            AckShutdown::ReadyToExit { .. }
        ));
        assert_eq!(
            exit_request_disposition(&shutdown, Some(0)),
            super::ExitRequestDisposition::Allow
        );
    }
}
