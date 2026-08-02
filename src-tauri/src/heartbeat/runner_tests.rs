#[cfg(test)]
mod tests {
    use crate::agent_bridge::AgentBridge;
    use crate::heartbeat::repo::HeartbeatRepo;
    use crate::heartbeat::runner::run_heartbeat;
    use parking_lot::Mutex;
    use rusqlite::Connection;
    use std::sync::Arc;

    fn test_db() -> Arc<Mutex<Connection>> {
        crate::rag::vec::register_vec_auto_extension();
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        crate::rag::vec::enable_vec_extension(&conn).unwrap();
        crate::db::apply_migrations(&mut conn).unwrap();
        Arc::new(Mutex::new(conn))
    }

    // Ignored in the default run: this exercises a real AgentBridge over
    // `python3` and asserts a clean "completed", which requires the sidecar +
    // network to answer the check. Without them the agent call errors and the
    // run is (correctly) "completed_with_errors". Kept for manual runs via
    // `cargo test -- --ignored` so a release `cargo test` isn't blocked by the
    // environment.
    #[tokio::test]
    #[ignore = "requires live sidecar/agent; run with --ignored"]
    async fn test_run_single_check() {
        let db = test_db();

        // Create heartbeat with one check
        let heartbeat_id = {
            let conn = db.lock();
            let h = HeartbeatRepo::create_heartbeat(&conn, "Test", "Desc", 60, 30).unwrap();
            HeartbeatRepo::add_check(&conn, &h.id, "Test Group", "test_agent", "test prompt", 0)
                .unwrap();
            h.id
        };

        // Mock agent bridge
        let agent_bridge = AgentBridge::new("python3".to_string(), vec![]);

        let result = run_heartbeat(db.clone(), agent_bridge, &heartbeat_id).await;
        assert!(result.is_ok());

        // Verify execution record was created
        let conn = db.lock();
        let executions =
            HeartbeatRepo::get_execution_history(&conn, &heartbeat_id, Some(10)).unwrap();
        assert_eq!(executions.len(), 1);
        assert_eq!(executions[0].status, "completed");
    }
}
