use parking_lot::Mutex;
use serde::Serialize;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

pub(super) const APP_SHUTDOWN_PREPARE_EVENT: &str = "app://prepare-shutdown";
const APP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);

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
}

impl Default for ShutdownState {
    fn default() -> Self {
        Self {
            next_request_id: 1,
            phase: ShutdownPhase::Idle,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(super) struct ShutdownCoordinator {
    inner: Arc<Mutex<ShutdownState>>,
}

impl ShutdownCoordinator {
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
            ShutdownPhase::Idle => {}
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

fn request_standard_exit(app: &AppHandle, failures: Vec<String>) {
    if failures.is_empty() {
        tracing::info!("shutdown preparation complete; requesting application exit");
    } else {
        tracing::warn!(
            failures = ?failures,
            "shutdown preparation reported failures; continuing with explicit exit"
        );
    }
    app.exit(0);
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
                    app.emit_to(
                        label.as_str(),
                        APP_SHUTDOWN_PREPARE_EVENT,
                        payload.clone(),
                    )
                    .map_err(|error| error.to_string())
                };
                if let Err(error) = emission {
                    match shutdown.acknowledge(
                        request_id,
                        &label,
                        vec![format!("failed to request preparation: {error}")],
                    ) {
                        AckShutdown::ReadyToExit { failures } => {
                            request_standard_exit(app, failures);
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
                    request_standard_exit(&app, failures);
                }
            });
        }
        BeginShutdown::ReadyToExit { .. } => request_standard_exit(app, Vec::new()),
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
        AckShutdown::ReadyToExit { failures } => request_standard_exit(&app, failures),
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

trait ProcessExitServices {
    fn shutdown_stp(&self) -> Result<(), String>;
    fn stop_sidecar(&self);
}

impl ProcessExitServices for crate::commands::AppState {
    fn shutdown_stp(&self) -> Result<(), String> {
        self.stp.shutdown()
    }

    fn stop_sidecar(&self) {
        self.agent.stop();
    }
}

fn cleanup_process_services(services: &impl ProcessExitServices) {
    if let Err(error) = services.shutdown_stp() {
        tracing::warn!(error = %error, "application exit cleanup could not stop STP cleanly");
    }
    services.stop_sidecar();
}

pub(super) fn cleanup_before_process_exit(app: &AppHandle) {
    let state = app.state::<crate::commands::AppState>();
    cleanup_process_services(&*state);
    tracing::info!("application exit cleanup stopped STP and the sidecar");
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

        assert_eq!(*services.calls.lock(), vec!["stp", "sidecar"]);
    }

    #[test]
    fn main_window_close_requests_application_exit() {
        assert_eq!(
            close_disposition("main"),
            WindowCloseDisposition::ExitApplication
        );
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
