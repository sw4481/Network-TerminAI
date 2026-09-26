use ccie_terminal_lib::recording::asciinema::CastWriter;

#[test]
fn writes_valid_asciinema_v2_header_and_events() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut w =
        CastWriter::create(tmp.path(), 120, 40, "xterm-256color", "/bin/zsh").unwrap();
    w.write_output(0.0, b"hello").unwrap();
    w.write_output(0.25, b" world\r\n").unwrap();
    let summary = w.finalize().unwrap();

    let content = std::fs::read_to_string(tmp.path()).unwrap();
    let lines: Vec<&str> = content.lines().collect();
    assert_eq!(lines.len(), 3);
    let header: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(header["version"], 2);
    assert_eq!(header["width"], 120);
    assert_eq!(header["height"], 40);
    assert_eq!(header["env"]["TERM"], "xterm-256color");

    let ev1: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(ev1[1], "o");
    assert_eq!(ev1[2], "hello");

    let ev2: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
    assert_eq!(ev2[2], " world\r\n");

    assert!(summary.size_bytes > 0);
    assert_eq!(summary.duration_ms, 250);
}
