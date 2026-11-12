//! Synchronous local observations. The service must own this on a blocking worker.
use super::model::{Diagnostic, LocalSample, MetricRow, MetricValue, SampleTime};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;
use sysinfo::{
    DiskRefreshKind, Disks, MemoryRefreshKind, Networks, ProcessRefreshKind, ProcessesToUpdate,
    System, MINIMUM_CPU_UPDATE_INTERVAL,
};

pub struct LocalCollector {
    system: System,
    networks: Networks,
    disks: Disks,
    last_cpu: Option<Instant>,
    last_disk_inventory: Option<u64>,
    cpu_processes: BTreeSet<String>,
    previous_rows: BTreeMap<String, BTreeSet<String>>,
    last_sample: Option<u64>,
}

impl Default for LocalCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalCollector {
    pub fn new() -> Self {
        Self {
            system: System::new(),
            networks: Networks::new(),
            disks: Disks::new(),
            last_cpu: None,
            last_disk_inventory: None,
            cpu_processes: BTreeSet::new(),
            previous_rows: BTreeMap::new(),
            last_sample: None,
        }
    }

    pub fn sample(&mut self, now: SampleTime) -> Result<LocalSample, Diagnostic> {
        if !sysinfo::IS_SUPPORTED_SYSTEM {
            return Err(Diagnostic::new(
                "local_unsupported",
                "OS metrics are unsupported",
                "local",
            ));
        }
        if self
            .last_sample
            .is_some_and(|last| now.monotonic_ms <= last)
        {
            return Err(Diagnostic::new(
                "local_time",
                "Sample monotonic time must advance",
                "local",
            ));
        }
        let mut diagnostics = Vec::new();
        let refresh_cpu = self
            .last_cpu
            .is_none_or(|last| last.elapsed() >= MINIMUM_CPU_UPDATE_INTERVAL);
        let cpu_ready = refresh_cpu && self.last_cpu.is_some();
        if refresh_cpu {
            self.system.refresh_cpu_usage();
        }
        self.system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram().with_swap());
        let mut process_refresh = ProcessRefreshKind::nothing().without_tasks().with_memory();
        if refresh_cpu {
            process_refresh = process_refresh.with_cpu();
        }
        self.system
            .refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh);
        self.networks.refresh(true);

        let cores = self.system.cpus().len();
        let cpu_value = |usage: f32| {
            if cpu_ready {
                percent(usage as f64)
            } else {
                missing("warming_up: CPU needs an observation interval")
            }
        };
        let mut cpu = vec![row(
            "total",
            [
                ("core", text("total")),
                ("label", text("Overall")),
                ("usage", cpu_value(self.system.global_cpu_usage())),
                ("logical_cores", unsigned(cores as u64)),
            ],
        )];
        for (index, core) in self.system.cpus().iter().enumerate() {
            cpu.push(row(
                &index.to_string(),
                [
                    ("core", text(&index.to_string())),
                    ("label", text(core.name())),
                    ("usage", cpu_value(core.cpu_usage())),
                    ("logical_cores", unsigned(cores as u64)),
                ],
            ));
        }
        if cores == 0 {
            cpu[0]
                .fields
                .insert("usage".into(), missing("per_core_unavailable"));
            diagnostics.push(Diagnostic::new(
                "local_cpu_unavailable",
                "Logical CPU details unavailable",
                "local.cpu",
            ));
        }

        if self
            .last_disk_inventory
            .is_none_or(|last| now.monotonic_ms.saturating_sub(last) >= 60_000)
        {
            self.disks
                .refresh_specifics(true, DiskRefreshKind::nothing());
            self.last_disk_inventory = Some(now.monotonic_ms);
        }
        let mut filesystems = Vec::new();
        for disk in self.disks.list_mut() {
            let refreshed = disk.refresh_specifics(DiskRefreshKind::nothing().with_storage());
            let mount = disk.mount_point().to_string_lossy();
            let mut item = filesystem_row(
                &mount,
                &disk.file_system().to_string_lossy(),
                disk.total_space(),
                disk.available_space(),
            );
            if !refreshed || disk.total_space() == 0 || disk.available_space() > disk.total_space()
            {
                for field in ["total_bytes", "available_bytes", "used_bytes"] {
                    item.fields
                        .insert(field.into(), missing("filesystem_capacity_unavailable"));
                }
            }
            filesystems.push(item);
        }
        let network = self
            .networks
            .iter()
            .map(|(name, data)| {
                row(
                    name,
                    [
                        ("interface", text(name)),
                        ("received_bytes", unsigned(data.total_received())),
                        ("transmitted_bytes", unsigned(data.total_transmitted())),
                        ("received_packets", unsigned(data.total_packets_received())),
                        (
                            "transmitted_packets",
                            unsigned(data.total_packets_transmitted()),
                        ),
                        ("received_errors", unsigned(data.total_errors_on_received())),
                        (
                            "transmitted_errors",
                            unsigned(data.total_errors_on_transmitted()),
                        ),
                    ],
                )
            })
            .collect();

        let mut observed_processes = BTreeSet::new();
        let mut processes = Vec::new();
        let mut unavailable = 0;
        for (pid, process) in self.system.processes() {
            let Some(key) = process_key(pid.as_u32(), process.start_time()) else {
                unavailable += 1;
                continue;
            };
            observed_processes.insert(key.clone());
            let memory = process_memory(process.memory());
            let cpu = if process.memory() == 0 {
                unavailable += 1;
                missing("unavailable_or_zero: process access or OS data may be limited")
            } else if !cpu_ready || !self.cpu_processes.contains(&key) {
                missing("warming_up: process needs an observation interval")
            } else {
                normalized_process_cpu(process.cpu_usage(), cores)
            };
            processes.push(row(
                &key,
                [
                    ("pid", unsigned(pid.as_u32() as u64)),
                    ("start_time", unsigned(process.start_time())),
                    (
                        "name",
                        if process.name().is_empty() {
                            missing("process_name_unavailable")
                        } else {
                            text(&process.name().to_string_lossy())
                        },
                    ),
                    ("cpu_percent", cpu),
                    ("memory_bytes", memory),
                ],
            ));
        }
        processes.sort_by(|a, b| {
            let value = |r: &MetricRow| r.fields["cpu_percent"].numeric().unwrap_or(-1.0);
            value(b)
                .total_cmp(&value(a))
                .then_with(|| a.key.cmp(&b.key))
        });
        processes.truncate(50);
        if unavailable > 0 {
            diagnostics.push(Diagnostic::new("local_process_access_limited", format!("{unavailable} observed processes have unavailable or zero memory/start data; unknown start times are omitted, permission denial is not established"), "local.processes"));
        }
        if refresh_cpu {
            self.last_cpu = Some(Instant::now());
            self.cpu_processes = observed_processes.clone();
        }
        let memory = memory_row(
            self.system.total_memory(),
            self.system.available_memory(),
            self.system.used_memory(),
            self.system.total_swap(),
            self.system.used_swap(),
        );
        let sources = BTreeMap::from([
            ("local.cpu".into(), cpu),
            ("local.memory".into(), vec![memory]),
            ("local.filesystems".into(), filesystems),
            ("local.network".into(), network),
            ("local.processes".into(), processes),
        ]);
        Ok(self.finish_sample(now, sources, &observed_processes, diagnostics))
    }

    fn finish_sample(
        &mut self,
        now: SampleTime,
        sources: BTreeMap<String, Vec<MetricRow>>,
        observed_processes: &BTreeSet<String>,
        mut diagnostics: Vec<Diagnostic>,
    ) -> LocalSample {
        for (source, rows) in &sources {
            let current: BTreeSet<_> = rows.iter().map(|r| r.key.clone()).collect();
            let observed = if source == "local.processes" {
                observed_processes
            } else {
                &current
            };
            if let Some(previous) = self.previous_rows.get(source) {
                let removed = previous.difference(observed).count();
                if removed > 0 {
                    diagnostics.push(Diagnostic::new("local_rows_disappeared", format!("{removed} previously reported rows are no longer observed; no zero values were substituted"), source));
                }
            }
            if rows.is_empty() {
                diagnostics.push(Diagnostic::new(
                    "local_source_empty",
                    "No rows observed; OS support/access or inventory may be limited",
                    source,
                ));
            }
            self.previous_rows.insert(source.clone(), current);
        }
        self.last_sample = Some(now.monotonic_ms);
        LocalSample {
            observed_at_ms: now.wall_ms,
            monotonic_ms: now.monotonic_ms,
            sources,
            diagnostics,
        }
    }
}

fn row<const N: usize>(key: &str, fields: [(&str, MetricValue); N]) -> MetricRow {
    MetricRow {
        key: key.into(),
        fields: fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    }
}
fn unsigned(value: u64) -> MetricValue {
    MetricValue::Unsigned {
        value: value.to_string(),
    }
}
fn text(value: &str) -> MetricValue {
    MetricValue::Text {
        value: value.into(),
    }
}
fn missing(reason: &str) -> MetricValue {
    MetricValue::Missing {
        reason: reason.into(),
    }
}
fn percent(value: f64) -> MetricValue {
    if value.is_finite() && (0.0..=100.0).contains(&value) {
        MetricValue::Number { value }
    } else {
        missing("cpu_percent_unavailable")
    }
}
fn normalized_process_cpu(value: f32, cores: usize) -> MetricValue {
    if cores == 0 {
        missing("logical_core_count_unavailable")
    } else {
        percent(value as f64 / cores as f64)
    }
}
fn process_memory(value: u64) -> MetricValue {
    if value == 0 {
        missing("unavailable_or_zero: resident memory")
    } else {
        unsigned(value)
    }
}
fn process_key(pid: u32, start_time: u64) -> Option<String> {
    (start_time != 0).then(|| format!("{pid}:{start_time}"))
}
fn memory_row(total: u64, available: u64, used: u64, swap_total: u64, swap_used: u64) -> MetricRow {
    let mut result = row(
        "memory",
        [
            ("total_bytes", unsigned(total)),
            ("available_bytes", unsigned(available)),
            ("used_bytes", unsigned(used)),
            ("swap_total_bytes", unsigned(swap_total)),
            ("swap_used_bytes", unsigned(swap_used)),
        ],
    );
    if total == 0 || available > total || used > total {
        for field in ["total_bytes", "available_bytes", "used_bytes"] {
            result
                .fields
                .insert(field.into(), missing("memory_unavailable"));
        }
    }
    result
}
fn filesystem_row(mount: &str, filesystem: &str, total: u64, available: u64) -> MetricRow {
    row(
        mount,
        [
            ("mount", text(mount)),
            ("filesystem", text(filesystem)),
            ("total_bytes", unsigned(total)),
            ("available_bytes", unsigned(available)),
            ("used_bytes", unsigned(total.saturating_sub(available))),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_first_cpu_sample_is_warming_up() {
        let sample = LocalCollector::new()
            .sample(SampleTime {
                wall_ms: 1,
                monotonic_ms: 1,
            })
            .unwrap();
        assert!(!sample.sources["local.cpu"].is_empty());
        for row in &sample.sources["local.cpu"] {
            assert!(
                matches!(&row.fields["usage"], MetricValue::Missing { reason } if reason.contains("warming"))
            );
        }
        assert!(sample.sources["local.processes"]
            .iter()
            .all(|r| matches!(r.fields["cpu_percent"], MetricValue::Missing { .. })));
    }

    #[test]
    fn process_cpu_is_normalized_by_logical_cores() {
        let normalized_percent = normalized_process_cpu(200.0, 4).numeric().unwrap();
        assert_eq!(normalized_percent, 50.0);
        assert!(matches!(
            normalized_process_cpu(200.0, 0),
            MetricValue::Missing { .. }
        ));
        assert!(matches!(
            normalized_process_cpu(f32::NAN, 4),
            MetricValue::Missing { .. }
        ));
    }

    #[test]
    fn process_exit_and_adapter_disappearance_are_not_zeroes() {
        let mut collector = LocalCollector::new();
        let sources = BTreeMap::from([
            (
                "local.network".into(),
                vec![row("eth0", [("received_bytes", unsigned(123))])],
            ),
            (
                "local.processes".into(),
                vec![row("42:1", [("memory_bytes", unsigned(456))])],
            ),
        ]);
        collector.finish_sample(
            SampleTime {
                wall_ms: 1,
                monotonic_ms: 1,
            },
            sources,
            &BTreeSet::from(["42:1".into()]),
            vec![],
        );
        let sample = collector.finish_sample(
            SampleTime {
                wall_ms: 2,
                monotonic_ms: 2,
            },
            BTreeMap::from([
                ("local.network".into(), vec![]),
                ("local.processes".into(), vec![]),
            ]),
            &BTreeSet::new(),
            vec![],
        );
        assert!(sample.sources["local.network"].is_empty());
        assert!(sample.sources["local.processes"].is_empty());
        assert_eq!(
            sample
                .diagnostics
                .iter()
                .filter(|d| d.code == "local_rows_disappeared")
                .count(),
            2
        );
    }

    #[test]
    fn local_units_are_bytes_and_percent() {
        assert_eq!(
            unsigned(u64::MAX),
            MetricValue::Unsigned {
                value: "18446744073709551615".into()
            }
        );
        let memory = memory_row(8192, 2048, 6144, 4096, 1024);
        assert_eq!(memory.fields["total_bytes"], unsigned(8192));
        assert_eq!(memory.fields["used_bytes"], unsigned(6144));
        let disk = filesystem_row("/", "apfs", 10000, 2500);
        assert_eq!(disk.fields["used_bytes"], unsigned(7500));
        assert!(matches!(process_memory(0), MetricValue::Missing { .. }));
        assert_eq!(process_memory(1024), unsigned(1024));
        assert_eq!(
            normalized_process_cpu(200.0, 4),
            MetricValue::Number { value: 50.0 }
        );
    }

    #[test]
    fn leaving_top_process_view_is_not_an_exit() {
        let mut collector = LocalCollector::new();
        let identity = BTreeSet::from(["42:1".into()]);
        collector.finish_sample(
            SampleTime {
                wall_ms: 1,
                monotonic_ms: 1,
            },
            BTreeMap::from([(
                "local.processes".into(),
                vec![row("42:1", [("memory_bytes", unsigned(1))])],
            )]),
            &identity,
            vec![],
        );
        let sample = collector.finish_sample(
            SampleTime {
                wall_ms: 2,
                monotonic_ms: 2,
            },
            BTreeMap::from([("local.processes".into(), vec![])]),
            &identity,
            vec![],
        );
        assert!(!sample
            .diagnostics
            .iter()
            .any(|d| d.code == "local_rows_disappeared"));
    }

    #[test]
    fn unknown_process_start_cannot_become_a_reusable_identity() {
        assert_eq!(process_key(42, 0), None);
        assert_ne!(process_key(42, 1), process_key(42, 2));
        assert_eq!(process_key(42, 1).unwrap(), "42:1");
        assert!(matches!(
            memory_row(0, 0, 0, 0, 0).fields["used_bytes"],
            MetricValue::Missing { .. }
        ));
        assert_eq!(
            memory_row(8192, 2048, 6144, 0, 0).fields["swap_total_bytes"],
            unsigned(0)
        );
    }

    #[test]
    fn early_cpu_refresh_is_a_gap_and_sample_clock_must_advance() {
        let mut collector = LocalCollector::new();
        collector
            .sample(SampleTime {
                wall_ms: 100,
                monotonic_ms: 1,
            })
            .unwrap();
        collector.last_cpu = Some(Instant::now());
        let sample = collector
            .sample(SampleTime {
                wall_ms: 90,
                monotonic_ms: 2,
            })
            .unwrap();
        assert!(matches!(
            sample.sources["local.cpu"][0].fields["usage"],
            MetricValue::Missing { .. }
        ));
        assert_eq!(collector.last_disk_inventory, Some(1));
        assert_eq!(
            collector
                .sample(SampleTime {
                    wall_ms: 100,
                    monotonic_ms: 2
                })
                .unwrap_err()
                .code,
            "local_time"
        );
    }

    #[test]
    #[ignore = "explicit normal-user native OS smoke; no GUI or device traffic"]
    fn native_os_metric_smoke() {
        use std::time::{Duration, SystemTime, UNIX_EPOCH};
        #[cfg(unix)]
        assert_ne!(unsafe { libc::geteuid() }, 0, "run as a normal user");
        let started = Instant::now();
        let now = || SampleTime {
            wall_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64,
            monotonic_ms: started.elapsed().as_millis() as u64,
        };
        let mut collector = LocalCollector::new();
        let first_started = Instant::now();
        let first = collector.sample(now()).unwrap();
        let first_latency = first_started.elapsed();
        assert!(matches!(
            first.sources["local.cpu"][0].fields["usage"],
            MetricValue::Missing { .. }
        ));
        std::thread::sleep(Duration::from_secs(2).max(MINIMUM_CPU_UPDATE_INTERVAL));
        let next_started = Instant::now();
        let sample = collector.sample(now()).unwrap();
        let next_latency = next_started.elapsed();
        assert_eq!(sample.sources.len(), 5);
        assert!(sample.sources["local.cpu"][0].fields["usage"]
            .numeric()
            .is_some());
        assert!(sample.sources["local.cpu"].len() > 1);
        let bytes = |value: &MetricValue| match value {
            MetricValue::Unsigned { value } => value.parse::<u64>().unwrap(),
            _ => panic!("expected bytes"),
        };
        assert!(bytes(&sample.sources["local.memory"][0].fields["total_bytes"]) > 1024 * 1024);
        assert!(!sample.sources["local.filesystems"].is_empty());
        assert!(sample.sources["local.filesystems"].iter().any(|r| matches!(&r.fields["total_bytes"], MetricValue::Unsigned { value } if value.parse::<u64>().unwrap() > 0)));
        assert!(!sample.sources["local.network"].is_empty());
        assert!(sample.sources["local.network"]
            .iter()
            .all(|r| matches!(r.fields["received_bytes"], MetricValue::Unsigned { .. })));
        assert!(!sample.sources["local.processes"].is_empty());
        assert!(sample.sources["local.processes"].len() <= 50);
        assert!(sample.sources["local.processes"]
            .iter()
            .any(|r| r.fields["cpu_percent"].numeric().is_some()));
        assert!(sample.sources["local.processes"].iter().all(
            |r| matches!(&r.fields["start_time"], MetricValue::Unsigned { value } if value != "0")
        ));
        assert!(collector
            .system
            .processes()
            .values()
            .all(|p| p.cmd().is_empty() && p.environ().is_empty()));
        serde_json::to_string(&sample).unwrap();
        println!("native_os={} arch={} first_latency_ms={} next_latency_ms={} cpu_rows={} filesystem_rows={} adapter_rows={} process_rows={} total_memory_bytes={} diagnostics={}",
            std::env::consts::OS, std::env::consts::ARCH, first_latency.as_millis(), next_latency.as_millis(),
            sample.sources["local.cpu"].len(), sample.sources["local.filesystems"].len(), sample.sources["local.network"].len(),
            sample.sources["local.processes"].len(), bytes(&sample.sources["local.memory"][0].fields["total_bytes"]), sample.diagnostics.len());
    }
}
