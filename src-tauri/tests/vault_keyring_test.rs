#[cfg(test)]
mod vault_keyring_tests {
    use keyring::Entry;

    #[test]
    #[ignore] // Run manually with: cargo test --test vault_keyring_test -- --ignored
    fn test_keyring_set_get() {
        let service = "ccie-terminal-test";
        let account = "test-account";
        let password = "test-password";

        // Create entry
        let entry = Entry::new(service, account).expect("Failed to create Entry");

        // Set password
        entry
            .set_password(password)
            .expect("Failed to set password");
        println!("✅ Password set successfully");

        // Get password
        let retrieved = entry.get_password().expect("Failed to get password");
        assert_eq!(retrieved, password);
        println!("✅ Password retrieved successfully: {}", retrieved);

        // Clean up
        entry
            .delete_credential()
            .expect("Failed to delete credential");
        println!("✅ Credential deleted successfully");
    }

    #[test]
    #[ignore]
    fn test_vault_canary_format() {
        let service = "ccie-terminal";
        let envelope_id = "test-envelope-id-123";
        let account = format!("ccie-terminal.vault.{}.__canary__", envelope_id);

        println!("Testing with:");
        println!("  Service: {}", service);
        println!("  Account: {}", account);

        let entry = Entry::new(service, &account).expect("Failed to create Entry");

        entry
            .set_password("test-canary-value")
            .expect("Failed to set password");
        println!("✅ Canary set successfully");

        let retrieved = entry.get_password().expect("Failed to get password");
        println!("✅ Canary retrieved: {}", retrieved);

        entry
            .delete_credential()
            .expect("Failed to delete credential");
        println!("✅ Canary deleted successfully");
    }
}
