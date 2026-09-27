//! CRUD for `pcap_templates`. `builtin = 1` rows are read-only:
//! `update_template` and `delete_template` reject them.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PcapTemplate {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub platform: String,
    pub interface: Option<String>,
    pub acl: Option<String>,
    pub duration_s: u32,
    pub builtin: bool,
}

fn row_to_template(r: &rusqlite::Row) -> rusqlite::Result<PcapTemplate> {
    Ok(PcapTemplate {
        id: r.get(0)?,
        name: r.get(1)?,
        vendor: r.get(2)?,
        platform: r.get(3)?,
        interface: r.get(4)?,
        acl: r.get(5)?,
        duration_s: r.get::<_, i64>(6)? as u32,
        builtin: r.get::<_, i64>(7)? != 0,
    })
}

pub fn list_templates(conn: &Connection) -> Result<Vec<PcapTemplate>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, vendor, platform, interface, acl, duration_s, builtin
         FROM pcap_templates ORDER BY builtin DESC, vendor, platform, name",
    )?;
    let rows = stmt
        .query_map([], row_to_template)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn create_template(conn: &Connection, t: &PcapTemplate) -> Result<String> {
    if t.duration_s == 0 || t.duration_s > 3600 {
        return Err(anyhow!("duration_s must be in 1..=3600"));
    }
    conn.execute(
        "INSERT INTO pcap_templates (id, name, vendor, platform, interface, acl, duration_s, builtin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
        params![t.id, t.name, t.vendor, t.platform, t.interface, t.acl, t.duration_s],
    )?;
    Ok(t.id.clone())
}

pub fn update_template(conn: &Connection, t: &PcapTemplate) -> Result<()> {
    let builtin: i64 = conn
        .query_row(
            "SELECT builtin FROM pcap_templates WHERE id = ?1",
            params![t.id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("template {} not found", t.id))?;
    if builtin != 0 {
        return Err(anyhow!("builtin templates are read-only"));
    }
    if t.duration_s == 0 || t.duration_s > 3600 {
        return Err(anyhow!("duration_s must be in 1..=3600"));
    }
    let n = conn.execute(
        "UPDATE pcap_templates
         SET name = ?2, vendor = ?3, platform = ?4, interface = ?5, acl = ?6, duration_s = ?7
         WHERE id = ?1 AND builtin = 0",
        params![t.id, t.name, t.vendor, t.platform, t.interface, t.acl, t.duration_s],
    )?;
    if n == 0 {
        return Err(anyhow!("template {} not updated", t.id));
    }
    Ok(())
}

pub fn delete_template(conn: &Connection, id: &str) -> Result<()> {
    let builtin: Option<i64> = conn
        .query_row(
            "SELECT builtin FROM pcap_templates WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    match builtin {
        None => Err(anyhow!("template {id} not found")),
        Some(1) => Err(anyhow!("builtin templates are read-only")),
        Some(_) => {
            conn.execute("DELETE FROM pcap_templates WHERE id = ?1", params![id])?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_and_migrate;
    use tempfile::TempDir;

    fn fresh_db() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = open_and_migrate(&path).unwrap();
        (dir, conn)
    }

    #[test]
    fn list_returns_seeded_builtins() {
        let (_g, conn) = fresh_db();
        let rows = list_templates(&conn).unwrap();
        assert!(rows.iter().filter(|t| t.builtin).count() >= 4);
        assert!(rows.iter().any(|t| t.id == "tpl-iosxe-wan"));
    }

    #[test]
    fn create_then_update_user_template() {
        let (_g, conn) = fresh_db();
        let t = PcapTemplate {
            id: "user-1".into(),
            name: "Edge SP1".into(),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
            interface: Some("Gi0/1".into()),
            acl: None,
            duration_s: 60,
            builtin: false,
        };
        create_template(&conn, &t).unwrap();
        let mut updated = t.clone();
        updated.name = "Edge SP1 v2".into();
        update_template(&conn, &updated).unwrap();
        let got = list_templates(&conn)
            .unwrap()
            .into_iter()
            .find(|x| x.id == "user-1")
            .unwrap();
        assert_eq!(got.name, "Edge SP1 v2");
    }

    #[test]
    fn delete_user_template() {
        let (_g, conn) = fresh_db();
        let t = PcapTemplate {
            id: "user-2".into(),
            name: "x".into(),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
            interface: None,
            acl: None,
            duration_s: 30,
            builtin: false,
        };
        create_template(&conn, &t).unwrap();
        delete_template(&conn, "user-2").unwrap();
        assert!(list_templates(&conn)
            .unwrap()
            .iter()
            .all(|x| x.id != "user-2"));
    }

    #[test]
    fn cannot_update_builtin() {
        let (_g, conn) = fresh_db();
        let mut t = list_templates(&conn)
            .unwrap()
            .into_iter()
            .find(|x| x.id == "tpl-iosxe-wan")
            .unwrap();
        t.name = "tampered".into();
        let err = update_template(&conn, &t).unwrap_err().to_string();
        assert!(err.contains("read-only"), "got: {err}");
    }

    #[test]
    fn cannot_delete_builtin() {
        let (_g, conn) = fresh_db();
        let err = delete_template(&conn, "tpl-iosxe-wan")
            .unwrap_err()
            .to_string();
        assert!(err.contains("read-only"), "got: {err}");
    }

    #[test]
    fn delete_nonexistent_returns_error() {
        let (_g, conn) = fresh_db();
        assert!(delete_template(&conn, "does-not-exist").is_err());
    }

    #[test]
    fn create_rejects_bad_duration() {
        let (_g, conn) = fresh_db();
        let t = PcapTemplate {
            id: "user-3".into(),
            name: "x".into(),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
            interface: None,
            acl: None,
            duration_s: 4000,
            builtin: false,
        };
        assert!(create_template(&conn, &t).is_err());
    }
}
