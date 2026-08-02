#[cfg(test)]
mod tests {
    use crate::database::Database;
    use crate::heartbeat::repo::HeartbeatRepo;

    #[test]
    fn test_create_heartbeat() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn();

        let result =
            HeartbeatRepo::create_heartbeat(conn, "Test Heartbeat", "Test description", 60, 30);

        assert!(result.is_ok());
        let heartbeat = result.unwrap();
        assert_eq!(heartbeat.name, "Test Heartbeat");
        assert_eq!(heartbeat.description, "Test description");
        assert_eq!(heartbeat.interval_minutes, 60);
        assert_eq!(heartbeat.retention_days, 30);
        assert!(heartbeat.enabled);
    }

    #[test]
    fn test_add_checks() {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn();

        let heartbeat = HeartbeatRepo::create_heartbeat(conn, "Test", "Desc", 60, 30).unwrap();

        let check1 =
            HeartbeatRepo::add_check(conn, &heartbeat.id, "Group 1", "meraki", "Check alerts", 0);
        let check2 =
            HeartbeatRepo::add_check(conn, &heartbeat.id, "Group 2", "pyats", "Check devices", 1);

        assert!(check1.is_ok());
        assert!(check2.is_ok());

        let checks = HeartbeatRepo::get_checks(conn, &heartbeat.id).unwrap();
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].sort_order, 0);
        assert_eq!(checks[1].sort_order, 1);
    }
}
