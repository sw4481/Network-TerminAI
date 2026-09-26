// Plan 00 / Phase 3 / Task 3.3 — end-to-end heartbeat round-trip:
// sidecar emits `sidecar.heartbeat` NDJSON → supervisor demuxes → sink
// persists into the `sidecar_status` row.

use ccie_terminal_lib::bridge::SidecarSupervisor;
use std::path::PathBuf;
use std::sync::Arc;

fn python_cmd() -> (String, Vec<String>) {
    let repo_root = match std::env::var("CCIE_REPO_ROOT") {
        Ok(p) => PathBuf::from(p),
        Err(_) => PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("CARGO_MANIFEST_DIR has a parent")
            .to_path_buf(),
    };
    let venv_python = if cfg!(windows) {
        repo_root.join("sidecar/.venv/Scripts/python.exe")
    } else {
        repo_root.join("sidecar/.venv/bin/python")
    };
    (
        venv_python.to_string_lossy().into_owned(),
        vec!["-m".into(), "ccie_sidecar".into()],
    )
}

#[test]
fn heartbeat_sink_receives_initial_and_periodic_beats() {
    let (cmd, args) = python_cmd();
    // Shorten the cadence so the test finishes quickly.
    std::env::set_var("CCIE_SIDECAR_HEARTBEAT_S", "1");

    let sup = SidecarSupervisor::new(cmd, args);

    let counter = Arc::new(parking_lot::Mutex::new(0u32));
    let last_version = Arc::new(parking_lot::Mutex::new(String::new()));
    {
        let counter = counter.clone();
        let last_version = last_version.clone();
        sup.set_heartbeat_sink(move |hb| {
            *counter.lock() += 1;
            *last_version.lock() = hb.version;
        });
    }

    // Touch the supervisor so the child spawns and the reader thread starts.
    let resp = sup.call("ping", serde_json::json!({})).expect("ping");
    assert_eq!(resp.as_str(), Some("pong"));

    // Observe both the startup beat and at least one periodic beat. Checking
    // only the startup message misses regressions where the emitter stalls
    // immediately after warmup while the process itself remains alive.
    std::thread::sleep(std::time::Duration::from_millis(1_750));
    sup.shutdown();

    let n = *counter.lock();
    assert!(n >= 2, "expected startup and periodic heartbeats, got {n}");
    let v = last_version.lock().clone();
    assert!(!v.is_empty(), "heartbeat should carry a version string");
}
