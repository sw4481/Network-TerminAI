//! OSC 133 (Final Term / iTerm2 semantic prompts) parser.
//!
//! Consumes raw PTY bytes, emits a stream of events:
//!   - `CommandStart { cmd }` when we see a `133;C` marker
//!   - `CommandEnd { exit_code }` when we see `133;D;<code>`
//!   - `Output(bytes)` for everything else
//!
//! # Design invariant (read this before touching `push_byte`)
//!
//! This parser is a **pass-through for display bytes**. Every printable byte
//! that arrives MUST end up in an `Output` event so xterm.js can render it.
//! OSC 133 markers are consumed as zero-width semantic events; they are the
//! ONLY thing we remove from the display stream. We must never withhold
//! ordinary output — doing so is what broke local echo: the TTY echoes typed
//! characters back as PTY output, and if the parser diverts those bytes the
//! user sees nothing as they type. (This mirrors how Warp/iTerm separate the
//! semantic layer from the display grid: markers are events, bytes are bytes.)
//!
//! Command text comes from the inline `133;C;<cmd>` payload that our shell
//! integration emits. For shells that use the buffered FinalTerm variant
//! (command typed between `B` and `C` with a bare `133;C`), we *tee* the
//! bytes into a capture buffer in addition to rendering them — capture is
//! additive and never removes anything from the display stream.
//!
//! TODO(phase-1.5): prompt-regex fallback for shells without OSC 133
//! (notably SSH into Cisco IOS — Router#, Switch(config)#, etc.).

#[derive(Debug, Clone)]
pub enum ParseEvent {
    Output(Vec<u8>),
    CommandStart {
        cmd: String,
    },
    CommandEnd {
        exit_code: Option<i32>,
    },
    /// Working directory reported by the shell via OSC 7 (`\e]7;file://host/path\a`).
    /// Emitted on every prompt so the tab's live cwd tracks `cd`.
    Cwd(String),
    /// The application switched to the alternate screen buffer
    /// (`\e[?1049h`, or legacy `\e[?1047h` / `\e[?47h`). Emitted when a
    /// full-screen TUI (claude, codex, vim, top, less, …) takes over the
    /// screen. Used to suppress the "command running" indicator, which would
    /// otherwise stay pinned for the whole TUI session (a long-lived foreground
    /// process never emits OSC 133 `D` until it exits).
    EnterAltScreen,
    /// The application restored the primary screen buffer
    /// (`\e[?1049l` / `\e[?1047l` / `\e[?47l`). The TUI has exited.
    ExitAltScreen,
}

#[derive(Debug)]
enum State {
    Normal,
    /// Saw `\x1b`; may be the start of an OSC or CSI.
    Esc,
    /// Saw `\x1b]`; reading the OSC body until BEL or ST.
    Osc,
    /// Inside an OSC body and saw `\x1b`; a following `\` is the ST terminator.
    OscEsc,
    /// Saw `\x1b[`; reading a CSI sequence until its final byte (0x40..=0x7e).
    /// Bytes are passed through verbatim AND buffered so we can recognize
    /// private-mode set/reset sequences (alt-screen) without consuming them.
    Csi,
}

pub struct Parser {
    state: State,
    /// Buffer for the body of an OSC sequence (between `\x1b]` and BEL/ST).
    osc_buf: Vec<u8>,
    /// True between a `133;B` (prompt end) and the next `133;C`/`133;D`.
    /// Used only for the buffered FinalTerm fallback; capture is non-destructive.
    capturing_cmd: bool,
    cmd_buf: Vec<u8>,
    /// Buffer for the body of a CSI sequence (between `\x1b[` and the final
    /// byte). Used only to recognize alt-screen private modes; the bytes are
    /// also passed through to the display stream.
    csi_buf: Vec<u8>,
    /// Pending plain output bytes (flushed when we emit an event or at end of feed).
    out_buf: Vec<u8>,
}

impl Parser {
    pub fn new() -> Self {
        Self {
            state: State::Normal,
            osc_buf: Vec::new(),
            capturing_cmd: false,
            cmd_buf: Vec::new(),
            csi_buf: Vec::new(),
            out_buf: Vec::new(),
        }
    }

    pub fn feed(&mut self, input: &[u8]) -> Vec<ParseEvent> {
        let mut events = Vec::new();
        let mut i = 0;
        while i < input.len() {
            let b = input[i];
            match self.state {
                State::Normal => {
                    if b == 0x1b {
                        self.state = State::Esc;
                    } else {
                        self.push_byte(b);
                    }
                    i += 1;
                }
                State::Esc => match b {
                    b']' => {
                        self.state = State::Osc;
                        self.osc_buf.clear();
                        i += 1;
                    }
                    b'[' => {
                        // CSI. Pass the intro bytes through (display is
                        // unaffected) but buffer the body so we can recognize
                        // the alt-screen private modes. The final byte is
                        // handled in State::Csi.
                        self.push_byte(0x1b);
                        self.push_byte(b'[');
                        self.csi_buf.clear();
                        self.state = State::Csi;
                        i += 1;
                    }
                    0x1b => {
                        // Collapse a run of ESCs; stay in Esc.
                        i += 1;
                    }
                    _ => {
                        // Not an OSC or CSI (e.g. ESC c reset, charset
                        // selection). Pass the ESC and this byte straight
                        // through so the rest of the escape sequence renders.
                        self.push_byte(0x1b);
                        self.push_byte(b);
                        self.state = State::Normal;
                        i += 1;
                    }
                },
                State::Csi => {
                    // Always pass the byte through to the display stream.
                    self.push_byte(b);
                    // A CSI sequence ends at its final byte in 0x40..=0x7e.
                    // Parameter/intermediate bytes (0x20..=0x3f) are buffered.
                    if (0x40..=0x7e).contains(&b) {
                        self.handle_csi_final(b, &mut events);
                        self.csi_buf.clear();
                        self.state = State::Normal;
                    } else {
                        self.csi_buf.push(b);
                    }
                    i += 1;
                }
                State::Osc => match b {
                    0x07 => {
                        // BEL terminator
                        self.handle_osc(&mut events);
                        self.osc_buf.clear();
                        self.state = State::Normal;
                        i += 1;
                    }
                    0x1b => {
                        // Possible ST terminator (ESC \). Defer decision.
                        self.state = State::OscEsc;
                        i += 1;
                    }
                    _ => {
                        self.osc_buf.push(b);
                        i += 1;
                    }
                },
                State::OscEsc => {
                    if b == b'\\' {
                        // ST terminator (ESC \).
                        self.handle_osc(&mut events);
                        self.osc_buf.clear();
                        self.state = State::Normal;
                        i += 1;
                    } else {
                        // The ESC did not begin an ST — it aborts the OSC and
                        // starts a NEW escape sequence. Terminate the stale OSC,
                        // then hand control to Esc (the ESC is consumed) and
                        // reprocess this byte there WITHOUT advancing i, so the
                        // new sequence's intro byte isn't lost. This also stops
                        // an unterminated OSC from swallowing the stream forever.
                        self.handle_osc(&mut events);
                        self.osc_buf.clear();
                        self.state = State::Esc;
                    }
                }
            }
        }
        self.flush_output(&mut events);
        events
    }

    /// Push a display byte. ALWAYS lands in the output stream; additionally
    /// tee'd into the command-capture buffer when capturing (non-destructive).
    fn push_byte(&mut self, b: u8) {
        self.out_buf.push(b);
        if self.capturing_cmd {
            self.cmd_buf.push(b);
        }
    }

    fn flush_output(&mut self, events: &mut Vec<ParseEvent>) {
        if !self.out_buf.is_empty() {
            let buf = std::mem::take(&mut self.out_buf);
            events.push(ParseEvent::Output(buf));
        }
    }

    /// Inspect a completed CSI sequence (final byte already pushed to output)
    /// for the alternate-screen private modes. `csi_buf` holds the body between
    /// `\x1b[` and the final byte, e.g. `?1049` for `\x1b[?1049h`.
    ///
    /// We emit a zero-width semantic event but do NOT alter the byte stream —
    /// xterm.js still receives the full sequence and performs the screen swap.
    fn handle_csi_final(&mut self, final_byte: u8, events: &mut Vec<ParseEvent>) {
        // Only DEC private modes (`?` prefix) with set (`h`) / reset (`l`).
        if final_byte != b'h' && final_byte != b'l' {
            return;
        }
        let body = match std::str::from_utf8(&self.csi_buf) {
            Ok(s) => s,
            Err(_) => return,
        };
        let Some(params) = body.strip_prefix('?') else {
            return;
        };
        // A single CSI can set/reset multiple modes: `\x1b[?1049;1h`.
        let is_alt = params
            .split(';')
            .any(|p| matches!(p, "1049" | "1047" | "47"));
        if !is_alt {
            return;
        }
        // Emit any pending output BEFORE the semantic event so ordering with
        // surrounding bytes is preserved (mirrors handle_osc).
        self.flush_output(events);
        if final_byte == b'h' {
            events.push(ParseEvent::EnterAltScreen);
        } else {
            events.push(ParseEvent::ExitAltScreen);
        }
    }

    fn handle_osc(&mut self, events: &mut Vec<ParseEvent>) {
        let body = std::str::from_utf8(&self.osc_buf).unwrap_or("").to_string();
        if let Some(rest) = body.strip_prefix("133;") {
            // Emit any pending output BEFORE the lifecycle event so ordering
            // between Output and CommandStart/End is preserved.
            self.flush_output(events);
            match rest.chars().next() {
                Some('A') => { /* prompt start — ignore */ }
                Some('B') => {
                    // Prompt end. Begin (non-destructive) capture in case the
                    // shell uses the buffered variant where the command flows
                    // as plain bytes before a bare `133;C`.
                    self.capturing_cmd = true;
                    self.cmd_buf.clear();
                }
                Some('C') => {
                    // Two supported forms:
                    //   inline   -> "133;C;<cmd>"  (our zsh/bash integration)
                    //   buffered -> "133;C"        (command tee'd between B and C)
                    let inline = rest.split_once(';').map(|x| x.1).unwrap_or("");
                    let cmd = if !inline.is_empty() {
                        inline.to_string()
                    } else if self.capturing_cmd {
                        clean_command(&String::from_utf8_lossy(&self.cmd_buf))
                    } else {
                        String::new()
                    };
                    self.capturing_cmd = false;
                    self.cmd_buf.clear();
                    events.push(ParseEvent::CommandStart { cmd });
                }
                Some('D') => {
                    // Defensive: D always ends capture state, even if C was missed.
                    self.capturing_cmd = false;
                    self.cmd_buf.clear();
                    let exit_code = rest.split(';').nth(1).and_then(|s| s.parse::<i32>().ok());
                    events.push(ParseEvent::CommandEnd { exit_code });
                }
                _ => { /* unknown 133; subcommand — ignore */ }
            }
        } else if let Some(rest) = body.strip_prefix("7;") {
            // OSC 7 — working directory report. Body is `file://<host>/<path>`
            // (or occasionally a bare path). Emit a Cwd event with the decoded
            // filesystem path so the tab's live cwd follows `cd`. This is a
            // zero-width semantic event (not re-emitted to xterm).
            self.flush_output(events);
            if let Some(path) = parse_osc7_path(rest) {
                events.push(ParseEvent::Cwd(path));
            }
        } else {
            // Unrelated OSC (window title OSC 0/2, hyperlinks OSC 8, clipboard
            // OSC 52, etc.). Re-emit it verbatim (BEL-terminated) so xterm.js
            // can act on it. Previously these were silently dropped, which
            // broke window titles and hyperlinks.
            let osc = std::mem::take(&mut self.osc_buf);
            self.out_buf.push(0x1b);
            self.out_buf.push(b']');
            self.out_buf.extend_from_slice(&osc);
            self.out_buf.push(0x07);
        }
    }
}

impl Default for Parser {
    fn default() -> Self {
        Self::new()
    }
}

/// Clean command text by removing ANSI escape sequences, control characters,
/// and bracket-paste markers. Used only for the buffered FinalTerm fallback.
fn clean_command(raw: &str) -> String {
    let mut result = String::new();
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            // ESC - skip escape sequence
            i += 1;
            if i < bytes.len() && bytes[i] == b'[' {
                // CSI - skip until we hit a letter
                i += 1;
                while i < bytes.len() && !(bytes[i] as char).is_ascii_alphabetic() {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1; // skip the final letter
                }
            } else if i < bytes.len() && bytes[i] == b']' {
                // OSC - skip until BEL or ST
                while i < bytes.len() && bytes[i] != 0x07 {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1; // skip BEL
                }
            } else {
                i += 1;
            }
        } else if b < 0x20 && b != b'\n' && b != b'\t' {
            // Control character - skip
            i += 1;
        } else {
            result.push(b as char);
            i += 1;
        }
    }
    result.trim().to_string()
}

/// Decode an OSC 7 body into a filesystem path.
///
/// The standard form is `file://<host>/<path>`; we also accept a bare
/// `/absolute/path`. Percent-encoded octets in the path are decoded (so paths
/// with spaces survive). Returns `None` if no usable path is present.
fn parse_osc7_path(body: &str) -> Option<String> {
    let raw = if let Some(after) = body.strip_prefix("file://") {
        // Strip the authority component (everything up to the first '/').
        let idx = after.find('/')?;
        &after[idx..]
    } else if body.starts_with('/') {
        body
    } else {
        return None;
    };
    let decoded = percent_decode(raw);
    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

/// Minimal percent-decoder for OSC 7 paths (avoids a dependency). Leaves any
/// malformed `%` escape untouched.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cwds(input: &str) -> Vec<String> {
        let mut p = Parser::new();
        p.feed(input.as_bytes())
            .into_iter()
            .filter_map(|e| match e {
                ParseEvent::Cwd(path) => Some(path),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn osc7_file_uri_with_host() {
        assert_eq!(
            cwds("\x1b]7;file://myhost/tmp/tf-drift-test\x07"),
            vec!["/tmp/tf-drift-test".to_string()]
        );
    }

    #[test]
    fn osc7_file_uri_empty_host() {
        assert_eq!(
            cwds("\x1b]7;file:///opt/example/infra\x07"),
            vec!["/opt/example/infra".to_string()]
        );
    }

    #[test]
    fn osc7_percent_decoded_path() {
        assert_eq!(
            cwds("\x1b]7;file://h/tmp/has%20space\x07"),
            vec!["/tmp/has space".to_string()]
        );
    }

    #[test]
    fn osc7_bare_path() {
        assert_eq!(cwds("\x1b]7;/var/log\x07"), vec!["/var/log".to_string()]);
    }

    #[test]
    fn osc7_does_not_leak_into_output() {
        // The OSC 7 sequence must be consumed, not re-emitted to the terminal.
        let mut p = Parser::new();
        let events = p.feed(b"before\x1b]7;file://h/x\x07after");
        let out: Vec<u8> = events
            .into_iter()
            .filter_map(|e| match e {
                ParseEvent::Output(b) => Some(b),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(String::from_utf8_lossy(&out), "beforeafter");
    }

    #[test]
    fn osc133_still_parses_alongside_osc7() {
        let mut p = Parser::new();
        let events = p.feed(b"\x1b]7;file://h/tmp\x07\x1b]133;C;ls\x07");
        let mut saw_cwd = false;
        let mut saw_cmd = false;
        for e in events {
            match e {
                ParseEvent::Cwd(p) if p == "/tmp" => saw_cwd = true,
                ParseEvent::CommandStart { cmd } if cmd == "ls" => saw_cmd = true,
                _ => {}
            }
        }
        assert!(
            saw_cwd && saw_cmd,
            "both OSC 7 cwd and OSC 133 command must parse"
        );
    }

    fn output_of(input: &[u8]) -> Vec<u8> {
        let mut p = Parser::new();
        p.feed(input)
            .into_iter()
            .filter_map(|e| match e {
                ParseEvent::Output(b) => Some(b),
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn has_event(events: &[ParseEvent], want: fn(&ParseEvent) -> bool) -> bool {
        events.iter().any(want)
    }

    #[test]
    fn alt_screen_enter_emits_event_for_1049h() {
        let mut p = Parser::new();
        let events = p.feed(b"\x1b[?1049h");
        assert!(
            has_event(&events, |e| matches!(e, ParseEvent::EnterAltScreen)),
            "ESC[?1049h must emit EnterAltScreen"
        );
    }

    #[test]
    fn alt_screen_exit_emits_event_for_1049l() {
        let mut p = Parser::new();
        let events = p.feed(b"\x1b[?1049l");
        assert!(
            has_event(&events, |e| matches!(e, ParseEvent::ExitAltScreen)),
            "ESC[?1049l must emit ExitAltScreen"
        );
    }

    #[test]
    fn alt_screen_legacy_modes_1047_and_47() {
        for seq in [b"\x1b[?1047h".as_slice(), b"\x1b[?47h".as_slice()] {
            let mut p = Parser::new();
            let events = p.feed(seq);
            assert!(
                has_event(&events, |e| matches!(e, ParseEvent::EnterAltScreen)),
                "legacy alt-screen enter mode must emit EnterAltScreen"
            );
        }
        for seq in [b"\x1b[?1047l".as_slice(), b"\x1b[?47l".as_slice()] {
            let mut p = Parser::new();
            let events = p.feed(seq);
            assert!(
                has_event(&events, |e| matches!(e, ParseEvent::ExitAltScreen)),
                "legacy alt-screen exit mode must emit ExitAltScreen"
            );
        }
    }

    #[test]
    fn alt_screen_bytes_still_passed_through_to_xterm() {
        // The escape MUST still reach xterm.js so it actually switches screens.
        // The semantic event is additive, not a replacement.
        assert_eq!(output_of(b"\x1b[?1049h"), b"\x1b[?1049h".to_vec());
        assert_eq!(output_of(b"\x1b[?1049l"), b"\x1b[?1049l".to_vec());
    }

    #[test]
    fn unrelated_csi_does_not_emit_alt_screen_and_passes_through() {
        // SGR color reset and a cursor move must pass through untouched and
        // produce no alt-screen events.
        let mut p = Parser::new();
        let events = p.feed(b"\x1b[0m\x1b[2J\x1b[?25l");
        assert!(
            !has_event(&events, |e| matches!(
                e,
                ParseEvent::EnterAltScreen | ParseEvent::ExitAltScreen
            )),
            "ordinary CSI must not be misread as alt-screen"
        );
        assert_eq!(
            output_of(b"\x1b[0m\x1b[2J\x1b[?25l"),
            b"\x1b[0m\x1b[2J\x1b[?25l".to_vec()
        );
    }

    #[test]
    fn alt_screen_split_across_feeds() {
        // PTY reads chop sequences arbitrarily; the CSI parser must hold state.
        let mut p = Parser::new();
        let mut events = p.feed(b"\x1b[?10");
        events.extend(p.feed(b"49h"));
        assert!(
            has_event(&events, |e| matches!(e, ParseEvent::EnterAltScreen)),
            "alt-screen enter split across two feeds must still be detected"
        );
    }
}
