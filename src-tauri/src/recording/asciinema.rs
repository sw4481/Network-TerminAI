//! asciinema v2 cast writer.
//!
//! Format reference (https://github.com/asciinema/asciinema/blob/develop/doc/asciicast-v2.md):
//! - Line 1: header object
//!   `{"version":2,"width":W,"height":H,"timestamp":<unix>,"env":{...}}`
//! - Lines 2+: event arrays `[<t_seconds_float>, "o"|"i", "<bytes>"]`.
//!
//! Each event is one line of NDJSON; the "o" channel encodes raw output
//! bytes as a JSON string (UTF-8). Bytes outside UTF-8 are best-effort
//! lossy-decoded — the asciinema spec assumes the cast represents what a
//! terminal renders.

use anyhow::{Context, Result};
use serde::Serialize;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
struct Header<'a> {
    version: u8,
    width: u16,
    height: u16,
    timestamp: u64,
    env: HeaderEnv<'a>,
}

#[derive(Serialize)]
struct HeaderEnv<'a> {
    #[serde(rename = "SHELL")]
    shell: &'a str,
    #[serde(rename = "TERM")]
    term: &'a str,
}

pub struct CastWriter {
    file: BufWriter<File>,
    path: PathBuf,
    size_bytes: u64,
    last_event_ms: u64,
}

impl CastWriter {
    pub fn create(
        path: &Path,
        width: u16,
        height: u16,
        term: &str,
        shell: &str,
    ) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("recording dir")?;
        }
        let f = File::create(path).context("create cast file")?;
        let mut w = BufWriter::new(f);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let header = Header {
            version: 2,
            width,
            height,
            timestamp,
            env: HeaderEnv { shell, term },
        };
        let line = serde_json::to_string(&header)?;
        w.write_all(line.as_bytes())?;
        w.write_all(b"\n")?;
        // Flush the header immediately so the file on disk is always a valid
        // asciicast even before the first output event or a clean stop. Without
        // this, a crash/restart mid-recording leaves a 0-byte file (the header
        // sits in the BufWriter and is lost).
        w.flush().context("flush cast header")?;
        let size_bytes = (line.len() + 1) as u64;
        Ok(Self {
            file: w,
            path: path.to_path_buf(),
            size_bytes,
            last_event_ms: 0,
        })
    }

    /// Append an output event at `t_seconds` since recording start.
    pub fn write_output(&mut self, t_seconds: f64, bytes: &[u8]) -> Result<()> {
        let s = String::from_utf8_lossy(bytes);
        let event = serde_json::json!([t_seconds, "o", s]);
        let line = serde_json::to_string(&event)?;
        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.size_bytes += (line.len() + 1) as u64;
        self.last_event_ms = (t_seconds * 1000.0) as u64;
        Ok(())
    }

    pub fn flush(&mut self) -> Result<()> {
        self.file.flush().context("flush cast")
    }

    pub fn finalize(mut self) -> Result<CastSummary> {
        self.file.flush().context("flush cast")?;
        Ok(CastSummary {
            path: self.path,
            size_bytes: self.size_bytes,
            duration_ms: self.last_event_ms,
        })
    }

    pub fn current_size(&self) -> u64 {
        self.size_bytes
    }

    pub fn last_event_ms(&self) -> u64 {
        self.last_event_ms
    }
}

#[derive(Debug, Clone)]
pub struct CastSummary {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub duration_ms: u64,
}
