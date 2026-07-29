/**
 * Global teardown for E2E tests
 *
 * Cleanup after all tests complete
 */
async function globalTeardown() {
  console.log('🧹 Cleaning up after E2E tests...');

  // Clean up any test artifacts
  // e.g., test databases, temporary files, etc.

  console.log('✅ Cleanup complete');
}

export default globalTeardown;
