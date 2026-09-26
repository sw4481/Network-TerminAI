// Smoke-test the packaged Python sidecar produced by
// `sidecar/scripts/build_sidecar.sh`. Skipped automatically when the build
// output isn't present (typical in CI before the sidecar build step runs).

use ccie_terminal_lib::bridge::SidecarSupervisor;
use std::path::PathBuf;

fn bundled_python() -> Option<(String, Vec<String>)> {
    let repo_root = match std::env::var("CCIE_REPO_ROOT") {
        Ok(p) => PathBuf::from(p),
        Err(_) => PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("CARGO_MANIFEST_DIR has a parent")
            .to_path_buf(),
    };
    let rel = if cfg!(windows) {
        "sidecar/dist/python/python.exe"
    } else {
        "sidecar/dist/python/bin/python3"
    };
    let py = repo_root.join(rel);
    if !py.is_file() {
        return None;
    }
    Some((
        py.to_string_lossy().into_owned(),
        vec!["-m".into(), "ccie_sidecar".into()],
    ))
}

#[test]
fn bundled_python_answers_ping() {
    let Some((cmd, args)) = bundled_python() else {
        eprintln!("SKIP: sidecar/dist/python not built (run sidecar/scripts/build_sidecar.sh)");
        return;
    };
    let sup = SidecarSupervisor::new(cmd, args);
    let resp = sup
        .call("ping", serde_json::json!({}))
        .expect("bundled sidecar ping");
    assert_eq!(resp.as_str(), Some("pong"));
    sup.shutdown();
}

#[test]
fn bundled_python_parses_show_version_via_genie() {
    let Some((cmd, args)) = bundled_python() else {
        eprintln!("SKIP: sidecar/dist/python not built");
        return;
    };
    let sup = SidecarSupervisor::new(cmd, args);
    let params = serde_json::json!({
        "vendor": "cisco",
        "platform": "iosxe",
        "command": "show version",
        "raw": "Cisco IOS XE Software, Version 17.09.04\ncisco CSR1000V (VXE) processor\n",
    });
    let resp = sup.call("parse.request", params).expect("parse.request");
    let parser = resp
        .get("parser")
        .and_then(|v| v.as_str())
        .expect("response has parser field");
    assert_eq!(parser, "genie", "expected Genie to handle iosxe show version");
    assert!(resp.get("data").is_some(), "missing data field");
    sup.shutdown();
}
