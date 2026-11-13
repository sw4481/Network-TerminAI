//! libproc metadata/task counters only: sysinfo's macOS reader fetches PROCARGS2.
use super::{missing, percent, process_key, row, text, unsigned, Diagnostic, MetricRow};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub(super) struct MacProcesses {
    previous: BTreeMap<(u32, u64, u64), (u64, u64)>,
}

impl MacProcesses {
    pub(super) fn sample(
        &mut self,
        cpu_ready: bool,
        cores: usize,
        cpu_processes: &BTreeSet<String>,
        diagnostics: &mut Vec<Diagnostic>,
    ) -> (Vec<MetricRow>, BTreeSet<String>, usize) {
        let pids = match process_ids() {
            Ok(pids) => pids,
            Err(reason) => {
                diagnostics.push(Diagnostic::new(
                    "local_process_inventory_unavailable",
                    reason,
                    "local.processes",
                ));
                self.previous.clear();
                return (vec![], BTreeSet::new(), 0);
            }
        };
        let mut rows = Vec::new();
        let mut observed = BTreeSet::new();
        let mut next = BTreeMap::new();
        let mut unavailable = 0;
        for pid in pids.into_iter().filter(|pid| *pid > 0) {
            // One kernel process reference supplies both identity and task counters.
            let all = unsafe { pid_info::<libc::proc_taskallinfo>(pid, libc::PROC_PIDTASKALLINFO) };
            let (bsd, task) = match all {
                Ok(info) => (info.pbsd, Ok(info.ptinfo)),
                Err(error) => {
                    match unsafe { pid_info::<libc::proc_bsdinfo>(pid, libc::PROC_PIDTBSDINFO) } {
                        Ok(bsd) => (bsd, Err(error)),
                        Err(_) => {
                            unavailable += 1;
                            continue;
                        }
                    }
                }
            };
            let Some(key) = process_key(bsd.pbi_pid, bsd.pbi_start_tvsec) else {
                unavailable += 1;
                continue;
            };
            if bsd.pbi_pid != pid as u32 {
                unavailable += 1;
                continue;
            }
            observed.insert(key.clone());
            let identity = (bsd.pbi_pid, bsd.pbi_start_tvsec, bsd.pbi_start_tvusec);
            let (cpu, memory) = match task {
                Ok(task) => {
                    #[allow(deprecated)]
                    let at = unsafe { libc::mach_absolute_time() };
                    let cpu = match task.pti_total_user.checked_add(task.pti_total_system) {
                        Some(total) => {
                            let value = if cpu_ready && cpu_processes.contains(&key) {
                                cpu_percent(total, at, self.previous.get(&identity).copied(), cores)
                            } else {
                                missing("warming_up: process needs an observation interval")
                            };
                            next.insert(identity, (total, at));
                            value
                        }
                        None => missing("process_cpu_counter_overflow"),
                    };
                    // Successful native task data distinguishes a real zero from denied access.
                    (cpu, unsigned(task.pti_resident_size))
                }
                Err(error) => {
                    unavailable += 1;
                    let reason = if error == libc::EPERM || error == libc::EACCES {
                        "permission_denied: process task data"
                    } else {
                        "process_task_unavailable"
                    };
                    (missing(reason), missing(reason))
                }
            };
            let name = if bsd.pbi_name[0] == 0 {
                name(&bsd.pbi_comm)
            } else {
                name(&bsd.pbi_name)
            };
            rows.push(row(
                &key,
                [
                    ("pid", unsigned(bsd.pbi_pid as u64)),
                    ("start_time", unsigned(bsd.pbi_start_tvsec)),
                    (
                        "name",
                        if name.is_empty() {
                            missing("process_name_unavailable")
                        } else {
                            text(&name)
                        },
                    ),
                    ("cpu_percent", cpu),
                    ("memory_bytes", memory),
                ],
            ));
        }
        self.previous = next;
        (rows, observed, unavailable)
    }
}

fn cpu_percent(
    total: u64,
    at: u64,
    previous: Option<(u64, u64)>,
    cores: usize,
) -> super::MetricValue {
    let Some((old_total, old_at)) = previous else {
        return missing("warming_up: process needs an observation interval");
    };
    if total < old_total || at <= old_at || cores == 0 {
        return missing("process_cpu_interval_unavailable");
    }
    // XNU fill_taskprocinfo returns Mach ticks, matching mach_absolute_time ticks.
    percent((total - old_total) as f64 / (at - old_at) as f64 * 100.0 / cores as f64)
}

fn name<const N: usize>(value: &[libc::c_char; N]) -> String {
    let bytes: Vec<_> = value
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

// T must be the zero-initializable C record matching this libproc flavor.
unsafe fn pid_info<T>(pid: i32, flavor: i32) -> Result<T, i32> {
    let mut value = std::mem::MaybeUninit::<T>::zeroed();
    let size = std::mem::size_of::<T>() as i32;
    let read = unsafe {
        *libc::__error() = 0;
        libc::proc_pidinfo(pid, flavor, 0, value.as_mut_ptr().cast(), size)
    };
    if read == size {
        Ok(unsafe { value.assume_init() })
    } else {
        Err(if read <= 0 {
            std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
        } else {
            libc::EIO
        })
    }
}

fn process_ids() -> Result<Vec<i32>, &'static str> {
    const PROC_ALL_PIDS: u32 = 1; // SDK sys/proc_info.h; proc_listpids returns bytes.
    let bytes = unsafe { libc::proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    if bytes <= 0 {
        return Err("Process enumeration failed");
    }
    let mut slots = bytes as usize / std::mem::size_of::<i32>() + 32;
    for _ in 0..3 {
        let capacity = slots
            .checked_mul(std::mem::size_of::<i32>())
            .and_then(|n| i32::try_from(n).ok())
            .ok_or("Process inventory size is unavailable")?;
        let mut pids = vec![0i32; slots];
        let read =
            unsafe { libc::proc_listpids(PROC_ALL_PIDS, 0, pids.as_mut_ptr().cast(), capacity) };
        if read <= 0 || !(read as usize).is_multiple_of(std::mem::size_of::<i32>()) {
            return Err("Process enumeration failed or returned incomplete metadata");
        }
        if read < capacity {
            pids.truncate(read as usize / std::mem::size_of::<i32>());
            return Ok(pids);
        }
        slots *= 2;
    }
    Err("Process inventory changed beyond the enumeration retry bound")
}

#[cfg(test)]
mod tests {
    use super::super::MetricValue;
    use super::*;

    #[test]
    fn mach_tick_cpu_normalizes_without_nanosecond_assumptions() {
        assert_eq!(
            cpu_percent(1200, 1100, Some((1000, 1000)), 4),
            MetricValue::Number { value: 50.0 }
        );
        assert_eq!(
            cpu_percent(1000, 1100, Some((1000, 1000)), 4),
            MetricValue::Number { value: 0.0 }
        );
        assert!(matches!(
            cpu_percent(1, 2, Some((2, 1)), 4),
            MetricValue::Missing { .. }
        ));
        assert!(matches!(
            cpu_percent(1, 2, None, 4),
            MetricValue::Missing { .. }
        ));
    }

    #[test]
    fn native_task_metadata_has_own_pid_identity_and_memory() {
        let info = unsafe {
            pid_info::<libc::proc_taskallinfo>(std::process::id() as i32, libc::PROC_PIDTASKALLINFO)
        }
        .unwrap();
        assert_eq!(info.pbsd.pbi_pid, std::process::id());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(info.pbsd.pbi_start_tvsec > 0 && info.pbsd.pbi_start_tvsec <= now);
        assert!(info.pbsd.pbi_start_tvusec < 1_000_000);
        assert!(info.ptinfo.pti_resident_size > 0);
        assert!(info.ptinfo.pti_total_user + info.ptinfo.pti_total_system > 0);
        assert!(!name(&info.pbsd.pbi_name).is_empty() || !name(&info.pbsd.pbi_comm).is_empty());
    }
}
