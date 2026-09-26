use ccie_terminal_lib::command_parser::{ParseEvent, Parser};

fn osc133(code: char, payload: Option<&str>) -> String {
    match payload {
        Some(p) => format!("\x1b]133;{};{}\x07", code, p),
        None => format!("\x1b]133;{}\x07", code),
    }
}

#[test]
fn emits_no_events_for_plain_bytes() {
    let mut p = Parser::new();
    let events = p.feed(b"hello world\n");
    assert!(
        !events.iter().any(|e| matches!(
            e,
            ParseEvent::CommandStart { .. } | ParseEvent::CommandEnd { .. }
        )),
        "got: {events:?}"
    );
    let bytes: Vec<u8> = events
        .iter()
        .flat_map(|e| match e {
            ParseEvent::Output(b) => b.clone(),
            _ => Vec::new(),
        })
        .collect();
    assert_eq!(bytes, b"hello world\n");
}

#[test]
fn detects_full_command_lifecycle() {
    let mut p = Parser::new();
    let mut events = Vec::new();

    let s = format!(
        "{}{}{}{}",
        osc133('A', None),
        osc133('B', None),
        "ls -la\n",
        osc133('C', None),
    );
    events.extend(p.feed(s.as_bytes()));
    events.extend(p.feed(b"total 48\n"));
    events.extend(p.feed(osc133('D', Some("0")).as_bytes()));

    let names: Vec<&str> = events
        .iter()
        .map(|e| match e {
            ParseEvent::CommandStart { .. } => "start",
            ParseEvent::CommandEnd { .. } => "end",
            ParseEvent::Output(_) => "out",
            ParseEvent::Cwd(_) => "cwd",
            ParseEvent::EnterAltScreen => "alt_enter",
            ParseEvent::ExitAltScreen => "alt_exit",
        })
        .collect();

    assert!(names.contains(&"start"), "expected start: {names:?}");
    assert!(names.contains(&"end"), "expected end: {names:?}");

    let start = events
        .iter()
        .find_map(|e| match e {
            ParseEvent::CommandStart { cmd, .. } => Some(cmd.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(start.trim(), "ls -la");

    let end_exit = events
        .iter()
        .find_map(|e| match e {
            ParseEvent::CommandEnd { exit_code, .. } => Some(*exit_code),
            _ => None,
        })
        .unwrap();
    assert_eq!(end_exit, Some(0));
}

#[test]
fn handles_split_osc_across_chunks() {
    let mut p = Parser::new();
    let first = format!(
        "{}{}echo hi\n\x1b]133",
        osc133('A', None),
        osc133('B', None)
    );
    let second = ";C\x07output\n";

    let mut events = Vec::new();
    events.extend(p.feed(first.as_bytes()));
    events.extend(p.feed(second.as_bytes()));

    assert!(events
        .iter()
        .any(|e| matches!(e, ParseEvent::CommandStart { .. })));
}

#[test]
fn handles_missing_exit_code() {
    let mut p = Parser::new();
    let s = format!(
        "{}{}pwd\n{}{}",
        osc133('A', None),
        osc133('B', None),
        osc133('C', None),
        osc133('D', None)
    );
    let events = p.feed(s.as_bytes());
    let end_exit = events
        .iter()
        .find_map(|e| match e {
            ParseEvent::CommandEnd { exit_code, .. } => Some(*exit_code),
            _ => None,
        })
        .unwrap();
    assert_eq!(end_exit, None);
}

#[test]
fn ignores_unrelated_osc_escapes() {
    let mut p = Parser::new();
    // OSC 0 (set window title) — should pass through without lifecycle events.
    let events = p.feed(b"\x1b]0;my title\x07hello\n");
    assert!(!events.iter().any(|e| matches!(
        e,
        ParseEvent::CommandStart { .. } | ParseEvent::CommandEnd { .. }
    )));
}

/// Collect all `Output` bytes from a list of events.
fn output_bytes(events: &[ParseEvent]) -> Vec<u8> {
    events
        .iter()
        .flat_map(|e| match e {
            ParseEvent::Output(b) => b.clone(),
            _ => Vec::new(),
        })
        .collect()
}

/// THE REGRESSION TEST. zsh emits `133;B` at the end of every prompt, so the
/// window between B and the next C is exactly when the user is typing and the
/// TTY is echoing their keystrokes back as PTY output. Those bytes MUST be
/// rendered — diverting them is what made typed characters invisible.
#[test]
fn renders_bytes_typed_between_prompt_end_and_command_start() {
    let mut p = Parser::new();
    let mut events = Vec::new();
    // Prompt drawn, prompt-end marker, then the TTY echoes "ls -la" as the
    // user types, then Enter fires the inline C marker.
    events.extend(p.feed(b"user@host % "));
    events.extend(p.feed(osc133('B', None).as_bytes()));
    events.extend(p.feed(b"ls -la")); // <-- echoed keystrokes
    events.extend(p.feed(osc133('C', Some("ls -la")).as_bytes()));

    let rendered = output_bytes(&events);
    assert!(
        rendered.windows(6).any(|w| w == b"ls -la"),
        "typed characters must be rendered to xterm, got: {:?}",
        String::from_utf8_lossy(&rendered)
    );
}

/// Non-133 OSC sequences (window title, OSC 8 hyperlinks, OSC 52 clipboard)
/// must be re-emitted so xterm.js can act on them.
#[test]
fn passes_through_unrelated_osc_to_output() {
    let mut p = Parser::new();
    let events = p.feed(b"\x1b]0;my title\x07hello\n");
    let rendered = output_bytes(&events);
    assert_eq!(rendered, b"\x1b]0;my title\x07hello\n");
}

/// OSC terminated by ST (ESC \) instead of BEL must not hang the parser or
/// swallow the following output.
#[test]
fn handles_st_terminated_osc() {
    let mut p = Parser::new();
    // 133;A terminated with ST, then plain output.
    let events = p.feed(b"\x1b]133;A\x1b\\after-st\n");
    let rendered = output_bytes(&events);
    assert_eq!(rendered, b"after-st\n");
}

/// An ESC inside an OSC body that is NOT an ST must terminate the stale OSC
/// and the following escape sequence must still be processed.
#[test]
fn osc_esc_that_is_not_st_recovers() {
    let mut p = Parser::new();
    // OSC 133;A, then ESC[31m (a color CSI, not ST), then text.
    let events = p.feed(b"\x1b]133;A\x1b[31mred\n");
    let rendered = output_bytes(&events);
    // The CSI color sequence and the text must survive.
    assert_eq!(rendered, b"\x1b[31mred\n");
}

/// CSI cursor-movement / redraw sequences (what Tab completion emits) must
/// pass through untouched.
#[test]
fn passes_through_csi_sequences() {
    let mut p = Parser::new();
    // Save cursor, clear line, restore — typical completion redraw.
    let input = b"\x1b7\x1b[2K\x1b[1G\x1b8done";
    let events = p.feed(input);
    let rendered = output_bytes(&events);
    assert_eq!(rendered, input);
}
