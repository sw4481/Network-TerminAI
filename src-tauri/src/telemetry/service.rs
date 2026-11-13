//! One runtime owns collection, authoring, revision fences and observable cleanup.
use super::{
    catalog::{ProtocolClassifier, UpstreamWidgetImporter},
    config::{DraftCaptureProof, DraftSamplePlan, TelemetryConfigRepository},
    history::TelemetryHistory,
    local::LocalCollector,
    model::*,
    parser::{validate_binding, TelemetryParser},
    policy::CommandPolicy,
    processing::{FrameNormalizer, MAX_WORKSPACE_BYTES},
    ssh::{SavedTargetMetadata, TelemetrySshSession, TelemetrySshTargetResolver},
};
use parking_lot::{Condvar, Mutex};
use sha2::Digest;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::PathBuf,
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex, Notify};
use tokio_util::sync::CancellationToken;

const CLEANUP: Duration = Duration::from_secs(3);
type Reply<T> = oneshot::Sender<Result<T, Diagnostic>>;
fn failure(code: &str, message: &str) -> Diagnostic {
    Diagnostic::new(code, message, "telemetry")
}
fn unknown() -> Diagnostic {
    failure(
        "workspace_unknown",
        "Telemetry workspace is not established",
    )
}
fn pending() -> Diagnostic {
    failure(
        "cleanup_pending",
        "Telemetry cleanup remains owned; retry Stop, Close or shutdown",
    )
}

trait LocalSampler: Send {
    fn sample(&mut self, now: SampleTime) -> Result<LocalSample, Diagnostic>;
}
impl LocalSampler for LocalCollector {
    fn sample(&mut self, now: SampleTime) -> Result<LocalSample, Diagnostic> {
        self.sample(now)
    }
}
pub struct LocalCollectorFactory(Arc<dyn Fn() -> Box<dyn LocalSampler> + Send + Sync>);
impl Default for LocalCollectorFactory {
    fn default() -> Self {
        Self(Arc::new(|| Box::new(LocalCollector::new())))
    }
}
impl LocalCollectorFactory {
    #[cfg(test)]
    fn fixture(create: impl Fn() -> Box<dyn LocalSampler> + Send + Sync + 'static) -> Self {
        Self(Arc::new(create))
    }
}
struct CollectedCapture {
    capture: Capture,
    display_name: String,
    reconnected: bool,
}
#[async_trait::async_trait]
trait SshSampler: Send {
    async fn capture(
        &mut self,
        request: CaptureRequest,
        cancel: CancellationToken,
    ) -> Result<CollectedCapture, Diagnostic>;
    async fn close(&mut self) -> Result<(), Diagnostic>;
    fn display_name(&self) -> Option<String> {
        None
    }
}
pub struct TelemetrySshFactory(Arc<dyn Fn(TargetRef) -> Box<dyn SshSampler> + Send + Sync>);
impl TelemetrySshFactory {
    pub fn new(db: Arc<Mutex<rusqlite::Connection>>, known_hosts: PathBuf) -> Self {
        Self(Arc::new(move |target| {
            Box::new(NativeSsh {
                resolver: Arc::new(TelemetrySshTargetResolver::new(
                    db.clone(),
                    known_hosts.clone(),
                )),
                target,
                session: None,
                display_name: String::new(),
            })
        }))
    }
    #[cfg(test)]
    fn fixture(create: impl Fn(TargetRef) -> Box<dyn SshSampler> + Send + Sync + 'static) -> Self {
        Self(Arc::new(create))
    }
}
struct NativeSsh {
    resolver: Arc<TelemetrySshTargetResolver>,
    target: TargetRef,
    session: Option<TelemetrySshSession>,
    display_name: String,
}
#[async_trait::async_trait]
impl SshSampler for NativeSsh {
    async fn capture(
        &mut self,
        request: CaptureRequest,
        cancel: CancellationToken,
    ) -> Result<CollectedCapture, Diagnostic> {
        let reconnected = self.session.is_none();
        if reconnected {
            self.display_name.clear();
            let resolver = self.resolver.clone();
            let target = self.target.clone();
            // Await the actual blocking call; neither cancellation nor timeout may detach it.
            let resolved = tokio::task::spawn_blocking(move || resolver.resolve(&target))
                .await
                .map_err(|_| {
                    failure("ssh_owner_failed", "Saved target resolution worker failed")
                })??;
            self.display_name = resolved.display_name().to_string();
            self.session = Some(TelemetrySshSession::connect(resolved, cancel.clone()).await?);
        }
        let result = self
            .session
            .as_mut()
            .unwrap()
            .capture(&request, cancel)
            .await;
        if result.is_err() {
            self.session = None;
        }
        result.map(|capture| CollectedCapture {
            capture,
            display_name: self.display_name.clone(),
            reconnected,
        })
    }
    async fn close(&mut self) -> Result<(), Diagnostic> {
        if let Some(session) = &mut self.session {
            session.close().await?;
        }
        self.session = None;
        self.resolver.shutdown().await
    }
    fn display_name(&self) -> Option<String> {
        (!self.display_name.trim().is_empty()).then(|| self.display_name.clone())
    }
}

#[derive(Clone)]
pub struct TelemetryClock(Arc<Clock>);
struct Clock {
    origin: Instant,
    wake: Notify,
    #[cfg(test)]
    time: Mutex<Option<SampleTime>>,
}
impl Default for TelemetryClock {
    fn default() -> Self {
        Self(Arc::new(Clock {
            origin: Instant::now(),
            wake: Notify::new(),
            #[cfg(test)]
            time: Mutex::new(None),
        }))
    }
}
impl TelemetryClock {
    fn now(&self) -> SampleTime {
        #[cfg(test)]
        if let Some(time) = *self.0.time.lock() {
            return time;
        }
        SampleTime {
            wall_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(i64::MAX as u128) as i64,
            monotonic_ms: self.0.origin.elapsed().as_millis().min(u64::MAX as u128) as u64,
        }
    }
    async fn wake(&self) {
        tokio::select! { _ = self.0.wake.notified() => {}, _ = tokio::time::sleep(Duration::from_millis(10)) => {} }
    }
    #[cfg(test)]
    fn fake(time: SampleTime) -> Self {
        let clock = Self::default();
        *clock.0.time.lock() = Some(time);
        clock
    }
    #[cfg(test)]
    fn advance(&self, duration: Duration) {
        let mut time = self.0.time.lock();
        let time = time.as_mut().unwrap();
        time.monotonic_ms += duration.as_millis() as u64;
        time.wall_ms += duration.as_millis() as i64;
        self.0.wake.notify_waiters();
    }
}

pub struct TelemetryService {
    requests: mpsc::Sender<Request>,
    stop: CancellationToken,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
    finished: Arc<(Mutex<Option<Result<(), Diagnostic>>>, Condvar)>,
}
enum Request {
    #[cfg(test)]
    RetainedBytes(String, Reply<usize>),
    #[cfg(test)]
    LocalDiagnostics(String, Reply<Vec<Diagnostic>>),
    #[cfg(test)]
    QuotaParity(String, Reply<bool>),
    #[cfg(test)]
    TargetRevision(String, String, Reply<Revision>),
    Establish(String, Reply<TelemetrySnapshot>),
    Start(
        StartRequest,
        Vec<SavedTargetMetadata>,
        Reply<TelemetrySnapshot>,
    ),
    Select(String, SavedTargetMetadata, Reply<TelemetrySnapshot>),
    Catalog(String, ConfigScope, Reply<TelemetryRead<AuthoringCatalog>>),
    Validate(String, ConfigDraft, Reply<TelemetryRead<ValidationReport>>),
    Import(
        String,
        ConfigScope,
        String,
        Reply<TelemetryRead<ImportReport>>,
    ),
    Reset(
        String,
        ConfigScope,
        ResetAsset,
        Reply<TelemetryRead<ConfigDraft>>,
    ),
    Test(
        String,
        String,
        TemplateAsset,
        Reply<TelemetryRead<ParsedInterpretation>>,
    ),
    Stop(String, bool, Reply<()>),
    Snapshot(String, Reply<TelemetrySnapshot>),
    Widget(WidgetQuery, Reply<TelemetryRead<WidgetPage>>),
    Series(SeriesQuery, Reply<TelemetryRead<SeriesPage>>),
    Preview(String, ConfigDraft, Reply<TelemetryRead<PreviewReport>>),
    Apply(
        String,
        ConfigDraft,
        PreviewToken,
        Reply<TelemetryRead<ApplyResult>>,
    ),
    Capture(
        String,
        TargetRef,
        CaptureRequest,
        Reply<TelemetryRead<Capture>>,
    ),
    CaptureDraft(
        String,
        TargetRef,
        ConfigDraft,
        String,
        Reply<TelemetryRead<Capture>>,
    ),
}
impl TelemetryService {
    /// Repository and service must receive the same parser Arc at construction.
    pub fn new(
        repository: TelemetryConfigRepository,
        local_factory: LocalCollectorFactory,
        ssh_factory: TelemetrySshFactory,
        parser: Arc<TelemetryParser>,
        clock: TelemetryClock,
    ) -> Self {
        let (requests, receive) = mpsc::channel(64);
        let stop = CancellationToken::new();
        let finished = Arc::new((Mutex::new(None), Condvar::new()));
        if !repository.uses_parser(&parser) {
            *finished.0.lock() = Some(Err(failure(
                "parser_owner",
                "Repository and service must share the same parser Arc",
            )));
            return Self {
                requests,
                stop,
                thread: Mutex::new(None),
                finished,
            };
        }
        let completion = finished.clone();
        let cancellation = stop.clone();
        let thread = thread::Builder::new()
            .name("telemetry-owner".into())
            .spawn(move || {
                let result = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => {
                        runtime.block_on(
                            Owner::new(repository, local_factory, ssh_factory, parser, clock)
                                .run(receive, cancellation),
                        );
                        Ok(())
                    }
                    Err(_) => Err(failure(
                        "owner_runtime",
                        "Cannot start telemetry owner runtime",
                    )),
                };
                *completion.0.lock() = Some(result);
                completion.1.notify_all();
            });
        let thread = match thread {
            Ok(thread) => Some(thread),
            Err(_) => {
                *finished.0.lock() = Some(Err(failure(
                    "owner_thread",
                    "Cannot start telemetry owner thread",
                )));
                None
            }
        };
        Self {
            requests,
            stop,
            thread: Mutex::new(thread),
            finished,
        }
    }
    async fn request<T>(&self, create: impl FnOnce(Reply<T>) -> Request) -> Result<T, Diagnostic> {
        if let Some(Err(error)) = self.finished.0.lock().clone() {
            return Err(error);
        }
        if self.stop.is_cancelled() {
            return Err(failure(
                "service_shutdown",
                "Telemetry service is shutting down",
            ));
        }
        let (send, receive) = oneshot::channel();
        self.requests.try_send(create(send)).map_err(|_| {
            failure(
                "service_busy",
                "Telemetry owner admission is unavailable; retry",
            )
        })?;
        receive.await.map_err(|_| {
            failure(
                "owner_stopped",
                "Telemetry owner stopped before acknowledging the request",
            )
        })?
    }
    pub async fn establish(&self, workspace_id: &str) -> Result<TelemetrySnapshot, Diagnostic> {
        self.request(|r| Request::Establish(workspace_id.into(), r))
            .await
    }
    pub async fn start(&self, request: StartRequest) -> Result<TelemetrySnapshot, Diagnostic> {
        self.request(|r| Request::Start(request, vec![], r)).await
    }
    pub async fn stop(&self, workspace_id: &str) -> Result<(), Diagnostic> {
        self.request(|r| Request::Stop(workspace_id.into(), false, r))
            .await
    }
    pub async fn close(&self, workspace_id: &str) -> Result<(), Diagnostic> {
        self.request(|r| Request::Stop(workspace_id.into(), true, r))
            .await
    }
    pub async fn snapshot(&self, workspace_id: &str) -> Result<TelemetrySnapshot, Diagnostic> {
        self.request(|r| Request::Snapshot(workspace_id.into(), r))
            .await
    }
    pub async fn widget(&self, query: WidgetQuery) -> Result<WidgetPage, Diagnostic> {
        self.widget_read(query).await.map(|read| read.value)
    }
    pub async fn widget_read(
        &self,
        query: WidgetQuery,
    ) -> Result<TelemetryRead<WidgetPage>, Diagnostic> {
        self.request(|r| Request::Widget(query, r)).await
    }
    pub async fn series(&self, query: SeriesQuery) -> Result<SeriesPage, Diagnostic> {
        self.series_read(query).await.map(|read| read.value)
    }
    pub async fn preview(
        &self,
        workspace_id: &str,
        draft: &ConfigDraft,
    ) -> Result<PreviewReport, Diagnostic> {
        self.preview_read(workspace_id, draft)
            .await
            .map(|read| read.value)
    }
    pub async fn apply(
        &self,
        workspace_id: &str,
        draft: ConfigDraft,
        token: PreviewToken,
    ) -> Result<ApplyResult, Diagnostic> {
        self.apply_read(workspace_id, draft, token)
            .await
            .map(|read| read.value)
    }
    pub async fn capture_sample(
        &self,
        workspace_id: &str,
        target: TargetRef,
        request: CaptureRequest,
    ) -> Result<Capture, Diagnostic> {
        self.capture_read(workspace_id, target, request)
            .await
            .map(|read| read.value)
    }
    pub async fn capture_draft_sample(
        &self,
        workspace_id: &str,
        target: TargetRef,
        draft: &ConfigDraft,
        parser_id: &str,
    ) -> Result<Capture, Diagnostic> {
        self.capture_draft_read(workspace_id, target, draft, parser_id)
            .await
            .map(|read| read.value)
    }
    pub(crate) async fn start_admitted(
        &self,
        request: StartRequest,
        names: Vec<SavedTargetMetadata>,
    ) -> Result<TelemetrySnapshot, Diagnostic> {
        self.request(|r| Request::Start(request, names, r)).await
    }
    pub(crate) async fn select(
        &self,
        id: &str,
        target: SavedTargetMetadata,
    ) -> Result<TelemetrySnapshot, Diagnostic> {
        self.request(|r| Request::Select(id.into(), target, r))
            .await
    }
    pub async fn catalog(
        &self,
        id: &str,
        scope: ConfigScope,
    ) -> Result<TelemetryRead<AuthoringCatalog>, Diagnostic> {
        self.request(|r| Request::Catalog(id.into(), scope, r))
            .await
    }
    pub async fn validate(
        &self,
        id: &str,
        draft: ConfigDraft,
    ) -> Result<TelemetryRead<ValidationReport>, Diagnostic> {
        self.request(|r| Request::Validate(id.into(), draft, r))
            .await
    }
    pub async fn import(
        &self,
        id: &str,
        scope: ConfigScope,
        yaml: String,
    ) -> Result<TelemetryRead<ImportReport>, Diagnostic> {
        self.request(|r| Request::Import(id.into(), scope, yaml, r))
            .await
    }
    pub async fn reset(
        &self,
        id: &str,
        scope: ConfigScope,
        asset: ResetAsset,
    ) -> Result<TelemetryRead<ConfigDraft>, Diagnostic> {
        self.request(|r| Request::Reset(id.into(), scope, asset, r))
            .await
    }
    pub async fn test_template(
        &self,
        id: &str,
        capture: &str,
        template: TemplateAsset,
    ) -> Result<TelemetryRead<ParsedInterpretation>, Diagnostic> {
        self.request(|r| Request::Test(id.into(), capture.into(), template, r))
            .await
    }
    pub async fn series_read(
        &self,
        query: SeriesQuery,
    ) -> Result<TelemetryRead<SeriesPage>, Diagnostic> {
        self.request(|r| Request::Series(query, r)).await
    }
    pub async fn preview_read(
        &self,
        id: &str,
        draft: &ConfigDraft,
    ) -> Result<TelemetryRead<PreviewReport>, Diagnostic> {
        self.request(|r| Request::Preview(id.into(), draft.clone(), r))
            .await
    }
    pub async fn apply_read(
        &self,
        id: &str,
        draft: ConfigDraft,
        token: PreviewToken,
    ) -> Result<TelemetryRead<ApplyResult>, Diagnostic> {
        self.request(|r| Request::Apply(id.into(), draft, token, r))
            .await
    }
    pub async fn capture_read(
        &self,
        id: &str,
        target: TargetRef,
        request: CaptureRequest,
    ) -> Result<TelemetryRead<Capture>, Diagnostic> {
        self.request(|r| Request::Capture(id.into(), target, request, r))
            .await
    }
    pub async fn capture_draft_read(
        &self,
        id: &str,
        target: TargetRef,
        draft: &ConfigDraft,
        parser_id: &str,
    ) -> Result<TelemetryRead<Capture>, Diagnostic> {
        self.request(|r| {
            Request::CaptureDraft(id.into(), target, draft.clone(), parser_id.into(), r)
        })
        .await
    }

    pub async fn shutdown(&self) -> Result<(), Diagnostic> {
        self.stop.cancel();
        let deadline = tokio::time::Instant::now() + CLEANUP;
        loop {
            if let Some(result) = self.finished.0.lock().clone() {
                self.join();
                return result;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(pending());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    pub fn shutdown_sync(&self, timeout: Duration) -> Result<(), Diagnostic> {
        self.stop.cancel();
        let deadline = Instant::now() + timeout.min(CLEANUP);
        let mut complete = self.finished.0.lock();
        while complete.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(pending());
            }
            self.finished.1.wait_for(&mut complete, left);
        }
        let result = complete.clone().unwrap();
        drop(complete);
        self.join();
        result
    }
    fn join(&self) {
        if let Some(thread) = self.thread.lock().take() {
            let _ = thread.join();
        }
    }
}
impl Drop for TelemetryService {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

type SshOwner = Arc<AsyncMutex<Box<dyn SshSampler>>>;
type LocalOwner = Arc<Mutex<Box<dyn LocalSampler>>>;
#[derive(Clone)]
struct Baseline {
    frame: Arc<WidgetFrame>,
    monotonic_ms: u64,
    received_ms: u64,
    wall_ms: i64,
    valid: bool,
    bytes: usize,
}
struct Poll {
    command: CaptureRequest,
    widgets: Vec<WidgetDefinition>,
    interval_ms: u64,
    next_ms: u64,
}
struct Target {
    reference: TargetRef,
    // Authoring enrollment alone never grants periodic collection.
    periodic: bool,
    config: EffectiveConfig,
    worker: Option<SshOwner>,
    cancel: CancellationToken,
    polls: Vec<Poll>,
    cursor: usize,
    busy: bool,
    suspended: bool,
    failures: usize,
    retry_ms: u64,
    status: TargetStatus,
    success_ms: Option<u64>,
    manual: Option<(
        CaptureRequest,
        Option<DraftSamplePlan>,
        Reply<TelemetryRead<Capture>>,
    )>,
    monitored_interfaces: Vec<String>,
}
struct Workspace {
    generation: u64,
    sequence: u64,
    running: bool,
    targets: BTreeMap<String, Target>,
    closing: bool,
    stopping: bool,
    local_enabled: bool,
    local_config: EffectiveConfig,
    local_worker: Option<LocalOwner>,
    local_busy: usize,
    local_next_ms: u64,
    cancel: CancellationToken,
    latest: BTreeMap<(String, String), Baseline>,
    history: TelemetryHistory,
    captures: BTreeMap<(String, String), VecDeque<Capture>>,
    local_samples: VecDeque<LocalSample>,
    proofs: BTreeMap<String, DraftCaptureProof>,
    capture_charges: BTreeMap<String, usize>,
    diagnostics: Vec<Diagnostic>,
    active_jobs: usize,
    retiring: BTreeMap<u64, (SshOwner, bool)>,
    waiters: Vec<Waiter>,
}
fn read_value<T>(
    id: &str,
    workspace: &Workspace,
    revision: Revision,
    value: T,
) -> TelemetryRead<T> {
    TelemetryRead {
        workspace_id: id.into(),
        generation: workspace.generation,
        sequence: workspace.sequence,
        revision,
        value,
    }
}
impl Workspace {
    fn source_revision(&self, target: &str) -> Result<Revision, Diagnostic> {
        if target == "local" {
            Ok(self.local_config.revision.clone())
        } else {
            self.targets
                .get(target)
                .map(|target| target.config.revision.clone())
                .ok_or_else(|| failure("target_unknown", "Target is not enrolled"))
        }
    }
    fn discard_draft_captures(&mut self) {
        if self.proofs.is_empty() {
            return;
        }
        self.captures.retain(|_, captures| {
            captures.retain(|capture| !self.proofs.contains_key(&capture.capture_id));
            !captures.is_empty()
        });
        for id in self.proofs.keys() {
            self.capture_charges.remove(id);
        }
        self.proofs.clear();
    }
    fn fence(&mut self) {
        self.discard_draft_captures();
        self.generation += 1;
        self.sequence += 1;
    }
}
struct Waiter {
    deadline: Instant,
    close: bool,
    reply: Reply<()>,
}
enum Output {
    Local(Result<LocalSample, Diagnostic>),
    Network {
        command: String,
        result: Result<CollectedCapture, Diagnostic>,
        frames: Vec<WidgetFrame>,
        sample: Option<Reply<TelemetryRead<Capture>>>,
        plan: Option<DraftSamplePlan>,
        display_name: Option<String>,
    },
    Preview {
        base: Revision,
        result: PreviewReport,
        sample: Option<LocalSample>,
        reply: Reply<TelemetryRead<PreviewReport>>,
    },
    Test {
        result: Result<ParsedInterpretation, Diagnostic>,
        base: Revision,
        reply: Reply<TelemetryRead<ParsedInterpretation>>,
    },
    Apply {
        base: Revision,
        result: Result<ApplyResult, Diagnostic>,
        reply: Reply<TelemetryRead<ApplyResult>>,
    },
}
struct Completed {
    workspace: String,
    generation: u64,
    target: String,
    revision: String,
    output: Output,
}
struct Owner {
    repository: Arc<TelemetryConfigRepository>,
    local_factory: LocalCollectorFactory,
    ssh_factory: TelemetrySshFactory,
    parser: Arc<TelemetryParser>,
    clock: TelemetryClock,
    workspaces: BTreeMap<String, Workspace>,
    jobs: tokio::task::JoinSet<Completed>,
    cleanup: tokio::task::JoinSet<(String, u64, Result<(), Diagnostic>)>,
    busy_targets: BTreeSet<String>,
    registered: Vec<TargetRef>,
    cursor: usize,
    retirement: u64,
    drain: Option<tokio::task::JoinHandle<Result<(), Diagnostic>>>,
    drain_ok: bool,
    shutdown: bool,
    local_effective: EffectiveConfig,
    apply_busy: bool,
    publication_targets: BTreeSet<String>,
    preview_jobs: usize,
}
impl Owner {
    fn new(
        repository: TelemetryConfigRepository,
        local_factory: LocalCollectorFactory,
        ssh_factory: TelemetrySshFactory,
        parser: Arc<TelemetryParser>,
        clock: TelemetryClock,
    ) -> Self {
        let local_effective = repository.effective_local();
        Self {
            repository: Arc::new(repository),
            local_factory,
            ssh_factory,
            parser,
            clock,
            workspaces: BTreeMap::new(),
            jobs: tokio::task::JoinSet::new(),
            cleanup: tokio::task::JoinSet::new(),
            busy_targets: BTreeSet::new(),
            registered: vec![],
            cursor: 0,
            retirement: 0,
            drain: None,
            drain_ok: false,
            shutdown: false,
            local_effective,
            apply_busy: false,
            publication_targets: BTreeSet::new(),
            preview_jobs: 0,
        }
    }
    async fn run(mut self, mut requests: mpsc::Receiver<Request>, stop: CancellationToken) {
        loop {
            if stop.is_cancelled() && !self.shutdown {
                self.shutdown = true;
                for workspace in self.workspaces.values_mut() {
                    Self::halt(workspace, &mut self.retirement);
                }
            }
            self.housekeeping();
            if self.shutdown
                && self.jobs.is_empty()
                && self.cleanup.is_empty()
                && self.drain.is_none()
                && self.workspaces.values().all(|w| w.retiring.is_empty())
                && self.parser.shutdown().await.is_ok()
            {
                break;
            }
            if !self.shutdown {
                self.schedule();
            }
            tokio::select! {
                request = requests.recv(), if !self.shutdown => match request { Some(request) => self.handle(request), None => stop.cancel() },
                result = self.jobs.join_next(), if !self.jobs.is_empty() => {
                    if let Some(Ok(result)) = result { self.complete(result); }
                },
                result = self.cleanup.join_next(), if !self.cleanup.is_empty() => {
                    if let Some(Ok((workspace, id, result))) = result {
                        if let Some(workspace) = self.workspaces.get_mut(&workspace) {
                            match result {
                                Ok(()) => { workspace.retiring.remove(&id); }
                                Err(error) => {
                                    if let Some((_, busy)) = workspace.retiring.get_mut(&id) { *busy = false; }
                                    diagnostic(&mut workspace.diagnostics, error);
                                }
                            }
                        }
                    }
                },
                _ = self.clock.wake() => {},
            }
        }
    }
    fn establish(&mut self, id: &str) -> Result<(), Diagnostic> {
        if id.is_empty() || id.len() > 128 {
            return Err(failure(
                "workspace_id",
                "Workspace identity is empty or exceeds its limit",
            ));
        }
        if self
            .workspaces
            .get(id)
            .is_some_and(|workspace| workspace.closing || workspace.stopping)
        {
            return Err(pending());
        }
        self.workspaces
            .entry(id.into())
            .or_insert_with(|| Workspace {
                generation: 0,
                sequence: 0,
                running: false,
                targets: BTreeMap::new(),
                closing: false,
                stopping: false,
                local_enabled: false,
                local_config: self.local_effective.clone(),
                local_worker: None,
                local_busy: 0,
                local_next_ms: 0,
                cancel: CancellationToken::new(),
                latest: BTreeMap::new(),
                history: TelemetryHistory::new(id),
                captures: BTreeMap::new(),
                local_samples: VecDeque::new(),
                proofs: BTreeMap::new(),
                capture_charges: BTreeMap::new(),
                diagnostics: vec![],
                active_jobs: 0,
                retiring: BTreeMap::new(),
                waiters: vec![],
            });
        Ok(())
    }
    fn target(&self, reference: TargetRef) -> Result<Target, Diagnostic> {
        if reference.connection_id.is_empty()
            || reference.connection_id.len() > 512
            || reference.connection_id == "local"
        {
            return Err(failure(
                "target_reference",
                "Select a nonempty, nonlocal saved target identity within the ID limit",
            ));
        }
        let config = self.repository.effective(&reference);
        let polls = polls(&config, &reference, false)?;
        Ok(Target {
            status: TargetStatus {
                target_id: reference.connection_id.clone(),
                display_name: "Saved connection name unavailable".into(),
                platform: Some(reference.platform),
                monitoring_selected: false,
                state: CollectionState::Stopped,
                last_success_at_ms: None,
                diagnostics: vec![],
            },
            reference,
            periodic: false,
            config,
            worker: None,
            cancel: CancellationToken::new(),
            polls,
            cursor: 0,
            busy: false,
            suspended: false,
            failures: 0,
            retry_ms: 0,
            success_ms: None,
            manual: None,
            monitored_interfaces: vec![],
        })
    }
    fn register(&mut self) -> Result<(), Diagnostic> {
        self.register_refs(
            self.workspaces
                .values()
                .flat_map(|workspace| {
                    workspace
                        .targets
                        .values()
                        .map(|target| target.reference.clone())
                })
                .collect(),
        )
    }
    fn register_refs(&mut self, references: Vec<TargetRef>) -> Result<(), Diagnostic> {
        let mut selected = BTreeMap::new();
        for target in references {
            if selected
                .insert(target.connection_id.clone(), target.platform)
                .is_some_and(|p| p != target.platform)
            {
                return Err(failure(
                    "target_platform",
                    "A saved target has conflicting selected platforms",
                ));
            }
        }
        let selected: Vec<_> = selected
            .into_iter()
            .map(|(connection_id, platform)| TargetRef {
                connection_id,
                platform,
            })
            .collect();
        if selected != self.registered {
            self.repository.register_targets(&selected)?;
            self.registered = selected;
        }
        Ok(())
    }
    fn enroll(&mut self, workspace_id: &str, reference: &TargetRef) -> Result<(), Diagnostic> {
        let workspace = self.workspaces.get(workspace_id).ok_or_else(unknown)?;
        if workspace.closing || workspace.stopping {
            return Err(pending());
        }
        if let Some(target) = workspace.targets.get(&reference.connection_id) {
            return if target.reference == *reference {
                Ok(())
            } else {
                Err(failure(
                    "target_platform",
                    "Saved target already has another selected platform",
                ))
            };
        }
        if workspace.targets.len() >= 10 {
            return Err(failure(
                "target_limit",
                "A workspace supports at most ten network targets",
            ));
        }
        let target = self.target(reference.clone())?;
        let mut references: Vec<_> = self
            .workspaces
            .values()
            .flat_map(|workspace| {
                workspace
                    .targets
                    .values()
                    .map(|target| target.reference.clone())
            })
            .collect();
        references.push(reference.clone());
        self.register_refs(references)?;
        self.workspaces
            .get_mut(workspace_id)
            .unwrap()
            .targets
            .insert(reference.connection_id.clone(), target);
        Ok(())
    }
    fn halt(workspace: &mut Workspace, retirement: &mut u64) {
        workspace.running = false;
        workspace.fence();
        workspace.cancel.cancel();
        workspace.cancel = CancellationToken::new();
        for target in workspace.targets.values_mut() {
            target.cancel.cancel();
            target.cancel = CancellationToken::new();
            if let Some(worker) = target.worker.take() {
                *retirement += 1;
                workspace.retiring.insert(*retirement, (worker, false));
            }
            if let Some((_, _, reply)) = target.manual.take() {
                let _ = reply.send(Err(failure(
                    "capture_cancelled",
                    "Sample collection was stopped",
                )));
            }
            target.status.state = CollectionState::Stopped;
        }
        workspace
            .latest
            .values_mut()
            .for_each(|baseline| baseline.valid = false);
    }
    fn handle(&mut self, request: Request) {
        let request = if self.apply_busy {
            let busy = || {
                failure(
                    "config_busy",
                    "Configuration publication is pending; retry authoring after it completes",
                )
            };
            match request {
                Request::Select(_, _, reply) => {
                    let _ = reply.send(Err(busy()));
                    return;
                }
                Request::Catalog(_, _, reply) => {
                    let _ = reply.send(Err(busy()));
                    return;
                }
                Request::Validate(_, _, reply) => {
                    let _ = reply.send(Err(busy()));
                    return;
                }
                Request::Import(_, _, _, reply) => {
                    let _ = reply.send(Err(busy()));
                    return;
                }
                Request::Reset(_, _, _, reply) => {
                    let _ = reply.send(Err(busy()));
                    return;
                }
                Request::Test(_, _, _, reply) => {
                    let _ = reply.send(Err(busy()));
                    return;
                }
                Request::Start(_, _, reply) => {
                    let _ = reply.send(Err(busy()));
                    return;
                }
                Request::Preview(_, _, reply) => {
                    let _ = reply.send(Err(busy()));
                    return;
                }
                Request::Apply(_, _, _, reply) => {
                    let _ = reply.send(Err(busy()));
                    return;
                }
                Request::Capture(_, _, _, reply) | Request::CaptureDraft(_, _, _, _, reply) => {
                    let _ = reply.send(Err(busy()));
                    return;
                }
                request => request,
            }
        } else {
            request
        };
        match request {
            #[cfg(test)]
            Request::RetainedBytes(id, reply) => {
                let _ = reply.send(
                    self.workspaces
                        .get(&id)
                        .map(retained_bytes)
                        .ok_or_else(unknown),
                );
            }
            #[cfg(test)]
            Request::LocalDiagnostics(id, reply) => {
                let _ = reply.send(
                    self.workspaces
                        .get(&id)
                        .map(|w| {
                            w.local_samples
                                .back()
                                .map(|s| s.diagnostics.clone())
                                .unwrap_or_default()
                        })
                        .ok_or_else(unknown),
                );
            }
            #[cfg(test)]
            Request::TargetRevision(id, target, reply) => {
                let _ = reply.send(
                    self.workspaces
                        .get(&id)
                        .and_then(|workspace| workspace.targets.get(&target))
                        .map(|target| target.config.revision.clone())
                        .ok_or_else(unknown),
                );
            }
            #[cfg(test)]
            Request::QuotaParity(id, reply) => {
                let _ = reply.send(
                    self.workspaces
                        .get(&id)
                        .map(|w| {
                            let original = w
                                .latest
                                .values()
                                .map(|b| encoded_bytes(b.frame.as_ref()))
                                .sum::<usize>()
                                + w.captures
                                    .values()
                                    .flatten()
                                    .map(encoded_bytes)
                                    .sum::<usize>()
                                + w.local_samples.iter().map(encoded_bytes).sum::<usize>()
                                + w.history.bytes()
                                + w.proofs
                                    .values()
                                    .map(DraftCaptureProof::bytes)
                                    .sum::<usize>();
                            original == retained_bytes(w)
                        })
                        .ok_or_else(unknown),
                );
            }
            Request::Establish(id, reply) => {
                let result = self.establish(&id).and_then(|_| self.snapshot(&id));
                let _ = reply.send(result);
            }
            Request::Snapshot(id, reply) => {
                let result = self.snapshot(&id);
                let _ = reply.send(result);
            }
            Request::Select(id, metadata, reply) => {
                let result = self.enroll(&id, &metadata.reference).and_then(|_| {
                    self.workspaces
                        .get_mut(&id)
                        .unwrap()
                        .targets
                        .get_mut(&metadata.reference.connection_id)
                        .unwrap()
                        .status
                        .display_name = metadata.display_name;
                    self.snapshot(&id)
                });
                let _ = reply.send(result);
            }
            Request::Catalog(id, scope, reply) => {
                let result = self.authoring(&id, |repository| {
                    let value = repository.authoring_catalog(scope)?;
                    Ok((value.own.expected_revision.clone(), value))
                });
                let _ = reply.send(result);
            }
            Request::Validate(id, draft, reply) => {
                let result = self.authoring(&id, |repository| {
                    Ok((repository.base_revision(), repository.validate(&draft)))
                });
                let _ = reply.send(result);
            }
            Request::Import(id, scope, yaml, reply) => {
                let result = self.authoring(&id, |repository| {
                    Ok((
                        repository.base_revision(),
                        UpstreamWidgetImporter::new(repository, scope).import(&yaml),
                    ))
                });
                let _ = reply.send(result);
            }
            Request::Reset(id, scope, asset, reply) => {
                let result = self.authoring(&id, |repository| {
                    let draft = repository.reset_draft(scope, asset)?;
                    Ok((draft.expected_revision.clone(), draft))
                });
                let _ = reply.send(result);
            }
            Request::Test(id, capture_id, template, reply) => {
                self.test_template(id, capture_id, template, reply)
            }
            Request::Widget(query, reply) => {
                let id = query.workspace_id.clone();
                let result = self
                    .workspaces
                    .get(&query.workspace_id)
                    .ok_or_else(unknown)
                    .and_then(|workspace| {
                        if workspace.closing || workspace.stopping {
                            return Err(pending());
                        }
                        let baseline = workspace
                            .latest
                            .get(&(query.target_id.clone(), query.widget_id.clone()))
                            .ok_or_else(|| {
                                failure("widget_unknown", "No sample exists for this widget")
                            })?;
                        let metadata = summary(
                            &baseline.frame,
                            workspace.running,
                            self.clock.now().monotonic_ms,
                            baseline.received_ms,
                            widget_interval(workspace, &query.target_id, &query.widget_id),
                        );
                        let offset = query.offset as usize;
                        let limit = query.limit.min(1000) as usize;
                        let rows = baseline
                            .frame
                            .rows
                            .iter()
                            .skip(offset)
                            .take(limit)
                            .cloned()
                            .collect::<Vec<_>>();
                        let end = offset.saturating_add(rows.len());
                        let revision = workspace.source_revision(&query.target_id)?;
                        Ok(read_value(
                            &id,
                            workspace,
                            revision,
                            WidgetPage {
                                metadata,
                                rows,
                                next_offset: (limit > 0 && end < baseline.frame.rows.len())
                                    .then_some(end as u32),
                            },
                        ))
                    });
                let _ = reply.send(result);
            }
            Request::Series(query, reply) => {
                let id = query.workspace_id.clone();
                let result = self
                    .workspaces
                    .get_mut(&query.workspace_id)
                    .ok_or_else(unknown)
                    .and_then(|workspace| {
                        if workspace.closing || workspace.stopping {
                            return Err(pending());
                        }
                        let revision = workspace.source_revision(&query.target_id)?;
                        workspace.history.advance(self.clock.now().monotonic_ms);
                        let value = workspace.history.series(query);
                        Ok(read_value(&id, workspace, revision, value))
                    });
                let _ = reply.send(result);
            }
            Request::Start(request, names, reply) => {
                let result = self.start(request, names);
                let _ = reply.send(result);
            }
            Request::Stop(id, close, reply) => {
                if let Some(workspace) = self.workspaces.get_mut(&id) {
                    workspace.closing |= close;
                    workspace.stopping = true;
                    Self::halt(workspace, &mut self.retirement);
                    self.drain_ok = false;
                    workspace.waiters.push(Waiter {
                        deadline: Instant::now() + CLEANUP,
                        close,
                        reply,
                    });
                } else {
                    let _ = reply.send(Err(unknown()));
                }
            }
            Request::Preview(id, draft, reply) => self.preview(id, draft, reply),
            Request::Apply(id, draft, token, reply) => {
                if let Some(workspace) = self.workspaces.get(&id) {
                    if workspace.closing || workspace.stopping {
                        let _ = reply.send(Err(pending()));
                        return;
                    }
                    let validation = self.repository.validate(&draft);
                    if !validation.valid {
                        let _ = reply.send(Err(validation
                            .diagnostics
                            .into_iter()
                            .next()
                            .unwrap_or_else(|| failure("config_invalid", "Draft is invalid"))));
                        return;
                    }
                    let generation = workspace.generation;
                    self.publication_targets = validation.affected_targets.into_iter().collect();
                    self.apply_busy = true;
                    for workspace in self.workspaces.values_mut() {
                        if self.publication_targets.contains("local")
                            || workspace
                                .targets
                                .keys()
                                .any(|target| self.publication_targets.contains(target))
                        {
                            workspace.fence();
                            for (id, target) in &mut workspace.targets {
                                if self.publication_targets.contains(id) {
                                    target.cancel.cancel();
                                    target.cancel = CancellationToken::new();
                                    if let Some(worker) = target.worker.take() {
                                        self.retirement += 1;
                                        workspace.retiring.insert(self.retirement, (worker, false));
                                    }
                                    for poll in &mut target.polls {
                                        poll.next_ms = 0;
                                    }
                                }
                            }
                            for ((target, _), baseline) in &mut workspace.latest {
                                if self.publication_targets.contains(target) {
                                    baseline.valid = false;
                                }
                            }
                        }
                    }
                    self.workspaces.get_mut(&id).unwrap().active_jobs += 1;
                    let repository = self.repository.clone();
                    self.jobs.spawn(async move {
                        let workspace = id.clone();
                        let base = draft.expected_revision.clone();
                        let result = tokio::task::spawn_blocking(move || {
                            repository.apply(&id, generation, draft, token)
                        })
                        .await
                        .unwrap_or_else(|_| {
                            Err(failure(
                                "config_owner",
                                "Configuration publication worker failed",
                            ))
                        });
                        Completed {
                            workspace,
                            generation,
                            target: String::new(),
                            revision: String::new(),
                            output: Output::Apply {
                                base,
                                result,
                                reply,
                            },
                        }
                    });
                } else {
                    let _ = reply.send(Err(unknown()));
                }
            }
            Request::Capture(id, reference, request, reply) => {
                let result = (|| {
                    self.workspaces.get(&id).ok_or_else(unknown)?;
                    let config = self.repository.effective(&reference);
                    validate_request(&reference, &config, &request)?;
                    self.enroll(&id, &reference)?;
                    let workspace = self.workspaces.get_mut(&id).unwrap();
                    let target = workspace.targets.get_mut(&reference.connection_id).unwrap();
                    if target.manual.is_some() {
                        return Err(failure(
                            "capture_busy",
                            "An explicit sample is already waiting for this target",
                        ));
                    }
                    Ok(())
                })();
                match result.and_then(|_| self.register()) {
                    Ok(()) => {
                        self.workspaces
                            .get_mut(&id)
                            .unwrap()
                            .targets
                            .get_mut(&reference.connection_id)
                            .unwrap()
                            .manual = Some((request, None, reply));
                        self.drain_ok = false;
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Request::CaptureDraft(id, reference, draft, parser_id, reply) => {
                let result = (|| {
                    self.enroll(&id, &reference)?;
                    let workspace = self.workspaces.get_mut(&id).unwrap();
                    let target = workspace.targets.get_mut(&reference.connection_id).unwrap();
                    if target.reference != reference || target.manual.is_some() {
                        return Err(failure(
                            "capture_busy",
                            "Sample target differs or already has a waiting explicit capture",
                        ));
                    }
                    let generation = self.workspaces[&id].generation;
                    let plan = self
                        .repository
                        .prepare_draft_sample(&id, generation, &reference, &draft, &parser_id)?;
                    let request = plan.request()?;
                    Ok((request, plan))
                })();
                match result {
                    Ok((request, plan)) => {
                        self.workspaces
                            .get_mut(&id)
                            .unwrap()
                            .targets
                            .get_mut(&reference.connection_id)
                            .unwrap()
                            .manual = Some((request, Some(plan), reply));
                        self.drain_ok = false;
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
        }
    }
    fn authoring<T>(
        &self,
        id: &str,
        action: impl FnOnce(&TelemetryConfigRepository) -> Result<(Revision, T), Diagnostic>,
    ) -> Result<TelemetryRead<T>, Diagnostic> {
        let workspace = self.workspaces.get(id).ok_or_else(unknown)?;
        if workspace.closing || workspace.stopping {
            return Err(pending());
        }
        let (revision, value) = action(&self.repository)?;
        Ok(read_value(id, workspace, revision, value))
    }
    fn test_template(
        &mut self,
        id: String,
        capture_id: String,
        template: TemplateAsset,
        reply: Reply<TelemetryRead<ParsedInterpretation>>,
    ) {
        let result = self.authoring(&id, |repository| Ok((repository.base_revision(), ())));
        let base = match result {
            Ok(read) => read.revision,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        let workspace = self.workspaces.get_mut(&id).unwrap();
        if self.preview_jobs >= 2 {
            let _ = reply.send(Err(failure(
                "preview_busy",
                "Preview admission is full; retry",
            )));
            return;
        }
        let Some(capture) = workspace
            .captures
            .values()
            .flatten()
            .find(|capture| capture.capture_id == capture_id)
        else {
            let _ = reply.send(Err(failure(
                "capture_unknown",
                "No retained sample exists for this workspace",
            )));
            return;
        };
        if capture.platform != template.platform
            || capture.command != template.command
            || template.id.is_empty()
            || template.id.len() > 512
            || template.text.len() > super::definition::MAX_TEMPLATE_BYTES
        {
            let _ = reply.send(Err(failure(
                "sample_binding",
                "Template does not match the retained sample",
            )));
            return;
        }
        if retained_bytes(workspace)
            .saturating_add(encoded_bytes(capture))
            .saturating_add(2 * 1024 * 1024)
            > MAX_WORKSPACE_BYTES
        {
            let _ = reply.send(Err(failure(
                "workspace_memory_limit",
                "No memory budget for a private template test",
            )));
            return;
        }
        let mut capture = capture.clone();
        let target = capture.target_id.clone();
        let revision = capture.revision.clone();
        if !workspace
            .targets
            .get(&target)
            .is_some_and(|target| target.config.revision == revision)
        {
            let _ = reply.send(Err(failure(
                "sample_obsolete",
                "Sample source changed; capture again",
            )));
            return;
        }
        capture.parser_id = template.id.clone();
        let generation = workspace.generation;
        let parser = self.parser.clone();
        let cancel = workspace.cancel.child_token();
        workspace.active_jobs += 1;
        self.preview_jobs += 1;
        self.drain_ok = false;
        self.jobs.spawn(async move {
            let result = parser
                .test_template(&capture, &template, cancel)
                .await
                .map(|rows| ParsedInterpretation {
                    capture_id,
                    parser_id: template.id,
                    template_sha256: template.sha256,
                    rows,
                });
            Completed {
                workspace: id,
                generation,
                target,
                revision,
                output: Output::Test {
                    result,
                    base,
                    reply,
                },
            }
        });
    }
    fn start(
        &mut self,
        request: StartRequest,
        names: Vec<SavedTargetMetadata>,
    ) -> Result<TelemetrySnapshot, Diagnostic> {
        let existing = self
            .workspaces
            .get(&request.workspace_id)
            .ok_or_else(unknown)?;
        if existing.closing || existing.stopping {
            return Err(pending());
        }
        if request.targets.len() > 10 {
            return Err(failure(
                "target_limit",
                "A workspace supports at most ten network targets",
            ));
        }
        let mut selected = BTreeMap::new();
        for reference in request.targets {
            if reference.connection_id.is_empty()
                || reference.connection_id == "local"
                || selected.contains_key(&reference.connection_id)
            {
                return Err(failure(
                    "target_reference",
                    "Select unique nonlocal saved target identities",
                ));
            }
            let mut target = self.target(reference)?;
            target.periodic = true;
            if let Some(saved) = names
                .iter()
                .find(|saved| saved.reference == target.reference)
            {
                target.status.display_name = saved.display_name.clone();
            }
            selected.insert(target.reference.connection_id.clone(), target);
        }
        for (id, interfaces) in &request.monitored_interfaces {
            let target = selected.get_mut(id).ok_or_else(|| {
                failure(
                    "interface_target",
                    "Selected interfaces require a selected target",
                )
            })?;
            for interface in interfaces {
                CommandPolicy::admit(
                    target.reference.platform,
                    &format!("show interfaces {interface}"),
                )?;
            }
            target.monitored_interfaces = interfaces.clone();
            target.polls = polls(&target.config, &target.reference, !interfaces.is_empty())?;
        }
        let mut references: Vec<_> = self
            .workspaces
            .iter()
            .filter(|(id, _)| *id != &request.workspace_id)
            .flat_map(|(_, workspace)| {
                workspace
                    .targets
                    .values()
                    .map(|target| target.reference.clone())
            })
            .collect();
        references.extend(selected.values().map(|target| target.reference.clone()));
        self.register_refs(references)?;
        let workspace = self.workspaces.get_mut(&request.workspace_id).unwrap();
        Self::halt(workspace, &mut self.retirement);
        workspace.targets = selected;
        workspace.local_enabled = request.local_enabled;
        workspace.local_config = self.repository.effective_local();
        workspace.local_next_ms = 0;
        workspace.running = true;
        reconcile(workspace)?;
        self.drain_ok = false;
        self.register()?;
        self.snapshot(&request.workspace_id)
    }
    fn preview(
        &mut self,
        id: String,
        draft: ConfigDraft,
        reply: Reply<TelemetryRead<PreviewReport>>,
    ) {
        let Some(workspace) = self.workspaces.get_mut(&id) else {
            let _ = reply.send(Err(unknown()));
            return;
        };
        if workspace.closing || workspace.stopping {
            let _ = reply.send(Err(pending()));
            return;
        }
        let validation = self.repository.validate(&draft);
        if !validation.valid {
            let report = PreviewReport {
                token: None,
                frames: vec![],
                diagnostics: validation.diagnostics,
                captures: vec![],
                local_samples: vec![],
                interpretations: vec![],
                frame_sources: vec![],
            };
            let _ = reply.send(Ok(read_value(
                &id,
                workspace,
                self.repository.base_revision(),
                report,
            )));
            return;
        }
        if self.preview_jobs >= 2 {
            let _ = reply.send(Err(failure(
                "preview_busy",
                "Preview admission is full; retry after current authoring completes",
            )));
            return;
        }
        let captures: Vec<_> = workspace
            .captures
            .values()
            .flatten()
            .filter(|c| match &draft.scope {
                ConfigScope::Local => false,
                ConfigScope::Profile(platform) => *platform == c.platform,
                ConfigScope::Device(target) => target == &c.target_id,
            })
            .collect();
        let local = matches!(draft.scope, ConfigScope::Local);
        let samples: Vec<_> = if local {
            workspace.local_samples.back().into_iter().collect()
        } else {
            vec![]
        };
        let external_bytes = retained_bytes(workspace).saturating_add(
            workspace
                .proofs
                .values()
                .map(DraftCaptureProof::bytes)
                .sum::<usize>(),
        );
        if external_bytes
            .saturating_add(
                captures
                    .iter()
                    .map(|capture| {
                        workspace
                            .capture_charges
                            .get(&capture.capture_id)
                            .copied()
                            .unwrap_or(MAX_WORKSPACE_BYTES)
                    })
                    .sum::<usize>(),
            )
            .saturating_add(encoded_bytes(&samples))
            > MAX_WORKSPACE_BYTES
        {
            let _ = reply.send(Err(failure(
                "workspace_memory_limit",
                "No memory budget for a private Preview copy",
            )));
            return;
        }
        let captures = captures.into_iter().cloned().collect();
        let mut samples: Vec<_> = samples.into_iter().cloned().collect();
        let proofs: Vec<_> = workspace.proofs.values().cloned().collect();
        let worker = local.then(|| {
            workspace
                .local_worker
                .get_or_insert_with(|| Arc::new(Mutex::new((self.local_factory.0)())))
                .clone()
        });
        let now = self.clock.now();
        let generation = workspace.generation;
        let base = draft.expected_revision.clone();
        let repository = self.repository.clone();
        workspace.active_jobs += 1;
        workspace.local_busy += usize::from(local);
        self.drain_ok = false;
        self.preview_jobs += 1;
        self.jobs.spawn(async move {
            let sample = if let Some(worker) = worker {
                match tokio::task::spawn_blocking(move || worker.lock().sample(now)).await {
                    Ok(Ok(sample)) => {
                        samples.push(sample.clone());
                        Some(sample)
                    }
                    result => {
                        let error = result.ok().and_then(Result::err).unwrap_or_else(|| {
                            failure("local_owner", "Local sampling worker failed")
                        });
                        return Completed {
                            workspace: id,
                            generation,
                            target: "local".into(),
                            revision: String::new(),
                            output: Output::Preview {
                                base,
                                result: PreviewReport {
                                    token: None,
                                    frames: vec![],
                                    diagnostics: vec![error],
                                    captures: vec![],
                                    local_samples: vec![],
                                    interpretations: vec![],
                                    frame_sources: vec![],
                                },
                                sample: None,
                                reply,
                            },
                        };
                    }
                }
            } else {
                None
            };
            let result = repository
                .preview_owned(
                    &id,
                    generation,
                    &draft,
                    captures,
                    samples,
                    proofs,
                    external_bytes,
                )
                .await;
            Completed {
                workspace: id,
                generation,
                target: if local { "local" } else { "" }.into(),
                revision: String::new(),
                output: Output::Preview {
                    base,
                    result,
                    sample,
                    reply,
                },
            }
        });
    }
    fn schedule(&mut self) {
        if self.drain.is_some() {
            return;
        }
        let now = self.clock.now();
        for (id, workspace) in &mut self.workspaces {
            if workspace.running
                && workspace.local_enabled
                && workspace.local_busy == 0
                && now.monotonic_ms >= workspace.local_next_ms
                && !(self.apply_busy && self.publication_targets.contains("local"))
            {
                let worker = workspace
                    .local_worker
                    .get_or_insert_with(|| Arc::new(Mutex::new((self.local_factory.0)())))
                    .clone();
                workspace.local_busy += 1;
                workspace.active_jobs += 1;
                workspace.local_next_ms = now.monotonic_ms + local_interval(workspace);
                let generation = workspace.generation;
                let id = id.clone();
                let revision = workspace.local_config.revision.clone();
                self.jobs.spawn(async move {
                    let result = tokio::task::spawn_blocking(move || worker.lock().sample(now))
                        .await
                        .unwrap_or_else(|_| {
                            Err(failure("local_owner", "Local sampling worker failed"))
                        });
                    Completed {
                        workspace: id,
                        generation,
                        target: "local".into(),
                        revision,
                        output: Output::Local(result),
                    }
                });
            }
        }
        let candidates: Vec<_> = self
            .workspaces
            .iter()
            .flat_map(|(w, workspace)| {
                workspace
                    .targets
                    .keys()
                    .map(move |t| (w.clone(), t.clone()))
            })
            .collect();
        if candidates.is_empty() {
            return;
        }
        let cursor = self.cursor;
        for step in 0..candidates.len() {
            if self.busy_targets.len() >= 4 {
                break;
            }
            let index = (cursor + step) % candidates.len();
            let (id, target_id) = &candidates[index];
            if self.busy_targets.contains(target_id) {
                continue;
            }
            if self.apply_busy && self.publication_targets.contains(target_id) {
                continue;
            }
            let workspace = self.workspaces.get_mut(id).unwrap();
            let target = workspace.targets.get_mut(target_id).unwrap();
            if target.busy
                || (target.manual.is_none()
                    && (!workspace.running
                        || !target.periodic
                        || target.suspended
                        || now.monotonic_ms < target.retry_ms))
            {
                continue;
            }
            let manual = target.manual.take();
            let selection = if let Some((request, plan, reply)) = manual {
                Some((request, vec![], Some(reply), plan))
            } else {
                let len = target.polls.len();
                (0..len).find_map(|n| {
                    let index = (target.cursor + n) % len;
                    let poll = &mut target.polls[index];
                    if now.monotonic_ms < poll.next_ms {
                        return None;
                    }
                    target.cursor = (index + 1) % len;
                    poll.next_ms = now.monotonic_ms + poll.interval_ms;
                    Some((poll.command.clone(), poll.widgets.clone(), None, None))
                })
            };
            let Some((request, definitions, sample, plan)) = selection else {
                continue;
            };
            if retained_bytes_parts(
                &workspace.latest,
                &workspace.local_samples,
                &workspace.history,
                &workspace.proofs,
                &workspace.capture_charges,
            )
            .saturating_add(request.command.cost().max_output_bytes)
                > MAX_WORKSPACE_BYTES
            {
                diagnostic(
                    &mut workspace.diagnostics,
                    failure(
                        "workspace_memory_limit",
                        "No memory budget to admit another capture",
                    ),
                );
                if let Some(reply) = sample {
                    let _ = reply.send(Err(failure(
                        "workspace_memory_limit",
                        "No memory budget to admit another capture",
                    )));
                }
                continue;
            }
            let worker = target
                .worker
                .get_or_insert_with(|| {
                    Arc::new(AsyncMutex::new((self.ssh_factory.0)(
                        target.reference.clone(),
                    )))
                })
                .clone();
            target.busy = true;
            target.status.state = CollectionState::Collecting;
            workspace.active_jobs += 1;
            self.busy_targets.insert(target_id.clone());
            self.cursor = (index + 1) % candidates.len();
            let id = id.clone();
            let target_id = target_id.clone();
            let revision = target.config.revision.clone();
            let config = target.config.clone();
            let scheduled_interval = target
                .polls
                .iter()
                .find(|poll| poll.command.command.as_str() == request.command.as_str())
                .map(|poll| (poll.interval_ms / 1000) as u32)
                .unwrap_or(30);
            let previous: BTreeMap<_, _> = definitions
                .iter()
                .filter_map(|definition| {
                    let key = (target_id.clone(), definition.widget.clone());
                    workspace
                        .latest
                        .get(&key)
                        .cloned()
                        .map(|baseline| (key, baseline))
                })
                .collect();
            let generation = workspace.generation;
            let cancel = target.cancel.clone();
            let parser = self.parser.clone();
            let clock = self.clock.clone();
            self.jobs.spawn(async move {
                let command = request.command.as_str().to_string();
                let (result, display_name) = {
                    let mut collector = worker.lock().await;
                    let result = collector.capture(request, cancel.clone()).await;
                    (result, collector.display_name())
                };
                let mut frames = vec![];
                if let Ok(collected) = &result {
                    for definition in definitions {
                        let context = FrameContext {
                            workspace_id: id.clone(),
                            target_id: target_id.clone(),
                            revision: revision.clone(),
                            generation,
                        };
                        let frame = match bind_capture(
                            &collected.capture,
                            &config,
                            &definition,
                            &target_id,
                        ) {
                            Ok(capture) => {
                                let template = &config.templates[&capture.parser_id];
                                match ProtocolClassifier::capture_rejection(&capture) {
                                    Some((state, diagnostic)) => failed_frame(
                                        &context,
                                        &definition,
                                        capture.observed_at_ms,
                                        state,
                                        diagnostic,
                                    ),
                                    None => {
                                        match parser.parse(&capture, template, cancel.clone()).await
                                        {
                                            Ok(records) => {
                                                let before = previous
                                                    .get(&(
                                                        target_id.clone(),
                                                        definition.widget.clone(),
                                                    ))
                                                    .filter(|before| {
                                                        !collected.reconnected
                                                            && compatible_time(
                                                                before,
                                                                capture.observed_at_ms,
                                                                clock.now().monotonic_ms,
                                                                scheduled_interval,
                                                            )
                                                    });
                                                ProtocolClassifier::normalize(
                                                    &context,
                                                    &definition,
                                                    &capture,
                                                    records,
                                                    before.map(|b| {
                                                        (b.frame.rows.as_slice(), b.monotonic_ms)
                                                    }),
                                                )
                                            }
                                            Err(error) => failed_frame(
                                                &context,
                                                &definition,
                                                capture.observed_at_ms,
                                                CollectionState::Failed,
                                                error,
                                            ),
                                        }
                                    }
                                }
                            }
                            Err(error) => failed_frame(
                                &context,
                                &definition,
                                collected.capture.observed_at_ms,
                                CollectionState::Failed,
                                error,
                            ),
                        };
                        frames.push(frame);
                    }
                }
                Completed {
                    workspace: id,
                    generation,
                    target: target_id,
                    revision,
                    output: Output::Network {
                        command,
                        result,
                        frames,
                        sample,
                        plan,
                        display_name,
                    },
                }
            });
        }
    }
    fn complete(&mut self, completed: Completed) {
        if matches!(
            completed.output,
            Output::Preview { .. } | Output::Test { .. }
        ) {
            self.preview_jobs = self.preview_jobs.saturating_sub(1);
        }
        if matches!(completed.output, Output::Network { .. }) {
            self.busy_targets.remove(&completed.target);
        }
        let Some(workspace) = self.workspaces.get_mut(&completed.workspace) else {
            return;
        };
        workspace.active_jobs = workspace.active_jobs.saturating_sub(1);
        if completed.target == "local" {
            workspace.local_busy = workspace.local_busy.saturating_sub(1);
        }
        if !matches!(completed.output, Output::Test { .. }) {
            if let Some(target) = workspace.targets.get_mut(&completed.target) {
                target.busy = false;
            }
        }
        let now = self.clock.now();
        let current = workspace.generation == completed.generation
            && (completed.revision.is_empty()
                || if completed.target == "local" {
                    workspace.local_config.revision == completed.revision
                } else {
                    workspace
                        .targets
                        .get(&completed.target)
                        .is_some_and(|t| t.config.revision == completed.revision)
                });
        match completed.output {
            Output::Local(result) if current => match result {
                Ok(sample) => {
                    for definition in workspace.local_config.widgets.clone() {
                        let context = FrameContext {
                            workspace_id: completed.workspace.clone(),
                            target_id: "local".into(),
                            revision: completed.revision.clone(),
                            generation: workspace.generation,
                        };
                        let previous = workspace
                            .latest
                            .get(&("local".into(), definition.widget.clone()))
                            .filter(|b| {
                                compatible_time(
                                    b,
                                    sample.observed_at_ms,
                                    now.monotonic_ms,
                                    (local_interval(workspace) / 1000) as u32,
                                )
                            });
                        let frame = FrameNormalizer::local(
                            &context,
                            &definition,
                            &sample,
                            previous.map(|b| (b.frame.rows.as_slice(), b.monotonic_ms)),
                        );
                        append_frame(workspace, frame, sample.monotonic_ms, now.monotonic_ms);
                    }
                    retain_local(workspace, sample);
                }
                Err(error) => diagnostic(&mut workspace.diagnostics, error),
            },
            Output::Network {
                command,
                result,
                frames,
                sample,
                plan,
                display_name,
            } => {
                if !current {
                    if let Some(reply) = sample {
                        let _ = reply.send(Err(failure(
                            "capture_obsolete",
                            "Sample belongs to an invalidated generation or configuration",
                        )));
                    }
                    return;
                }
                if let Some(target) = workspace.targets.get_mut(&completed.target) {
                    if let Some(name) = display_name {
                        target.status.display_name = name;
                    } else if result.is_err() {
                        target.status.display_name = "Saved connection name unavailable".into();
                    }
                }
                match result {
                    Ok(collected) => {
                        let target = workspace.targets.get_mut(&completed.target).unwrap();
                        target.status.display_name = if collected.display_name.trim().is_empty() {
                            "Saved connection name unavailable".into()
                        } else {
                            collected.display_name
                        };
                        target.failures = 0;
                        target.retry_ms = 0;
                        target.status.diagnostics.clear();
                        for poll in &mut target.polls {
                            if poll.command.command.as_str() == command {
                                poll.next_ms = now.monotonic_ms + poll.interval_ms;
                            }
                        }
                        if collected.capture.revision != completed.revision
                            || collected.capture.target_id != completed.target
                            || collected.capture.platform != target.reference.platform
                            || collected.capture.command != command
                        {
                            diagnostic(
                                &mut workspace.diagnostics,
                                failure(
                                    "source_binding",
                                    "Collector returned an invalid target or source revision",
                                ),
                            );
                            if let Some(reply) = sample {
                                let _ = reply.send(Err(failure(
                                    "source_binding",
                                    "Collector returned an invalid target or source revision",
                                )));
                            }
                            return;
                        }
                        if plan.is_none() {
                            let binding = target
                                .config
                                .templates
                                .get(&collected.capture.parser_id)
                                .ok_or_else(|| {
                                    failure(
                                        "source_binding",
                                        "Collector parser is not an effective asset",
                                    )
                                })
                                .and_then(|template| {
                                    validate_binding(&collected.capture, template)
                                });
                            if let Err(error) = binding {
                                diagnostic(&mut workspace.diagnostics, error.clone());
                                if let Some(reply) = sample {
                                    let _ = reply.send(Err(error));
                                }
                                return;
                            }
                        }
                        let mut any_success = false;
                        for frame in frames {
                            any_success |= frame.state == CollectionState::Fresh;
                            append_frame(
                                workspace,
                                frame,
                                collected.capture.monotonic_ms,
                                now.monotonic_ms,
                            );
                        }
                        let target = workspace.targets.get_mut(&completed.target).unwrap();
                        target.status.state = if any_success || sample.is_some() {
                            CollectionState::Fresh
                        } else {
                            CollectionState::Failed
                        };
                        if any_success || sample.is_some() {
                            target.success_ms = Some(now.monotonic_ms);
                            target.status.last_success_at_ms =
                                Some(collected.capture.observed_at_ms);
                        }
                        let proof = plan.map(|plan| if self.apply_busy { Err(failure("sample_obsolete", "Draft sample admission crossed a configuration publication; capture again after it completes")) }
                            else { self.repository.seal_draft_sample(plan, &collected.capture) }).transpose();
                        let retained = proof.and_then(|proof| {
                            retain_capture(workspace, collected.capture.clone(), proof)
                        });
                        if let Some(reply) = sample {
                            let _ = reply.send(retained.map(|_| {
                                read_value(
                                    &completed.workspace,
                                    workspace,
                                    completed.revision.clone(),
                                    collected.capture,
                                )
                            }));
                        }
                    }
                    Err(error) => {
                        let target = workspace.targets.get_mut(&completed.target).unwrap();
                        target.failures += 1;
                        target.suspended = suspended(&error);
                        target.retry_ms = now.monotonic_ms
                            + [5_000, 15_000, 30_000, 60_000][(target.failures - 1).min(3)];
                        for poll in &mut target.polls {
                            if poll.command.command.as_str() == command {
                                poll.next_ms = target.retry_ms;
                            }
                        }
                        target.status.state = CollectionState::Failed;
                        target.status.diagnostics = vec![error.clone()];
                        for ((id, _), baseline) in &mut workspace.latest {
                            if id == &completed.target {
                                baseline.valid = false;
                            }
                        }
                        if let Some(reply) = sample {
                            let _ = reply.send(Err(error));
                        }
                    }
                }
            }
            Output::Preview {
                base,
                mut result,
                sample,
                reply,
            } => {
                if current {
                    if let Some(sample) = sample {
                        retain_local(workspace, sample);
                    }
                } else {
                    result.token = None;
                    result.diagnostics.push(failure(
                        "preview_obsolete",
                        "Workspace generation changed during Preview",
                    ));
                }
                if !current || self.apply_busy || base != self.repository.base_revision() {
                    let _ = reply.send(Err(failure(
                        "preview_obsolete",
                        "Preview authority changed; retry",
                    )));
                } else {
                    let _ = reply.send(Ok(read_value(
                        &completed.workspace,
                        workspace,
                        base,
                        result,
                    )));
                }
            }
            Output::Test {
                result,
                base,
                reply,
            } => {
                let result =
                    if !current || self.apply_busy || self.repository.base_revision() != base {
                        Err(failure(
                            "template_obsolete",
                            "Template test authority changed; retry",
                        ))
                    } else {
                        result
                    };
                let _ = reply.send(result.map(|value| {
                    read_value(&completed.workspace, workspace, completed.revision, value)
                }));
            }
            Output::Apply {
                base,
                result,
                reply,
            } => {
                self.apply_busy = false;
                self.publication_targets.clear();
                self.local_effective = self.repository.effective_local();
                if result.is_ok() {
                    let base_changed = result
                        .as_ref()
                        .is_ok_and(|published| published.revision != base);
                    for workspace in self.workspaces.values_mut() {
                        if base_changed {
                            workspace.discard_draft_captures();
                        }
                        let mut changed = false;
                        let local = self.repository.effective_local();
                        if workspace.local_config.revision != local.revision {
                            workspace.local_config = local;
                            workspace.local_samples.clear();
                            changed = true;
                        }
                        for target in workspace.targets.values_mut() {
                            let effective = self.repository.effective(&target.reference);
                            if target.config.revision != effective.revision {
                                changed = true;
                                target.cancel.cancel();
                                target.cancel = CancellationToken::new();
                                if let Some(worker) = target.worker.take() {
                                    self.retirement += 1;
                                    workspace.retiring.insert(self.retirement, (worker, false));
                                }
                                target.config = effective;
                                target.suspended = false;
                                target.failures = 0;
                                target.retry_ms = 0;
                                match polls(
                                    &target.config,
                                    &target.reference,
                                    !target.monitored_interfaces.is_empty(),
                                ) {
                                    Ok(polls) => target.polls = polls,
                                    Err(error) => diagnostic(&mut workspace.diagnostics, error),
                                }
                                workspace
                                    .captures
                                    .retain(|(id, _), _| id != &target.reference.connection_id);
                            }
                        }
                        if changed {
                            workspace.fence();
                            workspace.local_next_ms = 0;
                            if let Err(error) = reconcile(workspace) {
                                diagnostic(&mut workspace.diagnostics, error);
                            }
                        }
                    }
                }
                let result = result.and_then(|value| {
                    let workspace = self
                        .workspaces
                        .get(&completed.workspace)
                        .ok_or_else(unknown)?;
                    Ok(read_value(
                        &completed.workspace,
                        workspace,
                        value.revision.clone(),
                        value,
                    ))
                });
                let _ = reply.send(result);
            }
            _ => {}
        }
    }
    fn housekeeping(&mut self) {
        for (id, workspace) in &mut self.workspaces {
            workspace.history.advance(self.clock.now().monotonic_ms);
            for (key, (worker, busy)) in &mut workspace.retiring {
                if !*busy {
                    *busy = true;
                    let worker = worker.clone();
                    let id = id.clone();
                    let key = *key;
                    self.cleanup.spawn(async move {
                        let result = worker.lock().await.close().await;
                        if result.is_err() {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                        (id, key, result)
                    });
                }
            }
        }
        if self
            .drain
            .as_ref()
            .is_some_and(|handle| handle.is_finished())
        {
            let mut handle = self.drain.take().unwrap();
            if let Some(result) = futures::FutureExt::now_or_never(&mut handle) {
                self.drain_ok = matches!(result, Ok(Ok(())));
                if !self.drain_ok {
                    for workspace in self.workspaces.values_mut() {
                        diagnostic(&mut workspace.diagnostics, pending());
                    }
                }
            } else {
                self.drain = Some(handle);
            }
        }
        let idle = self.jobs.is_empty()
            && self.cleanup.is_empty()
            && self
                .workspaces
                .values()
                .all(|w| !w.running && w.retiring.is_empty());
        if idle && !self.drain_ok && self.drain.is_none() && !self.shutdown {
            let parser = self.parser.clone();
            self.drain = Some(tokio::spawn(async move { parser.quiesce().await }));
        }
        let parser_ready = !self.parser.has_pending_cleanup()
            && (self.drain_ok
                || self
                    .workspaces
                    .values()
                    .any(|w| w.running || w.active_jobs > 0));
        let mut remove = vec![];
        for (id, workspace) in &mut self.workspaces {
            let done = workspace.active_jobs == 0 && workspace.retiring.is_empty() && parser_ready;
            if done && workspace.stopping {
                workspace.local_worker = None;
                workspace.stopping = false;
            }
            let mut waiters = vec![];
            for waiter in workspace.waiters.drain(..) {
                if done {
                    if waiter.close {
                        remove.push(id.clone());
                    }
                    let _ = waiter.reply.send(Ok(()));
                } else if Instant::now() >= waiter.deadline {
                    diagnostic(&mut workspace.diagnostics, pending());
                    let _ = waiter.reply.send(Err(pending()));
                } else {
                    waiters.push(waiter);
                }
            }
            workspace.waiters = waiters;
        }
        for id in remove {
            self.workspaces.remove(&id);
        }
        if !self.apply_busy {
            if let Err(error) = self.register() {
                for workspace in self.workspaces.values_mut() {
                    diagnostic(&mut workspace.diagnostics, error.clone());
                }
            }
        }
    }
    fn snapshot(&mut self, id: &str) -> Result<TelemetrySnapshot, Diagnostic> {
        let workspace = self.workspaces.get_mut(id).ok_or_else(unknown)?;
        let now = self.clock.now();
        workspace.history.advance(now.monotonic_ms);
        let mut targets: Vec<_> = workspace
            .targets
            .values()
            .map(|target| {
                let mut status = target.status.clone();
                status.monitoring_selected = target.periodic;
                if !workspace.running {
                    status.state = CollectionState::Stopped;
                } else if status.state == CollectionState::Fresh
                    && target.success_ms.is_some_and(|at| {
                        now.monotonic_ms.saturating_sub(at)
                            > target
                                .polls
                                .iter()
                                .map(|p| (3 * p.interval_ms).max(15_000))
                                .min()
                                .unwrap_or(15_000)
                    })
                {
                    status.state = CollectionState::Stale;
                }
                status
            })
            .collect();
        if workspace.local_enabled {
            let last = workspace
                .latest
                .iter()
                .filter(|((id, _), _)| id == "local")
                .map(|(_, b)| b)
                .max_by_key(|b| b.received_ms);
            targets.push(TargetStatus {
                target_id: "local".into(),
                display_name: "Local PC".into(),
                platform: None,
                monitoring_selected: workspace.local_enabled,
                state: if !workspace.running {
                    CollectionState::Stopped
                } else if last.is_none() {
                    CollectionState::Collecting
                } else if last.is_some_and(|b| {
                    now.monotonic_ms.saturating_sub(b.received_ms)
                        > (3 * local_interval(workspace)).max(15_000)
                }) {
                    CollectionState::Stale
                } else {
                    CollectionState::Fresh
                },
                last_success_at_ms: last.and_then(|b| b.frame.last_success_at_ms),
                diagnostics: vec![],
            });
        }
        Ok(TelemetrySnapshot {
            workspace_id: id.into(),
            generation: workspace.generation,
            sequence: workspace.sequence,
            running: workspace.running,
            targets,
            widgets: workspace
                .latest
                .iter()
                .map(|((target, widget), b)| {
                    summary(
                        &b.frame,
                        workspace.running,
                        now.monotonic_ms,
                        b.received_ms,
                        widget_interval(workspace, target, widget),
                    )
                })
                .collect(),
            series: workspace.history.summaries(),
            diagnostics: workspace.diagnostics.clone(),
        })
    }
}

fn polls(
    config: &EffectiveConfig,
    target: &TargetRef,
    selected: bool,
) -> Result<Vec<Poll>, Diagnostic> {
    let mut grouped: BTreeMap<String, Poll> = BTreeMap::new();
    for definition in &config.widgets {
        let WidgetSource::Ssh {
            commands,
            templates,
        } = &definition.source
        else {
            continue;
        };
        let (Some(command), Some(parser_id)) = (
            commands.get(&target.platform),
            templates.get(&target.platform),
        ) else {
            continue;
        };
        let request = CaptureRequest {
            command: CommandPolicy::admit(target.platform, command)?,
            parser_id: parser_id.clone(),
            revision: config.revision.clone(),
        };
        validate_request(target, config, &request)?;
        let interval = if selected {
            definition.selected_interval.unwrap_or(definition.interval)
        } else {
            definition.interval
        };
        let poll = grouped.entry(command.clone()).or_insert_with(|| Poll {
            command: request,
            widgets: vec![],
            interval_ms: u64::from(interval) * 1000,
            next_ms: 0,
        });
        poll.interval_ms = poll.interval_ms.min(u64::from(interval) * 1000);
        poll.widgets.push(definition.clone());
    }
    Ok(grouped.into_values().collect())
}
fn validate_request(
    target: &TargetRef,
    config: &EffectiveConfig,
    request: &CaptureRequest,
) -> Result<(), Diagnostic> {
    CommandPolicy::admit(target.platform, request.command.as_str())?;
    let template = config.templates.get(&request.parser_id).ok_or_else(|| {
        failure(
            "template_missing",
            "Sample parser is not an effective asset",
        )
    })?;
    if request.revision != config.revision
        || template.platform != target.platform
        || template.command != request.command.as_str()
        || template.sha256 != format!("{:x}", sha2::Sha256::digest(template.text.as_bytes()))
    {
        return Err(failure(
            "source_binding",
            "Sample request does not match the current effective source",
        ));
    }
    Ok(())
}
fn bind_capture(
    capture: &Capture,
    config: &EffectiveConfig,
    definition: &WidgetDefinition,
    target: &str,
) -> Result<Capture, Diagnostic> {
    let original = config.templates.get(&capture.parser_id).ok_or_else(|| {
        failure(
            "template_missing",
            "Original capture parser is not effective",
        )
    })?;
    validate_binding(capture, original)?;
    if capture.target_id != target || capture.revision != config.revision {
        return Err(failure(
            "source_binding",
            "Capture target or effective revision is obsolete",
        ));
    }
    let WidgetSource::Ssh {
        commands,
        templates,
    } = &definition.source
    else {
        return Err(failure("source_binding", "Capture requires an SSH widget"));
    };
    if commands.get(&capture.platform) != Some(&capture.command) {
        return Err(failure(
            "source_binding",
            "Widget command differs from the physical capture",
        ));
    }
    let parser_id = templates.get(&capture.platform).ok_or_else(|| {
        failure(
            "source_binding",
            "Widget has no parser for the capture platform",
        )
    })?;
    let template = config.templates.get(parser_id).ok_or_else(|| {
        failure(
            "template_missing",
            "Selected capture parser is not effective",
        )
    })?;
    let mut derived = capture.clone();
    derived.parser_id = parser_id.clone();
    validate_binding(&derived, template)?;
    Ok(derived)
}
fn reconcile(workspace: &mut Workspace) -> Result<(), Diagnostic> {
    let mut selected = BTreeSet::new();
    for target in workspace.targets.values() {
        for definition in &target.config.widgets {
            let WidgetSource::Ssh { templates, .. } = &definition.source else {
                continue;
            };
            let hash = templates
                .get(&target.reference.platform)
                .and_then(|id| target.config.templates.get(id))
                .map(|t| t.sha256.as_str())
                .unwrap_or("");
            selected.insert((
                target.reference.connection_id.clone(),
                definition.widget.clone(),
            ));
            if workspace
                .history
                .configure(&target.reference.connection_id, definition, hash)?
            {
                if let Some(baseline) = workspace.latest.get_mut(&(
                    target.reference.connection_id.clone(),
                    definition.widget.clone(),
                )) {
                    baseline.valid = false;
                }
            }
        }
    }
    if workspace.local_enabled {
        for definition in &workspace.local_config.widgets {
            selected.insert(("local".into(), definition.widget.clone()));
            if workspace.history.configure("local", definition, "")? {
                if let Some(baseline) = workspace
                    .latest
                    .get_mut(&("local".into(), definition.widget.clone()))
                {
                    baseline.valid = false;
                }
            }
        }
    }
    workspace.history.retain_widgets(&selected);
    workspace.latest.retain(|key, _| selected.contains(key));
    workspace
        .captures
        .retain(|(target, _), _| workspace.targets.contains_key(target));
    let retained: BTreeSet<_> = workspace
        .captures
        .values()
        .flatten()
        .map(|capture| capture.capture_id.as_str())
        .collect();
    workspace
        .proofs
        .retain(|id, _| retained.contains(id.as_str()));
    workspace
        .capture_charges
        .retain(|id, _| retained.contains(id.as_str()));
    Ok(())
}
fn compatible_time(before: &Baseline, wall_ms: i64, received_ms: u64, interval: u32) -> bool {
    before.valid
        && before.frame.state == CollectionState::Fresh
        && wall_ms > before.wall_ms
        && received_ms.saturating_sub(before.received_ms)
            <= (u64::from(interval) * 3000).max(15_000)
        && (wall_ms - before.wall_ms) as u64
            <= received_ms
                .saturating_sub(before.received_ms)
                .saturating_add((u64::from(interval) * 3000).max(15_000))
}
fn local_interval(workspace: &Workspace) -> u64 {
    workspace
        .local_config
        .widgets
        .iter()
        .map(|w| u64::from(w.interval) * 1000)
        .min()
        .unwrap_or(2000)
}
fn widget_interval(workspace: &Workspace, target: &str, widget: &str) -> u32 {
    if target == "local" {
        workspace
            .local_config
            .widgets
            .iter()
            .find(|w| w.widget == widget)
            .map(|w| w.interval)
            .unwrap_or(2)
    } else {
        workspace
            .targets
            .get(target)
            .and_then(|t| {
                t.polls
                    .iter()
                    .find(|p| p.widgets.iter().any(|w| w.widget == widget))
            })
            .map(|p| (p.interval_ms / 1000) as u32)
            .unwrap_or(30)
    }
}
fn suspended(error: &Diagnostic) -> bool {
    error.code.starts_with("ssh_auth_")
        || error.code.starts_with("ssh_host_key_")
        || error.code.starts_with("ssh_identity_")
        || error.code.starts_with("ssh_trust_")
        || error.code == "ssh_logging_privacy_unavailable"
}
fn diagnostic(diagnostics: &mut Vec<Diagnostic>, error: Diagnostic) {
    if !diagnostics
        .iter()
        .any(|old| old.code == error.code && old.path == error.path)
    {
        if diagnostics.len() == 64 {
            diagnostics.remove(0);
        }
        diagnostics.push(error);
    }
}
fn failed_frame(
    context: &FrameContext,
    definition: &WidgetDefinition,
    at: i64,
    state: CollectionState,
    error: Diagnostic,
) -> WidgetFrame {
    WidgetFrame {
        workspace_id: context.workspace_id.clone(),
        target_id: context.target_id.clone(),
        widget_id: definition.widget.clone(),
        revision: context.revision.clone(),
        generation: context.generation,
        observed_at_ms: at,
        last_success_at_ms: None,
        state,
        severity: ObservationSeverity::Info,
        units: BTreeMap::new(),
        rows: vec![],
        diagnostics: vec![error],
    }
}
fn summary(
    frame: &WidgetFrame,
    running: bool,
    now: u64,
    received: u64,
    interval: u32,
) -> WidgetSummary {
    WidgetSummary {
        workspace_id: frame.workspace_id.clone(),
        target_id: frame.target_id.clone(),
        widget_id: frame.widget_id.clone(),
        revision: frame.revision.clone(),
        generation: frame.generation,
        observed_at_ms: frame.observed_at_ms,
        last_success_at_ms: frame.last_success_at_ms,
        state: if !running {
            CollectionState::Stopped
        } else if frame.state == CollectionState::Fresh
            && now.saturating_sub(received) > (u64::from(interval) * 3000).max(15_000)
        {
            CollectionState::Stale
        } else {
            frame.state
        },
        severity: frame.severity,
        units: frame.units.clone(),
        row_count: frame.rows.len() as u32,
        diagnostics: frame.diagnostics.clone(),
    }
}
fn append_frame(
    workspace: &mut Workspace,
    mut frame: WidgetFrame,
    monotonic_ms: u64,
    received_ms: u64,
) {
    let key = (frame.target_id.clone(), frame.widget_id.clone());
    let old = workspace.latest.get(&key).map_or(0, |b| b.bytes);
    if let Some(previous) = workspace
        .latest
        .get(&key)
        .filter(|previous| previous.frame.revision == frame.revision)
    {
        if frame.last_success_at_ms.is_none() {
            frame.last_success_at_ms = previous.frame.last_success_at_ms;
        }
    }
    let frame_bytes = encoded_bytes(&frame);
    let bytes = retained_bytes(workspace)
        .saturating_sub(old)
        .saturating_add(frame_bytes);
    if bytes > MAX_WORKSPACE_BYTES {
        diagnostic(
            &mut workspace.diagnostics,
            failure(
                "workspace_memory_limit",
                "Latest table cannot fit the workspace memory budget",
            ),
        );
        return;
    }
    workspace.history.advance(received_ms);
    let others = bytes.saturating_sub(workspace.history.bytes());
    let admitted = workspace
        .history
        .append_bounded(&frame, MAX_WORKSPACE_BYTES.saturating_sub(others));
    let valid = match admitted {
        Ok(()) => true,
        Err(error) => {
            let clock_gap = error.code == "history_clock";
            diagnostic(&mut workspace.diagnostics, error);
            !clock_gap
        }
    };
    workspace.latest.insert(
        key,
        Baseline {
            monotonic_ms,
            received_ms,
            wall_ms: frame.observed_at_ms,
            frame: Arc::new(frame),
            valid,
            bytes: frame_bytes,
        },
    );
    workspace.sequence += 1;
}
fn retain_capture(
    workspace: &mut Workspace,
    capture: Capture,
    proof: Option<DraftCaptureProof>,
) -> Result<(), Diagnostic> {
    let key = (capture.target_id.clone(), capture.command.clone());
    let old = workspace
        .captures
        .get(&key)
        .filter(|v| v.len() == 2)
        .and_then(|v| v.front())
        .map_or(0, |capture| {
            workspace
                .capture_charges
                .get(&capture.capture_id)
                .copied()
                .unwrap_or(0)
                + workspace
                    .proofs
                    .get(&capture.capture_id)
                    .map_or(0, DraftCaptureProof::bytes)
        });
    let charge = encoded_bytes(&capture);
    if retained_bytes(workspace)
        .saturating_sub(old)
        .saturating_add(charge)
        .saturating_add(proof.as_ref().map_or(0, DraftCaptureProof::bytes))
        > MAX_WORKSPACE_BYTES
    {
        let error = failure(
            "workspace_memory_limit",
            "Raw capture cannot fit the workspace memory budget",
        );
        diagnostic(&mut workspace.diagnostics, error.clone());
        return Err(error);
    }
    let captures = workspace.captures.entry(key).or_default();
    if captures.len() == 2 {
        if let Some(old) = captures.pop_front() {
            workspace.proofs.remove(&old.capture_id);
            workspace.capture_charges.remove(&old.capture_id);
        }
    }
    if let Some(proof) = proof {
        workspace.proofs.insert(capture.capture_id.clone(), proof);
    }
    workspace
        .capture_charges
        .insert(capture.capture_id.clone(), charge);
    captures.push_back(capture);
    Ok(())
}
fn retain_local(workspace: &mut Workspace, sample: LocalSample) {
    let old = workspace.local_samples.front().map_or(0, encoded_bytes);
    if retained_bytes(workspace)
        .saturating_sub(old)
        .saturating_add(encoded_bytes(&sample))
        > MAX_WORKSPACE_BYTES
    {
        diagnostic(
            &mut workspace.diagnostics,
            failure(
                "workspace_memory_limit",
                "Local sample cannot fit the workspace memory budget",
            ),
        );
        return;
    }
    workspace.local_samples.clear();
    workspace.local_samples.push_back(sample);
}
fn retained_bytes(workspace: &Workspace) -> usize {
    retained_bytes_parts(
        &workspace.latest,
        &workspace.local_samples,
        &workspace.history,
        &workspace.proofs,
        &workspace.capture_charges,
    )
}
fn retained_bytes_parts(
    latest: &BTreeMap<(String, String), Baseline>,
    local: &VecDeque<LocalSample>,
    history: &TelemetryHistory,
    proofs: &BTreeMap<String, DraftCaptureProof>,
    capture_charges: &BTreeMap<String, usize>,
) -> usize {
    latest.values().map(|b| b.bytes).sum::<usize>()
        + capture_charges.values().sum::<usize>()
        + local.iter().map(encoded_bytes).sum::<usize>()
        + history.bytes()
        + proofs.values().map(DraftCaptureProof::bytes).sum::<usize>()
}
fn encoded_bytes(value: &impl serde::Serialize) -> usize {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    if serde_json::to_writer(&mut counter, value).is_err() {
        return MAX_WORKSPACE_BYTES;
    }
    counter.0.saturating_mul(4).saturating_add(512)
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

    #[derive(Default)]
    struct Probe {
        calls: Mutex<Vec<(String, u64)>>,
        active: Mutex<BTreeMap<String, usize>>,
        max_target: AtomicUsize,
        max_global: AtomicUsize,
        local_calls: AtomicUsize,
        local_factories: AtomicUsize,
        counter: AtomicU64,
        auth_failure: AtomicBool,
        cleanup_blocked: AtomicBool,
        hold: AtomicBool,
        ignore_cancel: AtomicBool,
        transport_failure: AtomicBool,
        local_hold: AtomicBool,
        local_rows: AtomicUsize,
        raw_tail: Mutex<String>,
        release: tokio::sync::Notify,
    }
    struct FakeLocal(Arc<Probe>);
    impl LocalSampler for FakeLocal {
        fn sample(&mut self, now: SampleTime) -> Result<LocalSample, Diagnostic> {
            self.0.local_calls.fetch_add(1, Ordering::SeqCst);
            while self.0.local_hold.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(5));
            }
            Ok(LocalSample {
                observed_at_ms: now.wall_ms,
                monotonic_ms: now.monotonic_ms,
                sources: BTreeMap::from([(
                    "local.network".into(),
                    (0..self.0.local_rows.load(Ordering::SeqCst).max(1))
                        .map(|n| MetricRow {
                            key: format!("eth{n}"),
                            fields: BTreeMap::from([
                                (
                                    "interface".into(),
                                    MetricValue::Text {
                                        value: format!("eth{n}"),
                                    },
                                ),
                                (
                                    "bytes".into(),
                                    MetricValue::Unsigned {
                                        value: self.0.counter.load(Ordering::SeqCst).to_string(),
                                    },
                                ),
                            ]),
                        })
                        .collect(),
                )]),
                diagnostics: vec![],
            })
        }
    }
    struct FakeSsh {
        target: TargetRef,
        probe: Arc<Probe>,
        clock: TelemetryClock,
        first: bool,
    }
    #[async_trait::async_trait]
    impl SshSampler for FakeSsh {
        fn display_name(&self) -> Option<String> {
            Some(format!("Saved {}", self.target.connection_id))
        }
        async fn capture(
            &mut self,
            request: CaptureRequest,
            cancel: CancellationToken,
        ) -> Result<CollectedCapture, Diagnostic> {
            let now = self.clock.now();
            self.probe
                .calls
                .lock()
                .push((self.target.connection_id.clone(), now.monotonic_ms));
            {
                let mut active = self.probe.active.lock();
                *active.entry(self.target.connection_id.clone()).or_default() += 1;
                self.probe
                    .max_target
                    .fetch_max(active[&self.target.connection_id], Ordering::SeqCst);
                self.probe
                    .max_global
                    .fetch_max(active.values().sum(), Ordering::SeqCst);
            }
            if self.target.connection_id == "slow" && self.probe.hold.load(Ordering::SeqCst) {
                if self.probe.ignore_cancel.load(Ordering::SeqCst) {
                    self.probe.release.notified().await;
                } else {
                    tokio::select! { _ = self.probe.release.notified() => {}, _ = cancel.cancelled() => {} }
                }
            }
            tokio::task::yield_now().await;
            *self
                .probe
                .active
                .lock()
                .get_mut(&self.target.connection_id)
                .unwrap() -= 1;
            if self.probe.auth_failure.load(Ordering::SeqCst) {
                return Err(failure("ssh_auth_failed", "Saved authentication failed"));
            }
            if self.probe.transport_failure.load(Ordering::SeqCst) {
                return Err(failure("ssh_connect_failed", "Fixture transport failure"));
            }
            let reconnected = std::mem::replace(&mut self.first, false);
            Ok(CollectedCapture {
                capture: Capture {
                    capture_id: uuid::Uuid::new_v4().to_string(),
                    target_id: self.target.connection_id.clone(),
                    platform: self.target.platform,
                    command: request.command.as_str().into(),
                    parser_id: request.parser_id,
                    revision: request.revision,
                    observed_at_ms: now.wall_ms,
                    monotonic_ms: now.monotonic_ms,
                    raw: format!(
                        "eth0 {}\n{}",
                        self.probe.counter.load(Ordering::SeqCst),
                        self.probe.raw_tail.lock()
                    ),
                },
                display_name: format!("Saved {}", self.target.connection_id),
                reconnected,
            })
        }
        async fn close(&mut self) -> Result<(), Diagnostic> {
            if self.probe.cleanup_blocked.load(Ordering::SeqCst) {
                Err(failure(
                    "ssh_cleanup_pending",
                    "Fixture cleanup remains owned",
                ))
            } else {
                Ok(())
            }
        }
    }

    struct Harness {
        service: Arc<TelemetryService>,
        clock: TelemetryClock,
        probe: Arc<Probe>,
        _directory: tempfile::TempDir,
        draft: ConfigDraft,
        publication_pause: Arc<(AtomicBool, AtomicBool)>,
    }
    impl Harness {
        fn new() -> Self {
            Self::configured(|_| {})
        }
        fn configured(modify: impl FnOnce(&mut Catalog)) -> Self {
            Self::with_parser(Arc::new(TelemetryParser::new()), modify)
        }
        fn with_parser(parser: Arc<TelemetryParser>, modify: impl FnOnce(&mut Catalog)) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let clock = TelemetryClock::fake(SampleTime {
                wall_ms: 1_000_000,
                monotonic_ms: 0,
            });
            let probe = Arc::new(Probe::default());
            probe.counter.store(100, Ordering::SeqCst);
            let widgets = "schema_version: 1\nwidgets:\n- widget: traffic\n  title: Traffic\n  source: {kind: ssh, commands: {iosxe: show interfaces}, templates: {iosxe: test.interfaces}}\n  interval: 30\n  key: [interface]\n  fields: {interface: [iface], bytes: [bytes]}\n  rates: {rate: {field: bytes, unit: B/s}}\n  history: {fields: [rate]}\n  view: {type: chart, series: [{field: rate, label: Traffic, unit: B/s}]}\n- widget: fast\n  title: Faster alternate parser\n  source: {kind: ssh, commands: {iosxe: show interfaces}, templates: {iosxe: test.other}}\n  interval: 5\n  key: [interface]\n  fields: {interface: [iface], bytes: [bytes]}\n  view: {type: table, columns: [{field: bytes, label: Bytes}]}\n- widget: local_traffic\n  title: Local traffic\n  source: {kind: local, collector: local.network}\n  interval: 2\n  key: [interface]\n  fields: {interface: [interface], bytes: [bytes]}\n  rates: {rate: {field: bytes, unit: B/s}}\n  history: {fields: [rate]}\n  view: {type: chart, series: [{field: rate, label: Traffic, unit: B/s}]}\n";
            let document: WidgetDocument = serde_yaml::from_str(widgets).unwrap();
            let text = "Value IFACE (\\S+)\nValue BYTES (\\d+)\n\nStart\n  ^${IFACE} ${BYTES}$$ -> Record\n";
            let templates = ["test.interfaces", "test.other"]
                .into_iter()
                .map(|id| {
                    (
                        id.into(),
                        TemplateAsset {
                            id: id.into(),
                            platform: Platform::Iosxe,
                            command: "show interfaces".into(),
                            text: text.into(),
                            sha256: format!("{:x}", sha2::Sha256::digest(text.as_bytes())),
                        },
                    )
                })
                .collect();
            let mut catalog = Catalog {
                widgets: document
                    .widgets
                    .into_iter()
                    .map(|w| (w.widget.clone(), w))
                    .collect(),
                templates,
                layouts: BTreeMap::new(),
            };
            modify(&mut catalog);
            let draft_widgets = serde_yaml::to_string(&WidgetDocument {
                schema_version: 1,
                widgets: vec![catalog.widgets["traffic"].clone()],
            })
            .unwrap();
            let repository =
                TelemetryConfigRepository::load(directory.path().into(), catalog, parser.clone())
                    .unwrap();
            let publication_pause = Arc::new((AtomicBool::new(false), AtomicBool::new(true)));
            *repository.publication_pause.lock().unwrap() = Some(publication_pause.clone());
            let draft = ConfigDraft {
                scope: ConfigScope::Profile(Platform::Iosxe),
                widgets_yaml: draft_widgets,
                layouts_yaml: "schema_version: 1\nlayouts: []\n".into(),
                templates: BTreeMap::new(),
                expected_revision: repository.base_revision(),
                reset_assets: vec![],
            };
            let local_probe = probe.clone();
            let ssh_probe = probe.clone();
            let ssh_clock = clock.clone();
            let service = Arc::new(TelemetryService::new(
                repository,
                LocalCollectorFactory::fixture(move || {
                    local_probe.local_factories.fetch_add(1, Ordering::SeqCst);
                    Box::new(FakeLocal(local_probe.clone()))
                }),
                TelemetrySshFactory::fixture(move |target| {
                    Box::new(FakeSsh {
                        target,
                        probe: ssh_probe.clone(),
                        clock: ssh_clock.clone(),
                        first: true,
                    })
                }),
                parser,
                clock.clone(),
            ));
            Self {
                service,
                clock,
                probe,
                _directory: directory,
                draft,
                publication_pause,
            }
        }
        async fn start(&self, ids: &[&str], local: bool) -> TelemetrySnapshot {
            self.service.establish("workspace").await.unwrap();
            self.service
                .start(StartRequest {
                    workspace_id: "workspace".into(),
                    targets: ids
                        .iter()
                        .map(|id| TargetRef {
                            connection_id: (*id).into(),
                            platform: Platform::Iosxe,
                        })
                        .collect(),
                    local_enabled: local,
                    monitored_interfaces: BTreeMap::new(),
                })
                .await
                .unwrap()
        }
        async fn wait(&self, ready: impl Fn(&TelemetrySnapshot) -> bool) -> TelemetrySnapshot {
            let result = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let snapshot = self.service.snapshot("workspace").await.unwrap();
                    if ready(&snapshot) {
                        return snapshot;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await;
            result.unwrap_or_else(|_| {
                let calls = self.probe.calls.lock();
                panic!("owned service made no expected progress; captures={}, local_calls={}, last_capture={:?}", calls.len(), self.probe.local_calls.load(Ordering::SeqCst), calls.last());
            })
        }
        async fn finish(&self) {
            self.service.shutdown().await.unwrap();
        }
        async fn revision(&self, target: &str) -> Revision {
            self.service
                .request(|reply| Request::TargetRevision("workspace".into(), target.into(), reply))
                .await
                .unwrap()
        }
        fn command_draft(&self, command: &str, parser: &str) -> ConfigDraft {
            let mut draft = self.draft.clone();
            draft.widgets_yaml = draft
                .widgets_yaml
                .replace("show interfaces", command)
                .replace("test.interfaces", parser);
            draft.templates.insert(parser.into(), "Value IFACE (\\S+)\nValue BYTES (\\d+)\n\nStart\n  ^${IFACE} ${BYTES}$$ -> Record\n".into());
            draft
        }
    }

    async fn authoring_target_stays_one_shot(draft_sample: bool) {
        let h = Harness::configured(|catalog| {
            catalog.widgets.remove("fast");
        });
        h.start(&["one"], false).await;
        let first = h.wait(|s| s.widgets.len() == 1).await;
        let target = TargetRef {
            connection_id: "two".into(),
            platform: Platform::Iosxe,
        };
        let draft = if draft_sample {
            h.command_draft("show interfaces", "draft.interfaces")
        } else {
            h.draft.clone()
        };
        if draft_sample {
            h.service
                .capture_draft_sample("workspace", target, &draft, "draft.interfaces")
                .await
                .unwrap();
        } else {
            h.service
                .capture_sample(
                    "workspace",
                    target,
                    CaptureRequest {
                        command: CommandPolicy::admit(Platform::Iosxe, "show interfaces").unwrap(),
                        parser_id: "test.interfaces".into(),
                        revision: first.widgets[0].revision.clone(),
                    },
                )
                .await
                .unwrap();
        }
        h.clock.advance(Duration::from_secs(30));
        h.wait(|s| {
            s.widgets
                .iter()
                .any(|w| w.target_id == "one" && w.observed_at_ms == 1_030_000)
        })
        .await;
        let count = || {
            h.probe
                .calls
                .lock()
                .iter()
                .filter(|(id, _)| id == "two")
                .count()
        };
        assert_eq!(
            count(),
            1,
            "authoring enrollment must not enable periodic polling"
        );
        let preview = h.service.preview("workspace", &draft).await.unwrap();
        assert!(preview.token.is_some(), "{:?}", preview.diagnostics);
        h.service
            .apply("workspace", draft, preview.token.unwrap())
            .await
            .unwrap();
        h.wait(|s| {
            s.widgets.iter().any(|w| {
                w.target_id == "one"
                    && w.generation == s.generation
                    && w.observed_at_ms == 1_030_000
            })
        })
        .await;
        h.clock.advance(Duration::from_secs(30));
        h.wait(|s| {
            s.widgets
                .iter()
                .any(|w| w.target_id == "one" && w.observed_at_ms == 1_060_000)
        })
        .await;
        assert_eq!(count(), 1, "Apply must preserve authoring-only eligibility");
        h.start(&["one", "two"], false).await;
        h.wait(|s| s.widgets.iter().any(|w| w.target_id == "two"))
            .await;
        assert!(count() > 1, "an explicit Start selection enables polling");
        assert_eq!(h.probe.max_target.load(Ordering::SeqCst), 1);
        assert!(h.probe.max_global.load(Ordering::SeqCst) <= 4);
        h.finish().await;
    }
    #[tokio::test]
    async fn review_current_authoring_capture_does_not_enable_polling() {
        authoring_target_stays_one_shot(false).await;
    }
    #[tokio::test]
    async fn metadata_selection_while_running_remains_authoring_only() {
        let h = Harness::new();
        h.start(&["one"], true).await;
        h.wait(|snapshot| snapshot.widgets.len() == 3).await;
        h.service
            .select(
                "workspace",
                SavedTargetMetadata {
                    reference: TargetRef {
                        connection_id: "editor-only".into(),
                        platform: Platform::Iosxe,
                    },
                    display_name: "Editor target".into(),
                },
            )
            .await
            .unwrap();
        let selected = h.service.snapshot("workspace").await.unwrap();
        assert!(
            selected
                .targets
                .iter()
                .find(|target| target.target_id == "one")
                .unwrap()
                .monitoring_selected
        );
        assert!(
            selected
                .targets
                .iter()
                .find(|target| target.target_id == "local")
                .unwrap()
                .monitoring_selected
        );
        assert!(
            !selected
                .targets
                .iter()
                .find(|target| target.target_id == "editor-only")
                .unwrap()
                .monitoring_selected
        );
        assert_eq!(
            selected
                .targets
                .iter()
                .find(|target| target.target_id == "editor-only")
                .unwrap()
                .display_name,
            "Editor target"
        );
        assert!(h
            .service
            .catalog("workspace", ConfigScope::Device("editor-only".into()))
            .await
            .is_ok());
        h.clock.advance(Duration::from_secs(60));
        h.wait(|snapshot| {
            snapshot
                .widgets
                .iter()
                .any(|widget| widget.observed_at_ms >= 1_060_000)
        })
        .await;
        assert!(h
            .probe
            .calls
            .lock()
            .iter()
            .all(|(target, _)| target == "one"));
        h.service.stop("workspace").await.unwrap();
        let stopped = h.service.snapshot("workspace").await.unwrap();
        assert!(
            stopped
                .targets
                .iter()
                .find(|target| target.target_id == "one")
                .unwrap()
                .monitoring_selected
        );
        assert!(
            !stopped
                .targets
                .iter()
                .find(|target| target.target_id == "editor-only")
                .unwrap()
                .monitoring_selected
        );
        h.start(&["editor-only"], false).await;
        let restarted = h.service.snapshot("workspace").await.unwrap();
        assert!(
            restarted
                .targets
                .iter()
                .find(|target| target.target_id == "editor-only")
                .unwrap()
                .monitoring_selected
        );
        h.finish().await;
    }
    #[tokio::test]
    async fn review_draft_authoring_capture_does_not_enable_polling() {
        authoring_target_stays_one_shot(true).await;
    }
    #[tokio::test]
    async fn review_command_edit_previews_with_an_old_command_already_retained() {
        let h = Harness::configured(|catalog| {
            catalog.widgets.remove("fast");
        });
        h.start(&["one"], false).await;
        h.wait(|s| s.widgets.len() == 1).await;
        h.service.stop("workspace").await.unwrap();
        let draft = h.command_draft("show version", "new.version");
        assert!(
            h.service
                .preview("workspace", &draft)
                .await
                .unwrap()
                .token
                .is_none(),
            "the new command still needs its own sample"
        );
        let capture = h
            .service
            .capture_draft_sample(
                "workspace",
                TargetRef {
                    connection_id: "one".into(),
                    platform: Platform::Iosxe,
                },
                &draft,
                "new.version",
            )
            .await
            .unwrap();
        let preview = h.service.preview("workspace", &draft).await.unwrap();
        assert!(preview.token.is_some(), "{:?}", preview.diagnostics);
        assert!(preview
            .frames
            .iter()
            .all(|frame| frame.revision == capture.revision));
        assert_eq!(capture.command, "show version");
        assert_eq!(capture.parser_id, "new.version");
        let result = h
            .service
            .apply("workspace", draft.clone(), preview.token.unwrap())
            .await
            .unwrap();
        assert_eq!(h.probe.calls.lock().len(), 2);
        let mut published = draft;
        published.expected_revision = result.revision;
        assert!(
            h.service
                .preview("workspace", &published)
                .await
                .unwrap()
                .token
                .is_none(),
            "obsolete ordinary source samples cannot authorize the new source"
        );
        let target = TargetRef {
            connection_id: "one".into(),
            platform: Platform::Iosxe,
        };
        h.service
            .capture_sample(
                "workspace",
                target.clone(),
                CaptureRequest {
                    command: CommandPolicy::admit(Platform::Iosxe, "show version").unwrap(),
                    parser_id: "new.version".into(),
                    revision: h.revision("one").await,
                },
            )
            .await
            .unwrap();
        let report = h.service.preview("workspace", &published).await.unwrap();
        assert!(report.token.is_some(), "{:?}", report.diagnostics);
        assert_eq!(
            h.probe.calls.lock().len(),
            3,
            "one ordinary sample under the new source suffices"
        );
        h.finish().await;
    }
    async fn one_recapture_after_fence_is_enough(repeated_start: bool) {
        let h = Harness::configured(|catalog| {
            catalog.widgets.remove("fast");
        });
        h.start(&["one"], false).await;
        h.wait(|s| s.widgets.len() == 1).await;
        h.service.stop("workspace").await.unwrap();
        let draft = h.command_draft("show version", "new.version");
        let target = TargetRef {
            connection_id: "one".into(),
            platform: Platform::Iosxe,
        };
        let old = h
            .service
            .capture_draft_sample("workspace", target.clone(), &draft, "new.version")
            .await
            .unwrap();
        if repeated_start {
            h.start(&["one"], false).await;
            h.start(&["one"], false).await;
            h.service.stop("workspace").await.unwrap();
        } else {
            h.service.stop("workspace").await.unwrap();
        }
        h.clock.advance(Duration::from_secs(1));
        let before = h.probe.calls.lock().len();
        let fresh = h
            .service
            .capture_draft_sample("workspace", target, &draft, "new.version")
            .await
            .unwrap();
        assert_ne!(fresh.capture_id, old.capture_id);
        let preview = h.service.preview("workspace", &draft).await.unwrap();
        assert!(preview.token.is_some(), "{:?}", preview.diagnostics);
        assert_eq!(
            h.probe.calls.lock().len(),
            before + 1,
            "one fresh command sample must suffice"
        );
        assert!(
            h.service
                .preview("workspace", &h.draft)
                .await
                .unwrap()
                .token
                .is_some(),
            "ordinary source captures survive the fence"
        );
        assert!(h
            .service
            .request(|reply| Request::QuotaParity("workspace".into(), reply))
            .await
            .unwrap());
        h.finish().await;
    }
    #[tokio::test]
    async fn review_fresh_draft_capture_after_stop_does_not_replay_stale_proof() {
        one_recapture_after_fence_is_enough(false).await;
    }
    #[tokio::test]
    async fn review_fresh_draft_capture_after_repeated_start_does_not_replay_stale_proof() {
        one_recapture_after_fence_is_enough(true).await;
    }
    #[tokio::test]
    async fn review_global_publication_invalidates_draft_proofs_on_a_fully_masked_workspace() {
        let h = Harness::configured(|catalog| {
            catalog.widgets.remove("fast");
        });
        h.start(&["one"], false).await;
        h.wait(|s| s.widgets.len() == 1).await;
        let mut device = h.draft.clone();
        device.scope = ConfigScope::Device("one".into());
        device.widgets_yaml = device
            .widgets_yaml
            .replace("title: Traffic", "title: Device");
        let preview = h.service.preview("workspace", &device).await.unwrap();
        let result = h
            .service
            .apply("workspace", device, preview.token.unwrap())
            .await
            .unwrap();
        h.wait(|s| s.widgets.iter().any(|w| w.generation == s.generation))
            .await;
        h.service.stop("workspace").await.unwrap();
        let mut draft = h.command_draft("show version", "new.version");
        draft.scope = ConfigScope::Device("one".into());
        draft.expected_revision = result.revision.clone();
        let target = TargetRef {
            connection_id: "one".into(),
            platform: Platform::Iosxe,
        };
        h.service
            .capture_draft_sample("workspace", target.clone(), &draft, "new.version")
            .await
            .unwrap();
        let before = h.service.snapshot("workspace").await.unwrap();
        let source = h.revision("one").await;
        h.service.establish("second").await.unwrap();
        h.service
            .start(StartRequest {
                workspace_id: "second".into(),
                targets: vec![TargetRef {
                    connection_id: "two".into(),
                    platform: Platform::Iosxe,
                }],
                local_enabled: false,
                monitored_interfaces: BTreeMap::new(),
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while h
                .service
                .snapshot("second")
                .await
                .unwrap()
                .widgets
                .is_empty()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut profile = h.draft.clone();
        profile.expected_revision = result.revision;
        profile.widgets_yaml = profile
            .widgets_yaml
            .replace("title: Traffic", "title: Profile");
        let preview = h.service.preview("second", &profile).await.unwrap();
        assert!(preview.token.is_some(), "{:?}", preview.diagnostics);
        let result = h
            .service
            .apply("second", profile, preview.token.unwrap())
            .await
            .unwrap();
        assert!(!result.affected_targets.contains(&"one".to_string()));
        assert!(result.masked_device_overrides.contains(&"one".to_string()));
        assert_eq!(h.revision("one").await, source);
        let after = h.service.snapshot("workspace").await.unwrap();
        assert_eq!(after.generation, before.generation);
        assert_eq!(after.series, before.series);
        draft.expected_revision = result.revision;
        let calls = h
            .probe
            .calls
            .lock()
            .iter()
            .filter(|(id, _)| id == "one")
            .count();
        h.service
            .capture_draft_sample("workspace", target, &draft, "new.version")
            .await
            .unwrap();
        let preview = h.service.preview("workspace", &draft).await.unwrap();
        assert!(preview.token.is_some(), "{:?}", preview.diagnostics);
        assert_eq!(
            h.probe
                .calls
                .lock()
                .iter()
                .filter(|(id, _)| id == "one")
                .count(),
            calls + 1
        );
        assert!(h
            .service
            .request(|reply| Request::QuotaParity("workspace".into(), reply))
            .await
            .unwrap());
        h.finish().await;
    }

    #[tokio::test]
    async fn ten_targets_one_slow_never_starves_local() {
        let h = Harness::new();
        h.probe.hold.store(true, Ordering::SeqCst);
        let ids = [
            "slow", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
        ];
        h.start(&ids, true).await;
        h.wait(|s| s.widgets.iter().filter(|w| w.target_id != "slow").count() == 19)
            .await;
        assert!(h.probe.local_calls.load(Ordering::SeqCst) > 0);
        let max_in_flight_per_target = h.probe.max_target.load(Ordering::SeqCst);
        let max_global_in_flight = h.probe.max_global.load(Ordering::SeqCst);
        assert_eq!(max_in_flight_per_target, 1);
        assert!(max_global_in_flight <= 4);
        h.clock.advance(Duration::from_secs(30));
        h.wait(|s| {
            s.widgets
                .iter()
                .any(|w| w.target_id == "local" && w.observed_at_ms > 1_000_000)
        })
        .await;
        h.finish().await;
    }

    #[tokio::test]
    async fn dedup_fastest_interval_without_overlapping_or_backlog() {
        let h = Harness::new();
        h.start(&["one"], false).await;
        h.wait(|s| s.widgets.len() == 2).await;
        assert_eq!(h.probe.calls.lock().len(), 1);
        h.clock.advance(Duration::from_secs(5));
        h.wait(|s| s.widgets.iter().all(|w| w.observed_at_ms == 1_005_000))
            .await;
        assert_eq!(h.probe.calls.lock().len(), 2);
        h.clock.advance(Duration::from_secs(1000));
        h.wait(|s| s.widgets.iter().all(|w| w.observed_at_ms == 2_005_000))
            .await;
        for _ in 0..10 {
            h.service.snapshot("workspace").await.unwrap();
        }
        assert_eq!(h.probe.calls.lock().len(), 3);
        assert_eq!(h.probe.max_target.load(Ordering::SeqCst), 1);
        h.finish().await;
    }

    #[tokio::test]
    async fn stop_remove_apply_fence_late_replies() {
        let h = Harness::new();
        h.probe.hold.store(true, Ordering::SeqCst);
        h.probe.ignore_cancel.store(true, Ordering::SeqCst);
        h.start(&["slow"], false).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while h.probe.calls.lock().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let service = h.service.clone();
        let stopped = tokio::spawn(async move { service.stop("workspace").await });
        h.wait(|s| !s.running).await;
        h.probe.release.notify_one();
        stopped.await.unwrap().unwrap();
        let late_revision_append_count = h
            .service
            .snapshot("workspace")
            .await
            .unwrap()
            .series
            .iter()
            .map(|s| s.point_count)
            .sum::<u32>();
        assert_eq!(late_revision_append_count, 0);
        h.start(&["one"], false).await;
        h.wait(|s| s.widgets.len() == 2).await;
        let before = h.service.snapshot("workspace").await.unwrap();
        let history_count_before_stop = before.series.iter().map(|s| s.point_count).sum::<u32>();
        h.service.stop("workspace").await.unwrap();
        let history_count_after_stop = h
            .service
            .snapshot("workspace")
            .await
            .unwrap()
            .series
            .iter()
            .map(|s| s.point_count)
            .sum::<u32>();
        assert_eq!(history_count_after_stop, history_count_before_stop);
        h.start(&[], false).await;
        assert!(h
            .service
            .snapshot("workspace")
            .await
            .unwrap()
            .targets
            .is_empty());
        h.service.close("workspace").await.unwrap();
        assert_eq!(
            h.service.snapshot("workspace").await.unwrap_err().code,
            "workspace_unknown"
        );
        h.finish().await;
    }

    #[tokio::test]
    async fn counter_reset_reconnect_and_sleep_create_gaps() {
        let h = Harness::new();
        h.start(&[], true).await;
        h.wait(|s| s.widgets.len() == 1).await;
        h.probe.counter.store(200, Ordering::SeqCst);
        h.clock.advance(Duration::from_secs(2));
        h.wait(|s| s.widgets[0].observed_at_ms == 1_002_000).await;
        let widget = || WidgetQuery {
            workspace_id: "workspace".into(),
            target_id: "local".into(),
            widget_id: "local_traffic".into(),
            offset: 0,
            limit: 1000,
        };
        assert_eq!(
            h.service.widget(widget()).await.unwrap().rows[0].fields["rate"],
            MetricValue::Number { value: 50.0 }
        );
        h.probe.counter.store(1, Ordering::SeqCst);
        h.clock.advance(Duration::from_secs(2));
        h.wait(|s| s.widgets[0].observed_at_ms == 1_004_000).await;
        assert!(
            matches!(&h.service.widget(widget()).await.unwrap().rows[0].fields["rate"], MetricValue::Missing { reason } if reason == "counter_reset")
        );
        h.clock.advance(Duration::from_secs(60));
        h.wait(|s| s.widgets[0].observed_at_ms == 1_064_000).await;
        assert!(matches!(
            h.service.widget(widget()).await.unwrap().rows[0].fields["rate"],
            MetricValue::Missing { .. }
        ));
        h.service.stop("workspace").await.unwrap();
        h.clock.advance(Duration::from_secs(2));
        h.start(&[], true).await;
        h.wait(|s| s.widgets[0].observed_at_ms == 1_066_000).await;
        assert!(matches!(
            h.service.widget(widget()).await.unwrap().rows[0].fields["rate"],
            MetricValue::Missing { .. }
        ));
        h.finish().await;
    }

    #[tokio::test]
    async fn auth_failure_suspends_retry() {
        let h = Harness::new();
        h.probe.auth_failure.store(true, Ordering::SeqCst);
        h.start(&["one"], false).await;
        h.wait(|s| s.targets[0].state == CollectionState::Failed)
            .await;
        assert_eq!(
            h.service.snapshot("workspace").await.unwrap().targets[0].display_name,
            "Saved one"
        );
        for _ in 0..5 {
            h.clock.advance(Duration::from_secs(120));
            h.service.snapshot("workspace").await.unwrap();
        }
        assert_eq!(h.probe.calls.lock().len(), 1);
        h.probe.auth_failure.store(false, Ordering::SeqCst);
        h.start(&["one"], false).await;
        h.wait(|s| s.widgets.len() == 2).await;
        assert_eq!(h.probe.calls.lock().len(), 2);
        h.finish().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sync_shutdown_does_not_depend_on_callers_tokio_runtime() {
        let h = Harness::new();
        h.start(&["one"], true).await;
        h.wait(|s| s.widgets.len() == 3).await;
        h.service.shutdown_sync(Duration::from_secs(3)).unwrap();
        h.service.shutdown_sync(Duration::from_secs(3)).unwrap();
    }

    #[tokio::test]
    async fn establishment_and_local_preview_are_explicit_and_stopped() {
        let h = Harness::new();
        assert_eq!(
            h.service.snapshot("workspace").await.unwrap_err().code,
            "workspace_unknown"
        );
        for _ in 0..2 {
            let s = h.service.establish("workspace").await.unwrap();
            assert!(!s.running);
            assert!(s.targets.is_empty());
        }
        assert_eq!(h.probe.local_calls.load(Ordering::SeqCst), 0);
        let mut draft = h.draft.clone();
        draft.scope = ConfigScope::Local;
        draft.widgets_yaml = serde_yaml::to_string(&WidgetDocument {
            schema_version: 1,
            widgets: h
                .service
                .catalog("workspace", ConfigScope::Local)
                .await
                .unwrap()
                .value
                .effective
                .widgets,
        })
        .unwrap();
        let report = h.service.preview("workspace", &draft).await.unwrap();
        assert_eq!(report.local_samples.len(), 1);
        assert!(report.captures.is_empty() && report.interpretations.is_empty());
        assert_eq!(
            report.frames[0].observed_at_ms,
            report.local_samples[0].observed_at_ms
        );
        assert_eq!(report.frame_sources.len(), report.frames.len());
        for link in &report.frame_sources {
            let PreviewSampleSource::Local {
                sample_index,
                collector,
            } = link.source
            else {
                panic!("Local frame must not pretend to be a CLI capture")
            };
            assert_eq!(collector, super::super::model::LocalCollector::Network);
            assert!(report.local_samples[sample_index as usize]
                .sources
                .contains_key(collector.as_str()));
            assert_eq!(
                report.frames[link.frame_index as usize].observed_at_ms,
                report.local_samples[sample_index as usize].observed_at_ms
            );
        }
        assert_eq!(h.probe.local_calls.load(Ordering::SeqCst), 1);
        assert!(h.probe.calls.lock().is_empty());
        assert!(!h.service.snapshot("workspace").await.unwrap().running);
        draft.widgets_yaml = "invalid: true".into();
        h.service.preview("workspace", &draft).await.unwrap();
        assert_eq!(h.probe.local_calls.load(Ordering::SeqCst), 1);
        h.finish().await;
    }

    #[tokio::test]
    async fn transport_retries_use_backoff_and_success_resets_it() {
        let h = Harness::configured(|catalog| {
            catalog.widgets.remove("fast");
        });
        h.probe.transport_failure.store(true, Ordering::SeqCst);
        h.start(&["one"], false).await;
        h.wait(|s| s.targets[0].state == CollectionState::Failed)
            .await;
        for (delay, count) in [(5, 2), (15, 3), (30, 4), (60, 5), (60, 6)] {
            h.clock.advance(Duration::from_secs(delay));
            tokio::time::timeout(Duration::from_secs(2), async {
                while h.probe.calls.lock().len() < count {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            h.wait(|s| s.targets[0].state == CollectionState::Failed)
                .await;
        }
        h.probe.transport_failure.store(false, Ordering::SeqCst);
        h.clock.advance(Duration::from_secs(60));
        h.wait(|s| s.widgets.len() == 1).await;
        h.probe.transport_failure.store(true, Ordering::SeqCst);
        h.clock.advance(Duration::from_secs(30));
        h.wait(|s| s.targets[0].state == CollectionState::Failed)
            .await;
        let count = h.probe.calls.lock().len();
        h.clock.advance(Duration::from_secs(5));
        tokio::time::timeout(Duration::from_secs(2), async {
            while h.probe.calls.lock().len() == count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        h.finish().await;
    }

    #[tokio::test]
    async fn selected_cadence_is_authored_and_preserved_after_apply() {
        let h = Harness::configured(|catalog| {
            catalog.widgets.remove("fast");
            catalog
                .widgets
                .get_mut("traffic")
                .unwrap()
                .selected_interval = Some(7);
        });
        h.service.establish("workspace").await.unwrap();
        let mut request = StartRequest {
            workspace_id: "workspace".into(),
            targets: vec![TargetRef {
                connection_id: "one".into(),
                platform: Platform::Iosxe,
            }],
            local_enabled: false,
            monitored_interfaces: BTreeMap::from([("one".into(), vec!["Gi1/0/1".into()])]),
        };
        h.service.start(request.clone()).await.unwrap();
        h.wait(|s| s.widgets.len() == 1).await;
        h.clock.advance(Duration::from_secs(6));
        h.service.snapshot("workspace").await.unwrap();
        assert_eq!(h.probe.calls.lock().len(), 1);
        h.clock.advance(Duration::from_secs(1));
        h.wait(|s| s.widgets[0].observed_at_ms == 1_007_000).await;
        assert_eq!(h.probe.calls.lock().len(), 2);
        let mut draft = h.draft.clone();
        draft.widgets_yaml = draft.widgets_yaml.replace("Traffic", "Renamed");
        let report = h.service.preview("workspace", &draft).await.unwrap();
        assert!(report.token.is_some(), "{:?}", report.diagnostics);
        let old_revision = h.service.snapshot("workspace").await.unwrap().widgets[0]
            .revision
            .clone();
        h.service
            .apply("workspace", draft, report.token.unwrap())
            .await
            .unwrap();
        h.wait(|s| s.widgets[0].revision != old_revision).await;
        h.clock.advance(Duration::from_secs(7));
        h.wait(|s| s.widgets[0].observed_at_ms == 1_014_000).await;
        request.monitored_interfaces.clear();
        let started = h.service.start(request).await.unwrap();
        h.wait(|s| s.widgets[0].generation == started.generation)
            .await;
        let count = h.probe.calls.lock().len();
        h.clock.advance(Duration::from_secs(7));
        h.service.snapshot("workspace").await.unwrap();
        assert_eq!(h.probe.calls.lock().len(), count);
        h.clock.advance(Duration::from_secs(23));
        h.wait(|s| s.widgets[0].observed_at_ms == 1_044_000).await;
        assert_eq!(h.probe.calls.lock().len(), count + 1);
        h.finish().await;
    }

    #[tokio::test]
    async fn multi_template_preview_reuses_capture_without_network_and_apply_fences_all_workspaces()
    {
        let h = Harness::new();
        h.start(&["one"], false).await;
        h.wait(|s| s.widgets.len() == 2).await;
        h.service.establish("second").await.unwrap();
        h.service
            .start(StartRequest {
                workspace_id: "second".into(),
                targets: vec![TargetRef {
                    connection_id: "one".into(),
                    platform: Platform::Iosxe,
                }],
                local_enabled: false,
                monitored_interfaces: BTreeMap::new(),
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while h.service.snapshot("second").await.unwrap().widgets.len() != 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let first = h.service.snapshot("workspace").await.unwrap();
        let second = h.service.snapshot("second").await.unwrap();
        let count = h.probe.calls.lock().len();
        let report = h.service.preview("workspace", &h.draft).await.unwrap();
        assert!(report.token.is_some(), "{:?}", report.diagnostics);
        assert_eq!(report.captures.len(), 1);
        assert_eq!(report.interpretations.len(), 1);
        let original = report.captures[0].clone();
        let interpretation = &report.interpretations[0];
        assert_eq!(interpretation.capture_id, original.capture_id);
        assert_eq!(interpretation.parser_id, "test.interfaces");
        assert_eq!(report.frames[0].observed_at_ms, original.observed_at_ms);
        assert_eq!(
            report.frames[0].rows[0].fields["bytes"],
            MetricValue::Unsigned {
                value: "100".into()
            }
        );
        assert_eq!(
            interpretation.rows[0].fields["bytes"],
            MetricValue::Text {
                value: "100".into()
            }
        );
        let catalog = h
            .service
            .catalog("workspace", ConfigScope::Profile(Platform::Iosxe))
            .await
            .unwrap();
        let mut template = catalog.value.effective.templates["test.interfaces"].clone();
        template.id = "edited.name".into();
        let tested = h
            .service
            .test_template("workspace", &original.capture_id, template.clone())
            .await
            .unwrap();
        assert_eq!(tested.value.capture_id, original.capture_id);
        assert_eq!(tested.value.parser_id, "edited.name");
        h.service.establish("private-other").await.unwrap();
        assert_eq!(
            h.service
                .test_template("private-other", &original.capture_id, template)
                .await
                .unwrap_err()
                .code,
            "capture_unknown"
        );
        assert_eq!(h.probe.calls.lock().len(), count);
        let mut draft = h.draft.clone();
        draft.widgets_yaml = draft
            .widgets_yaml
            .replace("title: Traffic", "title: Renamed");
        let report = h.service.preview("workspace", &draft).await.unwrap();
        h.service
            .apply("workspace", draft, report.token.unwrap())
            .await
            .unwrap();
        assert!(h.service.snapshot("workspace").await.unwrap().generation > first.generation);
        assert!(h.service.snapshot("second").await.unwrap().generation > second.generation);
        assert_eq!(h.probe.max_target.load(Ordering::SeqCst), 1);
        h.service.close("workspace").await.unwrap();
        assert!(h.service.snapshot("second").await.unwrap().running);
        h.clock.advance(Duration::from_secs(5));
        h.finish().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cleanup_failure_keeps_runtime_and_retry_joins_owned_resources() {
        let h = Harness::new();
        h.start(&["one"], false).await;
        h.wait(|s| s.widgets.len() == 2).await;
        h.probe.cleanup_blocked.store(true, Ordering::SeqCst);
        assert_eq!(
            h.service
                .shutdown_sync(Duration::from_millis(50))
                .unwrap_err()
                .code,
            "cleanup_pending"
        );
        assert!(h.service.thread.lock().is_some());
        assert!(h.service.finished.0.lock().is_none());
        h.probe.cleanup_blocked.store(false, Ordering::SeqCst);
        h.service.shutdown_sync(Duration::from_secs(3)).unwrap();
        assert!(h.service.thread.lock().is_none());
    }

    #[tokio::test]
    async fn blocking_local_sample_is_owned_through_timeout_and_close_retry() {
        let h = Harness::new();
        h.probe.local_hold.store(true, Ordering::SeqCst);
        h.start(&[], true).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while h.probe.local_calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            h.service.stop("workspace").await.unwrap_err().code,
            "cleanup_pending"
        );
        assert!(!h.service.snapshot("workspace").await.unwrap().running);
        assert_eq!(
            h.service.establish("workspace").await.unwrap_err().code,
            "cleanup_pending"
        );
        assert_eq!(
            h.service
                .start(StartRequest {
                    workspace_id: "workspace".into(),
                    targets: vec![],
                    local_enabled: true,
                    monitored_interfaces: BTreeMap::new()
                })
                .await
                .unwrap_err()
                .code,
            "cleanup_pending"
        );
        h.probe.local_hold.store(false, Ordering::SeqCst);
        h.service.close("workspace").await.unwrap();
        h.finish().await;
    }

    #[tokio::test]
    async fn app_lifecycle_waits_for_actual_telemetry_owner_before_sidecar_exit() {
        use crate::app_lifecycle::{cleanup_process_services, ProcessExitServices};
        struct ExitServices {
            service: Arc<TelemetryService>,
            entered: Arc<AtomicBool>,
            sidecar: Arc<AtomicBool>,
        }
        impl ProcessExitServices for ExitServices {
            fn shutdown_telemetry(&self) -> Result<(), String> {
                self.entered.store(true, Ordering::SeqCst);
                self.service
                    .shutdown_sync(Duration::from_secs(3))
                    .map_err(|d| d.code)
            }
            fn shutdown_discovery(&self) -> Result<(), String> {
                Ok(())
            }
            fn shutdown_stp(&self) -> Result<(), String> {
                Ok(())
            }
            fn stop_sidecar(&self) {
                self.sidecar.store(true, Ordering::SeqCst);
            }
        }
        struct Release(Arc<Probe>);
        impl Drop for Release {
            fn drop(&mut self) {
                self.0.local_hold.store(false, Ordering::SeqCst);
            }
        }
        let h = Harness::new();
        h.probe.local_hold.store(true, Ordering::SeqCst);
        let release = Release(h.probe.clone());
        h.start(&[], true).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while h.probe.local_calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let entered = Arc::new(AtomicBool::new(false));
        let sidecar = Arc::new(AtomicBool::new(false));
        let services = ExitServices {
            service: h.service.clone(),
            entered: entered.clone(),
            sidecar: sidecar.clone(),
        };
        let cleanup = tokio::task::spawn_blocking(move || cleanup_process_services(&services));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !cleanup.is_finished(),
            "native cleanup returned while the real Local owner was held"
        );
        assert!(entered.load(Ordering::SeqCst));
        assert!(!sidecar.load(Ordering::SeqCst));
        drop(release);
        tokio::time::timeout(Duration::from_secs(2), cleanup)
            .await
            .unwrap()
            .unwrap();
        assert!(sidecar.load(Ordering::SeqCst));
        h.service.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn private_preview_cannot_relabel_a_failed_old_base_after_unrelated_publication() {
        struct Release(Arc<Probe>);
        impl Drop for Release {
            fn drop(&mut self) {
                self.0.local_hold.store(false, Ordering::SeqCst);
            }
        }
        let h = Harness::new();
        h.start(&["one"], false).await;
        h.wait(|snapshot| snapshot.widgets.len() == 2).await;
        let mut changed = h.draft.clone();
        changed.widgets_yaml = changed
            .widgets_yaml
            .replace("title: Traffic", "title: Changed");
        let token = h
            .service
            .preview("workspace", &changed)
            .await
            .unwrap()
            .token
            .unwrap();
        h.service.establish("local-editor").await.unwrap();
        let local = h
            .service
            .catalog("local-editor", ConfigScope::Local)
            .await
            .unwrap()
            .value
            .own;
        h.probe.local_hold.store(true, Ordering::SeqCst);
        let release = Release(h.probe.clone());
        let service = h.service.clone();
        let preview =
            tokio::spawn(async move { service.preview_read("local-editor", &local).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while h.probe.local_calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        h.service.apply("workspace", changed, token).await.unwrap();
        drop(release);
        assert_eq!(preview.await.unwrap().unwrap_err().code, "preview_obsolete");
        h.finish().await;
    }

    #[tokio::test]
    async fn retained_widget_page_separates_current_authority_from_original_stopped_sample() {
        let h = Harness::new();
        h.start(&["one"], false).await;
        let before = h.wait(|snapshot| snapshot.widgets.len() == 2).await;
        let original = before
            .widgets
            .iter()
            .find(|widget| widget.widget_id == "traffic")
            .unwrap()
            .clone();
        h.service.stop("workspace").await.unwrap();
        let mut draft = h.draft.clone();
        draft.widgets_yaml = draft
            .widgets_yaml
            .replace("title: Traffic", "title: Renamed");
        let preview = h.service.preview("workspace", &draft).await.unwrap();
        h.service
            .apply("workspace", draft, preview.token.unwrap())
            .await
            .unwrap();
        let catalog = h
            .service
            .catalog("workspace", ConfigScope::Device("one".into()))
            .await
            .unwrap();
        let page = h
            .service
            .widget_read(WidgetQuery {
                workspace_id: "workspace".into(),
                target_id: "one".into(),
                widget_id: "traffic".into(),
                offset: 0,
                limit: 1,
            })
            .await
            .unwrap();
        assert_eq!(page.revision, catalog.value.effective.revision);
        assert_ne!(page.revision, original.revision);
        assert_eq!(page.value.metadata.revision, original.revision);
        assert_eq!(page.value.metadata.generation, original.generation);
        assert_eq!(page.value.metadata.observed_at_ms, original.observed_at_ms);
        assert!(page.generation > original.generation);
        assert_eq!(page.value.metadata.state, CollectionState::Stopped);
        h.finish().await;
    }

    #[tokio::test]
    async fn equal_wall_time_preview_frames_join_exact_physical_samples_and_candidate_parsers() {
        let h = Harness::new();
        h.service.establish("workspace").await.unwrap();
        let catalog = h
            .service
            .catalog("workspace", ConfigScope::Profile(Platform::Iosxe))
            .await
            .unwrap();
        let target = TargetRef {
            connection_id: "one".into(),
            platform: Platform::Iosxe,
        };
        let request = CaptureRequest {
            command: CommandPolicy::admit(Platform::Iosxe, "show interfaces").unwrap(),
            parser_id: "test.interfaces".into(),
            revision: catalog.value.effective.revision,
        };
        let first = h
            .service
            .capture_sample("workspace", target.clone(), request.clone())
            .await
            .unwrap();
        h.probe.counter.store(200, Ordering::SeqCst);
        let second = h
            .service
            .capture_sample("workspace", target, request)
            .await
            .unwrap();
        assert_eq!(first.observed_at_ms, second.observed_at_ms);
        assert_ne!(first.capture_id, second.capture_id);
        assert_ne!(first.raw, second.raw);
        let mut draft = h.draft.clone();
        draft.widgets_yaml = serde_yaml::to_string(&WidgetDocument {
            schema_version: 1,
            widgets: catalog.value.effective.widgets.clone(),
        })
        .unwrap()
        .replace("test.interfaces", "candidate.interfaces");
        draft.templates.insert(
            "candidate.interfaces".into(),
            catalog.value.effective.templates["test.interfaces"]
                .text
                .clone(),
        );
        let report = h.service.preview("workspace", &draft).await.unwrap();
        assert!(report.token.is_some(), "{:?}", report.diagnostics);
        assert_eq!(report.captures.len(), 2);
        assert_eq!(report.interpretations.len(), 4);
        assert_eq!(report.frames.len(), 4);
        let wire = serde_json::to_value(&report).unwrap();
        let links = wire
            .get("frame_sources")
            .and_then(|value| value.as_array())
            .expect("Preview must explicitly link frames to samples; timestamps can collide");
        assert_eq!(links.len(), report.frames.len());
        let mut seen = BTreeSet::new();
        for link in links {
            let index = link["frame_index"].as_u64().unwrap() as usize;
            assert!(seen.insert(index));
            let source = &link["source"]["capture"];
            let capture_id = source["capture_id"].as_str().unwrap();
            let parser_id = source["parser_id"].as_str().unwrap();
            assert_eq!(
                parser_id,
                if report.frames[index].widget_id == "traffic" {
                    "candidate.interfaces"
                } else {
                    "test.other"
                }
            );
            let physical = report
                .captures
                .iter()
                .find(|capture| capture.capture_id == capture_id)
                .unwrap();
            assert_eq!(physical.parser_id, "test.interfaces");
            let parsed = report
                .interpretations
                .iter()
                .find(|parsed| parsed.capture_id == capture_id && parsed.parser_id == parser_id)
                .unwrap();
            let raw_value = physical.raw.split_whitespace().nth(1).unwrap().to_string();
            assert_eq!(
                parsed.rows[0].fields["bytes"],
                MetricValue::Text {
                    value: raw_value.clone()
                }
            );
            assert_eq!(
                report.frames[index].rows[0].fields["bytes"],
                if report.frames[index].widget_id == "traffic" {
                    MetricValue::Unsigned { value: raw_value }
                } else {
                    MetricValue::Text { value: raw_value }
                }
            );
        }
        assert_eq!(h.probe.calls.lock().len(), 2);
        h.finish().await;
    }

    #[test]
    fn checked_rebinding_changes_only_actual_parser_selection_and_refuses_forgery() {
        let h = Harness::new();
        let config = {
            let document: WidgetDocument = serde_yaml::from_str(&h.draft.widgets_yaml).unwrap();
            document.widgets[0].clone()
        };
        let original = TemplateAsset {
            id: "a".into(),
            platform: Platform::Iosxe,
            command: "show interfaces".into(),
            text: "text".into(),
            sha256: format!("{:x}", sha2::Sha256::digest(b"text")),
        };
        let mut alternate = original.clone();
        alternate.id = "b".into();
        let mut definition = config;
        if let WidgetSource::Ssh { templates, .. } = &mut definition.source {
            templates.insert(Platform::Iosxe, "b".into());
        }
        let mut effective = EffectiveConfig {
            revision: "actual-source".into(),
            widgets: vec![definition.clone()],
            layouts: vec![],
            templates: BTreeMap::from([("a".into(), original), ("b".into(), alternate)]),
        };
        let capture = Capture {
            capture_id: "physical".into(),
            target_id: "one".into(),
            platform: Platform::Iosxe,
            command: "show interfaces".into(),
            parser_id: "a".into(),
            revision: effective.revision.clone(),
            observed_at_ms: 10,
            monotonic_ms: 2,
            raw: "private raw".into(),
        };
        let derived = bind_capture(&capture, &effective, &definition, "one").unwrap();
        let mut expected = capture.clone();
        expected.parser_id = "b".into();
        assert_eq!(derived, expected);
        assert!(bind_capture(&capture, &effective, &definition, "other").is_err());
        effective.templates.get_mut("b").unwrap().sha256 = "forged".into();
        assert!(bind_capture(&capture, &effective, &definition, "one").is_err());
        h.service.shutdown_sync(Duration::from_secs(3)).unwrap();
    }

    #[tokio::test]
    async fn new_command_draft_capture_edits_replay_then_apply_without_start() {
        let h = Harness::new();
        h.service.establish("workspace").await.unwrap();
        let mut draft = h.draft.clone();
        draft.widgets_yaml = draft
            .widgets_yaml
            .replace("show interfaces", "show version")
            .replace("test.interfaces", "new.version");
        let template =
            "Value IFACE (\\S+)\nValue BYTES (\\d+)\n\nStart\n  ^${IFACE} ${BYTES}$$ -> Record\n";
        draft
            .templates
            .insert("new.version".into(), template.into());
        let target = TargetRef {
            connection_id: "one".into(),
            platform: Platform::Iosxe,
        };
        let capture = h
            .service
            .capture_draft_sample("workspace", target, &draft, "new.version")
            .await
            .unwrap();
        assert_eq!(capture.command, "show version");
        assert_eq!(capture.parser_id, "new.version");
        assert!(!h.service.snapshot("workspace").await.unwrap().running);
        draft.widgets_yaml = draft.widgets_yaml.replace("new.version", "edited.version");
        draft.templates.clear();
        draft
            .templates
            .insert("edited.version".into(), format!("{template}\n"));
        let report = h.service.preview("workspace", &draft).await.unwrap();
        assert!(report.token.is_some(), "{:?}", report.diagnostics);
        assert_eq!(h.probe.calls.lock().len(), 1);
        assert!(report
            .frames
            .iter()
            .all(|frame| frame.revision == capture.revision));
        let mut changed_command = draft.clone();
        changed_command.widgets_yaml = changed_command
            .widgets_yaml
            .replace("show version", "show inventory");
        assert!(h
            .service
            .preview("workspace", &changed_command)
            .await
            .unwrap()
            .token
            .is_none());
        let report = h.service.preview("workspace", &draft).await.unwrap();
        h.service
            .apply("workspace", draft, report.token.unwrap())
            .await
            .unwrap();
        assert_eq!(h.probe.calls.lock().len(), 1);
        h.finish().await;
    }

    #[tokio::test]
    async fn stalled_real_publication_keeps_local_and_stop_responsive_and_fences_old_reply() {
        struct Release(Arc<(AtomicBool, AtomicBool)>);
        impl Drop for Release {
            fn drop(&mut self) {
                self.0 .1.store(true, Ordering::SeqCst);
            }
        }
        let h = Harness::new();
        h.start(&["one", "slow"], true).await;
        h.wait(|s| s.widgets.len() == 5).await;
        let mut draft = h.draft.clone();
        draft.widgets_yaml = draft
            .widgets_yaml
            .replace("title: Traffic", "title: Updated");
        let preview = h.service.preview("workspace", &draft).await.unwrap();
        let token = preview.token.unwrap();
        h.probe.hold.store(true, Ordering::SeqCst);
        h.probe.ignore_cancel.store(true, Ordering::SeqCst);
        h.clock.advance(Duration::from_secs(5));
        tokio::time::timeout(Duration::from_secs(2), async {
            while h
                .probe
                .calls
                .lock()
                .iter()
                .filter(|(id, _)| id == "slow")
                .count()
                < 2
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        h.publication_pause.1.store(false, Ordering::SeqCst);
        let release = Release(h.publication_pause.clone());
        let service = h.service.clone();
        let publication =
            tokio::spawn(async move { service.apply("workspace", draft, token).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !h.publication_pause.0.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let before =
            tokio::time::timeout(Duration::from_millis(500), h.service.snapshot("workspace"))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            h.service
                .catalog("workspace", ConfigScope::Local)
                .await
                .unwrap_err()
                .code,
            "config_busy"
        );
        assert_eq!(
            h.service
                .validate("workspace", h.draft.clone())
                .await
                .unwrap_err()
                .code,
            "config_busy"
        );
        assert_eq!(
            h.service
                .import("workspace", ConfigScope::Local, "widget: x".into())
                .await
                .unwrap_err()
                .code,
            "config_busy"
        );
        assert_eq!(
            h.service
                .reset(
                    "workspace",
                    ConfigScope::Local,
                    ResetAsset::Widget("x".into())
                )
                .await
                .unwrap_err()
                .code,
            "config_busy"
        );
        assert_eq!(
            tokio::time::timeout(
                Duration::from_millis(500),
                h.service.preview("workspace", &h.draft)
            )
            .await
            .unwrap()
            .unwrap_err()
            .code,
            "config_busy"
        );
        let local_calls = h.probe.local_calls.load(Ordering::SeqCst);
        h.clock.advance(Duration::from_secs(2));
        tokio::time::timeout(Duration::from_secs(2), async {
            while h.probe.local_calls.load(Ordering::SeqCst) == local_calls {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        h.probe.release.notify_one();
        let service = h.service.clone();
        let stopped = tokio::spawn(async move { service.stop("workspace").await });
        h.wait(|s| !s.running).await;
        let after = h.service.snapshot("workspace").await.unwrap();
        assert_eq!(
            before
                .series
                .iter()
                .filter(|s| s.target_id == "slow")
                .map(|s| s.point_count)
                .sum::<u32>(),
            after
                .series
                .iter()
                .filter(|s| s.target_id == "slow")
                .map(|s| s.point_count)
                .sum::<u32>()
        );
        drop(release);
        publication.await.unwrap().unwrap();
        stopped.await.unwrap().unwrap();
        h.finish().await;
    }

    #[tokio::test]
    async fn invalid_cross_workspace_start_preserves_the_previous_stopped_selection() {
        let h = Harness::new();
        h.start(&["one"], false).await;
        h.wait(|s| s.widgets.len() == 2).await;
        h.service.establish("second").await.unwrap();
        let request = StartRequest {
            workspace_id: "second".into(),
            targets: vec![TargetRef {
                connection_id: "one".into(),
                platform: Platform::Ios,
            }],
            local_enabled: false,
            monitored_interfaces: BTreeMap::new(),
        };
        assert!(h.service.start(request).await.is_err());
        let second = h.service.snapshot("second").await.unwrap();
        assert!(!second.running);
        assert!(second.targets.is_empty());
        assert!(h.service.snapshot("workspace").await.unwrap().running);
        h.finish().await;
    }

    #[tokio::test]
    async fn latest_rows_page_at_one_thousand_and_series_limit_stays_visible() {
        let h = Harness::new();
        h.probe.local_rows.store(2005, Ordering::SeqCst);
        h.start(&[], true).await;
        h.wait(|s| s.widgets.len() == 1).await;
        let query = |offset| WidgetQuery {
            workspace_id: "workspace".into(),
            target_id: "local".into(),
            widget_id: "local_traffic".into(),
            offset,
            limit: 5000,
        };
        let first = h.service.widget(query(0)).await.unwrap();
        assert_eq!(first.metadata.row_count, 2005);
        assert_eq!(first.rows.len(), 1000);
        assert_eq!(first.next_offset, Some(1000));
        let second = h.service.widget(query(1000)).await.unwrap();
        assert_eq!(second.rows.len(), 1000);
        assert_eq!(second.next_offset, Some(2000));
        let last = h.service.widget(query(2000)).await.unwrap();
        assert_eq!(last.rows.len(), 5);
        assert_eq!(last.next_offset, None);
        let snapshot = h.service.snapshot("workspace").await.unwrap();
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|d| d.code == "history_series_limit"));
        assert!(snapshot.series.is_empty());
        h.finish().await;
    }

    #[tokio::test]
    async fn rollback_keeps_exact_latest_and_recovery_starts_with_a_gap() {
        let h = Harness::new();
        h.probe.counter.store(u64::MAX - 2, Ordering::SeqCst);
        h.start(&[], true).await;
        h.wait(|s| s.widgets.len() == 1).await;
        h.probe.counter.store(u64::MAX, Ordering::SeqCst);
        h.clock.advance(Duration::from_secs(2));
        h.wait(|s| s.widgets[0].observed_at_ms == 1_002_000).await;
        let query = || WidgetQuery {
            workspace_id: "workspace".into(),
            target_id: "local".into(),
            widget_id: "local_traffic".into(),
            offset: 0,
            limit: 10,
        };
        assert_eq!(
            h.service.widget(query()).await.unwrap().rows[0].fields["rate"],
            MetricValue::Number { value: 1.0 }
        );
        let before = h.service.snapshot("workspace").await.unwrap();
        h.clock.0.time.lock().as_mut().unwrap().wall_ms = 1_000_000;
        h.clock.advance(Duration::from_secs(2));
        let after = h.wait(|s| s.sequence > before.sequence).await;
        assert!(after.diagnostics.iter().any(|d| d.code == "history_clock"));
        assert_eq!(after.series[0].point_count, before.series[0].point_count);
        assert_eq!(
            h.service.widget(query()).await.unwrap().rows[0].fields["bytes"],
            MetricValue::Unsigned {
                value: u64::MAX.to_string()
            }
        );
        assert_eq!(after.targets[0].state, CollectionState::Fresh);
        h.clock.0.time.lock().as_mut().unwrap().wall_ms = 1_010_000;
        h.clock.advance(Duration::from_secs(2));
        h.wait(|s| s.widgets[0].observed_at_ms == 1_012_000).await;
        assert!(matches!(
            h.service.widget(query()).await.unwrap().rows[0].fields["rate"],
            MetricValue::Missing { .. }
        ));
        h.finish().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn actual_local_sampler_closes_without_callers_runtime_progress() {
        let directory = tempfile::tempdir().unwrap();
        let parser = Arc::new(TelemetryParser::new());
        let catalog = Catalog::builtin().unwrap();
        let mut memory = catalog.widgets["local_memory"].clone();
        memory.title = "Edited memory".into();
        let mut processes = catalog.widgets["local_processes"].clone();
        processes.title = "Edited processes".into();
        let repository =
            TelemetryConfigRepository::load(directory.path().into(), catalog, parser.clone())
                .unwrap();
        let mut draft = ConfigDraft {
            scope: ConfigScope::Local,
            widgets_yaml: serde_yaml::to_string(&WidgetDocument {
                schema_version: 1,
                widgets: vec![memory],
            })
            .unwrap(),
            layouts_yaml: "schema_version: 1\nlayouts: []\n".into(),
            templates: BTreeMap::new(),
            expected_revision: repository.base_revision(),
            reset_assets: vec![],
        };
        let mut process_draft = draft.clone();
        process_draft.widgets_yaml = serde_yaml::to_string(&WidgetDocument {
            schema_version: 1,
            widgets: vec![processes],
        })
        .unwrap();
        let service = TelemetryService::new(
            repository,
            LocalCollectorFactory::default(),
            TelemetrySshFactory::fixture(|_| panic!("local-only start resolved SSH")),
            parser,
            TelemetryClock::default(),
        );
        service.establish("native-local").await.unwrap();
        service
            .start(StartRequest {
                workspace_id: "native-local".into(),
                targets: vec![],
                local_enabled: true,
                monitored_interfaces: BTreeMap::new(),
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = service.snapshot("native-local").await.unwrap();
                if snapshot
                    .widgets
                    .iter()
                    .any(|w| w.widget_id == "local_memory" && w.row_count > 0)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let process_report = service
            .preview("native-local", &process_draft)
            .await
            .unwrap();
        let diagnostics = service
            .request(|reply| Request::LocalDiagnostics("native-local".into(), reply))
            .await
            .unwrap();
        assert!(
            process_report.token.is_some(),
            "Native process Preview rejected: {:?}; sample codes/paths: {:?}",
            process_report.diagnostics,
            diagnostics
                .iter()
                .map(|d| (&d.code, &d.path))
                .collect::<Vec<_>>()
        );
        let result = service
            .apply("native-local", process_draft, process_report.token.unwrap())
            .await
            .unwrap();
        draft.expected_revision = result.revision;
        let report = service.preview("native-local", &draft).await.unwrap();
        let diagnostics = service
            .request(|reply| Request::LocalDiagnostics("native-local".into(), reply))
            .await
            .unwrap();
        assert!(
            report.token.is_some(),
            "Native Local Preview rejected: {:?}; sample codes/paths: {:?}",
            report.diagnostics,
            diagnostics
                .iter()
                .map(|d| (&d.code, &d.path))
                .collect::<Vec<_>>()
        );
        service
            .apply("native-local", draft, report.token.unwrap())
            .await
            .unwrap();
        service.shutdown_sync(Duration::from_secs(3)).unwrap();
    }

    #[tokio::test]
    async fn coalesced_fastest_schedule_owns_sleep_gap_threshold() {
        let h = Harness::new();
        h.start(&["one"], false).await;
        h.wait(|s| s.widgets.len() == 2).await;
        h.probe.counter.store(200, Ordering::SeqCst);
        h.clock.advance(Duration::from_secs(5));
        h.wait(|s| s.widgets.iter().all(|w| w.observed_at_ms == 1_005_000))
            .await;
        h.probe.counter.store(300, Ordering::SeqCst);
        h.clock.advance(Duration::from_secs(60));
        h.wait(|s| s.widgets.iter().all(|w| w.observed_at_ms == 1_065_000))
            .await;
        let page = h
            .service
            .widget(WidgetQuery {
                workspace_id: "workspace".into(),
                target_id: "one".into(),
                widget_id: "traffic".into(),
                offset: 0,
                limit: 10,
            })
            .await
            .unwrap();
        assert!(matches!(
            page.rows[0].fields["rate"],
            MetricValue::Missing { .. }
        ));
        h.finish().await;
    }

    #[tokio::test]
    async fn slow_selected_interval_replaces_ordinary_interval_without_a_faster_widget() {
        let h = Harness::configured(|catalog| {
            catalog.widgets.remove("fast");
            catalog
                .widgets
                .get_mut("traffic")
                .unwrap()
                .selected_interval = Some(120);
        });
        h.service.establish("workspace").await.unwrap();
        h.service
            .start(StartRequest {
                workspace_id: "workspace".into(),
                targets: vec![TargetRef {
                    connection_id: "one".into(),
                    platform: Platform::Iosxe,
                }],
                local_enabled: false,
                monitored_interfaces: BTreeMap::from([("one".into(), vec!["Gi1".into()])]),
            })
            .await
            .unwrap();
        h.wait(|s| s.widgets.len() == 1).await;
        h.clock.advance(Duration::from_secs(119));
        h.service.snapshot("workspace").await.unwrap();
        assert_eq!(h.probe.calls.lock().len(), 1);
        h.clock.advance(Duration::from_secs(1));
        h.wait(|s| s.widgets[0].observed_at_ms == 1_120_000).await;
        assert_eq!(h.probe.calls.lock().len(), 2);
        h.finish().await;
    }

    #[tokio::test]
    async fn combined_raw_latest_history_budget_is_bounded_and_snapshot_has_no_raw() {
        let h = Harness::new();
        *h.probe.raw_tail.lock() = format!("PRIVATE-RAW-ONLY{}\n", "x".repeat(1024 * 1024));
        h.start(
            &[
                "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
            ],
            false,
        )
        .await;
        h.wait(|s| s.widgets.len() == 20).await;
        h.clock.advance(Duration::from_secs(5));
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = h.service.snapshot("workspace").await.unwrap();
                if snapshot
                    .diagnostics
                    .iter()
                    .any(|d| d.code == "workspace_memory_limit")
                {
                    break snapshot;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let snapshot = match result {
            Ok(snapshot) => snapshot,
            Err(_) => {
                let bytes = h
                    .service
                    .request(|reply| Request::RetainedBytes("workspace".into(), reply))
                    .await
                    .unwrap();
                let snapshot = h.service.snapshot("workspace").await.unwrap();
                panic!("memory admission diagnostic missing: bytes={bytes}, captures={}, widget_states={:?}, diagnostics={:?}", h.probe.calls.lock().len(),
                snapshot.widgets.iter().map(|w| (&w.target_id, w.state)).collect::<Vec<_>>(), snapshot.diagnostics);
            }
        };
        let bytes = h
            .service
            .request(|reply| Request::RetainedBytes("workspace".into(), reply))
            .await
            .unwrap();
        assert!(bytes <= 64 * 1024 * 1024);
        assert!(bytes > 32 * 1024 * 1024);
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("PRIVATE-RAW-ONLY"));
        assert!(h
            .service
            .request(|reply| Request::QuotaParity("workspace".into(), reply))
            .await
            .unwrap());
        tokio::time::timeout(Duration::from_millis(500), h.service.snapshot("workspace"))
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), h.service.stop("workspace"))
            .await
            .unwrap()
            .unwrap();
        h.finish().await;
    }

    #[tokio::test]
    async fn fully_masked_device_keeps_effective_revision_and_history_during_profile_apply() {
        let h = Harness::new();
        h.start(&["one", "two"], false).await;
        h.wait(|s| s.widgets.len() == 4).await;
        let mut device = h.draft.clone();
        device.scope = ConfigScope::Device("one".into());
        device.widgets_yaml = device
            .widgets_yaml
            .replace("title: Traffic", "title: Device");
        let report = h.service.preview("workspace", &device).await.unwrap();
        let result = h
            .service
            .apply("workspace", device, report.token.unwrap())
            .await
            .unwrap();
        h.wait(|s| {
            s.widgets
                .iter()
                .find(|w| w.target_id == "one" && w.widget_id == "traffic")
                .is_some_and(|w| w.generation == s.generation)
        })
        .await;
        let before = h.service.snapshot("workspace").await.unwrap();
        let mut profile = h.draft.clone();
        profile.expected_revision = result.revision;
        profile.widgets_yaml = profile
            .widgets_yaml
            .replace("title: Traffic", "title: Profile");
        let report = h.service.preview("workspace", &profile).await.unwrap();
        assert!(report.token.is_some(), "{:?}", report.diagnostics);
        let result = h
            .service
            .apply("workspace", profile, report.token.unwrap())
            .await
            .unwrap();
        assert!(!result.affected_targets.contains(&"one".to_string()));
        assert!(result.affected_targets.contains(&"two".to_string()));
        assert!(result.masked_device_overrides.contains(&"one".to_string()));
        let after = h.service.snapshot("workspace").await.unwrap();
        let old = before
            .widgets
            .iter()
            .find(|w| w.target_id == "one" && w.widget_id == "traffic")
            .unwrap();
        let retained = after
            .widgets
            .iter()
            .find(|w| w.target_id == "one" && w.widget_id == "traffic")
            .unwrap();
        assert_eq!(old.revision, retained.revision);
        assert_eq!(
            before
                .series
                .iter()
                .filter(|s| s.target_id == "one")
                .map(|s| s.point_count)
                .sum::<u32>(),
            after
                .series
                .iter()
                .filter(|s| s.target_id == "one")
                .map(|s| s.point_count)
                .sum::<u32>()
        );
        h.finish().await;
    }

    #[tokio::test]
    async fn pending_close_refuses_new_work_and_late_start_never_recreates_ownership() {
        struct Release(Arc<Probe>);
        impl Drop for Release {
            fn drop(&mut self) {
                self.0.local_hold.store(false, Ordering::SeqCst);
            }
        }
        let h = Harness::new();
        h.probe.local_hold.store(true, Ordering::SeqCst);
        let release = Release(h.probe.clone());
        h.start(&[], true).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while h.probe.local_calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let service = h.service.clone();
        let close = tokio::spawn(async move { service.close("workspace").await });
        h.wait(|s| !s.running).await;
        assert_eq!(
            h.service.establish("workspace").await.unwrap_err().code,
            "cleanup_pending"
        );
        let request = StartRequest {
            workspace_id: "workspace".into(),
            targets: vec![],
            local_enabled: true,
            monitored_interfaces: BTreeMap::new(),
        };
        assert_eq!(
            h.service.start(request.clone()).await.unwrap_err().code,
            "cleanup_pending"
        );
        drop(release);
        close.await.unwrap().unwrap();
        assert_eq!(
            h.service.start(request).await.unwrap_err().code,
            "workspace_unknown"
        );
        assert_eq!(
            h.service
                .preview("workspace", &h.draft)
                .await
                .unwrap_err()
                .code,
            "workspace_unknown"
        );
        let sample = CaptureRequest {
            command: CommandPolicy::admit(Platform::Iosxe, "show interfaces").unwrap(),
            parser_id: "test.interfaces".into(),
            revision: "obsolete".into(),
        };
        assert_eq!(
            h.service
                .capture_sample(
                    "workspace",
                    TargetRef {
                        connection_id: "one".into(),
                        platform: Platform::Iosxe
                    },
                    sample
                )
                .await
                .unwrap_err()
                .code,
            "workspace_unknown"
        );
        assert!(!h.service.establish("workspace").await.unwrap().running);
        h.finish().await;
    }

    #[tokio::test]
    async fn quota_cache_preserves_encoded_escapes_and_replacement_charges() {
        let h = Harness::new();
        *h.probe.raw_tail.lock() = "private\t\n\u{0}\\\"ß\n".into();
        h.start(&["one"], false).await;
        h.wait(|s| s.widgets.len() == 2).await;
        for at in [1_000_000, 1_005_000, 1_010_000] {
            h.wait(|s| s.widgets.iter().all(|w| w.observed_at_ms == at))
                .await;
            assert!(h
                .service
                .request(|reply| Request::QuotaParity("workspace".into(), reply))
                .await
                .unwrap());
            h.clock.advance(Duration::from_secs(5));
        }
        h.finish().await;
    }
    #[tokio::test]
    async fn stopped_authoring_retains_sampler_until_explicit_stop_acknowledgement() {
        let h = Harness::new();
        h.service.establish("workspace").await.unwrap();
        let mut draft = h.draft.clone();
        draft.scope = ConfigScope::Local;
        draft.widgets_yaml = "schema_version: 1\nwidgets: []\n".into();
        h.service.preview("workspace", &draft).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        h.clock.advance(Duration::from_secs(2));
        h.service.preview("workspace", &draft).await.unwrap();
        assert_eq!(h.probe.local_factories.load(Ordering::SeqCst), 1);
        assert_eq!(h.probe.local_calls.load(Ordering::SeqCst), 2);
        h.service.stop("workspace").await.unwrap();
        h.clock.advance(Duration::from_secs(2));
        h.service.preview("workspace", &draft).await.unwrap();
        assert_eq!(h.probe.local_factories.load(Ordering::SeqCst), 2);
        h.finish().await;
    }
    #[tokio::test]
    async fn pending_parser_reap_blocks_ack_without_stopping_another_workspace() {
        let script = "import sys,json,time\nfor line in sys.stdin:\n r=json.loads(line)\n if r['capture']['target_id']=='blocked': time.sleep(60)\n print(json.dumps({'id':r['id'],'headers':['iface','bytes'],'records':[['eth0','100']]}),flush=True)\n";
        let mut parser = TelemetryParser::fixture(script, Duration::from_millis(500));
        parser.set_cleanup_budget_for_test(Duration::from_millis(50));
        let parser = Arc::new(parser);
        parser.block_cleanup_for_test(true);
        struct Release(Arc<TelemetryParser>);
        impl Drop for Release {
            fn drop(&mut self) {
                self.0.block_cleanup_for_test(false);
            }
        }
        let release = Release(parser.clone());
        let h = Harness::with_parser(parser.clone(), |catalog| {
            catalog.widgets.remove("fast");
        });
        h.start(&["blocked"], false).await;
        h.wait(|s| {
            s.widgets.iter().any(|w| {
                w.diagnostics
                    .iter()
                    .any(|d| d.code == "parser_cleanup_pending")
            })
        })
        .await;
        h.service.establish("second").await.unwrap();
        h.service
            .start(StartRequest {
                workspace_id: "second".into(),
                targets: vec![TargetRef {
                    connection_id: "healthy".into(),
                    platform: Platform::Iosxe,
                }],
                local_enabled: true,
                monitored_interfaces: BTreeMap::new(),
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while h.service.snapshot("second").await.unwrap().widgets.len() != 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(h
            .service
            .snapshot("second")
            .await
            .unwrap()
            .widgets
            .iter()
            .all(|widget| widget.state == CollectionState::Fresh));
        assert_eq!(
            h.service.stop("workspace").await.unwrap_err().code,
            "cleanup_pending"
        );
        let calls = h.probe.local_calls.load(Ordering::SeqCst);
        h.clock.advance(Duration::from_secs(2));
        tokio::time::timeout(Duration::from_secs(2), async {
            while h.probe.local_calls.load(Ordering::SeqCst) == calls {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(h.service.snapshot("second").await.unwrap().running);
        drop(release);
        h.service.stop("workspace").await.unwrap();
        h.finish().await;
    }
    #[tokio::test]
    async fn constructor_refuses_separate_parser_owners() {
        let directory = tempfile::tempdir().unwrap();
        let repository = TelemetryConfigRepository::load(
            directory.path().into(),
            Catalog::default(),
            Arc::new(TelemetryParser::new()),
        )
        .unwrap();
        let service = TelemetryService::new(
            repository,
            LocalCollectorFactory::default(),
            TelemetrySshFactory::fixture(|_| panic!("no collection requested")),
            Arc::new(TelemetryParser::new()),
            TelemetryClock::default(),
        );
        assert_eq!(
            service.establish("workspace").await.unwrap_err().code,
            "parser_owner"
        );
        assert_eq!(
            service
                .shutdown_sync(Duration::from_secs(3))
                .unwrap_err()
                .code,
            "parser_owner"
        );
    }
}
