#[cfg(test)]
mod tests {
    use crate::heartbeat::scheduler::interval_to_cron;

    #[test]
    fn test_interval_to_cron_zero_invalid() {
        let result = interval_to_cron(0);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("at least 1 minute"));
    }

    #[test]
    fn test_interval_to_cron_minutes() {
        assert_eq!(interval_to_cron(1).unwrap(), "0 */1 * * * *");
        assert_eq!(interval_to_cron(5).unwrap(), "0 */5 * * * *");
        assert_eq!(interval_to_cron(30).unwrap(), "0 */30 * * * *");
    }

    #[test]
    fn test_interval_to_cron_hours() {
        assert_eq!(interval_to_cron(60).unwrap(), "0 0 */1 * * *");
        assert_eq!(interval_to_cron(120).unwrap(), "0 0 */2 * * *");
        assert_eq!(interval_to_cron(720).unwrap(), "0 0 */12 * * *");
    }

    #[test]
    fn test_interval_to_cron_days() {
        assert_eq!(interval_to_cron(1440).unwrap(), "0 0 0 */1 * *");
        assert_eq!(interval_to_cron(2880).unwrap(), "0 0 0 */2 * *");
        assert_eq!(interval_to_cron(10080).unwrap(), "0 0 0 */7 * *");
    }
}
