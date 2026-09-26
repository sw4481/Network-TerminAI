//! Safe plain-text export helpers for terminal scrollback and asciinema casts.

use crate::recording::redactor::Redactor;
use crate::recording::supervisor::RecordingDto;
use anyhow::{anyhow, Context, Result};
use chrono::{SecondsFormat, TimeZone, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::fmt::Write as _;
use std::path::Path;

#[derive(Debug, Default)]
enum EscapeState {
    #[default]
    Ground,
    Escape,
    EscapeIntermediate,
    SingleShift,
    Csi,
    Osc {
        escape_seen: bool,
    },
    StringSequence {
        escape_seen: bool,
    },
}

#[derive(Debug, Default)]
struct AnsiStripper {
    state: EscapeState,
}

impl AnsiStripper {
    fn feed(&mut self, input: &str, mut emit: impl FnMut(char)) {
        for ch in input.chars() {
            let state = std::mem::take(&mut self.state);
            self.state = match state {
                EscapeState::Ground => {
                    if ch == '\u{1b}' {
                        EscapeState::Escape
                    } else if ch == '\r' || ch == '\n' || ch == '\t' {
                        emit(ch);
                        EscapeState::Ground
                    } else if ch.is_control() || ch == '\u{7f}' {
                        EscapeState::Ground
                    } else {
                        emit(ch);
                        EscapeState::Ground
                    }
                }
                EscapeState::Escape => match ch {
                    '[' => EscapeState::Csi,
                    ']' => EscapeState::Osc { escape_seen: false },
                    'P' | 'X' | '^' | '_' => EscapeState::StringSequence { escape_seen: false },
                    'N' | 'O' => EscapeState::SingleShift,
                    '\u{1b}' => EscapeState::Escape,
                    _ if ('\u{20}'..='\u{2f}').contains(&ch) => EscapeState::EscapeIntermediate,
                    _ => EscapeState::Ground,
                },
                EscapeState::EscapeIntermediate => {
                    if ch == '\u{1b}' {
                        EscapeState::Escape
                    } else if ('\u{30}'..='\u{7e}').contains(&ch) {
                        EscapeState::Ground
                    } else {
                        EscapeState::EscapeIntermediate
                    }
                }
                EscapeState::SingleShift => {
                    if ch == '\u{1b}' {
                        EscapeState::Escape
                    } else {
                        EscapeState::Ground
                    }
                }
                EscapeState::Csi => {
                    if ch == '\u{1b}' {
                        EscapeState::Escape
                    } else if ('\u{40}'..='\u{7e}').contains(&ch) {
                        EscapeState::Ground
                    } else {
                        EscapeState::Csi
                    }
                }
                EscapeState::Osc { escape_seen } => {
                    if ch == '\u{7}' || (escape_seen && ch == '\\') {
                        EscapeState::Ground
                    } else {
                        EscapeState::Osc {
                            escape_seen: ch == '\u{1b}',
                        }
                    }
                }
                EscapeState::StringSequence { escape_seen } => {
                    if escape_seen && ch == '\\' {
                        EscapeState::Ground
                    } else {
                        EscapeState::StringSequence {
                            escape_seen: ch == '\u{1b}',
                        }
                    }
                }
            };
        }
    }
}

fn normalize_plain_text(input: &str) -> String {
    let mut stripper = AnsiStripper::default();
    let mut output = String::with_capacity(input.len());
    let mut pending_cr = false;
    stripper.feed(input, |ch| {
        if pending_cr {
            output.push('\n');
            pending_cr = false;
            if ch == '\n' {
                return;
            }
        }
        if ch == '\r' {
            pending_cr = true;
        } else {
            output.push(ch);
        }
    });
    if pending_cr {
        output.push('\n');
    }
    output
}

/// Apply the recording Redactor's built-in patterns, then remove terminal
/// control sequences and normalize all line endings to LF.
pub fn render_redacted_scrollback(input: &[u8]) -> Result<String> {
    let mut redactor = Redactor::new(&[]).map_err(|error| anyhow!(error))?;
    let redacted = redactor.feed(input);
    Ok(normalize_plain_text(&String::from_utf8_lossy(&redacted)))
}

pub fn write_redacted_scrollback(input: &[u8], target: &Path) -> Result<()> {
    let rendered = render_redacted_scrollback(input)?;
    std::fs::write(target, rendered.as_bytes())
        .with_context(|| format!("write scrollback export {}", target.display()))
}

#[derive(Debug, Deserialize)]
struct CastHeader {
    version: u8,
    timestamp: i64,
}

#[derive(Debug, Default)]
struct TimestampedLineWriter {
    output: String,
    current: String,
    line_started_ms: Option<i64>,
    pending_cr_ms: Option<i64>,
}

impl TimestampedLineWriter {
    fn feed(&mut self, ch: char, event_ms: i64) -> Result<()> {
        if let Some(cr_ms) = self.pending_cr_ms.take() {
            self.flush_line(cr_ms)?;
            if ch == '\n' {
                return Ok(());
            }
        }

        match ch {
            '\r' => self.pending_cr_ms = Some(event_ms),
            '\n' => self.flush_line(event_ms)?,
            _ => {
                if self.line_started_ms.is_none() {
                    self.line_started_ms = Some(event_ms);
                }
                self.current.push(ch);
            }
        }
        Ok(())
    }

    fn flush_line(&mut self, delimiter_ms: i64) -> Result<()> {
        let timestamp_ms = self.line_started_ms.take().unwrap_or(delimiter_ms);
        let timestamp = format_timestamp(timestamp_ms)?;
        writeln!(&mut self.output, "[{timestamp}] {}", self.current)?;
        self.current.clear();
        Ok(())
    }

    fn finish(mut self) -> Result<String> {
        if let Some(cr_ms) = self.pending_cr_ms.take() {
            self.flush_line(cr_ms)?;
        }
        if !self.current.is_empty() {
            let timestamp_ms = self
                .line_started_ms
                .take()
                .ok_or_else(|| anyhow!("unterminated line has no timestamp"))?;
            let timestamp = format_timestamp(timestamp_ms)?;
            writeln!(&mut self.output, "[{timestamp}] {}", self.current)?;
        }
        Ok(self.output)
    }
}

fn format_timestamp(timestamp_ms: i64) -> Result<String> {
    let value = Utc
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .ok_or_else(|| anyhow!("timestamp is outside the supported range"))?;
    Ok(value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn event_timestamp_ms(header_ms: i64, offset: f64) -> Result<i64> {
    if !offset.is_finite() || offset < 0.0 {
        return Err(anyhow!("event offset must be finite and non-negative"));
    }
    let offset_ms = (offset * 1000.0).round();
    if !offset_ms.is_finite() || offset_ms > i64::MAX as f64 {
        return Err(anyhow!("event offset is outside the supported range"));
    }
    header_ms
        .checked_add(offset_ms as i64)
        .ok_or_else(|| anyhow!("event timestamp overflow"))
}

/// Convert an asciinema v2 cast into deterministic line-oriented text.
pub fn render_cast_text(input: &str) -> Result<String> {
    let mut lines = input.lines();
    let header_line = lines.next().ok_or_else(|| anyhow!("missing cast header"))?;
    let header: CastHeader = serde_json::from_str(header_line).context("parse cast header")?;
    if header.version != 2 {
        return Err(anyhow!("cast header version must be 2"));
    }
    if header.timestamp < 0 {
        return Err(anyhow!("cast header timestamp must be non-negative"));
    }
    let header_ms = header
        .timestamp
        .checked_mul(1000)
        .ok_or_else(|| anyhow!("cast header timestamp overflow"))?;
    format_timestamp(header_ms).context("validate cast header timestamp")?;

    let mut stripper = AnsiStripper::default();
    let mut writer = TimestampedLineWriter::default();
    for (index, line) in lines.enumerate() {
        let line_number = index + 2;
        if line.trim().is_empty() {
            return Err(anyhow!("empty cast event at line {line_number}"));
        }
        let event: Value = serde_json::from_str(line)
            .with_context(|| format!("parse cast event at line {line_number}"))?;
        let values = event
            .as_array()
            .filter(|values| values.len() == 3)
            .ok_or_else(|| anyhow!("invalid cast event at line {line_number}"))?;
        let offset = values[0]
            .as_f64()
            .ok_or_else(|| anyhow!("invalid cast event offset at line {line_number}"))?;
        let channel = values[1]
            .as_str()
            .ok_or_else(|| anyhow!("invalid cast event channel at line {line_number}"))?;
        if !matches!(channel, "o" | "i" | "m") {
            return Err(anyhow!("invalid cast event channel at line {line_number}"));
        }
        let data = values[2]
            .as_str()
            .ok_or_else(|| anyhow!("invalid cast event payload at line {line_number}"))?;
        let timestamp_ms = event_timestamp_ms(header_ms, offset)
            .with_context(|| format!("invalid cast event at line {line_number}"))?;
        if channel != "o" {
            continue;
        }
        let mut feed_error = None;
        stripper.feed(data, |ch| {
            if feed_error.is_none() {
                feed_error = writer.feed(ch, timestamp_ms).err();
            }
        });
        if let Some(error) = feed_error {
            return Err(error).with_context(|| format!("render cast event at line {line_number}"));
        }
    }
    writer.finish()
}

pub fn export_recording_text(recording: Option<&RecordingDto>, target: &Path) -> Result<()> {
    let recording = recording.ok_or_else(|| anyhow!("recording not found"))?;
    if recording.ended_at.is_none() {
        return Err(anyhow!("recording is still active"));
    }
    let cast = std::fs::read_to_string(&recording.path)
        .with_context(|| format!("read recording cast {}", recording.path))?;
    let rendered = render_cast_text(&cast)?;
    std::fs::write(target, rendered.as_bytes())
        .with_context(|| format!("write recording text export {}", target.display()))
}
