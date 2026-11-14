//! App-owned, bounded saved-profile discovery. Cancellation preserves committed captures.
use super::{
    discovery_transport::{self, DiscoveryProcesses},
    graph, ingest,
    snmp::{self, CollectionMode},
    CaptureOutcome, CaptureStatus, DiscoverySummary, NeighborRecord, TopologyNode,
};
use crate::{
    commands::{ssh::decrypt_password, topology::DiscoveryDevice},
    parsers::bridge::{NeighborCapture, ParserBridge},
    ssh_exec::SshTarget,
};
use futures::{future::BoxFuture, stream::FuturesUnordered, StreamExt};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{sync::Semaphore, time::Instant};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;

const MAX_DEVICES: usize = 50;
const CONCURRENCY: usize = 4;
const DEVICE_TIME: Duration = Duration::from_secs(90);
const RUN_TIME: Duration = Duration::from_secs(900);
const ROUTING_COMMANDS: [(&str, &str); 4] = [
    ("bgp", "show ip bgp summary"),
    ("ospf", "show ip ospf neighbor"),
    ("isis", "show isis neighbors"),
    ("eigrp", "show ip eigrp neighbors"),
];
const COMMANDS: [(&str, &str); 2] = [
    ("cdp", "show cdp neighbors detail"),
    ("lldp", "show lldp neighbors detail"),
];

// Not Debug/Serialize: temporary overrides are request-only secrets.
#[derive(serde::Deserialize)]
pub struct DiscoveryRequest {
    pub graph_id: String,
    pub seed_ids: Vec<String>,
    pub eligible_ids: Vec<String>,
    #[serde(default)]
    pub passwords: HashMap<String, String>,
    #[serde(default)]
    pub max_depth: u8,
    #[serde(default)]
    pub include_routing: bool,
    #[serde(default)]
    pub collection_mode: CollectionMode,
    #[serde(default)]
    pub snmp_secret_id: Option<String>,
}
impl Drop for DiscoveryRequest {
    fn drop(&mut self) {
        for password in self.passwords.values_mut() {
            password.zeroize();
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Running,
    Cancelling,
    Completed,
    Cancelled,
    TimedOut,
    Failed,
}
impl RunState {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Running | Self::Cancelling)
    }
}
#[derive(Clone, serde::Serialize)]
pub struct DeviceOutcome {
    pub connection_id: String,
    pub host: String,
    pub depth: u8,
    pub status: String,
    pub captures: Vec<CaptureOutcome>,
    pub error: Option<String>,
}
#[derive(Clone, serde::Serialize)]
pub struct NotDialed {
    pub reference: String,
    pub reason: String,
}
#[derive(Clone, serde::Serialize)]
pub struct DiscoveryReport {
    pub run_id: String,
    pub graph_id: String,
    pub state: RunState,
    pub max_depth: u8,
    pub collection_mode: CollectionMode,
    pub devices: Vec<DeviceOutcome>,
    pub not_dialed: Vec<NotDialed>,
    pub additional_not_dialed: usize,
    pub nodes_processed: u32,
    pub edges_processed: u32,
    /// Admission and submission-to-reply wait; neither is isolated Python CPU time.
    pub parser_admission_ms: u64,
    pub parser_reply_ms: u64,
}
struct Run {
    report: DiscoveryReport,
    cancel: CancellationToken,
}
struct SecretTarget(SshTarget);
impl Drop for SecretTarget {
    fn drop(&mut self) {
        self.0.password.zeroize();
    }
}
struct Profile {
    id: String,
    source: TopologyNode,
    target: Option<Arc<SecretTarget>>,
    snmp_credential: Option<Arc<snmp::Credential>>,
    failure: Option<String>,
    supported: bool,
}
struct Scope {
    include_routing: bool,
    profiles: HashMap<String, Arc<Profile>>,
    hosts: HashMap<String, Vec<String>>,
}
type Execute = Arc<
    dyn Fn(
            Arc<SecretTarget>,
            String,
            CancellationToken,
            Instant,
        ) -> BoxFuture<'static, Result<String, String>>
        + Send
        + Sync,
>;
type Parse = Arc<
    dyn Fn(
            String,
            String,
            String,
            String,
            String,
            Option<String>,
        ) -> BoxFuture<'static, Result<NeighborCapture, String>>
        + Send
        + Sync,
>;

type SnmpExecute = Arc<
    dyn Fn(
            String,
            Arc<snmp::Credential>,
            CancellationToken,
            Instant,
        ) -> BoxFuture<'static, Result<Vec<snmp::Capture>, String>>
        + Send
        + Sync,
>;

pub struct TopologyDiscoveryService {
    vault: Option<Arc<crate::commands::VaultState>>,
    snmp_execute: Option<SnmpExecute>,
    db: Arc<Mutex<Connection>>,
    current: Mutex<Option<Run>>,
    closed: AtomicBool,
    processes: Arc<DiscoveryProcesses>,
    // ponytail: one shared-parser request at a time; isolate if measured HOL requires it.
    parser_slot: Arc<Semaphore>,
    execute: Execute,
    parse: Parse,
}
impl TopologyDiscoveryService {
    pub fn new(db: Arc<Mutex<Connection>>, parser: ParserBridge) -> Self {
        let processes = Arc::new(DiscoveryProcesses::default());
        let transport = processes.clone();
        let execute: Execute = Arc::new(move |target, command, cancel, deadline| {
            let transport = transport.clone();
            Box::pin(async move {
                discovery_transport::run_command(&target.0, &command, cancel, deadline, &transport)
                    .await
            })
        });
        let parse: Parse = Arc::new(
            move |protocol, vendor, platform, command, raw, interfaces_raw| {
                let parser = parser.clone();
                Box::pin(async move {
                    parser
                        .neighbor_capture_with_interfaces(
                            &protocol,
                            &vendor,
                            &platform,
                            &command,
                            &raw,
                            interfaces_raw.as_deref(),
                        )
                        .await
                        .map_err(|_| "Neighbor parsing failed".into())
                })
            },
        );
        Self {
            vault: None,
            snmp_execute: None,
            db,
            current: Mutex::new(None),
            closed: AtomicBool::new(false),
            processes,
            parser_slot: Arc::new(Semaphore::new(1)),
            execute,
            parse,
        }
    }
    pub fn with_snmp(mut self, vault: Arc<crate::commands::VaultState>) -> Self {
        self.vault = Some(vault);
        if let Ok(worker) = snmp::Worker::production() {
            let processes = self.processes.clone();
            self.snmp_execute = Some(Arc::new(move |host, credential, cancel, deadline| {
                let worker = worker.clone();
                let processes = processes.clone();
                Box::pin(async move {
                    worker
                        .run(&host, &credential, cancel, deadline, &processes)
                        .await
                })
            }));
        }
        self
    }
    pub fn status(&self, run_id: Option<&str>) -> Result<Option<DiscoveryReport>, String> {
        let current = self.current.lock();
        if let Some(id) = run_id {
            if current.as_ref().map(|run| run.report.run_id.as_str()) != Some(id) {
                return Err("Discovery run is no longer available".into());
            }
        }
        Ok(current.as_ref().map(|run| run.report.clone()))
    }
    pub fn start(
        self: &Arc<Self>,
        mut request: DiscoveryRequest,
    ) -> Result<DiscoveryReport, String> {
        let mut current = self.current.lock();
        if self.closed.load(Ordering::SeqCst) {
            return Err("Discovery is shutting down".into());
        }
        if let Some(run) = current.as_ref().filter(|run| run.report.state.is_active()) {
            return Ok(run.report.clone());
        }
        if request.graph_id.is_empty()
            || request.graph_id.len() > 256
            || request.max_depth > 1
            || request.seed_ids.is_empty()
            || request.seed_ids.len() > MAX_DEVICES
            || request.eligible_ids.len() > 500
            || request.passwords.len() > 500
            || request.passwords.values().any(|p| p.len() > 4096)
        {
            return Err(
                "Discovery requires 1–50 seeds, at most 500 eligible profiles and depth 0 or 1"
                    .into(),
            );
        }
        let eligible: HashSet<_> = request.eligible_ids.iter().cloned().collect();
        if request.seed_ids.iter().any(|id| !eligible.contains(id))
            || eligible.iter().any(|id| id.is_empty() || id.len() > 256)
            || request.passwords.keys().any(|id| !eligible.contains(id))
        {
            return Err(
                "Seeds and password overrides must belong to the explicit eligible set".into(),
            );
        }
        let credential = if request.collection_mode == CollectionMode::Ssh {
            if request.snmp_secret_id.is_some() {
                return Err("SNMP credentials require an explicit SNMP mode".into());
            }
            None
        } else {
            if request.include_routing {
                return Err("Routing collection is unavailable in SNMP mode".into());
            }
            #[cfg(not(unix))]
            return Err("Topology SNMP discovery is unsupported on this platform".into());
            if self.snmp_execute.is_none() {
                return Err("Topology SNMP worker unavailable".into());
            }
            let vault = self
                .vault
                .as_ref()
                .ok_or("Topology SNMP vault unavailable")?;
            Some(snmp::Credential::read(
                &self.db.lock(),
                vault,
                request
                    .snmp_secret_id
                    .as_deref()
                    .ok_or("Select a topology SNMP credential")?,
                request.collection_mode,
            )?)
        };
        let scope = self.snapshot(&mut request, credential)?;
        let report = DiscoveryReport {
            run_id: uuid::Uuid::new_v4().to_string(),
            graph_id: request.graph_id.clone(),
            state: RunState::Running,
            max_depth: request.max_depth,
            collection_mode: request.collection_mode,
            devices: vec![],
            not_dialed: vec![],
            additional_not_dialed: 0,
            nodes_processed: 0,
            edges_processed: 0,
            parser_admission_ms: 0,
            parser_reply_ms: 0,
        };
        let cancel = CancellationToken::new();
        *current = Some(Run {
            report: report.clone(),
            cancel: cancel.clone(),
        });
        let service = self.clone();
        let id = report.run_id.clone();
        let seeds = std::mem::take(&mut request.seed_ids);
        let deadline = Instant::now() + RUN_TIME;
        tokio::spawn(async move {
            service.run(id, seeds, scope, cancel, deadline).await;
        });
        Ok(report)
    }
    pub fn cancel(&self, run_id: &str) -> Result<DiscoveryReport, String> {
        let mut current = self.current.lock();
        let run = current
            .as_mut()
            .filter(|run| run.report.run_id == run_id)
            .ok_or("Discovery run is no longer available")?;
        if run.report.state.is_active() {
            run.report.state = RunState::Cancelling;
            run.cancel.cancel();
        }
        Ok(run.report.clone())
    }
    pub fn shutdown(&self) -> Result<(), String> {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(run) = self
            .current
            .lock()
            .as_mut()
            .filter(|run| run.report.state.is_active())
        {
            run.report.state = RunState::Cancelling;
            run.cancel.cancel();
        }
        self.processes.shutdown()
    }
    fn snapshot(
        &self,
        request: &mut DiscoveryRequest,
        credential: Option<Arc<snmp::Credential>>,
    ) -> Result<Scope, String> {
        let mut scope = Scope {
            include_routing: request.include_routing,
            profiles: HashMap::new(),
            hosts: HashMap::new(),
        };
        {
            let conn = self.db.lock();
            if graph::get_graph(&conn, &request.graph_id)
                .map_err(|_| "Could not read discovery graph")?
                .is_none()
            {
                return Err("Discovery graph not found".into());
            }
            let mut query = conn
                .prepare("SELECT id, host FROM ssh_connections ORDER BY id")
                .map_err(|_| "Could not snapshot saved hosts")?;
            let rows = query
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|_| "Could not snapshot saved hosts")?;
            for row in rows {
                let (id, host) = row.map_err(|_| "Could not snapshot saved hosts")?;
                scope
                    .hosts
                    .entry(normalize_host(&host))
                    .or_default()
                    .push(id);
            }
            for id in &request.eligible_ids {
                if scope.profiles.contains_key(id) {
                    continue;
                }
                // One locked snapshot owns metadata, endpoint and saved credential together.
                let row: (String, String, Option<String>, Option<String>, i64, Option<String>, Option<String>) = conn.query_row("SELECT host,name,vendor,platform,port,user,password_encrypted FROM ssh_connections WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))).map_err(|_| "Eligible saved profile no longer exists")?;
                let source = TopologyNode {
                    graph_id: request.graph_id.clone(),
                    device_ref: row.0.clone(),
                    device_kind: "ssh".into(),
                    label: row.1,
                    vendor: row.2,
                    platform: row.3,
                    mgmt_ip: row
                        .0
                        .parse::<std::net::IpAddr>()
                        .ok()
                        .map(|ip| ip.to_string()),
                };
                let is_snmp = credential.is_some();
                let supported = is_snmp
                    || DiscoveryDevice {
                        source: source.clone(),
                    }
                    .supports_manual_collection();
                let mut failure = (!is_snmp && !(1..=65535).contains(&row.4))
                    .then(|| "Invalid saved SSH port".into());
                let mut target = None;
                if !is_snmp && supported && failure.is_none() {
                    if let Some(username) = row.5 {
                        // Same override precedence and decryptor as the existing saved-SSH path.
                        let password = request
                            .passwords
                            .remove(id)
                            .or_else(|| row.6.and_then(|value| decrypt_password(&value).ok()));
                        if let Some(password) = password {
                            target = Some(Arc::new(SecretTarget(SshTarget {
                                host: row.0,
                                port: row.4 as u16,
                                username,
                                password,
                            })));
                        }
                    }
                    if target.is_none() {
                        failure =
                            Some("Saved username/password unavailable for this profile".into());
                    }
                }
                scope.profiles.insert(
                    id.clone(),
                    Arc::new(Profile {
                        id: id.clone(),
                        source,
                        target,
                        snmp_credential: credential.clone(),
                        failure,
                        supported,
                    }),
                );
            }
        }
        for password in request.passwords.values_mut() {
            password.zeroize();
        }
        request.passwords.clear();
        Ok(scope)
    }
    fn update(&self, id: &str, update: impl FnOnce(&mut DiscoveryReport)) {
        if let Some(run) = self
            .current
            .lock()
            .as_mut()
            .filter(|run| run.report.run_id == id)
        {
            update(&mut run.report);
        }
    }
    fn not_dialed(&self, id: &str, reference: &str, reason: &str) {
        self.update(id, |report| {
            let reference: String = reference.chars().take(256).collect();
            if report
                .not_dialed
                .iter()
                .any(|item| item.reference == reference && item.reason == reason)
            {
                return;
            }
            if report.not_dialed.len() < 1000 {
                report.not_dialed.push(NotDialed {
                    reference,
                    reason: reason.into(),
                });
            } else {
                report.additional_not_dialed += 1;
            }
        });
    }
    async fn run(
        self: Arc<Self>,
        id: String,
        seeds: Vec<String>,
        scope: Scope,
        cancel: CancellationToken,
        deadline: Instant,
    ) {
        let max_depth = self
            .status(Some(&id))
            .ok()
            .flatten()
            .map(|r| r.max_depth)
            .unwrap_or(0);
        let mut queue: VecDeque<_> = seeds.into_iter().map(|seed| (seed, 0)).collect();
        let mut visited = HashSet::new();
        let mut hosts = HashSet::new();
        let mut attempted = 0;
        // Complete a depth before admitting the next: deterministic BFS boundary.
        for depth in 0..=max_depth {
            let mut jobs = FuturesUnordered::new();
            loop {
                while jobs.len() < CONCURRENCY
                    && !cancel.is_cancelled()
                    && Instant::now() < deadline
                    && queue.front().is_some_and(|(_, next)| *next == depth)
                {
                    let (profile_id, _) = queue.pop_front().unwrap();
                    if !visited.insert(profile_id.clone()) {
                        continue;
                    }
                    let Some(profile) = scope.profiles.get(&profile_id).cloned() else {
                        continue;
                    };
                    let host = normalize_host(&profile.source.device_ref);
                    if scope.hosts.get(&host).map(Vec::len) != Some(1) {
                        self.not_dialed(
                            &id,
                            &profile.source.device_ref,
                            "Ambiguous saved host; no unique saved profile",
                        );
                        continue;
                    }
                    if !hosts.insert(host) {
                        continue;
                    }
                    if attempted >= MAX_DEVICES {
                        self.not_dialed(
                            &id,
                            &profile.source.device_ref,
                            "50-device attempt limit reached",
                        );
                        continue;
                    }
                    attempted += 1;
                    self.update(&id, |r| {
                        r.devices.push(DeviceOutcome {
                            connection_id: profile.id.clone(),
                            host: profile.source.device_ref.clone(),
                            depth,
                            status: "running".into(),
                            captures: vec![],
                            error: None,
                        })
                    });
                    jobs.push(self.collect(
                        id.clone(),
                        profile,
                        cancel.clone(),
                        deadline,
                        scope.include_routing,
                    ));
                }
                let Some((profile_id, neighbors)) = jobs.next().await else {
                    break;
                };
                for neighbor in neighbors {
                    let Some(reference) = neighbor
                        .neighbor_mgmt_ip
                        .as_deref()
                        .filter(|host| !host.trim().is_empty())
                    else {
                        self.not_dialed(
                            &id,
                            &neighbor.neighbor_name,
                            "Missing neighbor management address; advertised name not dialed",
                        );
                        continue;
                    };
                    let normalized = normalize_host(reference);
                    let matches = scope.hosts.get(&normalized);
                    let reason = match matches {
                        None => Some("No exact saved host match"),
                        Some(ids) if ids.len() != 1 => {
                            Some("Ambiguous saved host; no unique saved profile")
                        }
                        Some(ids) if !scope.profiles.contains_key(&ids[0]) => {
                            Some("Saved neighbor is outside the explicit eligible set")
                        }
                        _ => None,
                    };
                    if let Some(reason) = reason {
                        self.not_dialed(&id, reference, reason);
                        continue;
                    }
                    let target = &matches.unwrap()[0];
                    if visited.contains(target) || target == &profile_id {
                        continue;
                    }
                    if depth >= max_depth {
                        self.not_dialed(
                            &id,
                            reference,
                            "Recursion depth limit; neighbor not dialed",
                        );
                    } else {
                        queue.push_back((target.clone(), depth + 1));
                    }
                }
            }
        }
        for (profile_id, _) in queue {
            self.not_dialed(&id, &profile_id, "Run stopped before admission");
        }
        self.update(&id, |report| {
            report.state = if cancel.is_cancelled() {
                RunState::Cancelled
            } else if Instant::now() >= deadline {
                RunState::TimedOut
            } else {
                RunState::Completed
            }
        });
    }
    async fn collect(
        &self,
        id: String,
        profile: Arc<Profile>,
        cancel: CancellationToken,
        run_deadline: Instant,
        include_routing: bool,
    ) -> (String, Vec<NeighborRecord>) {
        let deadline = (Instant::now() + DEVICE_TIME).min(run_deadline);
        if let Some(credential) = &profile.snmp_credential {
            return self
                .collect_snmp(id, profile.clone(), credential.clone(), cancel, deadline)
                .await;
        }
        let commands: Vec<_> = COMMANDS
            .iter()
            .chain(ROUTING_COMMANDS.iter().filter(|_| include_routing))
            .copied()
            .collect();
        // Invalidate prior freshness before IO, including failed/unsupported profiles.
        let initial_status = if !profile.supported {
            "unsupported"
        } else if profile.failure.is_some() {
            "failed"
        } else {
            "incomplete"
        };
        let Ok(attempts) = self.record_attempt(&id, &profile, &commands, initial_status, deadline)
        else {
            self.update(&id, |r| {
                let row = r
                    .devices
                    .iter_mut()
                    .find(|r| r.connection_id == profile.id)
                    .unwrap();
                row.status = if cancel.is_cancelled() {
                    "cancelled"
                } else if Instant::now() >= deadline {
                    "timed_out"
                } else {
                    "failed"
                }
                .into();
                row.error =
                    Some("Could not record collection attempt; no commands executed".into());
            });
            return (profile.id.clone(), vec![]);
        };
        if !profile.supported || profile.failure.is_some() {
            self.update(&id, |r| {
                let row = r
                    .devices
                    .iter_mut()
                    .find(|r| r.connection_id == profile.id)
                    .unwrap();
                row.status = if profile.supported {
                    "failed"
                } else {
                    "unsupported"
                }
                .into();
                row.error = Some(profile.failure.clone().unwrap_or_else(|| {
                    "Only saved Cisco IOS/IOS-XE profiles are supported".into()
                }));
            });
            return (profile.id.clone(), vec![]);
        }
        let interfaces_raw =
            if include_routing && !cancel.is_cancelled() && Instant::now() < deadline {
                (self.execute)(
                    profile.target.as_ref().unwrap().clone(),
                    "show ip interface".into(),
                    cancel.clone(),
                    deadline,
                )
                .await
                .ok()
            } else {
                None
            };
        let mut captures = vec![];
        let mut neighbors = vec![];
        for &(protocol, command) in &commands {
            if cancel.is_cancelled() || Instant::now() >= deadline {
                break;
            }
            let raw = match (self.execute)(
                profile.target.as_ref().unwrap().clone(),
                command.into(),
                cancel.clone(),
                deadline,
            )
            .await
            {
                Ok(raw) => raw,
                Err(message) => {
                    let saved = self.record_outcome(
                        &id,
                        &profile,
                        (command, &attempts[command]),
                        "failed",
                        deadline,
                    );
                    captures.push(failed(
                        protocol,
                        if saved.is_ok() {
                            &message
                        } else {
                            "Capture failed; receipt outcome could not be recorded"
                        },
                    ));
                    continue;
                }
            };
            let capture = match self
                .parse_capture(
                    &id,
                    &profile,
                    protocol,
                    command,
                    raw.clone(),
                    if matches!(protocol, "bgp" | "ospf" | "isis" | "eigrp") {
                        interfaces_raw.clone()
                    } else {
                        None
                    },
                    cancel.clone(),
                    deadline,
                )
                .await
            {
                Ok(capture) => capture,
                Err(message) => {
                    let saved = self.record_outcome(
                        &id,
                        &profile,
                        (command, &attempts[command]),
                        "failed",
                        deadline,
                    );
                    captures.push(failed(
                        protocol,
                        if saved.is_ok() {
                            &message
                        } else {
                            "Capture failed; receipt outcome could not be recorded"
                        },
                    ));
                    continue;
                }
            };
            if capture.status == CaptureStatus::Unsupported {
                let saved = self.record_outcome(
                    &id,
                    &profile,
                    (command, &attempts[command]),
                    "unsupported",
                    deadline,
                );
                if saved.is_err() {
                    captures.push(failed(
                        protocol,
                        "Unsupported capture; receipt outcome could not be recorded",
                    ));
                    continue;
                }
                captures.push(CaptureOutcome {
                    protocol: protocol.into(),
                    status: CaptureStatus::Unsupported,
                    records: 0,
                    error: Some("Saved platform parser is unsupported".into()),
                });
                continue;
            }
            if capture.status != CaptureStatus::Completed
                || capture.records.len() > 2000
                || capture.records.iter().any(|r| {
                    r.protocol != protocol
                        || (matches!(protocol, "bgp" | "ospf" | "isis" | "eigrp") && r.routing.is_none())
                })
            {
                let saved = self.record_outcome(
                    &id,
                    &profile,
                    (command, &attempts[command]),
                    "failed",
                    deadline,
                );
                captures.push(failed(
                    protocol,
                    if saved.is_ok() {
                        "Parser capture failed validation"
                    } else {
                        "Capture validation failed; receipt outcome could not be recorded"
                    },
                ));
                continue;
            }
            // Stop and commit share one authority lock: no late parser write after Stop.
            let mut current = self.current.lock();
            let Some(run) = current.as_mut().filter(|run| {
                run.report.run_id == id
                    && run.report.graph_id == profile.source.graph_id
                    && run.report.state == RunState::Running
                    && !run.cancel.is_cancelled()
                    && Instant::now() < deadline
            }) else {
                break;
            };
            let persisted = ingest::ingest_owned_capture(
                &self.db.lock(),
                &profile.source,
                command,
                &raw,
                &capture.records,
                &attempts[command],
            );
            match persisted {
                Ok(summary) => {
                    run.report.nodes_processed += summary.nodes_added;
                    run.report.edges_processed += summary.edges_added;
                    captures.push(CaptureOutcome {
                        protocol: protocol.into(),
                        status: CaptureStatus::Completed,
                        records: capture.records.len() as u32,
                        error: None,
                    });
                    neighbors.extend(
                        capture
                            .records
                            .into_iter()
                            .filter(|r| matches!(r.protocol.as_str(), "cdp" | "lldp")),
                    );
                }
                Err(_) => {
                    let saved = super::evidence::CaptureEvidence::finish(
                        &self.db.lock(),
                        &profile.source.graph_id,
                        &profile.source.device_ref,
                        command,
                        &attempts[command],
                        "failed",
                    );
                    captures.push(failed(
                        protocol,
                        if saved.is_ok() {
                            "Could not commit discovery capture to its graph"
                        } else {
                            "Capture was not committed; receipt outcome could not be recorded"
                        },
                    ));
                }
            }
        }
        let summary = DiscoverySummary::from_captures(captures.clone());
        self.update(&id, |r| {
            let row = r
                .devices
                .iter_mut()
                .find(|r| r.connection_id == profile.id)
                .unwrap();
            row.status = if cancel.is_cancelled() {
                "cancelled"
            } else if Instant::now() >= deadline {
                "timed_out"
            } else if summary.status == super::DiscoveryStatus::Completed
                && captures.len() == commands.len()
            {
                "completed"
            } else if summary.cache_updated {
                "partial"
            } else {
                "failed"
            }
            .into();
            row.captures = captures;
        });
        (profile.id.clone(), neighbors)
    }
    async fn collect_snmp(
        &self,
        id: String,
        profile: Arc<Profile>,
        credential: Arc<snmp::Credential>,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> (String, Vec<NeighborRecord>) {
        let commands = [("cdp", "snmp:cdp"), ("lldp", "snmp:lldp")];
        let mut outcomes = vec![];
        let mut neighbors = vec![];
        let attempts = match self.record_attempt(&id, &profile, &commands, "incomplete", deadline) {
            Ok(attempts) => attempts,
            Err(_) => {
                self.update(&id, |r| {
                    if let Some(row) = r.devices.iter_mut().find(|r| r.connection_id == profile.id)
                    {
                        row.status = "failed".into();
                        row.error =
                            Some("Could not record collection attempt; no worker executed".into());
                    }
                });
                return (profile.id.clone(), neighbors);
            }
        };
        let result = (self.snmp_execute.as_ref().expect("SNMP admitted"))(
            profile.source.device_ref.clone(),
            credential,
            cancel.clone(),
            deadline,
        )
        .await;
        match result {
            Err(_) => {
                for (protocol, command) in commands {
                    let saved = self.record_outcome(
                        &id,
                        &profile,
                        (command, &attempts[command]),
                        "failed",
                        deadline,
                    );
                    outcomes.push(failed(
                        protocol,
                        if saved.is_ok() {
                            "SNMP worker failed, cancelled or timed out"
                        } else {
                            "SNMP capture stopped; receipt outcome was not recorded"
                        },
                    ));
                }
            }
            Ok(captures) => {
                for capture in captures {
                    let command = match capture.protocol.as_str() {
                        "cdp" => "snmp:cdp",
                        "lldp" => "snmp:lldp",
                        _ => continue,
                    };
                    // Identical Stop/run/graph authority boundary to SSH; no await under either lock.
                    let mut current = self.current.lock();
                    let Some(run) = current.as_mut().filter(|run| {
                        run.report.run_id == id
                            && run.report.graph_id == profile.source.graph_id
                            && run.report.state == RunState::Running
                            && !run.cancel.is_cancelled()
                            && Instant::now() < deadline
                    }) else {
                        break;
                    };
                    let conn = self.db.lock();
                    if capture.status != CaptureStatus::Completed {
                        let status = if capture.status == CaptureStatus::Unsupported {
                            "unsupported"
                        } else {
                            "failed"
                        };
                        let saved = super::evidence::CaptureEvidence::finish_with_snmp(
                            &conn,
                            &profile.source.graph_id,
                            &profile.source.device_ref,
                            command,
                            &attempts[command],
                            status,
                            Some(&capture.observations),
                        );
                        outcomes.push(CaptureOutcome {
                            protocol: capture.protocol,
                            status: if saved.is_ok() {
                                capture.status
                            } else {
                                CaptureStatus::Failed
                            },
                            records: 0,
                            error: Some(
                                if saved.is_ok() {
                                    "SNMP table collection failed or unsupported"
                                } else {
                                    "SNMP outcome could not be recorded"
                                }
                                .into(),
                            ),
                        });
                        continue;
                    }
                    // Cache only validated normalized records/provenance, never stdin or raw error output.
                    let raw = match serde_json::to_string(&capture) {
                        Ok(raw) => raw,
                        Err(_) => {
                            outcomes
                                .push(failed(&capture.protocol, "SNMP capture encoding failed"));
                            continue;
                        }
                    };
                    match ingest::ingest_owned_snmp_capture(
                        &conn,
                        &profile.source,
                        command,
                        &raw,
                        &capture,
                        &attempts[command],
                    ) {
                        Ok(summary) => {
                            run.report.nodes_processed += summary.nodes_added;
                            run.report.edges_processed += summary.edges_added;
                            outcomes.push(CaptureOutcome {
                                protocol: capture.protocol,
                                status: CaptureStatus::Completed,
                                records: capture.records.len() as u32,
                                error: None,
                            });
                            neighbors.extend(capture.records);
                        }
                        Err(_) => {
                            let saved = super::evidence::CaptureEvidence::finish(
                                &conn,
                                &profile.source.graph_id,
                                &profile.source.device_ref,
                                command,
                                &attempts[command],
                                "failed",
                            );
                            outcomes.push(failed(&capture.protocol, if saved.is_ok() { "Could not commit SNMP capture to its graph" } else { "SNMP capture was not committed; receipt outcome could not be recorded" }));
                        }
                    }
                }
            }
        }
        let summary = DiscoverySummary::from_captures(outcomes.clone());
        self.update(&id, |r| {
            if let Some(row) = r.devices.iter_mut().find(|r| r.connection_id == profile.id) {
                row.status = if cancel.is_cancelled() {
                    "cancelled"
                } else if Instant::now() >= deadline {
                    "timed_out"
                } else if summary.status == super::DiscoveryStatus::Completed && outcomes.len() == 2
                {
                    "completed"
                } else if summary.cache_updated {
                    "partial"
                } else {
                    "failed"
                }
                .into();
                row.captures = outcomes;
            }
        });
        (profile.id.clone(), neighbors)
    }
    fn record_attempt(
        &self,
        id: &str,
        profile: &Profile,
        commands: &[(&str, &str)],
        status: &str,
        deadline: Instant,
    ) -> Result<HashMap<String, String>, String> {
        let current = self.current.lock();
        let Some(_) = current.as_ref().filter(|run| {
            run.report.run_id == id
                && run.report.graph_id == profile.source.graph_id
                && run.report.state == RunState::Running
                && !run.cancel.is_cancelled()
                && Instant::now() < deadline
        }) else {
            return Err("Collection attempt no longer owns its run".into());
        };
        let conn = self.db.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|_| "Could not record collection attempt")?;
        let mut attempts = HashMap::new();
        for (_, command) in commands {
            let token = super::evidence::CaptureEvidence::attempt(
                &tx,
                &profile.source.graph_id,
                &profile.source.device_ref,
                command,
                status,
            )
            .map_err(|_| "Could not record collection attempt")?;
            attempts.insert((*command).to_string(), token);
        }
        tx.commit()
            .map_err(|_| "Could not record collection attempt")?;
        Ok(attempts)
    }
    fn record_outcome(
        &self,
        id: &str,
        profile: &Profile,
        capture: (&str, &str),
        status: &str,
        deadline: Instant,
    ) -> Result<(), String> {
        let current = self.current.lock();
        let Some(_) = current.as_ref().filter(|run| {
            run.report.run_id == id
                && run.report.graph_id == profile.source.graph_id
                && run.report.state == RunState::Running
                && !run.cancel.is_cancelled()
                && Instant::now() < deadline
        }) else {
            return Err("Collection attempt no longer owns its run".into());
        };
        super::evidence::CaptureEvidence::finish(
            &self.db.lock(),
            &profile.source.graph_id,
            &profile.source.device_ref,
            capture.0,
            capture.1,
            status,
        )
        .map_err(|_| "Could not record capture outcome".into())
    }
    async fn parse_capture(
        &self,
        id: &str,
        profile: &Profile,
        protocol: &str,
        command: &str,
        raw: String,
        interfaces_raw: Option<String>,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<NeighborCapture, String> {
        let admission = Instant::now();
        let permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("Discovery cancelled".into()),
            _ = tokio::time::sleep_until(deadline) => return Err("Device deadline exceeded while waiting for parser".into()),
            permit = self.parser_slot.clone().acquire_owned() => permit.map_err(|_| "Parser admission closed")?,
        };
        self.update(id, |r| {
            r.parser_admission_ms += admission.elapsed().as_millis() as u64
        });
        let parse = self.parse.clone();
        let protocol = protocol.to_string();
        let command = command.to_string();
        let vendor = profile.source.vendor.clone().unwrap_or_default();
        let platform = profile.source.platform.clone().unwrap_or_default();
        // Retain admission through ACTUAL completion, even after the run stops waiting.
        let mut task = tokio::spawn(async move {
            let _permit = permit;
            parse(protocol, vendor, platform, command, raw, interfaces_raw).await
        });
        let submitted = Instant::now();
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("Discovery cancelled; queued parser result will be ignored".into()),
            _ = tokio::time::sleep_until(deadline) => Err("Device deadline exceeded; queued parser result will be ignored".into()),
            reply = &mut task => reply.map_err(|_| "Neighbor parser task failed")?,
        };
        self.update(id, |r| {
            r.parser_reply_ms += submitted.elapsed().as_millis() as u64
        });
        result
    }
}
fn normalize_host(host: &str) -> String {
    let host = host.trim();
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| host.trim_end_matches('.').to_ascii_lowercase())
}
fn failed(protocol: &str, message: &str) -> CaptureOutcome {
    CaptureOutcome {
        protocol: protocol.into(),
        status: CaptureStatus::Failed,
        records: 0,
        error: Some(message.into()),
    }
}
#[cfg(test)]
#[path = "discovery_tests.rs"]
mod tests;
