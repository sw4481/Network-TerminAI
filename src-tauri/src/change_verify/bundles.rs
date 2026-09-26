use anyhow::Result;
use rusqlite::{params, Connection};
use uuid::Uuid;

use super::model::{CheckBundle, NewCheckBundle};

pub fn create(db: &mut Connection, new: NewCheckBundle) -> Result<CheckBundle> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let tx = db.transaction()?;
    tx.execute(
        "INSERT INTO check_bundles(id,name,description,vendor,platform,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?6)",
        params![&id, &new.name, &new.description, &new.vendor, &new.platform, now],
    )?;
    for (idx, cmd) in new.commands.iter().enumerate() {
        tx.execute(
            "INSERT INTO check_bundle_commands(bundle_id,idx,command) VALUES (?1,?2,?3)",
            params![&id, idx as i64, cmd],
        )?;
    }
    tx.commit()?;
    get(db, &id)
}

pub fn get(db: &Connection, id: &str) -> Result<CheckBundle> {
    let mut stmt = db.prepare(
        "SELECT id,name,description,vendor,platform,created_at,updated_at
         FROM check_bundles WHERE id = ?1",
    )?;
    let (bid, name, desc, vendor, platform, created_at, updated_at): (String, String, Option<String>, String, String, i64, i64) =
        stmt.query_row(params![id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
        })?;
    let mut cmd_stmt = db.prepare(
        "SELECT command FROM check_bundle_commands WHERE bundle_id = ?1 ORDER BY idx ASC",
    )?;
    let commands: Vec<String> = cmd_stmt
        .query_map(params![&bid], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(CheckBundle { id: bid, name, description: desc, vendor, platform, commands, created_at, updated_at })
}

pub fn list(db: &Connection, vendor: Option<&str>, platform: Option<&str>) -> Result<Vec<CheckBundle>> {
    let mut stmt = db.prepare(
        "SELECT id FROM check_bundles
         WHERE (?1 IS NULL OR vendor = ?1)
           AND (?2 IS NULL OR platform = ?2)
         ORDER BY updated_at DESC",
    )?;
    let ids: Vec<String> = stmt
        .query_map(params![vendor, platform], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<_, _>>()?;
    ids.iter().map(|id| get(db, id)).collect()
}

pub fn update_commands(db: &mut Connection, id: &str, commands: Vec<String>) -> Result<()> {
    let tx = db.transaction()?;
    tx.execute("DELETE FROM check_bundle_commands WHERE bundle_id = ?1", params![id])?;
    for (idx, cmd) in commands.iter().enumerate() {
        tx.execute(
            "INSERT INTO check_bundle_commands(bundle_id,idx,command) VALUES (?1,?2,?3)",
            params![id, idx as i64, cmd],
        )?;
    }
    let now = chrono::Utc::now().timestamp();
    tx.execute("UPDATE check_bundles SET updated_at = ?1 WHERE id = ?2", params![now, id])?;
    tx.commit()?;
    Ok(())
}

pub fn rename(db: &Connection, id: &str, name: &str, description: Option<&str>) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    db.execute(
        "UPDATE check_bundles SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
        params![name, description, now, id],
    )?;
    Ok(())
}

pub fn delete(db: &Connection, id: &str) -> Result<()> {
    db.execute("DELETE FROM check_bundles WHERE id = ?1", params![id])?;
    Ok(())
}
