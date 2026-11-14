//! Saved Network Architect investigations. No PTY, bridge or continuation ownership.
use crate::session::Tab;
use anyhow::{bail, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const RUN_KEYS: &[&str] = &[
    "workspace_id",
    "run_id",
    "status",
    "started_at",
    "ended_at",
    "scope",
    "coverage",
];
const EVENT_KEYS: &[&str] = &[
    "type",
    "version",
    "workspace_id",
    "run_id",
    "seq",
    "kind",
    "payload",
];

pub struct CanvasRepository<'a> {
    conn: &'a Connection,
}
impl<'a> CanvasRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    fn workspace(&self, id: &str) -> Result<Tab> {
        self.conn.query_row(
            "SELECT id,title,shell_cmd,cwd,created_at,tab_type FROM tabs WHERE id=? AND tab_type='canvas'",
            [id], tab_row,
        ).optional()?.ok_or_else(|| anyhow::anyhow!("Unknown Canvas workspace"))
    }

    pub fn create_workspace(&self, title: &str) -> Result<Tab> {
        valid_title(title)?;
        let id = uuid::Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO tabs (id,title,shell_cmd,cwd,tab_type) VALUES (?,?,'','','canvas')",
            params![id, title],
        )?;
        self.workspace(&id)
    }

    pub fn rename_workspace(&self, id: &str, title: &str) -> Result<()> {
        valid_title(title)?;
        self.workspace(id)?;
        self.conn.execute(
            "UPDATE tabs SET title=? WHERE id=? AND tab_type='canvas'",
            params![title, id],
        )?;
        Ok(())
    }

    pub fn list_workspaces(&self) -> Result<Vec<Tab>> {
        let mut statement = self.conn.prepare("SELECT id,title,shell_cmd,cwd,created_at,tab_type FROM tabs WHERE tab_type='canvas' ORDER BY created_at,id")?;
        let rows = statement
            .query_map([], tab_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn open_workspace(&self, id: &str) -> Result<Value> {
        let tab = self.workspace(id)?;
        // Opening is data-only: no orphan cleanup, PTY or approval continuation.
        self.conn.execute(
            "UPDATE tabs SET closed_at=NULL WHERE id=? AND tab_type='canvas'",
            [id],
        )?;
        let runs = self.runs(id)?;
        let evidence = json_rows(self.conn, "SELECT e.snapshot_json FROM copilot_canvas_evidence e JOIN copilot_canvas_runs r ON r.id=e.run_id WHERE r.tab_id=? ORDER BY e.rowid", id)?;
        let cards = json_rows(self.conn, "SELECT c.card_json FROM copilot_canvas_cards c JOIN copilot_canvas_runs r ON r.id=c.run_id WHERE r.tab_id=? ORDER BY c.rowid", id)?;
        let warnings = json_rows(
            self.conn,
            "SELECT warnings_json FROM copilot_canvas_runs WHERE tab_id=? ORDER BY rowid",
            id,
        )?
        .into_iter()
        .flat_map(|v| v.as_array().cloned().unwrap_or_default())
        .collect::<Vec<_>>();
        Ok(json!({"tab":tab,"runs":runs,"evidence":evidence,"cards":cards,"warnings":warnings}))
    }

    fn runs(&self, id: &str) -> Result<Vec<Value>> {
        let mut stmt = self.conn.prepare("SELECT id,status,started_at,ended_at,scope_json,coverage_json FROM copilot_canvas_runs WHERE tab_id=? ORDER BY rowid")?;
        let rows = stmt
            .query_map([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(|(run_id,status,started_at,ended_at,scope,coverage)| Ok(json!({"workspace_id":id,"run_id":run_id,"status":status,"started_at":started_at,"ended_at":ended_at,"scope":serde_json::from_str::<Value>(&scope)?,"coverage":serde_json::from_str::<Value>(&coverage)?}))).collect()
    }

    pub fn save_run(&self, id: &str, run: &Value) -> Result<()> {
        self.workspace(id)?;
        shape(run, RUN_KEYS)?;
        bounded(run)?;
        ensure!(run["workspace_id"] == id, "Run workspace mismatch");
        let run_id = text(&run["run_id"])?;
        ensure!(!run_id.is_empty(), "Empty run ID");
        let status = text(&run["status"])?;
        ensure!(
            matches!(
                status,
                "collecting"
                    | "awaiting_approval"
                    | "completed"
                    | "failed"
                    | "cancelled"
                    | "interrupted"
            ),
            "Invalid run status"
        );
        timestamp(&run["started_at"])?;
        if live(status) {
            ensure!(
                run["ended_at"].is_null(),
                "Live run cannot have an end time"
            );
        } else {
            timestamp(&run["ended_at"])?;
            ensure!(
                chrono::DateTime::parse_from_rfc3339(text(&run["ended_at"])?)?
                    >= chrono::DateTime::parse_from_rfc3339(text(&run["started_at"])?)?,
                "Run ends before it starts"
            );
        }
        let tx = self.conn.unchecked_transaction()?;
        let mut snapshots = BTreeMap::new();
        for s in json_rows(
            &tx,
            "SELECT snapshot_json FROM copilot_canvas_evidence WHERE run_id=? ORDER BY rowid",
            run_id,
        )? {
            snapshots.insert(text(&s["evidence_id"])?.to_string(), s);
        }
        collect_refs(&run["coverage"], &snapshots, &mut BTreeSet::new())?;
        let owner: Option<String> = tx
            .query_row(
                "SELECT tab_id FROM copilot_canvas_runs WHERE id=?",
                [run_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(owner) = owner {
            ensure!(owner == id, "Run belongs to another workspace");
            let old = self
                .runs(id)?
                .into_iter()
                .find(|r| r["run_id"] == run_id)
                .unwrap();
            let mut normalized = run.clone();
            if run["coverage"].is_null() && !old["coverage"].is_null() {
                normalized["coverage"] = old["coverage"].clone();
            }
            if !live(text(&old["status"])?) {
                ensure!(old == normalized, "Finished run is immutable");
                return Ok(());
            }
            ensure!(
                old["started_at"] == run["started_at"],
                "Run start is immutable"
            );
            // Event coverage is newer than a potentially delayed status save.
            let coverage = if old["coverage"].is_null() {
                &run["coverage"]
            } else {
                &old["coverage"]
            };
            tx.execute("UPDATE copilot_canvas_runs SET status=?,ended_at=?,scope_json=?,coverage_json=? WHERE id=?",params![status,run["ended_at"].as_str(),run["scope"].to_string(),coverage.to_string(),run_id])?;
        } else {
            ensure!(live(status), "New run must be live");
            tx.execute("INSERT INTO copilot_canvas_runs (id,tab_id,status,started_at,scope_json,coverage_json) VALUES (?,?,?,?,?,?)",params![run_id,id,status,text(&run["started_at"])?,run["scope"].to_string(),run["coverage"].to_string()])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn save_event(&self, id: &str, event: &Value) -> Result<()> {
        self.workspace(id)?;
        validate_event(event)?;
        ensure!(event["workspace_id"] == id, "Event workspace mismatch");
        let run_id = text(&event["run_id"])?;
        let tx = self.conn.unchecked_transaction()?;
        let (owner,status,hashes,warnings): (String,String,String,String) = tx.query_row("SELECT tab_id,status,event_hashes_json,warnings_json FROM copilot_canvas_runs WHERE id=?",[run_id],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or_else(||anyhow::anyhow!("Unknown Canvas run"))?;
        ensure!(owner == id, "Run belongs to another workspace");
        let seq = event["seq"].as_u64().unwrap();
        let mut hashes: BTreeMap<u64, String> = serde_json::from_str(&hashes)?;
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(event)?));
        if let Some(old) = hashes.get(&seq) {
            ensure!(*old == digest, "Conflicting event sequence");
            return Ok(());
        }
        ensure!(live(&status), "Cannot append to a finished run");
        ensure!(
            hashes.keys().next_back().is_none_or(|last| seq > *last),
            "Out of order Canvas event"
        );
        let payload = &event["payload"];
        match text(&event["kind"])? {
            "card" => {
                shape(payload, &["card", "snapshots"])?;
                let card = &payload["card"];
                let mut snapshots = BTreeMap::new();
                for s in json_rows(&tx,"SELECT snapshot_json FROM copilot_canvas_evidence WHERE run_id=? ORDER BY rowid",run_id)? { snapshots.insert(text(&s["evidence_id"])?.to_string(),s); }
                for s in array(&payload["snapshots"])? {
                    validate_snapshot(s, id, run_id)?;
                    let evidence_id = text(&s["evidence_id"])?;
                    if let Some(old) = snapshots.insert(evidence_id.to_string(), s.clone()) {
                        ensure!(old == *s, "Conflicting evidence ID");
                    }
                    let existing: Option<(String, String)> = tx
                        .query_row(
                            "SELECT run_id,snapshot_json FROM copilot_canvas_evidence WHERE id=?",
                            [evidence_id],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()?;
                    if let Some((owner, json)) = existing {
                        ensure!(
                            owner == run_id && serde_json::from_str::<Value>(&json)? == *s,
                            "Evidence ID belongs to another run or has changed"
                        );
                    }
                }
                validate_card(card, id, run_id, &snapshots)?;
                let mut needed = BTreeSet::new();
                collect_refs(card, &snapshots, &mut needed)?;
                // Retain transitive derived ancestry, never unrelated discovery snapshots.
                let mut pending: Vec<(String, bool)> =
                    needed.iter().map(|id| (id.clone(), false)).collect();
                let mut active = BTreeSet::new();
                let mut checked = BTreeSet::new();
                while let Some((evidence_id, exit)) = pending.pop() {
                    if exit {
                        active.remove(&evidence_id);
                        checked.insert(evidence_id);
                        continue;
                    }
                    if checked.contains(&evidence_id) {
                        continue;
                    }
                    ensure!(
                        active.insert(evidence_id.clone()),
                        "Cyclic evidence ancestry"
                    );
                    pending.push((evidence_id.clone(), true));
                    for parent in array(&snapshots[&evidence_id]["parent_refs"])? {
                        resolve(parent, &snapshots)?;
                        let parent_id = text(&parent["evidence_id"])?;
                        ensure!(!active.contains(parent_id), "Cyclic evidence ancestry");
                        needed.insert(parent_id.to_string());
                        pending.push((parent_id.to_string(), false));
                    }
                }
                for evidence_id in needed {
                    let s = &snapshots[&evidence_id];
                    tx.execute("INSERT INTO copilot_canvas_evidence (id,run_id,snapshot_json) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",params![evidence_id,run_id,s.to_string()])?;
                }
                let card_id = text(&card["card_id"])?;
                let old: Option<(String, String)> = tx
                    .query_row(
                        "SELECT run_id,card_json FROM copilot_canvas_cards WHERE id=?",
                        [card_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if let Some((owner, json)) = old {
                    ensure!(
                        owner == run_id && serde_json::from_str::<Value>(&json)? == *card,
                        "Conflicting card ID"
                    );
                } else {
                    tx.execute("INSERT INTO copilot_canvas_cards (id,run_id,insertion_order,card_json) VALUES (?,?,?,?)",params![card_id,run_id,seq,card.to_string()])?;
                }
            }
            "coverage" => {
                ensure!(payload.is_object(), "Invalid coverage");
                let mut snapshots = BTreeMap::new();
                for s in json_rows(&tx,"SELECT snapshot_json FROM copilot_canvas_evidence WHERE run_id=? ORDER BY rowid",run_id)? { snapshots.insert(text(&s["evidence_id"])?.to_string(),s); }
                collect_refs(payload, &snapshots, &mut BTreeSet::new())?;
                tx.execute(
                    "UPDATE copilot_canvas_runs SET coverage_json=? WHERE id=?",
                    params![payload.to_string(), run_id],
                )?;
            }
            "warning" => {
                ensure!(
                    payload.is_object() && payload.get("limitation").is_some_and(Value::is_string),
                    "Invalid warning"
                );
                let mut warnings: Vec<Value> = serde_json::from_str(&warnings)?;
                // A clipped warning snapshot is temporary, not evidence backing a saved card.
                let mut warning = event.clone();
                warning["payload"] = json!({"limitation":payload["limitation"]});
                warnings.push(warning);
                tx.execute(
                    "UPDATE copilot_canvas_runs SET warnings_json=? WHERE id=?",
                    params![serde_json::to_string(&warnings)?, run_id],
                )?;
            }
            _ => unreachable!(),
        }
        hashes.insert(seq, digest);
        tx.execute(
            "UPDATE copilot_canvas_runs SET event_hashes_json=? WHERE id=?",
            params![serde_json::to_string(&hashes)?, run_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Called once at process startup, before any agent turn can be created.
    pub fn interrupt_orphan_runs(&self) -> Result<usize> {
        Ok(self.conn.execute("UPDATE copilot_canvas_runs SET status='interrupted',ended_at=? WHERE status IN ('collecting','awaiting_approval')",[chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)])?)
    }
}

fn tab_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Tab> {
    Ok(Tab {
        id: row.get(0)?,
        title: row.get(1)?,
        shell_cmd: row.get(2)?,
        cwd: row.get(3)?,
        created_at: row.get(4)?,
        tab_type: row.get(5)?,
    })
}
fn json_rows(conn: &Connection, sql: &str, id: &str) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|s| Ok(serde_json::from_str(&s)?))
        .collect()
}
fn valid_title(title: &str) -> Result<()> {
    ensure!(!title.trim().is_empty(), "Canvas title cannot be empty");
    Ok(())
}
fn live(status: &str) -> bool {
    matches!(status, "collecting" | "awaiting_approval")
}
fn bounded(value: &Value) -> Result<()> {
    ensure!(
        serde_json::to_vec(value)?.len() <= MAX_BYTES,
        "Canvas payload exceeded the 2 MiB bound"
    );
    Ok(())
}
fn shape(value: &Value, keys: &[&str]) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Expected Canvas object"))?;
    ensure!(
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)),
        "Invalid Canvas fields"
    );
    Ok(())
}
fn text(value: &Value) -> Result<&str> {
    value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Expected Canvas string"))
}
fn array(value: &Value) -> Result<&Vec<Value>> {
    value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Expected Canvas array"))
}
fn texts(value: &Value) -> Result<()> {
    for v in array(value)? {
        text(v)?;
    }
    Ok(())
}
fn timestamp(value: &Value) -> Result<()> {
    let s = text(value)?;
    ensure!(s.ends_with('Z'), "Canvas timestamp must be UTC");
    chrono::DateTime::parse_from_rfc3339(s)?;
    Ok(())
}

pub fn validate_event(event: &Value) -> Result<()> {
    shape(event, EVENT_KEYS)?;
    bounded(&event["payload"])?;
    ensure!(
        event["type"] == "canvas" && event["version"].as_u64() == Some(1),
        "Unsupported Canvas version"
    );
    ensure!(
        !text(&event["workspace_id"])?.is_empty() && !text(&event["run_id"])?.is_empty(),
        "Missing Canvas ownership"
    );
    ensure!(
        event["seq"]
            .as_u64()
            .is_some_and(|seq| seq > 0 && seq <= 9_007_199_254_740_991),
        "Invalid Canvas sequence"
    );
    ensure!(
        matches!(text(&event["kind"])?, "card" | "coverage" | "warning"),
        "Invalid Canvas event kind"
    );
    Ok(())
}
fn validate_snapshot(s: &Value, workspace: &str, run: &str) -> Result<()> {
    shape(
        s,
        &[
            "evidence_id",
            "workspace_id",
            "run_id",
            "call_id",
            "collected_at",
            "source",
            "origin",
            "complete",
            "limitation",
            "data",
            "parent_refs",
            "calculation",
        ],
    )?;
    bounded(s)?;
    ensure!(
        s["workspace_id"] == workspace && s["run_id"] == run,
        "Foreign evidence"
    );
    ensure!(
        !text(&s["evidence_id"])?.is_empty() && !text(&s["call_id"])?.is_empty(),
        "Missing evidence identity"
    );
    timestamp(&s["collected_at"])?;
    let source = s["source"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Invalid evidence source"))?;
    ensure!(
        source
            .keys()
            .all(|k| matches!(k.as_str(), "helper" | "resource" | "arguments"))
            && !text(&s["source"]["helper"])?.is_empty(),
        "Invalid evidence source"
    );
    if let Some(resource) = source.get("resource") {
        text(resource)?;
    }
    let complete = s["complete"]
        .as_bool()
        .ok_or_else(|| anyhow::anyhow!("Invalid evidence completeness"))?;
    ensure!(
        if complete {
            s["limitation"].is_null()
        } else {
            s["limitation"].is_string()
        },
        "Invalid evidence limitation"
    );
    let parents = array(&s["parent_refs"])?;
    match text(&s["origin"])? {
        "derived" => ensure!(
            !parents.is_empty() && !text(&s["calculation"])?.trim().is_empty(),
            "Missing derived ancestry"
        ),
        "observed" | "execution_output" | "agent_authored" => ensure!(
            parents.is_empty() && s["calculation"].is_null(),
            "Unexpected derived ancestry"
        ),
        _ => bail!("Invalid evidence origin"),
    }
    for parent in parents {
        shape(parent, &["evidence_id", "path"])?;
        text(&parent["evidence_id"])?;
        text(&parent["path"])?;
    }
    Ok(())
}
fn resolve<'a>(reference: &Value, snapshots: &'a BTreeMap<String, Value>) -> Result<&'a Value> {
    shape(reference, &["evidence_id", "path"])?;
    let s = snapshots
        .get(text(&reference["evidence_id"])?)
        .ok_or_else(|| anyhow::anyhow!("Missing evidence"))?;
    ensure!(s["complete"] == true, "Incomplete evidence");
    let path = text(&reference["path"])?;
    ensure!(
        path.is_empty() || path.starts_with('/'),
        "Invalid JSON Pointer"
    );
    for part in path.split('/').skip(1) {
        let mut chars = part.chars();
        while let Some(c) = chars.next() {
            if c == '~' {
                ensure!(
                    matches!(chars.next(), Some('0' | '1')),
                    "Invalid JSON Pointer escape"
                );
            }
        }
        let key = part.replace("~1", "/").replace("~0", "~");
        ensure!(
            !matches!(key.as_str(), "__proto__" | "prototype" | "constructor"),
            "Unsafe JSON property"
        );
    }
    s["data"]
        .pointer(path)
        .ok_or_else(|| anyhow::anyhow!("Missing evidence path"))
}
fn collect_refs(
    value: &Value,
    snapshots: &BTreeMap<String, Value>,
    ids: &mut BTreeSet<String>,
) -> Result<()> {
    if let Some(object) = value.as_object() {
        if object.contains_key("evidence_id") && object.contains_key("path") {
            resolve(value, snapshots)?;
            ids.insert(text(&value["evidence_id"])?.to_string());
        } else {
            for v in object.values() {
                collect_refs(v, snapshots, ids)?;
            }
        }
    } else if let Some(values) = value.as_array() {
        for v in values {
            collect_refs(v, snapshots, ids)?;
        }
    }
    Ok(())
}
fn topology_id(value: &Value) -> Result<(Option<&str>, u64)> {
    if let Some(text) = value.as_str() {
        return Ok((Some(text), 0));
    }
    let number = value
        .as_f64()
        .ok_or_else(|| anyhow::anyhow!("Topology identifier must be scalar"))?;
    ensure!(number.is_finite(), "Topology identifier must be finite");
    // Match JavaScript Number identity, including rounded integers and signed zero.
    Ok((None, if number == 0.0 { 0 } else { number.to_bits() }))
}
fn validate_card(
    c: &Value,
    workspace: &str,
    run: &str,
    snapshots: &BTreeMap<String, Value>,
) -> Result<()> {
    shape(
        c,
        &[
            "type",
            "title",
            "source_refs",
            "metadata",
            "card_id",
            "workspace_id",
            "run_id",
            "created_at",
        ],
    )?;
    ensure!(
        c["workspace_id"] == workspace && c["run_id"] == run,
        "Foreign card"
    );
    ensure!(
        !text(&c["card_id"])?.is_empty() && !text(&c["title"])?.trim().is_empty(),
        "Invalid card identity/title"
    );
    timestamp(&c["created_at"])?;
    let refs = |v: &Value| -> Result<()> {
        for r in array(v)? {
            resolve(r, snapshots)?;
        }
        Ok(())
    };
    refs(&c["source_refs"])?;
    ensure!(
        !array(&c["source_refs"])?.is_empty(),
        "Missing card sources"
    );
    let scalar = |v: &Value| -> Result<()> {
        let resolved = resolve(v, snapshots)?;
        ensure!(
            resolved.is_string() || resolved.is_number(),
            "Observed identifier must be scalar"
        );
        Ok(())
    };
    let assessment = |v: &Value| -> Result<()> {
        refs(&v["supporting_refs"])?;
        refs(&v["contradictory_refs"])?;
        texts(&v["unknowns"])?;
        texts(&v["remediation_considerations"])?;
        Ok(())
    };
    let m = &c["metadata"];
    match text(&c["type"])? {
        "text" => {
            shape(m, &["body"])?;
            resolve(&m["body"], snapshots)?;
        }
        "key_value" => {
            shape(m, &["fields"])?;
            ensure!(!array(&m["fields"])?.is_empty(), "Empty projection");
            for field in array(&m["fields"])? {
                shape(field, &["label", "ref"])?;
                text(&field["label"])?;
                resolve(&field["ref"], snapshots)?;
            }
        }
        "table" => {
            shape(m, &["columns", "rows"])?;
            ensure!(
                !array(&m["columns"])?.is_empty() && !array(&m["rows"])?.is_empty(),
                "Empty projection"
            );
            let mut keys = Vec::new();
            for column in array(&m["columns"])? {
                shape(column, &["key", "label"])?;
                text(&column["label"])?;
                let key = text(&column["key"])?;
                ensure!(!keys.contains(&key), "Duplicate column");
                keys.push(key);
            }
            for row in array(&m["rows"])? {
                shape(row, &["cells"])?;
                shape(&row["cells"], &keys)?;
                for key in &keys {
                    resolve(&row["cells"][*key], snapshots)?;
                }
            }
        }
        "chart" => {
            shape(m, &["form", "x_label", "y_label", "points"])?;
            ensure!(
                m["form"] == "bar" || m["form"] == "line",
                "Unsupported chart form"
            );
            text(&m["x_label"])?;
            text(&m["y_label"])?;
            ensure!(!array(&m["points"])?.is_empty(), "Empty projection");
            for point in array(&m["points"])? {
                shape(point, &["label", "value"])?;
                scalar(&point["label"])?;
                ensure!(
                    resolve(&point["value"], snapshots)?.is_number(),
                    "Chart needs numeric evidence"
                );
            }
        }
        "topology" => {
            shape(m, &["nodes", "links"])?;
            ensure!(!array(&m["nodes"])?.is_empty(), "Empty projection");
            let mut ids = BTreeSet::new();
            for node in array(&m["nodes"])? {
                shape(node, &["id"])?;
                scalar(&node["id"])?;
                ensure!(
                    ids.insert(topology_id(resolve(&node["id"], snapshots)?)?),
                    "Duplicate topology node"
                );
            }
            for link in array(&m["links"])? {
                shape(link, &["from", "to", "relationship"])?;
                scalar(&link["from"])?;
                scalar(&link["to"])?;
                let from = resolve(&link["from"], snapshots)?;
                let to = resolve(&link["to"], snapshots)?;
                ensure!(
                    ids.contains(&topology_id(from)?) && ids.contains(&topology_id(to)?),
                    "Topology link endpoint missing"
                );
                let relationship = resolve(&link["relationship"], snapshots)?;
                shape(relationship, &["from", "to"])?;
                ensure!(
                    matches!(
                        text(&snapshots[text(&link["relationship"]["evidence_id"])?]["origin"])?,
                        "observed" | "agent_authored"
                    ) && topology_id(&relationship["from"])? == topology_id(from)?
                        && topology_id(&relationship["to"])? == topology_id(to)?,
                    "Topology requires matching observed or agent-authored relationship"
                );
            }
        }
        "findings" => {
            shape(m, &["findings"])?;
            ensure!(!array(&m["findings"])?.is_empty(), "Empty projection");
            for finding in array(&m["findings"])? {
                shape(
                    finding,
                    &[
                        "device",
                        "interface",
                        "symptom",
                        "severity",
                        "cause_assessment",
                        "supporting_refs",
                        "contradictory_refs",
                        "unknowns",
                        "remediation_considerations",
                    ],
                )?;
                scalar(&finding["device"])?;
                scalar(&finding["interface"])?;
                text(&finding["symptom"])?;
                assessment(finding)?;
                ensure!(
                    matches!(text(&finding["severity"])?, "critical" | "warning" | "info")
                        && matches!(
                            text(&finding["cause_assessment"])?,
                            "evidence_supported" | "likely" | "undetermined"
                        ),
                    "Invalid finding assessment"
                );
            }
        }
        "assessment" => {
            shape(
                m,
                &[
                    "narrative",
                    "supporting_refs",
                    "contradictory_refs",
                    "unknowns",
                    "remediation_considerations",
                ],
            )?;
            text(&m["narrative"])?;
            assessment(m)?;
        }
        _ => bail!("Unsupported card type"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open_and_migrate_to(&dir.path().join("synthetic.db"), 96).unwrap();
        (dir, conn)
    }
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/copilot_canvas/v1.json")).unwrap()
    }
    fn run(id: &str, run_id: &str) -> Value {
        json!({"workspace_id":id,"run_id":run_id,"status":"collecting",
            "started_at":"2026-10-25T12:00:00Z","ended_at":null,"scope":null,"coverage":null})
    }
    fn event(id: &str, run_id: &str, index: usize) -> Value {
        let f = fixture();
        let mut card = f["cards"][index].clone();
        card["card_id"] = json!(format!("card-{index}"));
        card["workspace_id"] = json!(id);
        card["run_id"] = json!(run_id);
        card["created_at"] = json!("2026-10-25T12:00:02Z");
        let mut snapshots = f["snapshots"].clone();
        for s in snapshots.as_array_mut().unwrap() {
            s["workspace_id"] = json!(id);
            s["run_id"] = json!(run_id);
        }
        json!({"type":"canvas","version":1,"workspace_id":id,"run_id":run_id,
            "seq":index+1,"kind":"card","payload":{"card":card,"snapshots":snapshots}})
    }

    #[test]
    fn copilot_canvas_roundtrips_authored_tables_and_graphs_without_relabeling_observations() {
        for index in [1, 4] {
            let (_dir, conn) = db();
            let repo = CanvasRepository::new(&conn);
            let tab = repo.create_workspace("Authored presentation").unwrap();
            repo.save_run(&tab.id, &run(&tab.id, "run-authored"))
                .unwrap();
            let mut ev = event(&tab.id, "run-authored", index);
            for snapshot in ev["payload"]["snapshots"].as_array_mut().unwrap() {
                snapshot["origin"] = json!("agent_authored");
            }
            repo.save_event(&tab.id, &ev).unwrap();
            let reopened = repo.open_workspace(&tab.id).unwrap();
            assert_eq!(reopened["cards"][0], ev["payload"]["card"]);
            assert!(reopened["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["origin"] == "agent_authored"));
        }
    }

    #[test]
    fn copilot_canvas_rejects_duplicate_nodes_and_dangling_graph_links() {
        for duplicate in [true, false] {
            let (_dir, conn) = db();
            let repo = CanvasRepository::new(&conn);
            let tab = repo.create_workspace("Invalid graph").unwrap();
            repo.save_run(&tab.id, &run(&tab.id, "run-invalid-graph"))
                .unwrap();
            let mut ev = event(&tab.id, "run-invalid-graph", 4);
            let nodes = ev["payload"]["card"]["metadata"]["nodes"]
                .as_array_mut()
                .unwrap();
            if duplicate {
                nodes.push(nodes[0].clone());
            } else {
                nodes.pop();
            }
            assert!(
                repo.save_event(&tab.id, &ev).is_err(),
                "ambiguous graph was accepted"
            );
            assert_eq!(repo.open_workspace(&tab.id).unwrap()["cards"], json!([]));
        }
    }

    #[test]
    fn copilot_canvas_rejects_bad_contract_references_and_oversized_events() {
        let (_dir, conn) = db();
        let repo = CanvasRepository::new(&conn);
        let tab = repo.create_workspace("Synthetic").unwrap();
        repo.save_run(&tab.id, &run(&tab.id, "run-1")).unwrap();
        let valid = event(&tab.id, "run-1", 1);
        let mut cases = Vec::new();
        let mut ev = valid.clone();
        ev["version"] = json!(2);
        cases.push(ev);
        let mut ev = valid.clone();
        ev["seq"] = json!(0);
        cases.push(ev);
        let mut ev = valid.clone();
        ev["extra"] = json!(true);
        cases.push(ev);
        let mut ev = valid.clone();
        ev["payload"]["card"]["metadata"]["rows"][0]["cells"]["errors"] = json!(123);
        cases.push(ev);
        for pointer in [
            "/missing",
            "/devices/0/~2",
            "/__proto__",
            "/devices/01",
            "devices[0]",
        ] {
            let mut ev = valid.clone();
            ev["payload"]["card"]["source_refs"][0]["path"] = json!(pointer);
            cases.push(ev);
        }
        let mut ev = valid.clone();
        ev["payload"]["snapshots"][0]["complete"] = json!(false);
        ev["payload"]["snapshots"][0]["limitation"] = json!("clipped");
        cases.push(ev);
        let mut ev = valid.clone();
        ev["payload"]["snapshots"][0]["origin"] = json!("model_claim");
        cases.push(ev);
        let mut ev = valid.clone();
        ev["payload"]["card"]["title"] = json!("x".repeat(MAX_BYTES));
        cases.push(ev);
        for ev in cases {
            assert!(
                repo.save_event(&tab.id, &ev).is_err(),
                "accepted malformed event"
            );
        }
        let snapshot = repo.open_workspace(&tab.id).unwrap();
        assert_eq!(snapshot["cards"], json!([]));
        assert_eq!(snapshot["evidence"], json!([]));
    }

    #[test]
    fn copilot_canvas_accepts_near_limit_producer_payload_without_counting_envelope() {
        let (_dir, conn) = db();
        let repo = CanvasRepository::new(&conn);
        let tab = repo.create_workspace("Synthetic").unwrap();
        let run_id = "00000000-0000-4000-8000-000000000002";
        repo.save_run(&tab.id, &run(&tab.id, run_id)).unwrap();
        let mut ev = event(&tab.id, run_id, 0);
        ev["payload"]["snapshots"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
        ev["payload"]["snapshots"][0]["data"]["padding"] = json!("");
        // Leave room for the producer's default JSON separators, not the transport envelope.
        let remaining = MAX_BYTES - 128 - serde_json::to_vec(&ev["payload"]).unwrap().len();
        ev["payload"]["snapshots"][0]["data"]["padding"] = json!("x".repeat(remaining));
        assert!(serde_json::to_vec(&ev["payload"]).unwrap().len() <= MAX_BYTES);
        assert!(serde_json::to_vec(&ev).unwrap().len() > MAX_BYTES);
        validate_event(&ev).expect("producer-compatible payload was rejected by envelope overhead");
        repo.save_event(&tab.id, &ev).unwrap();
        let restored = repo.open_workspace(&tab.id).unwrap();
        assert_eq!(restored["cards"][0], ev["payload"]["card"]);
        assert_eq!(restored["evidence"], ev["payload"]["snapshots"]);
        ev["payload"]["snapshots"][0]["data"]["padding"] = json!("x".repeat(MAX_BYTES));
        assert!(
            validate_event(&ev).is_err(),
            "oversized payload was accepted"
        );
    }

    #[test]
    fn copilot_canvas_rejects_cyclic_ancestry_and_foreign_coverage_refs() {
        let (_dir, conn) = db();
        let repo = CanvasRepository::new(&conn);
        let tab = repo.create_workspace("Synthetic").unwrap();
        repo.save_run(&tab.id, &run(&tab.id, "run-1")).unwrap();
        let mut ev = event(&tab.id, "run-1", 0);
        for (index, parent) in [(0, "evidence-b"), (1, "evidence-a")] {
            ev["payload"]["snapshots"][index]["origin"] = json!("derived");
            ev["payload"]["snapshots"][index]["calculation"] = json!("Synthetic calculation");
            ev["payload"]["snapshots"][index]["parent_refs"] =
                json!([{"evidence_id":parent,"path":""}]);
        }
        assert!(
            repo.save_event(&tab.id, &ev).is_err(),
            "cyclic ancestry was retained"
        );
        let coverage = json!({"type":"canvas","version":1,"workspace_id":tab.id,"run_id":"run-1","seq":1,"kind":"coverage","payload":{"assessed_refs":[{"evidence_id":"foreign","path":""}]}});
        assert!(
            repo.save_event(&tab.id, &coverage).is_err(),
            "unknown coverage evidence was accepted"
        );
    }

    #[test]
    fn copilot_canvas_coverage_survives_delayed_status_and_exact_status_retry() {
        let (_dir, conn) = db();
        let repo = CanvasRepository::new(&conn);
        let tab = repo.create_workspace("Synthetic").unwrap();
        let mut r = run(&tab.id, "run-1");
        repo.save_run(&tab.id, &r).unwrap();
        let coverage = json!({"type":"canvas","version":1,"workspace_id":tab.id,"run_id":"run-1","seq":1,"kind":"coverage","payload":{"denominator":null,"assessed_refs":[]}});
        repo.save_event(&tab.id, &coverage).unwrap();
        r["status"] = json!("completed");
        r["ended_at"] = json!("2026-10-25T12:01:00Z");
        repo.save_run(&tab.id, &r).unwrap();
        repo.save_run(&tab.id, &r).unwrap();
        assert_eq!(
            repo.open_workspace(&tab.id).unwrap()["runs"][0]["coverage"],
            coverage["payload"]
        );
        r["coverage"] = json!({"denominator":999,"assessed_refs":[]});
        assert!(
            repo.save_run(&tab.id, &r).is_err(),
            "conflicting finished coverage was accepted"
        );
    }

    #[test]
    fn copilot_canvas_run_coverage_rejects_unknown_and_foreign_references() {
        let (_dir, conn) = db();
        let repo = CanvasRepository::new(&conn);
        let a = repo.create_workspace("Synthetic A").unwrap();
        let b = repo.create_workspace("Synthetic B").unwrap();
        let mut r = run(&a.id, "run-a");
        r["coverage"] = json!({"assessed_refs":[{"evidence_id":"unknown","path":""}]});
        assert!(
            repo.save_run(&a.id, &r).is_err(),
            "new run accepted unknown coverage evidence"
        );
        assert_eq!(repo.open_workspace(&a.id).unwrap()["runs"], json!([]));
        repo.save_run(&b.id, &run(&b.id, "run-b")).unwrap();
        repo.save_event(&b.id, &event(&b.id, "run-b", 0)).unwrap();
        r["coverage"] = Value::Null;
        repo.save_run(&a.id, &r).unwrap();
        r["coverage"] = json!({"assessed_refs":[{"evidence_id":"evidence-a","path":"/devices/0"}]});
        assert!(
            repo.save_run(&a.id, &r).is_err(),
            "run accepted foreign coverage evidence"
        );
        assert!(repo.save_event(&a.id,&json!({"type":"canvas","version":1,"workspace_id":a.id,"run_id":"run-a","seq":1,"kind":"coverage","payload":r["coverage"]})).is_err());
        let mut owned: Value = serde_json::from_str(
            &event(&a.id, "run-a", 0)
                .to_string()
                .replace("evidence-a", "owned-a")
                .replace("evidence-b", "owned-b"),
        )
        .unwrap();
        owned["payload"]["card"]["card_id"] = json!("owned-card");
        repo.save_event(&a.id, &owned).unwrap();
        r["coverage"] = json!({"assessed_refs":[{"evidence_id":"owned-a","path":"/devices/0"}],"denominator":null});
        repo.save_run(&a.id, &r).unwrap();
        assert_eq!(
            repo.open_workspace(&a.id).unwrap()["runs"][0]["coverage"],
            r["coverage"]
        );
        r["coverage"] = json!({"assessed_refs":[{"evidence_id":"owned-a","path":"/missing"}]});
        assert!(
            repo.save_run(&a.id, &r).is_err(),
            "run accepted an unknown coverage path"
        );
    }

    #[test]
    fn copilot_canvas_rename_persists_closed_title_and_rejects_other_tabs() {
        let (_dir, conn) = db();
        let repo = CanvasRepository::new(&conn);
        let tab = repo.create_workspace("Original").unwrap();
        let terminal =
            crate::session::create_tab(&conn, "Terminal", "synthetic-shell", "/synthetic").unwrap();
        crate::session::close_tab(&conn, &tab.id).unwrap();
        repo.rename_workspace(&tab.id, "Renamed investigation")
            .unwrap();
        assert_eq!(
            repo.list_workspaces().unwrap()[0].title,
            "Renamed investigation"
        );
        assert_eq!(
            repo.open_workspace(&tab.id).unwrap()["tab"]["title"],
            "Renamed investigation"
        );
        for id in ["missing", terminal.id.as_str()] {
            assert!(repo.rename_workspace(id, "Wrong").is_err());
        }
        for title in ["", " \n\t"] {
            assert!(repo.rename_workspace(&tab.id, title).is_err());
            assert!(repo.create_workspace(title).is_err());
        }
        assert_eq!(
            crate::session::list_open_tabs(&conn)
                .unwrap()
                .iter()
                .find(|t| t.id == terminal.id)
                .unwrap()
                .title,
            "Terminal"
        );
    }

    #[test]
    fn copilot_canvas_migration_has_exactly_three_new_tables() {
        let (_dir, conn) = db();
        let count: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'copilot_canvas_%'", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn copilot_canvas_real_tab_chat_close_and_reopen_without_execution() {
        let (_dir, conn) = db();
        let repo = CanvasRepository::new(&conn);
        let tab = repo.create_workspace("Synthetic investigation").unwrap();
        assert_eq!(tab.tab_type, "canvas");
        assert_eq!(tab.shell_cmd, "");
        assert_eq!(tab.cwd, "");
        crate::session::save_ai_message_with_agent(
            &conn,
            &tab.id,
            "assistant",
            "Synthetic answer",
            1792929600,
            Some("network-architect"),
        )
        .unwrap();
        let messages =
            crate::session::get_ai_messages_by_tab_agent(&conn, &tab.id, Some("network-architect"))
                .unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "Synthetic answer");
        repo.save_run(&tab.id, &run(&tab.id, "run-1")).unwrap();
        crate::session::close_tab(&conn, &tab.id).unwrap();
        assert!(!crate::session::list_open_tabs(&conn)
            .unwrap()
            .iter()
            .any(|t| t.id == tab.id));
        assert_eq!(repo.list_workspaces().unwrap()[0].id, tab.id);
        let snapshot = repo.open_workspace(&tab.id).unwrap();
        assert_eq!(snapshot["tab"]["id"], tab.id);
        assert_eq!(snapshot["runs"][0]["status"], "collecting");
        assert!(crate::session::list_open_tabs(&conn)
            .unwrap()
            .iter()
            .any(|t| t.id == tab.id));
    }

    #[test]
    fn copilot_canvas_numeric_graph_identity_matches_frontend_numbers() {
        for (a, b) in [
            (json!(1), json!(1.0)),
            (json!(0), json!(-0.0)),
            (json!(9007199254740992_u64), json!(9007199254740993_u64)),
        ] {
            let (_dir, conn) = db();
            let repo = CanvasRepository::new(&conn);
            let tab = repo.create_workspace("Numeric graph").unwrap();
            repo.save_run(&tab.id, &run(&tab.id, "numbers")).unwrap();
            let mut ev = event(&tab.id, "numbers", 4);
            ev["payload"]["snapshots"][0]["data"]["devices"][0]["id"] = a.clone();
            ev["payload"]["snapshots"][0]["data"]["devices"][1]["id"] = b.clone();
            ev["payload"]["snapshots"][0]["data"]["links"][0] = json!({"from":a,"to":b});
            assert!(
                repo.save_event(&tab.id, &ev).is_err(),
                "frontend-equivalent duplicate accepted"
            );
        }
        let (_dir, conn) = db();
        let repo = CanvasRepository::new(&conn);
        let tab = repo.create_workspace("Typed graph").unwrap();
        repo.save_run(&tab.id, &run(&tab.id, "typed")).unwrap();
        let mut ev = event(&tab.id, "typed", 4);
        ev["payload"]["snapshots"][0]["data"]["devices"][0]["id"] = json!(1);
        ev["payload"]["snapshots"][0]["data"]["devices"][1]["id"] = json!("1");
        ev["payload"]["snapshots"][0]["data"]["links"][0] = json!({"from":1.0,"to":"1"});
        repo.save_event(&tab.id, &ev).unwrap();
    }

    #[test]
    fn copilot_canvas_fixture_roundtrip_immutable_duplicates_and_terminal_guard() {
        let (_dir, conn) = db();
        let repo = CanvasRepository::new(&conn);
        let tab = repo.create_workspace("Synthetic").unwrap();
        let mut r = run(&tab.id, "run-1");
        repo.save_run(&tab.id, &r).unwrap();
        for i in 0..7 {
            let ev = event(&tab.id, "run-1", i);
            repo.save_event(&tab.id, &ev).unwrap();
            repo.save_event(&tab.id, &ev).unwrap();
        }
        let saved = repo.open_workspace(&tab.id).unwrap();
        assert_eq!(saved["cards"].as_array().unwrap().len(), 7);
        assert_eq!(saved["evidence"].as_array().unwrap().len(), 2);
        for i in 0..7 {
            assert_eq!(
                saved["cards"][i],
                event(&tab.id, "run-1", i)["payload"]["card"]
            );
        }
        assert_eq!(
            saved["evidence"][0]["data"],
            fixture()["snapshots"][0]["data"]
        );
        let mut conflict = event(&tab.id, "run-1", 0);
        conflict["payload"]["card"]["title"] = json!("changed");
        assert!(repo.save_event(&tab.id, &conflict).is_err());
        conflict["seq"] = json!(8);
        assert!(repo.save_event(&tab.id, &conflict).is_err());
        r["status"] = json!("completed");
        r["ended_at"] = json!("2026-10-25T12:01:00Z");
        repo.save_run(&tab.id, &r).unwrap();
        repo.save_run(&tab.id, &r).unwrap();
        repo.save_event(&tab.id, &event(&tab.id, "run-1", 0))
            .unwrap();
        let mut late = event(&tab.id, "run-1", 0);
        late["seq"] = json!(8);
        late["payload"]["card"]["card_id"] = json!("late");
        assert!(repo.save_event(&tab.id, &late).is_err());
        assert!(repo.save_run(&tab.id, &run(&tab.id, "run-1")).is_err());
    }

    #[test]
    fn copilot_canvas_atomic_rollback_unknown_and_cross_owner_rejection() {
        let (_dir, conn) = db();
        let repo = CanvasRepository::new(&conn);
        let a = repo.create_workspace("A").unwrap();
        let b = repo.create_workspace("B").unwrap();
        repo.save_run(&a.id, &run(&a.id, "run-1")).unwrap();
        assert!(repo.save_run(&b.id, &run(&b.id, "run-1")).is_err());
        assert!(repo.save_run("missing", &run("missing", "run-x")).is_err());
        assert!(repo.save_event(&a.id, &event(&a.id, "missing", 0)).is_err());
        assert!(repo.save_event(&b.id, &event(&a.id, "run-1", 0)).is_err());
        let mut foreign = event(&a.id, "run-1", 0);
        foreign["payload"]["snapshots"][0]["workspace_id"] = json!(b.id);
        assert!(repo.save_event(&a.id, &foreign).is_err());
        conn.execute_batch("CREATE TRIGGER reject_card BEFORE INSERT ON copilot_canvas_cards BEGIN SELECT RAISE(ABORT, 'synthetic save failure'); END;").unwrap();
        assert!(repo.save_event(&a.id, &event(&a.id, "run-1", 0)).is_err());
        let saved = repo.open_workspace(&a.id).unwrap();
        assert_eq!(saved["evidence"], json!([]));
        assert_eq!(saved["cards"], json!([]));
        conn.execute_batch("DROP TRIGGER reject_card").unwrap();
        repo.save_event(&a.id, &event(&a.id, "run-1", 0)).unwrap();
    }

    #[test]
    fn copilot_canvas_startup_only_interrupts_orphans_and_preserves_evidence() {
        let (_dir, conn) = db();
        let repo = CanvasRepository::new(&conn);
        let a = repo.create_workspace("A").unwrap();
        let mut r = run(&a.id, "run-1");
        r["status"] = json!("awaiting_approval");
        repo.save_run(&a.id, &r).unwrap();
        repo.save_event(&a.id, &event(&a.id, "run-1", 0)).unwrap();
        assert_eq!(
            repo.open_workspace(&a.id).unwrap()["runs"][0]["status"],
            "awaiting_approval"
        );
        assert_eq!(repo.interrupt_orphan_runs().unwrap(), 1);
        assert_eq!(repo.interrupt_orphan_runs().unwrap(), 0);
        let snapshot = repo.open_workspace(&a.id).unwrap();
        assert_eq!(snapshot["runs"][0]["status"], "interrupted");
        assert!(snapshot["runs"][0]["ended_at"].is_string());
        assert_eq!(snapshot["cards"].as_array().unwrap().len(), 1);
    }
}
