//! Export a completed fan-out run as a zip bundle.
//!
//! Layout:
//! ```text
//! report.md            — markdown summary + per-device status table
//! manifest.json        — machine-readable run metadata
//! devices/<kind>_<name>.txt — raw stdout per successful device
//! ```

use crate::fanout::store::FanoutStore;
use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;
use zip::ZipWriter;

#[derive(Debug, Serialize)]
pub struct ExportManifest {
    pub run_id: String,
    pub command: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: String,
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub devices: Vec<ExportDeviceEntry>,
}

#[derive(Debug, Serialize)]
pub struct ExportDeviceEntry {
    pub display_name: String,
    pub device_kind: String,
    pub status: String,
    pub error: Option<String>,
    pub duration_ms: Option<i64>,
}

pub fn export_run_zip(conn: &Connection, run_id: &str, dest: &Path) -> Result<ExportManifest> {
    let detail = FanoutStore::get_run_detail(conn, run_id)?;
    let manifest = ExportManifest {
        run_id: detail.summary.id.clone(),
        command: detail.summary.command.clone(),
        started_at: detail.summary.started_at,
        ended_at: detail.summary.ended_at,
        status: detail.summary.status.clone(),
        total: detail.summary.total,
        succeeded: detail.summary.succeeded,
        failed: detail.summary.failed,
        devices: detail
            .devices
            .iter()
            .map(|d| ExportDeviceEntry {
                display_name: d.display_name.clone(),
                device_kind: d.device_kind.as_str().to_string(),
                status: d.status.clone(),
                error: d.error.clone(),
                duration_ms: match (d.started_at, d.ended_at) {
                    (Some(s), Some(e)) => Some((e - s) * 1000),
                    _ => None,
                },
            })
            .collect(),
    };

    let file = std::fs::File::create(dest).context("create zip dest")?;
    let mut zip = ZipWriter::new(file);
    let opts: SimpleFileOptions = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    zip.start_file("manifest.json", opts)?;
    serde_json::to_writer_pretty(&mut zip, &manifest)?;

    zip.start_file("report.md", opts)?;
    let report = render_report(&manifest);
    zip.write_all(report.as_bytes())?;

    for d in &detail.devices {
        if let Some(bid) = &d.block_id {
            let raw_bytes: Vec<u8> = conn
                .query_row(
                    "SELECT output FROM command_blocks WHERE id = ?1",
                    [bid],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            let path = format!(
                "devices/{}_{}.txt",
                d.device_kind.as_str(),
                sanitize_filename(&d.display_name)
            );
            zip.start_file(path, opts)?;
            zip.write_all(&raw_bytes)?;
        }
    }

    zip.finish()?;
    Ok(manifest)
}

fn render_report(m: &ExportManifest) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "# Fan-Out Run `{}`\n\n",
        m.run_id
    ));
    out.push_str(&format!("**Command:** `{}`\n\n", m.command.replace('`', "\\`")));
    out.push_str(&format!(
        "**Status:** {} ({}/{} succeeded, {} failed)\n\n",
        m.status, m.succeeded, m.total, m.failed
    ));
    out.push_str(&format!(
        "**Started:** {} \u{2014} **Ended:** {}\n\n",
        m.started_at,
        m.ended_at
            .map(|e| e.to_string())
            .unwrap_or_else(|| "(running)".to_string())
    ));
    out.push_str("## Per-device results\n\n");
    out.push_str("| Device | Kind | Status | Duration | Error |\n");
    out.push_str("|---|---|---|---|---|\n");
    for d in &m.devices {
        out.push_str(&format!(
            "| {} | {} | {} | {} | {} |\n",
            d.display_name,
            d.device_kind,
            d.status,
            d.duration_ms
                .map(|ms| format!("{ms} ms"))
                .unwrap_or_else(|| "—".to_string()),
            d.error.as_deref().unwrap_or("—").replace('|', "\\|"),
        ));
    }
    out
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => c,
            _ => '_',
        })
        .collect()
}
