use ccie_terminal_lib::recording::supervisor::RecordingDto;
use ccie_terminal_lib::transcript_export::{
    export_recording_text, render_cast_text, render_redacted_scrollback, write_redacted_scrollback,
};
use serde_json::json;
use std::path::Path;
use tempfile::TempDir;

fn cast(events: &[serde_json::Value]) -> String {
    let mut output = json!({
        "version": 2,
        "width": 120,
        "height": 40,
        "timestamp": 0,
        "env": {"SHELL": "/bin/zsh", "TERM": "xterm-256color"}
    })
    .to_string();
    output.push('\n');
    for event in events {
        output.push_str(&event.to_string());
        output.push('\n');
    }
    output
}

fn recording(path: &Path, ended: bool) -> RecordingDto {
    RecordingDto {
        id: "recording-1".to_string(),
        tab_id: "tab-1".to_string(),
        started_at: 0,
        ended_at: ended.then_some(1),
        path: path.to_string_lossy().to_string(),
        size_bytes: 0,
        duration_ms: 0,
        session_kind: "local".to_string(),
    }
}

#[test]
fn scrollback_export_redacts_strips_controls_and_normalizes_line_endings() {
    let input = b"\x1b[31menable secret 5 TESTSECRET\x1b[0m\r\n\x1b]0;title\x07ok\rnext\0\x08\n";
    let rendered = render_redacted_scrollback(input).unwrap();
    assert!(!rendered.contains("TESTSECRET"));
    let mut lines = rendered.lines();
    let redacted_line = lines.next().unwrap();
    assert!(redacted_line.starts_with("enable secret 5 "));
    assert!(redacted_line["enable secret 5 ".len()..]
        .chars()
        .all(|character| character == '*'));
    assert_eq!(lines.collect::<Vec<_>>(), vec!["ok", "next"]);
    assert!(!rendered.contains('\x1b'));
    assert!(!rendered.contains('\0'));
}

#[test]
fn scrollback_write_errors_propagate() {
    let tmp = TempDir::new().unwrap();
    let error = write_redacted_scrollback(b"hello", tmp.path()).unwrap_err();
    assert!(error.to_string().contains("write scrollback export"));
}

#[test]
fn cast_chunks_join_into_logical_lines_with_line_start_timestamps() {
    let input = cast(&[
        json!([0.100, "o", "show "]),
        json!([0.200, "o", "version\r"]),
        json!([0.300, "o", "\nnext"]),
        json!([0.400, "o", " line\npartial"]),
    ]);
    let rendered = render_cast_text(&input).unwrap();
    assert_eq!(
        rendered,
        concat!(
            "[1970-01-01T00:00:00.100Z] show version\n",
            "[1970-01-01T00:00:00.300Z] next line\n",
            "[1970-01-01T00:00:00.400Z] partial\n",
        )
    );
}

#[test]
fn ansi_osc_dcs_and_controls_are_removed_across_event_boundaries() {
    let input = cast(&[
        json!([0.100, "o", "\u{1b}[31"]),
        json!([0.200, "o", "mred\u{1b}[0m\u{1b}]0;title"]),
        json!([0.300, "o", "\u{1b}\\\u{1b}Pdiscard"]),
        json!([0.400, "o", "\u{1b}\\ok\u{0}\u{8}\n"]),
    ]);
    assert_eq!(
        render_cast_text(&input).unwrap(),
        "[1970-01-01T00:00:00.200Z] redok\n"
    );
}

#[test]
fn cr_lf_blank_lines_and_final_pending_cr_are_deterministic() {
    let input = cast(&[
        json!([0.100, "o", "first\r\n"]),
        json!([0.200, "o", "\n"]),
        json!([0.300, "o", "last\r"]),
    ]);
    assert_eq!(
        render_cast_text(&input).unwrap(),
        concat!(
            "[1970-01-01T00:00:00.100Z] first\n",
            "[1970-01-01T00:00:00.200Z] \n",
            "[1970-01-01T00:00:00.300Z] last\n",
        )
    );
}

#[test]
fn crlf_split_across_events_uses_the_cr_event_for_an_empty_line() {
    let input = cast(&[json!([0.100, "o", "\r"]), json!([0.200, "o", "\n"])]);
    assert_eq!(
        render_cast_text(&input).unwrap(),
        "[1970-01-01T00:00:00.100Z] \n"
    );
}

#[test]
fn non_output_channels_are_ignored() {
    let input = cast(&[
        json!([0.100, "i", "typed input"]),
        json!([0.200, "m", "marker"]),
        json!([0.300, "o", "visible\n"]),
    ]);
    assert_eq!(
        render_cast_text(&input).unwrap(),
        "[1970-01-01T00:00:00.300Z] visible\n"
    );
}

#[test]
fn malformed_headers_and_events_fail() {
    let invalid = [
        "",
        "{}\n",
        "{\"version\":1,\"timestamp\":0}\n",
        "{\"version\":2,\"timestamp\":-1}\n",
        "{\"version\":2,\"timestamp\":0}\nnot-json\n",
        "{\"version\":2,\"timestamp\":0}\n[0.1,\"o\"]\n",
        "{\"version\":2,\"timestamp\":0}\n[-0.1,\"o\",\"bad\"]\n",
        "{\"version\":2,\"timestamp\":0}\n[0.1,\"x\",\"bad\"]\n",
        "{\"version\":2,\"timestamp\":0}\n[1e400,\"o\",\"bad\"]\n",
    ];
    for input in invalid {
        assert!(
            render_cast_text(input).is_err(),
            "expected malformed cast to fail: {input:?}"
        );
    }
}

#[test]
fn missing_and_active_recordings_fail() {
    let tmp = TempDir::new().unwrap();
    let target = tmp.path().join("out.txt");
    assert_eq!(
        export_recording_text(None, &target)
            .unwrap_err()
            .to_string(),
        "recording not found"
    );
    let active = recording(&tmp.path().join("active.cast"), false);
    assert_eq!(
        export_recording_text(Some(&active), &target)
            .unwrap_err()
            .to_string(),
        "recording is still active"
    );
}

#[test]
#[allow(clippy::approx_constant)]
fn completed_recording_exports_without_reprocessing_the_cast() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("source.cast");
    let target = tmp.path().join("out.txt");
    std::fs::write(
        &source,
        cast(&[json!([0.318, "o", "show ip interface brief\n"])]),
    )
    .unwrap();
    let dto = recording(&source, true);
    export_recording_text(Some(&dto), &target).unwrap();
    assert_eq!(
        std::fs::read_to_string(target).unwrap(),
        "[1970-01-01T00:00:00.318Z] show ip interface brief\n"
    );
}

#[test]
fn parse_failure_does_not_overwrite_target_and_write_errors_propagate() {
    let tmp = TempDir::new().unwrap();
    let malformed = tmp.path().join("malformed.cast");
    let target = tmp.path().join("out.txt");
    std::fs::write(&malformed, "not a cast\n").unwrap();
    std::fs::write(&target, "keep me").unwrap();
    let dto = recording(&malformed, true);
    assert!(export_recording_text(Some(&dto), &target).is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep me");

    let valid = tmp.path().join("valid.cast");
    std::fs::write(&valid, cast(&[json!([0.0, "o", "ok\n"])])).unwrap();
    let dto = recording(&valid, true);
    assert!(export_recording_text(Some(&dto), tmp.path()).is_err());
}
