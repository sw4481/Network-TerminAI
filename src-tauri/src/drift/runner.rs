//! On-demand drift run: dispatch `show running-config` to each device the
//! intent's selector points at via Plan 07's fan-out executor, then for each
//! finished result render+normalize+diff and persist a `drift_reports` row.

use crate::drift::diff::diff_intent_vs_running;
use crate::drift::intent::{IntentRepo, IntentTemplate, MatchMode};
use crate::drift::normalize::{normalize, Vendor};
use crate::drift::presence::match_intent_presence;
use crate::drift::render::render_intent;
use crate::drift::report::{DriftReport, DriftReportRepo};
use crate::fanout::executor::{ExecuteArgs, Executor, MemberRef};
use crate::fanout::model::{DeviceKind, FanoutMember};
use crate::fanout::store::FanoutStore;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::sync::Arc;

/// Resolve the device set this template's selector targets.
///
/// Precedence (first non-empty wins):
///   1. `group_id`           — every member of the saved fan-out group.
///   2. `ssh_connection_id`  — one saved SSH connection.
///   3. `device_ids`         — legacy explicit `kind:id` token list.
///
/// The legacy `tags` field is no longer resolved: it matched against the
/// command-block tag vocabulary (Plan 01) via a join that was both
/// conceptually wrong for SSH-driven drift and literally a cartesian product.
/// Existing tag-only templates now resolve to an empty set; re-point them at a
/// group or connection.
pub fn resolve_selector(
    conn: &Connection,
    tpl: &IntentTemplate,
) -> Result<Vec<MemberRef>> {
    // 1. Fan-out group — expand to its members (reuses the canonical member
    //    listing so display names / device kinds stay consistent with the UI).
    if let Some(group_id) = tpl.selector.group_id.as_deref() {
        if !group_id.is_empty() {
            let members = FanoutStore::list_members(conn, group_id)?;
            return Ok(members
                .into_iter()
                .map(|m| MemberRef {
                    device_id: m.device_id,
                    device_kind: m.device_kind,
                    display_name: m.display_name,
                })
                .collect());
        }
    }

    // 2. Single saved SSH connection.
    if let Some(ssh_id) = tpl.selector.ssh_connection_id.as_deref() {
        if !ssh_id.is_empty() {
            let display = lookup_display_name(conn, DeviceKind::Ssh, ssh_id)?
                .unwrap_or_else(|| format!("ssh:{ssh_id}"));
            return Ok(vec![MemberRef {
                device_id: ssh_id.to_string(),
                device_kind: DeviceKind::Ssh,
                display_name: display,
            }]);
        }
    }

    // 3. Legacy explicit device_ids (`kind:id` composites or raw ssh uuids).
    if !tpl.selector.device_ids.is_empty() {
        let mut out = Vec::new();
        for raw in &tpl.selector.device_ids {
            let (kind, id) = parse_device_id_token(raw);
            let display = lookup_display_name(conn, kind, &id)?
                .unwrap_or_else(|| format!("{}:{}", kind.as_str(), id));
            out.push(MemberRef {
                device_id: id,
                device_kind: kind,
                display_name: display,
            });
        }
        return Ok(out);
    }

    Ok(Vec::new())
}

fn parse_device_id_token(raw: &str) -> (DeviceKind, String) {
    if let Some(rest) = raw.strip_prefix("ssh:") {
        return (DeviceKind::Ssh, rest.to_string());
    }
    if let Some(rest) = raw.strip_prefix("netconf:") {
        return (DeviceKind::Netconf, rest.to_string());
    }
    (DeviceKind::Ssh, raw.to_string())
}

fn lookup_display_name(
    conn: &Connection,
    kind: DeviceKind,
    id: &str,
) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    let name = match kind {
        DeviceKind::Ssh => conn
            .query_row(
                "SELECT name FROM ssh_connections WHERE id = ?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()?,
        DeviceKind::Netconf => {
            if let Ok(num) = id.parse::<i64>() {
                conn.query_row(
                    "SELECT name FROM netconf_devices WHERE id = ?1",
                    [num],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            } else {
                None
            }
        }
    };
    Ok(name)
}

/// Execute a fan-out, then build drift reports from each device's stdout.
pub async fn run_on_demand(
    db: Arc<Mutex<Connection>>,
    executor: Executor,
    template_id: &str,
) -> Result<Vec<DriftReport>> {
    let (tpl, members) = {
        let conn = db.lock();
        let tpl = IntentRepo::get(&conn, template_id)?
            .with_context(|| format!("intent {template_id} not found"))?;
        let members = resolve_selector(&conn, &tpl)?;
        (tpl, members)
    };

    if members.is_empty() {
        return Ok(Vec::new());
    }

    let args = ExecuteArgs {
        command: "show running-config".to_string(),
        group_id: None,
        members: members.clone(),
        timeout_ms: 60_000,
        concurrency: members.len().min(50),
    };
    let run_id = executor.spawn_run(args).await?;
    let _ = executor.await_run(&run_id).await?;

    // Read back per-device results and emit drift reports.
    let detail = {
        let conn = db.lock();
        FanoutStore::get_run_detail(&conn, &run_id)?
    };

    let vendor = Vendor::parse(&tpl.vendor, &tpl.platform);
    let intent_rendered = render_intent(&tpl, None)?;
    let intent_norm = normalize(vendor, &intent_rendered);

    let mut out = Vec::new();
    for d in &detail.devices {
        let conn = db.lock();
        if d.status == "success" {
            // Pull raw output from the persisted command_blocks row
            let raw: Option<Vec<u8>> = if let Some(bid) = &d.block_id {
                rusqlite::OptionalExtension::optional(conn.query_row(
                    "SELECT output FROM command_blocks WHERE id = ?1",
                    [bid],
                    |r| r.get::<_, Vec<u8>>(0),
                ))?
            } else {
                None
            };
            match raw {
                Some(bytes) => {
                    let raw_str = String::from_utf8_lossy(&bytes).into_owned();
                    let running_norm = normalize(vendor, &raw_str);
                    // Archive the normalized running-config (dedup + retention
                    // handled by the repo). Best-effort: a failure here must
                    // not abort the drift report.
                    if let Err(e) = crate::drift::archive::ConfigSnapshotRepo::insert(
                        &conn,
                        &d.device_id,
                        d.device_kind.as_str(),
                        &tpl.vendor,
                        &tpl.platform,
                        &running_norm,
                        "drift_run",
                    ) {
                        tracing::warn!(error = %e, device = %d.device_id, "config archive insert failed");
                    }
                    let patch = match tpl.match_mode {
                        MatchMode::Baseline => {
                            diff_intent_vs_running(&intent_norm, &running_norm)
                        }
                        MatchMode::Partial => {
                            match_intent_presence(&intent_norm, &running_norm)
                        }
                    };
                    let mut patch = patch;
                    if let Ok(excepted) =
                        crate::drift::exception::DriftExceptionRepo::active_lines(&conn, template_id)
                    {
                        if !excepted.is_empty() {
                            crate::drift::exception::apply_exceptions(&mut patch, &excepted, tpl.match_mode);
                        }
                    }
                    let report = DriftReportRepo::insert(
                        &conn,
                        template_id,
                        &d.device_id,
                        d.device_kind.as_str(),
                        Some(&patch),
                        None,
                    )?;
                    out.push(report);
                }
                None => {
                    let report = DriftReportRepo::insert(
                        &conn,
                        template_id,
                        &d.device_id,
                        d.device_kind.as_str(),
                        None,
                        Some("no output captured"),
                    )?;
                    out.push(report);
                }
            }
        } else {
            // failed / timeout / cancelled — record as error report
            let msg = d
                .error
                .clone()
                .unwrap_or_else(|| format!("device {} status={}", d.display_name, d.status));
            let report = DriftReportRepo::insert(
                &conn,
                template_id,
                &d.device_id,
                d.device_kind.as_str(),
                None,
                Some(&msg),
            )?;
            out.push(report);
        }
    }

    Ok(out)
}

// `FanoutMember` is referenced for type clarity; suppress unused-import lint.
#[allow(dead_code)]
fn _type_anchor(_m: &FanoutMember) {}
