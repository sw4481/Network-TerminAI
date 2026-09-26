use anyhow::{Context, Result};
use refinery::embed_migrations;
pub use refinery::Target;
use rusqlite::Connection;
use std::path::Path;

embed_migrations!("migrations");

/// Open a SQLite database and run migrations up to (and including) `version`.
/// Used by migration regression tests that need to seed legacy data at one
/// schema version, then apply a single subsequent migration in isolation.
pub fn open_and_migrate_to(path: &Path, version: u32) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("create db parent dir")?;
    }
    // Plan 12: register sqlite-vec BEFORE opening the connection so the
    // auto-extension hook applies to it. V0039's `CREATE VIRTUAL TABLE ...
    // USING vec0(...)` then succeeds during refinery's run.
    crate::rag::vec::register_vec_auto_extension();
    let mut conn = Connection::open(path).context("open sqlite")?;
    // Plan 12 Phase 1 follow-up: SQLite ships with FKs OFF by default.
    // V0039 declares `ON DELETE CASCADE` on rag_chunks / rag_document_tags;
    // without this pragma those cascades silently no-op in production and
    // `delete_document` would leak rag_chunks rows. Set it BEFORE the
    // migration runner so any future migrations also benefit.
    conn.execute_batch("PRAGMA foreign_keys = ON")
        .context("enable foreign_keys pragma")?;
    // Sanity-check: vec_version() must resolve. Catches the case where
    // a future refactor opens the connection before registration.
    crate::rag::vec::enable_vec_extension(&conn).context("verify sqlite-vec extension")?;
    migrations::runner()
        .set_target(Target::Version(version))
        .run(&mut conn)
        .context("run migrations to target version")?;
    Ok(conn)
}

pub fn open_and_migrate(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("create db parent dir")?;
    }
    // Plan 12: register sqlite-vec BEFORE opening the connection so the
    // auto-extension hook applies to it. V0039's `CREATE VIRTUAL TABLE ...
    // USING vec0(...)` then succeeds during refinery's run.
    crate::rag::vec::register_vec_auto_extension();
    let mut conn = Connection::open(path).context("open sqlite")?;
    // Plan 12 Phase 1 follow-up: SQLite ships with FKs OFF by default.
    // V0039 declares `ON DELETE CASCADE` on rag_chunks / rag_document_tags;
    // without this pragma those cascades silently no-op in production and
    // `delete_document` would leak rag_chunks rows. Set it BEFORE the
    // migration runner so any future migrations also benefit.
    conn.execute_batch("PRAGMA foreign_keys = ON")
        .context("enable foreign_keys pragma")?;
    // Sanity-check: vec_version() must resolve. Catches the case where
    // a future refactor opens the connection before registration.
    crate::rag::vec::enable_vec_extension(&conn).context("verify sqlite-vec extension")?;
    // Auto-update safety net: an app update can ship migrations that fail
    // against an existing user DB, and a failed run aborts boot (the caller
    // `.expect()`s this in lib.rs). Snapshot the DB before applying anything
    // new so the user's sessions/vault/RAG data is recoverable. Only runs
    // when there are actually pending migrations, so a normal boot with an
    // up-to-date (and potentially large) DB pays nothing.
    if let Err(e) = backup_before_pending_migrations(&mut conn, path) {
        // A backup failure must never block boot — log and continue.
        tracing::warn!("pre-migration DB backup skipped: {e:#}");
    }
    migrations::runner()
        .run(&mut conn)
        .context("run migrations")?;
    Ok(conn)
}

/// Number of recent pre-migration backups to retain. Older ones are pruned.
const MAX_DB_BACKUPS: usize = 3;

/// If the embedded migration set is ahead of what's applied to `conn`, copy the
/// on-disk DB at `path` to a timestamped `<name>.bak-<unix_ts>` sibling before
/// migrations run, then prune to the [`MAX_DB_BACKUPS`] most recent backups.
///
/// No-ops (no backup) when the DB is empty/new or already fully migrated.
fn backup_before_pending_migrations(conn: &mut Connection, path: &Path) -> Result<()> {
    // Nothing to protect if the file doesn't exist yet or is empty (fresh DB).
    let is_empty = std::fs::metadata(path).map(|m| m.len() == 0).unwrap_or(true);
    if is_empty {
        return Ok(());
    }

    let runner = migrations::runner();
    let latest_embedded = runner
        .get_migrations()
        .iter()
        .map(|m| m.version())
        .max()
        .unwrap_or(0);
    let last_applied = runner
        .get_last_applied_migration(conn)
        .context("read last applied migration")?
        .map(|m| m.version())
        .unwrap_or(0);

    if latest_embedded <= last_applied {
        return Ok(()); // already up to date — no migration will run
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("sessions.db");
    let backup = path.with_file_name(format!("{file_name}.bak-{ts}"));
    std::fs::copy(path, &backup).context("copy DB to pre-migration backup")?;
    tracing::info!(
        "backed up DB before migrating {last_applied} -> {latest_embedded}: {}",
        backup.display()
    );

    prune_old_backups(path, file_name);
    Ok(())
}

/// Keep only the [`MAX_DB_BACKUPS`] newest `<name>.bak-*` files next to `path`.
fn prune_old_backups(path: &Path, file_name: &str) {
    let Some(dir) = path.parent() else { return };
    let prefix = format!("{file_name}.bak-");
    let mut backups: Vec<std::path::PathBuf> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with(&prefix))
                    .unwrap_or(false)
            })
            .collect(),
        Err(_) => return,
    };
    if backups.len() <= MAX_DB_BACKUPS {
        return;
    }
    // Filenames end in a unix timestamp, so lexical sort == chronological.
    backups.sort();
    let to_remove = backups.len() - MAX_DB_BACKUPS;
    for old in backups.into_iter().take(to_remove) {
        let _ = std::fs::remove_file(old);
    }
}

/// Apply all embedded migrations against an already-opened, mutable
/// connection. Used by tests that build up a custom connection (e.g.
/// in-memory) and by `RagStore::open_in_memory` after it has set the
/// `foreign_keys` pragma and registered sqlite-vec.
///
/// The caller is responsible for having registered sqlite-vec already
/// (V0039 needs `vec0`). The Phase 1 helper [`crate::rag::vec::enable_vec_extension`]
/// should be invoked first.
pub fn apply_migrations(conn: &mut Connection) -> Result<()> {
    migrations::runner()
        .run(conn)
        .context("run migrations")?;
    Ok(())
}

pub fn default_db_path() -> Result<std::path::PathBuf> {
    let dir = dirs::config_dir()
        .context("could not determine OS config dir")?
        .join("ccie-terminal");
    std::fs::create_dir_all(&dir).context("create config dir")?;
    Ok(dir.join("sessions.db"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_migrations() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");

        let conn = open_and_migrate(&db_path).unwrap();

        // Verify tables were created
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(tables.contains(&"tabs".to_string()));
        assert!(tables.contains(&"command_blocks".to_string()));
        assert!(tables.contains(&"scrollback".to_string()));
        assert!(tables.contains(&"profiles".to_string()));

        // V0030 runnable notebooks
        assert!(tables.contains(&"notebooks".to_string()));
        assert!(tables.contains(&"notebook_cells".to_string()));
        assert!(tables.contains(&"notebook_runs".to_string()));
        assert!(tables.contains(&"notebook_cell_runs".to_string()));

        let cell_columns: Vec<String> = conn
            .prepare("PRAGMA table_info(notebook_cells)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(cell_columns.len(), 5);

        // Verify profiles table schema
        let profile_columns: Vec<String> = conn
            .prepare("PRAGMA table_info(profiles)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(profile_columns.contains(&"id".to_string()));
        assert!(profile_columns.contains(&"name".to_string()));
        assert!(profile_columns.contains(&"provider".to_string()));
        assert!(profile_columns.contains(&"model".to_string()));
        assert!(profile_columns.contains(&"created_at".to_string()));
        assert!(profile_columns.contains(&"last_used_at".to_string()));

        // V0033 change verification
        assert!(tables.contains(&"check_bundles".to_string()));
        assert!(tables.contains(&"check_bundle_commands".to_string()));
        assert!(tables.contains(&"change_snapshots".to_string()));
        assert!(tables.contains(&"change_snapshot_results".to_string()));
        assert!(tables.contains(&"change_reports".to_string()));

        // V0039 RAG tables (Plan 12 Phase 1)
        assert!(tables.contains(&"rag_documents".to_string()));
        assert!(tables.contains(&"rag_document_tags".to_string()));
        assert!(tables.contains(&"rag_chunks".to_string()));
        assert!(tables.contains(&"rag_queries_log".to_string()));
        // rag_chunks_vec is a virtual table — sqlite_master rows for
        // virtual tables also have type='table', so this assertion holds.
        assert!(tables.contains(&"rag_chunks_vec".to_string()));
    }

    #[test]
    fn test_profile_insert() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");

        let conn = open_and_migrate(&db_path).unwrap();

        // Insert a test profile
        conn.execute(
            "INSERT INTO profiles (id, name, provider, model) VALUES (?, ?, ?, ?)",
            rusqlite::params!["test-id", "fast", "anthropic", "claude-sonnet-4-6"],
        )
        .unwrap();

        // Verify it was inserted
        let name: String = conn
            .query_row(
                "SELECT name FROM profiles WHERE id = ?",
                ["test-id"],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(name, "fast");
    }

    /// Plan 12 Phase 1 follow-up: regression for the production-bug fix.
    /// `open_and_migrate` must leave foreign_keys ON; otherwise V0039's
    /// ON DELETE CASCADE rules silently no-op and orphaned rag_chunks
    /// pile up after `delete_document`.
    #[test]
    fn open_and_migrate_enables_foreign_keys() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("fk.db");
        let conn = open_and_migrate(&db_path).unwrap();
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "foreign_keys pragma must be ON after open_and_migrate");
    }

    /// Auto-update safety net: opening a DB that is behind the embedded
    /// migration set must leave a timestamped `.bak-*` snapshot beside it.
    #[test]
    fn open_and_migrate_backs_up_when_migrations_pending() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("sessions.db");

        // Seed a DB pinned to an early schema version so the full embedded set
        // is "pending" on the next open.
        {
            let _conn = open_and_migrate_to(&db_path, 30).unwrap();
        }
        assert!(db_path.exists());

        // Full migrate — should snapshot first since we're behind HEAD.
        let _conn = open_and_migrate(&db_path).unwrap();

        let backups: Vec<_> = std::fs::read_dir(temp_dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with("sessions.db.bak-"))
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(backups.len(), 1, "expected exactly one pre-migration backup");
    }

    /// A fully up-to-date DB must NOT produce a backup on open (avoids copying
    /// a large RAG-laden DB on every normal boot).
    #[test]
    fn open_and_migrate_no_backup_when_up_to_date() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("sessions.db");

        let _conn = open_and_migrate(&db_path).unwrap(); // first run: fully migrated
        drop(_conn);
        let _conn = open_and_migrate(&db_path).unwrap(); // second run: nothing pending

        let backup_count = std::fs::read_dir(temp_dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with("sessions.db.bak-"))
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(backup_count, 0, "up-to-date DB must not be backed up");
    }
}
