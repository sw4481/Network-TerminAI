//! Tauri command surface for the AI guardrails system. Phase 1 ships
//! `guardrail_classify` + `guardrail_record_decision` — the minimum needed
//! for the Phase 2 NETCONF/SSH hook to call into. Phase 4 fleshes out the
//! rules CRUD surface.

use crate::commands::AppState;
use crate::guardrails::ambiguity::{self, SecondOpinion};
use crate::guardrails::classifier::{self, Tier};
use crate::guardrails::decisions::{self, DecisionRecord, DecisionRow};
use crate::guardrails::impact::{self, ImpactSummary};
use crate::guardrails::rules::{Rule, RuleSet};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct ClassifyArgs {
    pub vendor: String,
    pub platform: String,
    pub command: String,
}

#[derive(Debug, Serialize)]
pub struct ClassifyResponse {
    pub tier: String,
    pub rule_id: Option<String>,
    pub reasoning: String,
}

#[tauri::command]
pub fn guardrail_classify(
    state: State<'_, AppState>,
    args: ClassifyArgs,
) -> Result<ClassifyResponse, String> {
    let rs = state.guardrails_ruleset.read();
    let d = classifier::classify(&rs, &args.vendor, &args.platform, &args.command);
    Ok(ClassifyResponse {
        tier: d.tier.as_str().to_string(),
        rule_id: d.rule_id,
        reasoning: d.reasoning,
    })
}

#[derive(Debug, Deserialize)]
pub struct RecordDecisionArgs {
    pub session_id: String,
    pub command: String,
    pub tier: u8,
    pub rule_id: Option<String>,
    pub decision: String,
    pub user_action: Option<String>,
    pub reasoning: String,
}

#[tauri::command]
pub fn guardrail_record_decision(
    state: State<'_, AppState>,
    args: RecordDecisionArgs,
) -> Result<String, String> {
    let conn = state.db.lock();
    decisions::record_decision(
        &conn,
        &DecisionRecord {
            id: String::new(),
            session_id: args.session_id,
            command: args.command,
            tier: args.tier,
            rule_id: args.rule_id,
            decision: args.decision,
            user_action: args.user_action,
            reasoning: args.reasoning,
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn guardrail_decisions_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<DecisionRow>, String> {
    let conn = state.db.lock();
    decisions::list_decisions(
        &conn,
        session_id.as_deref(),
        limit.unwrap_or(200),
        offset.unwrap_or(0),
    )
    .map_err(|e| e.to_string())
}

// --- Rule CRUD (used by the Phase 4 editor and Phase 2 setup) ---------------

#[tauri::command]
pub fn guardrail_rules_list(state: State<'_, AppState>) -> Result<Vec<Rule>, String> {
    let conn = state.db.lock();
    list_rules_inner(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn guardrail_rule_upsert(state: State<'_, AppState>, rule: Rule) -> Result<String, String> {
    // Reject malformed regex *before* we touch the DB.
    regex::Regex::new(&rule.pattern_regex).map_err(|e| format!("invalid regex: {}", e))?;
    let mut r = rule;
    if r.id.is_empty() {
        r.id = uuid::Uuid::new_v4().to_string();
    }
    // Builtin rules cannot be overwritten via this surface.
    if r.builtin {
        return Err("cannot upsert a builtin rule via the user CRUD surface".into());
    }
    let conn = state.db.lock();
    upsert_rule_inner(&conn, &r).map_err(|e| e.to_string())?;
    drop(conn);
    reload_ruleset(&state).map_err(|e| e.to_string())?;
    Ok(r.id)
}

#[tauri::command]
pub fn guardrail_rule_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock();
    conn.execute(
        "DELETE FROM blast_radius_rules WHERE id = ?1 AND builtin = 0",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);
    reload_ruleset(&state).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn guardrail_rule_set_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE blast_radius_rules SET enabled = ?1, updated_at = strftime('%s','now') WHERE id = ?2",
        rusqlite::params![enabled as i64, id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);
    reload_ruleset(&state).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn guardrail_ruleset_reload(state: State<'_, AppState>) -> Result<usize, String> {
    reload_ruleset(&state).map_err(|e| e.to_string())?;
    Ok(state.guardrails_ruleset.read().len())
}

#[derive(Debug, Serialize)]
pub struct TestRegexResult {
    pub matched: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub fn guardrail_test_regex(pattern: String, input: String) -> Result<TestRegexResult, String> {
    match regex::Regex::new(&pattern) {
        Err(e) => Ok(TestRegexResult {
            matched: false,
            error: Some(e.to_string()),
        }),
        Ok(rx) => Ok(TestRegexResult {
            matched: rx.is_match(&input),
            error: None,
        }),
    }
}

#[derive(Debug, Serialize)]
pub struct ImportReport {
    pub imported: usize,
    pub skipped_builtin: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
pub fn guardrail_rules_export(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.db.lock();
    // Export only user (non-builtin) rules — builtins are bundled.
    let mut stmt = conn
        .prepare(
            "SELECT id, name, vendor, platform, pattern_regex, tier, reason, enabled, builtin
             FROM blast_radius_rules WHERE builtin = 0 ORDER BY vendor, platform, tier",
        )
        .map_err(|e| e.to_string())?;
    let rules: Vec<Rule> = stmt
        .query_map([], row_to_rule)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&rules).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn guardrail_rules_import(
    state: State<'_, AppState>,
    json: String,
) -> Result<ImportReport, String> {
    let parsed: Vec<Rule> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let mut report = ImportReport {
        imported: 0,
        skipped_builtin: 0,
        errors: vec![],
    };
    let conn = state.db.lock();
    for mut r in parsed {
        if r.builtin {
            report.skipped_builtin += 1;
            continue;
        }
        if r.id.is_empty() {
            r.id = uuid::Uuid::new_v4().to_string();
        }
        if let Err(e) = regex::Regex::new(&r.pattern_regex) {
            report
                .errors
                .push(format!("rule {}: invalid regex: {}", r.id, e));
            continue;
        }
        match upsert_rule_inner(&conn, &r) {
            Ok(()) => report.imported += 1,
            Err(e) => report.errors.push(format!("rule {}: {}", r.id, e)),
        }
    }
    drop(conn);
    reload_ruleset(&state).map_err(|e| e.to_string())?;
    Ok(report)
}

// --- internal helpers -------------------------------------------------------

fn row_to_rule(r: &rusqlite::Row<'_>) -> rusqlite::Result<Rule> {
    Ok(Rule {
        id: r.get(0)?,
        name: r.get(1)?,
        vendor: r.get(2)?,
        platform: r.get(3)?,
        pattern_regex: r.get(4)?,
        tier: r.get::<_, i64>(5)? as u8,
        reason: r.get(6)?,
        enabled: r.get::<_, i64>(7)? != 0,
        builtin: r.get::<_, i64>(8)? != 0,
    })
}

fn list_rules_inner(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<Rule>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, vendor, platform, pattern_regex, tier, reason, enabled, builtin
         FROM blast_radius_rules
         ORDER BY builtin DESC, vendor, platform, tier",
    )?;
    let rows: Vec<Rule> = stmt
        .query_map([], row_to_rule)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn upsert_rule_inner(conn: &rusqlite::Connection, r: &Rule) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO blast_radius_rules
           (id, name, vendor, platform, pattern_regex, tier, reason, enabled, builtin, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, strftime('%s','now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           vendor = excluded.vendor,
           platform = excluded.platform,
           pattern_regex = excluded.pattern_regex,
           tier = excluded.tier,
           reason = excluded.reason,
           enabled = excluded.enabled,
           updated_at = strftime('%s','now')",
        rusqlite::params![
            r.id,
            r.name,
            r.vendor,
            r.platform,
            r.pattern_regex,
            r.tier as i64,
            r.reason,
            r.enabled as i64,
            r.builtin as i64,
        ],
    )?;
    Ok(())
}

/// Embedded builtin ruleset bytes — used both to compile the in-memory
/// `RuleSet` and to UPSERT into `blast_radius_rules` so the audit log's
/// foreign key on `rule_id` can resolve.
pub const BUILTIN_RULES_JSON: &str = include_str!("../guardrails/builtin_rules.json");

/// Parse the embedded builtin JSON into a `Vec<Rule>`.
pub fn builtin_rules() -> anyhow::Result<Vec<Rule>> {
    Ok(serde_json::from_str(BUILTIN_RULES_JSON)?)
}

/// Idempotently seed builtin rules into the `blast_radius_rules` table.
/// Safe to call repeatedly — the upsert preserves user `enabled` toggles
/// on existing builtin rows by using `INSERT OR IGNORE` (we only insert
/// rows that don't already exist, so user toggles stick).
pub fn seed_builtin_rules(conn: &rusqlite::Connection) -> anyhow::Result<usize> {
    let rules = builtin_rules()?;
    let mut inserted = 0usize;
    for r in &rules {
        let n = conn.execute(
            "INSERT OR IGNORE INTO blast_radius_rules
               (id, name, vendor, platform, pattern_regex, tier, reason, enabled, builtin)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1)",
            rusqlite::params![
                r.id,
                r.name,
                r.vendor,
                r.platform,
                r.pattern_regex,
                r.tier as i64,
                r.reason,
                r.enabled as i64,
            ],
        )?;
        inserted += n;
    }
    Ok(inserted)
}

/// Recompute the in-memory `RuleSet` by merging the embedded builtin set
/// with the user-authored DB rows and replacing the `AppState`-held
/// instance. Also seeds the builtin rows into the DB so the audit-log FK
/// on `rule_id` resolves. Callers must not hold the `db` lock when
/// invoking this.
pub fn reload_ruleset(state: &AppState) -> anyhow::Result<()> {
    let mut rules = builtin_rules()?;
    let conn = state.db.lock();
    let n = seed_builtin_rules(&conn)?;
    if n > 0 {
        tracing::info!(seeded = n, "guardrails: builtin rules seeded into DB");
    }
    let user_rules = list_rules_inner(&conn).unwrap_or_default();
    drop(conn);
    // User rules with `builtin: false` extend the set; user rules can't
    // override builtins (the upsert path rejects builtin=true).
    rules.extend(user_rules.into_iter().filter(|r| !r.builtin));
    let new_rs = RuleSet::compile(rules)?;
    let mut guard = state.guardrails_ruleset.write();
    *guard = new_rs;
    Ok(())
}

#[allow(dead_code)]
pub fn _tier_to_u8(t: Tier) -> u8 {
    t.as_u8()
}

// --- Phase 5: Impact preview + LLM second-opinion -------------------------

#[tauri::command]
pub fn guardrail_impact_summary(
    state: State<'_, AppState>,
    vendor: String,
    platform: String,
    command: String,
) -> Result<ImpactSummary, String> {
    let conn = state.db.lock();
    Ok(impact::summarize(&conn, &vendor, &platform, &command))
}

#[derive(Debug, Serialize)]
pub struct SecondOpinionResponse {
    pub tier: String,
    pub reasoning: String,
}

#[tauri::command]
pub async fn guardrail_second_opinion(
    state: State<'_, AppState>,
    vendor: String,
    platform: String,
    command: String,
) -> Result<SecondOpinionResponse, String> {
    let bridge = state.agent.clone();
    // Take the rule-engine decision first so we can apply the LLM ONLY as
    // a tier-raising overlay.
    let rule_decision = {
        let rs = state.guardrails_ruleset.read();
        classifier::classify(&rs, &vendor, &platform, &command)
    };
    let llm = ambiguity::second_opinion(bridge, &vendor, &platform, &command)
        .await
        .map_err(|e| e.to_string())?;
    let merged = ambiguity::merge(rule_decision.tier, &llm);
    Ok(SecondOpinionResponse {
        tier: merged.as_str().to_string(),
        reasoning: format!("{} | LLM: {}", rule_decision.reasoning, llm.reasoning),
    })
}

#[allow(dead_code)]
pub fn _opinion_apply(_o: SecondOpinion) {}
