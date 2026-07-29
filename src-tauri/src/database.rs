use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// Database wrapper for IaC-related operations
pub struct Database {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IaCExecution {
    pub id: String,
    pub command_block_id: String,
    pub tool: String,
    pub subcommand: String,
    pub project_path: String,
    pub git_commit: Option<String>,
    pub git_branch: Option<String>,
    pub had_uncommitted_changes: bool,
    pub blast_radius: Option<String>,
    pub resources_changed: Option<u32>,
    pub resources_failed: Option<u32>,
    pub metadata_json: Option<String>,
    pub created_at: u64,
}

impl Database {
    /// Create a new in-memory database for testing
    pub fn new_in_memory() -> Result<Self> {
        // Register sqlite-vec extension before opening connection
        crate::rag::vec::register_vec_auto_extension();
        let mut conn = Connection::open_in_memory()?;
        // Enable foreign keys
        conn.execute_batch("PRAGMA foreign_keys = ON")?;
        // Verify vec extension is available
        crate::rag::vec::enable_vec_extension(&conn)?;
        // Apply migrations
        crate::db::apply_migrations(&mut conn)?;
        Ok(Self { conn })
    }

    /// Get a reference to the connection (for testing)
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn insert_iac_execution(
        &self,
        command_block_id: &str,
        tool: crate::iac::types::IaCTool,
        subcommand: &str,
        project_path: &str,
        git_commit: Option<&str>,
        git_branch: Option<&str>,
        had_uncommitted_changes: bool,
        blast_radius: Option<&str>,
        metadata: &crate::iac::types::IaCMetadata,
    ) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let tool_str = match tool {
            crate::iac::types::IaCTool::Terraform => "terraform",
            crate::iac::types::IaCTool::Ansible => "ansible",
        };
        let metadata_json = serde_json::to_string(metadata)?;
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();

        self.conn.execute(
            "INSERT INTO iac_executions (
                id, command_block_id, tool, subcommand, project_path,
                git_commit, git_branch, had_uncommitted_changes,
                blast_radius, resources_changed, resources_failed,
                metadata_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                &id,
                command_block_id,
                tool_str,
                subcommand,
                project_path,
                git_commit,
                git_branch,
                had_uncommitted_changes as i32,
                blast_radius,
                metadata.resources_changed as i64,
                metadata.resources_failed as i64,
                &metadata_json,
                created_at as i64,
            ],
        )?;

        Ok(id)
    }

    pub fn get_iac_execution(&self, id: &str) -> Result<Option<IaCExecution>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, command_block_id, tool, subcommand, project_path,
                    git_commit, git_branch, had_uncommitted_changes,
                    blast_radius, resources_changed, resources_failed,
                    metadata_json, created_at
             FROM iac_executions WHERE id = ?1"
        )?;

        let result = stmt.query_row(params![id], |row| {
            Ok(IaCExecution {
                id: row.get(0)?,
                command_block_id: row.get(1)?,
                tool: row.get(2)?,
                subcommand: row.get(3)?,
                project_path: row.get(4)?,
                git_commit: row.get(5)?,
                git_branch: row.get(6)?,
                had_uncommitted_changes: row.get::<_, i32>(7)? != 0,
                blast_radius: row.get(8)?,
                resources_changed: row.get::<_, Option<i64>>(9)?.map(|v| v as u32),
                resources_failed: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                metadata_json: row.get(11)?,
                created_at: row.get::<_, i64>(12)? as u64,
            })
        });

        match result {
            Ok(exec) => Ok(Some(exec)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Insert IaC execution directly via shared Arc<Mutex<Connection>>
    /// Used by iac_process_block command which needs to share the AppState db
    pub fn insert_iac_execution_direct(
        conn: &std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
        command_block_id: &str,
        tool: crate::iac::types::IaCTool,
        subcommand: &str,
        project_path: &str,
        git_commit: Option<&str>,
        git_branch: Option<&str>,
        had_uncommitted_changes: bool,
        blast_radius: Option<&str>,
        metadata: &crate::iac::types::IaCMetadata,
    ) -> Result<String> {
        let db = conn.lock();
        let id = uuid::Uuid::new_v4().to_string();
        let tool_str = match tool {
            crate::iac::types::IaCTool::Terraform => "terraform",
            crate::iac::types::IaCTool::Ansible => "ansible",
        };
        let metadata_json = serde_json::to_string(metadata)?;
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();

        db.execute(
            "INSERT INTO iac_executions (
                id, command_block_id, tool, subcommand, project_path,
                git_commit, git_branch, had_uncommitted_changes,
                blast_radius, resources_changed, resources_failed,
                metadata_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                &id,
                command_block_id,
                tool_str,
                subcommand,
                project_path,
                git_commit,
                git_branch,
                had_uncommitted_changes as i32,
                blast_radius,
                metadata.resources_changed as i64,
                metadata.resources_failed as i64,
                &metadata_json,
                created_at as i64,
            ],
        )?;

        Ok(id)
    }
}

#[cfg(test)]
mod iac_tests {
    use super::*;
    use crate::iac::types::{IaCTool, IaCMetadata, ResourceEvent, ResourceAction};

    #[test]
    fn test_insert_and_get_iac_execution() {
        let db = Database::new_in_memory().unwrap();

        // Create a dummy tab and command block first (foreign key requirement)
        let tab_id = uuid::Uuid::new_v4().to_string();
        let block_id = uuid::Uuid::new_v4().to_string();

        db.conn.execute(
            "INSERT INTO tabs (id, title, shell_cmd, cwd, tab_type) VALUES (?, 'test', 'bash', '/tmp', 'terminal')",
            params![&tab_id],
        ).unwrap();

        db.conn.execute(
            "INSERT INTO command_blocks (id, tab_id, cmd, started_at, output) VALUES (?, ?, 'terraform apply', 1234567890, X'')",
            params![&block_id, &tab_id],
        ).unwrap();

        let metadata = IaCMetadata {
            resources_changed: 2,
            resources_failed: 0,
            resource_events: vec![
                ResourceEvent {
                    resource_type: "aws_security_group".to_string(),
                    resource_name: "alb".to_string(),
                    resource_id: Some("sg-abc123".to_string()),
                    action: ResourceAction::Create,
                    timestamp: 1234567890,
                    duration_ms: None,
                    error: None,
                },
            ],
            summary: "2 resources changed".to_string(),
        };

        let exec_id = db.insert_iac_execution(
            &block_id,
            IaCTool::Terraform,
            "apply",
            "/test/project",
            Some("abc123"),
            Some("main"),
            false,
            Some("low"),
            &metadata,
        ).unwrap();

        let result = db.get_iac_execution(&exec_id).unwrap();
        assert!(result.is_some());

        let execution = result.unwrap();
        assert_eq!(execution.tool, "terraform");
        assert_eq!(execution.subcommand, "apply");
        assert_eq!(execution.resources_changed, Some(2));
        assert_eq!(execution.resources_failed, Some(0));
    }
}
