//! Vendor-aware capture command builder.
//!
//! Pure string-producer. Given a `CaptureSpec`, returns the exact lines the
//! orchestrator will send over SSH for the four supported vendors. Canonical
//! flows are documented in `docs/packet-capture/ios-xe-flow.md`.

use super::types::{CaptureScript, CaptureSpec, DeviceKind};
use anyhow::{anyhow, Result};

const MAX_DURATION_S: u32 = 3600;

fn sanitize_name(n: &str) -> String {
    n.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_uppercase()
        .chars()
        .take(15)
        .collect()
}

pub fn build(spec: &CaptureSpec) -> Result<CaptureScript> {
    if spec.interface.trim().is_empty() {
        return Err(anyhow!("interface is required"));
    }
    if spec.duration_s == 0 {
        return Err(anyhow!("duration_s must be > 0"));
    }
    if spec.duration_s > MAX_DURATION_S {
        return Err(anyhow!("duration_s must be <= {}", MAX_DURATION_S));
    }
    let name = sanitize_name(&spec.capture_name);
    if name.is_empty() {
        return Err(anyhow!("capture_name sanitized to empty"));
    }

    Ok(match spec.device_kind {
        DeviceKind::IosXe => build_iosxe(&name, spec),
        DeviceKind::Nxos => build_nxos(&name, spec),
        DeviceKind::Junos => build_junos(&name, spec),
        DeviceKind::Eos => build_eos(&name, spec),
        DeviceKind::Local => return Err(anyhow!("local captures are launched through dumpcap")),
    })
}

fn build_iosxe(name: &str, spec: &CaptureSpec) -> CaptureScript {
    // Default to `match any` (all L2/L3), not `match ipv4 any any`. Verified on
    // a live Catalyst 9000: `match ipv4 any any` only captures IPv4 transit and
    // returns an empty/near-empty file when the link carries non-IP frames
    // (ARP/STP/PTP/etc.) or no IPv4 in the window — the "0 packets" symptom.
    // `match any` captures everything, which is what a generic capture expects.
    let match_line = match &spec.acl {
        Some(acl) => format!("monitor capture {name} match access-list {acl}"),
        None => format!("monitor capture {name} match any"),
    };
    CaptureScript {
        setup: vec![
            format!("monitor capture {name} interface {} both", spec.interface),
            match_line,
            format!(
                "monitor capture {name} buffer circular size {}",
                spec.buffer_mb
            ),
            format!("monitor capture {name} limit duration {}", spec.duration_s),
        ],
        start: vec![format!("monitor capture {name} start")],
        // No poll: the capture auto-stops after `limit duration` (set in setup),
        // so the orchestrator waits duration+slack then stops — same as NX-OS /
        // Junos. The old `| include State` poll was fragile (the field is
        // `Status`, not `State`, on CAT9K and depends on platform formatting).
        poll: None,
        stop: vec![
            format!("monitor capture {name} stop"),
            // CAT9K / IOS-XE 17.x require the `location` keyword on export.
            // Verified against a live Catalyst 9000 (IOS-XE 17.19): bare
            // `export flash:CAP.pcap` returns "% Invalid input"; `export
            // location flash:CAP.pcap` returns "Export Started Successfully".
            format!(
                "monitor capture {name} export location {}",
                spec.on_device_path
            ),
        ],
        cleanup: vec![format!("no monitor capture {name}")],
        remote_pcap_path: spec.on_device_path.clone(),
    }
}

fn build_nxos(_name: &str, spec: &CaptureSpec) -> CaptureScript {
    let filter = spec
        .acl
        .as_ref()
        .map(|f| format!(r#" capture-filter "{f}""#))
        .unwrap_or_default();
    CaptureScript {
        setup: vec![],
        start: vec![format!(
            "ethanalyzer local interface {}{} limit-captured-frames 0 autostop duration {} write {}",
            spec.interface, filter, spec.duration_s, spec.on_device_path
        )],
        poll: None,
        stop: vec![],
        cleanup: vec![],
        remote_pcap_path: spec.on_device_path.clone(),
    }
}

fn build_junos(_name: &str, spec: &CaptureSpec) -> CaptureScript {
    CaptureScript {
        setup: vec![],
        start: vec![format!(
            "monitor traffic interface {} write-file {} size 65535 count 2000 no-resolve",
            spec.interface, spec.on_device_path,
        )],
        poll: None,
        stop: vec![],
        cleanup: vec![],
        remote_pcap_path: spec.on_device_path.clone(),
    }
}

fn build_eos(_name: &str, spec: &CaptureSpec) -> CaptureScript {
    CaptureScript {
        setup: vec![],
        start: vec![format!(
            "bash timeout {} sudo tcpdump -i {} -U -w {}",
            spec.duration_s, spec.interface, spec.on_device_path,
        )],
        poll: None,
        stop: vec![],
        cleanup: vec![],
        remote_pcap_path: spec.on_device_path.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(kind: DeviceKind, iface: &str, acl: Option<&str>, dur: u32) -> CaptureSpec {
        CaptureSpec {
            capture_name: "CAP".into(),
            device_kind: kind,
            interface: iface.into(),
            acl: acl.map(String::from),
            duration_s: dur,
            buffer_mb: 10,
            on_device_path: match kind {
                DeviceKind::IosXe => "flash:CAP.pcap".into(),
                DeviceKind::Nxos => "bootflash:CAP.pcap".into(),
                DeviceKind::Junos => "/var/tmp/CAP.pcap".into(),
                DeviceKind::Eos => "/mnt/flash/CAP.pcap".into(),
                DeviceKind::Local => String::new(),
            },
        }
    }

    #[test]
    fn iosxe_builds_17x_flow_no_acl() {
        let s = build(&spec(DeviceKind::IosXe, "GigabitEthernet0/0/1", None, 30)).unwrap();
        assert_eq!(
            s.setup,
            vec![
                "monitor capture CAP interface GigabitEthernet0/0/1 both",
                "monitor capture CAP match any",
                "monitor capture CAP buffer circular size 10",
                "monitor capture CAP limit duration 30",
            ],
        );
        assert_eq!(s.start, vec!["monitor capture CAP start"]);
        // IOS-XE auto-stops on the duration limit; no polling.
        assert_eq!(s.poll, None);
        assert_eq!(
            s.stop,
            vec![
                "monitor capture CAP stop",
                "monitor capture CAP export location flash:CAP.pcap",
            ]
        );
        assert_eq!(s.cleanup, vec!["no monitor capture CAP"]);
        assert_eq!(s.remote_pcap_path, "flash:CAP.pcap");
    }

    #[test]
    fn iosxe_uses_acl_when_provided() {
        let s = build(&spec(DeviceKind::IosXe, "Gi0/0/1", Some("MGMT_ACL"), 15)).unwrap();
        assert!(s
            .setup
            .iter()
            .any(|l| l == "monitor capture CAP match access-list MGMT_ACL"));
        assert!(s
            .setup
            .iter()
            .any(|l| l == "monitor capture CAP limit duration 15"));
    }

    #[test]
    fn nxos_ethanalyzer_single_line() {
        let s = build(&spec(DeviceKind::Nxos, "mgmt0", None, 30)).unwrap();
        assert!(s.setup.is_empty());
        assert_eq!(s.start, vec![
            "ethanalyzer local interface mgmt0 limit-captured-frames 0 autostop duration 30 write bootflash:CAP.pcap",
        ]);
        assert!(s.poll.is_none());
        assert_eq!(s.stop, Vec::<String>::new());
        assert_eq!(s.cleanup, Vec::<String>::new());
        assert_eq!(s.remote_pcap_path, "bootflash:CAP.pcap");
    }

    #[test]
    fn nxos_ethanalyzer_with_capture_filter() {
        let mut sp = spec(DeviceKind::Nxos, "mgmt0", None, 30);
        sp.acl = Some("host 10.1.1.1".into());
        let s = build(&sp).unwrap();
        assert_eq!(
            s.start,
            vec![
                r#"ethanalyzer local interface mgmt0 capture-filter "host 10.1.1.1" limit-captured-frames 0 autostop duration 30 write bootflash:CAP.pcap"#,
            ]
        );
    }

    #[test]
    fn junos_monitor_traffic_write_file() {
        let s = build(&spec(DeviceKind::Junos, "ge-0/0/0", None, 30)).unwrap();
        assert_eq!(
            s.start,
            vec![
                "monitor traffic interface ge-0/0/0 write-file /var/tmp/CAP.pcap size 65535 count 2000 no-resolve",
            ]
        );
        assert!(s.poll.is_none());
        assert_eq!(s.remote_pcap_path, "/var/tmp/CAP.pcap");
    }

    #[test]
    fn eos_tcpdump_via_bash() {
        let s = build(&spec(DeviceKind::Eos, "Ethernet1", None, 30)).unwrap();
        assert_eq!(
            s.start,
            vec!["bash timeout 30 sudo tcpdump -i Ethernet1 -U -w /mnt/flash/CAP.pcap",]
        );
    }

    #[test]
    fn capture_name_is_sanitized() {
        let mut sp = spec(DeviceKind::IosXe, "Gi0/0/1", None, 30);
        sp.capture_name = "my cap!".into();
        let s = build(&sp).unwrap();
        assert!(s.setup[0].contains("MYCAP"));
    }

    #[test]
    fn rejects_empty_interface() {
        let mut sp = spec(DeviceKind::IosXe, "", None, 30);
        sp.interface = "".into();
        assert!(build(&sp).is_err());
    }

    #[test]
    fn rejects_duration_zero() {
        let mut sp = spec(DeviceKind::IosXe, "Gi0/0/1", None, 0);
        sp.duration_s = 0;
        assert!(build(&sp).is_err());
    }

    #[test]
    fn rejects_duration_too_long() {
        let mut sp = spec(DeviceKind::IosXe, "Gi0/0/1", None, 4000);
        sp.duration_s = 4000;
        assert!(build(&sp).is_err());
    }
}
