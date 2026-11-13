//! Two lazy, telemetry-owned workers; no shared AI sidecar or Unix process owner.
//! Keep the owning runtime alive through shutdown (including Drop-triggered cleanup).
use super::{
    definition::MAX_TEMPLATE_BYTES,
    model::{Capture, Diagnostic, MetricRow, MetricValue, TemplateAsset},
};
use serde::{
    ser::{SerializeMap, SerializeSeq},
    Deserialize, Serialize,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot, Mutex, Notify},
    task::JoinHandle,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

const MAX_CAPTURE: usize = 2 * 1024 * 1024;
const MAX_REQUEST: usize = 16 * 1024 * 1024;
pub(crate) const MAX_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_ROWS: usize = 10_000;
type ParseResult = Result<Vec<MetricRow>, Diagnostic>;
type OutputAdmission = Box<dyn Fn(&PendingRows) -> Result<(), Diagnostic> + Send + Sync>;

fn failure(code: &str, message: &str) -> Diagnostic {
    Diagnostic::new(code, message, "parser")
}

/// Construction does not spawn a process or require a Tokio runtime.
/// `parse` and `test_template` require the telemetry owner runtime; `shutdown`
/// cancels admission, terminates each worker and joins its cleanup task.
pub struct TelemetryParser {
    spec: WorkerSpec,
    pool: Mutex<Pool>,
    stop: CancellationToken,
    sequence: AtomicU64,
    timeout: Duration,
    cleanup_budget: Duration,
    draining: AtomicBool,
    admission: Arc<StdMutex<Admission>>,
    available: Arc<Notify>,
}

#[derive(Default)]
struct Pool {
    senders: Vec<mpsc::Sender<Job>>,
    owners: Vec<JoinHandle<()>>,
    stop: CancellationToken,
}

#[derive(Default)]
struct Admission {
    epoch: u64,
    busy: [bool; 2],
    pending_cleanup: [bool; 2],
    preview_active: bool,
    preview_waiting: usize,
    collection_waiting: usize,
}
#[derive(Clone, Copy)]
enum Priority {
    Collection,
    Preview,
}
struct AdmissionGuard {
    state: Arc<StdMutex<Admission>>,
    available: Arc<Notify>,
    priority: Priority,
    slot: Option<usize>,
    epoch: u64,
}
impl AdmissionGuard {
    fn mark_cleanup_pending(&self) {
        let mut state = self.state.lock().unwrap();
        if state.epoch == self.epoch {
            if let Some(slot) = self.slot {
                if state.busy[slot] {
                    state.pending_cleanup[slot] = true;
                }
            }
        }
    }
}
impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        if state.epoch != self.epoch {
            return;
        }
        if let Some(slot) = self.slot {
            state.busy[slot] = false;
            state.pending_cleanup[slot] = false;
            if matches!(self.priority, Priority::Preview) {
                state.preview_active = false;
            }
        } else {
            match self.priority {
                Priority::Preview => state.preview_waiting -= 1,
                Priority::Collection => state.collection_waiting -= 1,
            }
        }
        self.available.notify_waiters();
    }
}

struct Job {
    id: String,
    payload: Vec<u8>,
    deadline: Instant,
    cancel: CancellationToken,
    reply: oneshot::Sender<ParseResult>,
    // Keep the claim until request buffers and rejected replies have been destroyed.
    output_admission: Option<OutputAdmission>,
}

struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl Default for TelemetryParser {
    fn default() -> Self {
        Self::new()
    }
}

impl TelemetryParser {
    pub fn new() -> Self {
        Self {
            spec: WorkerSpec::default(),
            pool: Mutex::new(Pool::default()),
            stop: CancellationToken::new(),
            sequence: AtomicU64::new(0),
            timeout: Duration::from_secs(3),
            cleanup_budget: Duration::from_secs(3),
            draining: AtomicBool::new(false),
            admission: Arc::new(StdMutex::new(Admission::default())),
            available: Arc::new(Notify::new()),
        }
    }

    pub async fn parse(
        &self,
        capture: &Capture,
        template: &TemplateAsset,
        cancel: CancellationToken,
    ) -> ParseResult {
        self.parse_priority(capture, template, cancel, Priority::Collection, None)
            .await
    }

    pub(crate) async fn parse_preview(
        &self,
        capture: &Capture,
        template: &TemplateAsset,
        cancel: CancellationToken,
    ) -> ParseResult {
        self.parse_priority(capture, template, cancel, Priority::Preview, None)
            .await
    }

    async fn admit(
        &self,
        priority: Priority,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<AdmissionGuard, Diagnostic> {
        let mut guard = {
            let mut state = self.admission.lock().unwrap();
            let full = match priority {
                Priority::Preview => state.preview_waiting >= 1,
                Priority::Collection => state.collection_waiting >= 4,
            };
            if full {
                return Err(failure(
                    "parser_busy",
                    "Parser admission is full; retry after current work completes",
                ));
            }
            match priority {
                Priority::Preview => state.preview_waiting += 1,
                Priority::Collection => state.collection_waiting += 1,
            }
            AdmissionGuard {
                state: self.admission.clone(),
                available: self.available.clone(),
                priority,
                slot: None,
                epoch: state.epoch,
            }
        };
        loop {
            let available = self.available.notified();
            tokio::pin!(available);
            available.as_mut().enable();
            if self.stop.is_cancelled() {
                return Err(failure("parser_shutdown", "Parser is shut down"));
            }
            if self.draining.load(Ordering::Acquire) {
                return Err(failure(
                    "parser_quiescing",
                    "Parser cleanup is pending; retry after quiescence",
                ));
            }
            if cancel.is_cancelled() {
                return Err(failure("parser_cancelled", "Parsing was cancelled"));
            }
            {
                let mut state = self.admission.lock().unwrap();
                if state.epoch != guard.epoch {
                    return Err(failure(
                        "parser_quiescing",
                        "Parser pool generation changed during admission",
                    ));
                }
                let free = state.busy.iter().filter(|busy| !**busy).count();
                let ready = match priority {
                    Priority::Preview => !state.preview_active && free > 0,
                    Priority::Collection => {
                        free > 0
                            && (state.preview_waiting == 0 || state.preview_active || free == 2)
                    }
                };
                if ready {
                    let slot = state.busy.iter().position(|busy| !*busy).unwrap();
                    state.busy[slot] = true;
                    match priority {
                        Priority::Preview => {
                            state.preview_waiting -= 1;
                            state.preview_active = true;
                        }
                        Priority::Collection => state.collection_waiting -= 1,
                    }
                    guard.slot = Some(slot);
                    return Ok(guard);
                }
            }
            tokio::select! {
                _ = self.stop.cancelled() => {}, _ = cancel.cancelled() => {}, _ = &mut available => {},
                _ = tokio::time::sleep_until(deadline) => return Err(failure("parser_timeout", "Parser admission deadline exceeded")),
            }
        }
    }

    async fn parse_priority(
        &self,
        capture: &Capture,
        template: &TemplateAsset,
        cancel: CancellationToken,
        priority: Priority,
        output_admission: Option<OutputAdmission>,
    ) -> ParseResult {
        let deadline = Instant::now() + self.timeout;
        validate_binding(capture, template)?;
        if self.stop.is_cancelled() {
            return Err(failure("parser_shutdown", "Parser is shut down"));
        }
        if cancel.is_cancelled() {
            return Err(failure("parser_cancelled", "Parsing was cancelled"));
        }
        let admission = self.admit(priority, &cancel, deadline).await?;
        let ordinal = self.sequence.fetch_add(1, Ordering::Relaxed);
        let id = ordinal.to_string();
        let mut payload = serde_json::to_vec(&serde_json::json!({
            "id": id, "operation": "parse", "capture": capture, "template": template
        }))
        .map_err(|_| failure("parser_protocol", "Cannot encode parser request"))?;
        payload.push(b'\n');
        if payload.len() > MAX_REQUEST {
            return Err(failure("parser_limit", "Parser request exceeds its limit"));
        }
        let sender = {
            let mut pool = self.pool.lock().await;
            if self.stop.is_cancelled() {
                return Err(failure("parser_shutdown", "Parser is shut down"));
            }
            if self.draining.load(Ordering::Acquire) {
                return Err(failure(
                    "parser_quiescing",
                    "Parser cleanup is pending; retry after quiescence",
                ));
            }
            if pool.senders.is_empty() {
                // Tasks own only their channels/spec/token, never the parser itself.
                for _ in 0..2 {
                    let (tx, rx) = mpsc::channel(1);
                    pool.senders.push(tx);
                    let stop = pool.stop.clone();
                    pool.owners
                        .push(tokio::spawn(owner(rx, self.spec.clone(), stop)));
                }
            }
            pool.senders[admission.slot.unwrap()].clone()
        };
        let local_cancel = cancel.child_token();
        let _guard = CancelOnDrop(local_cancel.clone());
        let (reply, mut receive) = oneshot::channel();
        let job = Job {
            id,
            payload,
            deadline,
            cancel: local_cancel.clone(),
            reply,
            output_admission,
        };
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => return Err(failure("parser_shutdown", "Parser is shut down")),
            _ = cancel.cancelled() => return Err(failure("parser_cancelled", "Parsing was cancelled")),
            _ = tokio::time::sleep_until(deadline) => return Err(failure("parser_timeout", "Parser deadline exceeded")),
            result = sender.send(job) => result.map_err(|_| failure("parser_shutdown", "Parser owner exited"))?,
        }
        // A reply acknowledges cleanup; a budget expiry leaves the actor owning the Child.
        let reason = tokio::select! {
            biased;
            _ = self.stop.cancelled() => failure("parser_shutdown", "Parser is shut down"),
            _ = cancel.cancelled() => failure("parser_cancelled", "Parsing was cancelled"),
            _ = tokio::time::sleep_until(deadline) => failure("parser_timeout", "Parser deadline exceeded"),
            result = &mut receive => return result.unwrap_or_else(|_| Err(failure("parser_shutdown", "Parser owner exited"))),
        };
        local_cancel.cancel();
        match tokio::time::timeout(self.cleanup_budget, &mut receive).await {
            Ok(_) => Err(reason),
            Err(_) => {
                // Keep this actor unavailable until its actual cleanup acknowledgement.
                admission.mark_cleanup_pending();
                tokio::spawn(async move {
                    let _ = receive.await;
                    drop(admission);
                });
                Err(failure(
                    "parser_cleanup_pending",
                    "Parser cleanup is pending; retry shutdown",
                ))
            }
        }
    }

    pub(crate) fn has_pending_cleanup(&self) -> bool {
        self.admission
            .lock()
            .unwrap()
            .pending_cleanup
            .iter()
            .any(|pending| *pending)
    }

    pub async fn test_template(
        &self,
        capture: &Capture,
        template: &TemplateAsset,
        cancel: CancellationToken,
    ) -> ParseResult {
        self.parse_preview(capture, template, cancel).await
    }

    pub(crate) async fn parse_preview_admitted(
        &self,
        capture: &Capture,
        template: &TemplateAsset,
        cancel: CancellationToken,
        admit: impl Fn(&PendingRows) -> Result<(), Diagnostic> + Send + Sync + 'static,
    ) -> ParseResult {
        self.parse_priority(
            capture,
            template,
            cancel,
            Priority::Preview,
            Some(Box::new(admit)),
        )
        .await
    }

    pub(crate) async fn parse_admitted(
        &self,
        capture: &Capture,
        template: &TemplateAsset,
        cancel: CancellationToken,
        admit: impl Fn(&PendingRows) -> Result<(), Diagnostic> + Send + Sync + 'static,
    ) -> ParseResult {
        self.parse_priority(
            capture,
            template,
            cancel,
            Priority::Collection,
            Some(Box::new(admit)),
        )
        .await
    }

    pub async fn shutdown(&self) -> Result<(), Diagnostic> {
        self.stop.cancel();
        self.drain().await
    }

    pub async fn quiesce(&self) -> Result<(), Diagnostic> {
        self.drain().await
    }

    async fn drain(&self) -> Result<(), Diagnostic> {
        self.draining.store(true, Ordering::Release);
        self.available.notify_waiters();
        tokio::time::timeout(self.cleanup_budget, async {
            let mut pool = self.pool.lock().await;
            pool.stop.cancel();
            pool.senders.clear();
            // Pending handles survive timeout; later calls await these same owners.
            while let Some(owner) = pool.owners.last_mut() {
                let _ = owner.await;
                pool.owners.pop();
            }
            pool.stop = CancellationToken::new();
            let mut admission = self.admission.lock().unwrap();
            *admission = Admission {
                epoch: admission.epoch.wrapping_add(1),
                ..Admission::default()
            };
            self.draining.store(false, Ordering::Release);
            self.available.notify_waiters();
        })
        .await
        .map_err(|_| {
            failure(
                "parser_cleanup_pending",
                "Parser cleanup is pending; retry shutdown",
            )
        })
    }
}

impl Drop for TelemetryParser {
    fn drop(&mut self) {
        self.stop.cancel();
        self.pool.get_mut().stop.cancel();
    }
}

pub(crate) fn validate_binding(
    capture: &Capture,
    template: &TemplateAsset,
) -> Result<(), Diagnostic> {
    if capture.raw.len() > MAX_CAPTURE || template.text.len() > MAX_TEMPLATE_BYTES {
        return Err(failure(
            "parser_limit",
            "Capture or template exceeds its limit",
        ));
    }
    let name_valid = !template.id.is_empty()
        && template.id.len() <= 128
        && template
            .id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'));
    let identities = [
        &capture.capture_id,
        &capture.target_id,
        &capture.revision,
        &capture.command,
        &capture.parser_id,
    ];
    if !name_valid
        || identities
            .iter()
            .any(|value| value.is_empty() || value.len() > 512)
        || capture.observed_at_ms < 0
        || capture.parser_id != template.id
        || capture.platform != template.platform
        || capture.command != template.command
        || template.sha256 != format!("{:x}", Sha256::digest(template.text.as_bytes()))
    {
        return Err(failure(
            "parser_binding",
            "Capture and template metadata do not match",
        ));
    }
    Ok(())
}

#[derive(Clone, Default)]
struct WorkerSpec {
    #[cfg(test)]
    script: Option<String>,
    #[cfg(test)]
    started: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    exited: Arc<std::sync::Mutex<Vec<(u32, std::process::ExitStatus)>>>,
    #[cfg(test)]
    wait_blocked: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(test)]
    materialized: Arc<std::sync::atomic::AtomicUsize>,
}

impl WorkerSpec {
    fn command(&self) -> Result<Command, Diagnostic> {
        let (python, source) = if let Some(python) = crate::commands::bundled_python_path() {
            (python, None)
        } else if cfg!(debug_assertions) {
            let sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("sidecar");
            (
                sidecar.join(if cfg!(windows) {
                    ".venv/Scripts/python.exe"
                } else {
                    ".venv/bin/python"
                }),
                Some(sidecar.join("src")),
            )
        } else {
            return Err(failure(
                "parser_unavailable",
                "Bundled parser Python is unavailable",
            ));
        };
        let mut command = Command::new(python);
        command
            .env_clear()
            .env("LC_ALL", "C")
            .current_dir(std::env::temp_dir())
            .arg("-I")
            .arg("-u")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Windows Python requires the OS directory for standard system DLL resolution.
        #[cfg(windows)]
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        #[cfg(test)]
        if let Some(script) = &self.script {
            command.arg("-c").arg(script);
            return Ok(command);
        }
        if let Some(source) = source {
            command.args(["-c", "import sys,runpy;sys.path.insert(0,sys.argv[1]);sys.argv=['ccie_sidecar.telemetry.worker'];runpy.run_module('ccie_sidecar.telemetry.worker',run_name='__main__')"]).arg(source);
        } else {
            command.args(["-m", "ccie_sidecar.telemetry.worker"]);
        }
        Ok(command)
    }
}

struct Worker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Worker {
    fn spawn(spec: &WorkerSpec) -> Result<Self, Diagnostic> {
        let mut child = spec
            .command()?
            .spawn()
            .map_err(|_| failure("parser_unavailable", "Cannot launch parser worker"))?;
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        #[cfg(test)]
        spec.started.fetch_add(1, Ordering::SeqCst);
        Ok(Self {
            child,
            input,
            output,
        })
    }

    async fn exchange(&mut self, job: &Job, spec: &WorkerSpec) -> ParseResult {
        self.input
            .write_all(&job.payload)
            .await
            .map_err(|_| failure("parser_protocol", "Parser input closed"))?;
        self.input
            .flush()
            .await
            .map_err(|_| failure("parser_protocol", "Parser input closed"))?;
        let mut bytes = Vec::new();
        (&mut self.output)
            .take((MAX_OUTPUT + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|_| failure("parser_protocol", "Cannot read parser response"))?;
        if bytes.len() > MAX_OUTPUT {
            return Err(failure("parser_limit", "Parser response exceeds its limit"));
        }
        if bytes.last() != Some(&b'\n') {
            return Err(failure("parser_protocol", "Incomplete parser response"));
        }
        decode(&bytes, &job.id, job.output_admission.as_ref(), spec)
    }

    async fn terminate(&mut self, _spec: &WorkerSpec) {
        #[cfg(test)]
        let pid = self.child.id();
        // start_kill is cross-platform; wait observes/reaps even an already exited child.
        let status = loop {
            let _ = self.child.start_kill();
            #[cfg(test)]
            if _spec.wait_blocked.load(Ordering::SeqCst) {
                // Simulate unavailable OS wait status without releasing the real Child.
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            }
            match self.child.wait().await {
                Ok(status) => break status,
                // Retain ownership if the OS cannot yet report an exit status.
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        };
        #[cfg(test)]
        if let Some(pid) = pid {
            _spec.exited.lock().unwrap().push((pid, status));
        }
        #[cfg(not(test))]
        let _ = status;
    }
}

async fn owner(mut jobs: mpsc::Receiver<Job>, spec: WorkerSpec, stop: CancellationToken) {
    let mut worker: Option<Worker> = None;
    loop {
        let job = tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            job = jobs.recv() => match job { Some(job) => job, None => break },
        };
        let result = tokio::select! {
            biased;
            _ = stop.cancelled() => Err(failure("parser_shutdown", "Parser is shut down")),
            _ = job.cancel.cancelled() => Err(failure("parser_cancelled", "Parsing was cancelled")),
            _ = tokio::time::sleep_until(job.deadline) => Err(failure("parser_timeout", "Parser deadline exceeded")),
            result = async {
                if worker.is_none() { worker = Some(Worker::spawn(&spec)?); }
                worker.as_mut().unwrap().exchange(&job, &spec).await
            } => result,
        };
        if result.is_err() {
            if let Some(mut owned) = worker.take() {
                owned.terminate(&spec).await;
            }
        }
        let _ = job.reply.send(result);
    }
    if let Some(mut owned) = worker {
        owned.terminate(&spec).await;
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerReply {
    id: String,
    headers: Option<Vec<String>>,
    records: Option<Vec<Vec<serde_json::Value>>>,
    diagnostic: Option<Diagnostic>,
}

/// Validated compact records; serialization projects rows without building keyed maps.
pub(crate) struct PendingRows {
    headers: Vec<String>,
    records: Vec<Vec<serde_json::Value>>,
}
impl Serialize for PendingRows {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Row<'a> {
            key: String,
            fields: Fields<'a>,
        }
        struct Fields<'a> {
            headers: &'a [String],
            values: &'a [serde_json::Value],
        }
        impl Serialize for Fields<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut fields = serializer.serialize_map(Some(self.headers.len()))?;
                for (header, value) in self.headers.iter().zip(self.values) {
                    let value = match value {
                        serde_json::Value::String(value) => value.clone(),
                        value => serde_json::to_string(value).map_err(serde::ser::Error::custom)?,
                    };
                    fields.serialize_entry(header, &MetricValue::Text { value })?;
                }
                fields.end()
            }
        }
        let mut rows = serializer.serialize_seq(Some(self.records.len()))?;
        for (index, record) in self.records.iter().enumerate() {
            rows.serialize_element(&Row {
                key: index.to_string(),
                fields: Fields {
                    headers: &self.headers,
                    values: record,
                },
            })?;
        }
        rows.end()
    }
}

fn decode(
    bytes: &[u8],
    expected_id: &str,
    admit: Option<&OutputAdmission>,
    _spec: &WorkerSpec,
) -> ParseResult {
    let bad = || failure("parser_protocol", "Invalid or mismatched parser response");
    let reply: WorkerReply = serde_json::from_slice(bytes).map_err(|_| bad())?;
    if reply.id != expected_id {
        return Err(bad());
    }
    match (reply.headers, reply.records, reply.diagnostic) {
        (None, None, Some(diagnostic)) => Err(diagnostic),
        (Some(headers), Some(records), None) => {
            let unique: BTreeSet<_> = headers.iter().collect();
            if records.len() > MAX_ROWS
                || headers.is_empty()
                || unique.len() != headers.len()
                || headers.iter().any(|h| {
                    h.is_empty()
                        || h.len() > 128
                        || !h
                            .bytes()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
                })
                || records.iter().any(|record| {
                    record.len() != headers.len()
                        || record
                            .iter()
                            .any(|value| !value.is_string() && !value.is_array())
                })
            {
                return Err(bad());
            }
            let pending = PendingRows { headers, records };
            if let Some(admit) = admit {
                admit(&pending)?;
            }
            pending
                .records
                .into_iter()
                .enumerate()
                .map(|(index, record)| {
                    let fields = pending
                        .headers
                        .iter()
                        .cloned()
                        .zip(record)
                        .map(|(header, value)| {
                            let value = match value {
                                serde_json::Value::String(value) => value,
                                serde_json::Value::Array(values) => {
                                    serde_json::to_string(&values).map_err(|_| bad())?
                                }
                                _ => return Err(bad()),
                            };
                            Ok((header, MetricValue::Text { value }))
                        })
                        .collect::<Result<BTreeMap<_, _>, _>>()?;
                    #[cfg(test)]
                    _spec.materialized.fetch_add(1, Ordering::SeqCst);
                    // Provisional ordinal only; widget normalization builds composite keys.
                    Ok(MetricRow {
                        key: index.to_string(),
                        fields,
                    })
                })
                .collect()
        }
        _ => Err(bad()),
    }
}

#[cfg(test)]
impl TelemetryParser {
    pub(crate) fn fixture(script: &str, timeout: Duration) -> Self {
        let mut parser = Self::new();
        parser.spec.script = Some(script.into());
        parser.timeout = timeout;
        parser
    }
    pub(crate) fn set_cleanup_budget_for_test(&mut self, budget: Duration) {
        self.cleanup_budget = budget;
    }
    pub(crate) fn block_cleanup_for_test(&self, blocked: bool) {
        self.spec.wait_blocked.store(blocked, Ordering::SeqCst);
    }
    pub(crate) fn materialized_rows_for_test(&self) -> usize {
        self.spec.materialized.load(Ordering::SeqCst)
    }
    pub(crate) fn workers_started_for_test(&self) -> usize {
        self.spec.started.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::model::Platform;

    fn sample(raw: &str) -> (Capture, TemplateAsset) {
        let text = "Value NAME (\\S+)\n\nStart\n  ^${NAME}$$ -> Record\n".to_string();
        let template = TemplateAsset {
            id: "names".into(),
            platform: Platform::Iosxe,
            command: "show interfaces".into(),
            sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
            text,
        };
        let capture = Capture {
            capture_id: "capture".into(),
            target_id: "target".into(),
            platform: Platform::Iosxe,
            command: template.command.clone(),
            parser_id: template.id.clone(),
            revision: "revision".into(),
            observed_at_ms: 1,
            monotonic_ms: 1,
            raw: raw.into(),
        };
        (capture, template)
    }

    #[tokio::test]
    async fn parser_timeout_cancel_and_shutdown_reap_owned_worker() {
        let parser = TelemetryParser::new();
        let (capture, template) = sample("Gi1\n");
        let rows = parser
            .parse(&capture, &template, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            rows[0].fields["name"],
            MetricValue::Text {
                value: "Gi1".into()
            }
        );
        parser.shutdown().await.unwrap();
        assert!(parser
            .parse(&capture, &template, CancellationToken::new())
            .await
            .is_err());
    }

    const FIXTURE: &str = r#"
import sys,json,time
for line in sys.stdin:
 r=json.loads(line)
 raw=r['capture']['raw']
 if raw=='hang': time.sleep(60)
 if raw=='overflow': print('x'*(2*1024*1024+1),flush=True); continue
 if raw=='wrong': r['id']='stale-id'
 print(json.dumps({'id':r['id'],'headers':['name'],'records':[[raw]]}),flush=True)
"#;

    #[test]
    fn projected_rows_match_native_charge_for_escaping_arrays_and_empty_records() {
        for records in [
            serde_json::json!([]),
            serde_json::json!([["quotes\"\\\n\u{0000}é", ["x\"", {"nested": [1, true, null]}]], ["", []]]),
        ] {
            let bytes = serde_json::to_vec(&serde_json::json!({
                "id": "projection", "headers": ["z_last", "a_first"], "records": records,
            }))
            .unwrap();
            let projected = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let measured = projected.clone();
            let admit: OutputAdmission = Box::new(move |rows| {
                measured.store(serde_json::to_vec(rows).unwrap().len(), Ordering::SeqCst);
                Ok(())
            });
            let rows = decode(&bytes, "projection", Some(&admit), &WorkerSpec::default()).unwrap();
            assert_eq!(
                projected.load(Ordering::SeqCst),
                serde_json::to_vec(&rows).unwrap().len()
            );
        }
    }

    #[test]
    fn malformed_compact_records_never_reach_admission_or_materialization() {
        for records in [serde_json::json!([["good"], []]), serde_json::json!([[42]])] {
            let bytes = serde_json::to_vec(&serde_json::json!({
                "id": "bad", "headers": ["name"], "records": records,
            }))
            .unwrap();
            let spec = WorkerSpec::default();
            let admit: OutputAdmission =
                Box::new(|_| panic!("invalid compact output reached admission"));
            assert_eq!(
                decode(&bytes, "bad", Some(&admit), &spec).unwrap_err().code,
                "parser_protocol"
            );
            assert_eq!(spec.materialized.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn pending_cleanup_mark_cannot_outlive_or_reuse_its_epoch() {
        let state = Arc::new(StdMutex::new(Admission {
            busy: [true, false],
            ..Admission::default()
        }));
        let guard = AdmissionGuard {
            state: state.clone(),
            available: Arc::new(Notify::new()),
            priority: Priority::Collection,
            slot: Some(0),
            epoch: 0,
        };
        guard.mark_cleanup_pending();
        assert_eq!(state.lock().unwrap().pending_cleanup, [true, false]);
        drop(guard);
        assert_eq!(state.lock().unwrap().pending_cleanup, [false, false]);
        let stale = AdmissionGuard {
            state: state.clone(),
            available: Arc::new(Notify::new()),
            priority: Priority::Collection,
            slot: Some(0),
            epoch: 0,
        };
        *state.lock().unwrap() = Admission {
            epoch: 1,
            busy: [true, false],
            ..Admission::default()
        };
        stale.mark_cleanup_pending();
        drop(stale);
        let state = state.lock().unwrap();
        assert_eq!(state.pending_cleanup, [false, false]);
        assert_eq!(state.busy, [true, false]);
    }

    #[tokio::test]
    async fn nonterminal_quiesce_reaps_real_children_and_later_parse_restarts() {
        let parser = TelemetryParser::fixture(FIXTURE, Duration::from_secs(3));
        let (capture, template) = sample("first");
        parser
            .parse(&capture, &template, CancellationToken::new())
            .await
            .unwrap();
        parser.quiesce().await.unwrap();
        assert_eq!(
            parser.spec.started.load(Ordering::SeqCst),
            parser.spec.exited.lock().unwrap().len()
        );
        let (capture, template) = sample("second");
        parser
            .test_template(&capture, &template, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(parser.spec.started.load(Ordering::SeqCst), 2);
        parser.shutdown().await.unwrap();
        assert_eq!(
            parser.spec.started.load(Ordering::SeqCst),
            parser.spec.exited.lock().unwrap().len()
        );
    }

    #[tokio::test]
    async fn nonterminal_quiesce_retains_pending_owners_and_blocks_admission() {
        let mut parser = TelemetryParser::fixture(FIXTURE, Duration::from_secs(3));
        parser.cleanup_budget = Duration::from_millis(30);
        let (capture, template) = sample("first");
        parser
            .parse(&capture, &template, CancellationToken::new())
            .await
            .unwrap();
        parser.spec.wait_blocked.store(true, Ordering::SeqCst);
        assert_eq!(
            parser.quiesce().await.unwrap_err().code,
            "parser_cleanup_pending"
        );
        assert!(!parser.pool.lock().await.owners.is_empty());
        assert_eq!(
            parser
                .parse(&capture, &template, CancellationToken::new())
                .await
                .unwrap_err()
                .code,
            "parser_quiescing"
        );
        parser.spec.wait_blocked.store(false, Ordering::SeqCst);
        parser.quiesce().await.unwrap();
        parser
            .parse(&capture, &template, CancellationToken::new())
            .await
            .unwrap();
        parser.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn preview_admission_is_bounded_and_collection_uses_other_real_actor() {
        let parser = Arc::new(TelemetryParser::fixture(FIXTURE, Duration::from_secs(3)));
        let active_parser = parser.clone();
        let active_cancel = CancellationToken::new();
        let cancel = active_cancel.clone();
        let active = tokio::spawn(async move {
            let (capture, template) = sample("hang");
            active_parser
                .test_template(&capture, &template, cancel)
                .await
        });
        wait_started(&parser).await;
        let waiting_parser = parser.clone();
        let waiting_cancel = CancellationToken::new();
        let cancel = waiting_cancel.clone();
        let waiting = tokio::spawn(async move {
            let (capture, template) = sample("waiting");
            waiting_parser
                .test_template(&capture, &template, cancel)
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while parser.admission.lock().unwrap().preview_waiting == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let (capture, template) = sample("excess");
        assert_eq!(
            parser
                .test_template(&capture, &template, CancellationToken::new())
                .await
                .unwrap_err()
                .code,
            "parser_busy"
        );
        let records = parser
            .parse(&capture, &template, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(records.len(), 1);
        assert!(!parser.has_pending_cleanup());
        assert_eq!(parser.spec.started.load(Ordering::SeqCst), 2);
        waiting_cancel.cancel();
        assert_eq!(waiting.await.unwrap().unwrap_err().code, "parser_cancelled");
        active_cancel.cancel();
        active.await.unwrap().unwrap_err();
        parser.shutdown().await.unwrap();
        assert_eq!(
            parser.spec.started.load(Ordering::SeqCst),
            parser.spec.exited.lock().unwrap().len()
        );
    }

    async fn wait_started(parser: &TelemetryParser) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while parser.spec.started.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn canceled_dropped_timed_out_and_shutdown_jobs_reap_before_replacement() {
        for mode in ["timeout", "cancel", "drop", "shutdown"] {
            let parser = Arc::new(TelemetryParser::fixture(
                FIXTURE,
                Duration::from_millis(300),
            ));
            let cancel = CancellationToken::new();
            let task_parser = parser.clone();
            let task_cancel = cancel.clone();
            let task = tokio::spawn(async move {
                let (capture, template) = sample("hang");
                task_parser.parse(&capture, &template, task_cancel).await
            });
            wait_started(&parser).await;
            match mode {
                "cancel" => cancel.cancel(),
                "drop" => task.abort(),
                "shutdown" => parser.shutdown().await.unwrap(),
                _ => {}
            }
            if mode != "drop" {
                assert!(task.await.unwrap().is_err());
            }
            tokio::time::timeout(Duration::from_secs(3), async {
                while parser.spec.exited.lock().unwrap().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            // Entries are written only after Child::wait returns an ExitStatus.
            let owned_worker_exited = !parser.spec.exited.lock().unwrap().is_empty();
            assert!(owned_worker_exited);
            if mode != "shutdown" {
                for revision in ["new-revision", "later-revision"] {
                    let (mut capture, template) = sample(revision);
                    capture.revision = revision.into();
                    let rows = parser
                        .parse(&capture, &template, CancellationToken::new())
                        .await
                        .unwrap();
                    assert_eq!(
                        rows[0].fields["name"],
                        MetricValue::Text {
                            value: revision.into()
                        }
                    );
                }
            }
            parser.shutdown().await.unwrap();
            assert_eq!(
                parser.spec.started.load(Ordering::SeqCst),
                parser.spec.exited.lock().unwrap().len()
            );
        }
    }

    #[tokio::test]
    async fn protocol_overflow_wrong_id_and_parser_drop_reap() {
        let parser = TelemetryParser::fixture(FIXTURE, Duration::from_secs(3));
        let exited = parser.spec.exited.clone();
        for raw in ["overflow", "wrong"] {
            let (capture, template) = sample(raw);
            assert!(parser
                .parse(&capture, &template, CancellationToken::new())
                .await
                .is_err());
        }
        assert_eq!(exited.lock().unwrap().len(), 2);
        let (capture, template) = sample("valid");
        parser
            .parse(&capture, &template, CancellationToken::new())
            .await
            .unwrap();
        drop(parser);
        tokio::time::timeout(Duration::from_secs(3), async {
            while exited.lock().unwrap().len() != 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn real_regex_hang_is_killed_and_metadata_failure_spawns_nothing() {
        let mut parser = TelemetryParser::new();
        parser.timeout = Duration::from_millis(300);
        let (mut capture, mut template) = sample("a");
        capture.command = "show version".into();
        assert_eq!(
            parser
                .parse(&capture, &template, CancellationToken::new())
                .await
                .unwrap_err()
                .code,
            "parser_binding"
        );
        assert_eq!(parser.spec.started.load(Ordering::SeqCst), 0);
        capture.command = template.command.clone();
        capture.raw = format!("{}!", "a".repeat(100));
        template.text = "Value NAME ((a+)+)\n\nStart\n  ^${NAME}$$ -> Record\n".into();
        template.sha256 = format!("{:x}", Sha256::digest(template.text.as_bytes()));
        assert_eq!(
            parser
                .parse(&capture, &template, CancellationToken::new())
                .await
                .unwrap_err()
                .code,
            "parser_timeout"
        );
        assert_eq!(parser.spec.exited.lock().unwrap().len(), 1);
        parser.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_jobs_use_at_most_two_lazy_processes() {
        let parser = Arc::new(TelemetryParser::fixture(FIXTURE, Duration::from_secs(3)));
        assert_eq!(parser.spec.started.load(Ordering::SeqCst), 0);
        let mut jobs = Vec::new();
        for i in 0..4 {
            let parser = parser.clone();
            jobs.push(tokio::spawn(async move {
                let name = format!("request-{i}");
                let (capture, template) = sample(&name);
                let rows = parser
                    .parse(&capture, &template, CancellationToken::new())
                    .await
                    .unwrap();
                assert_eq!(rows[0].fields["name"], MetricValue::Text { value: name });
            }));
        }
        for job in jobs {
            job.await.unwrap();
        }
        assert_eq!(parser.spec.started.load(Ordering::SeqCst), 2);
        parser.shutdown().await.unwrap();
        assert_eq!(parser.spec.exited.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn cleanup_failure_is_bounded_visible_and_retry_keeps_same_owner() {
        let mut parser = TelemetryParser::fixture(FIXTURE, Duration::from_millis(50));
        parser.cleanup_budget = Duration::from_millis(50);
        parser.spec.wait_blocked.store(true, Ordering::SeqCst);
        let (capture, template) = sample("hang");
        let start = Instant::now();
        let diagnostic = parser
            .parse(&capture, &template, CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(diagnostic.code, "parser_cleanup_pending");
        assert!(parser.has_pending_cleanup());
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(parser.spec.exited.lock().unwrap().is_empty());
        assert_eq!(parser.spec.started.load(Ordering::SeqCst), 1);
        let start = Instant::now();
        assert_eq!(
            parser.shutdown().await.unwrap_err().code,
            "parser_cleanup_pending"
        );
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(parser.pool.lock().await.owners.len(), 1);
        parser.spec.wait_blocked.store(false, Ordering::SeqCst);
        parser.shutdown().await.unwrap();
        assert!(!parser.has_pending_cleanup());
        assert_eq!(parser.spec.exited.lock().unwrap().len(), 1);
        assert_eq!(parser.spec.started.load(Ordering::SeqCst), 1);
    }
}
