/**
 * Global setup for E2E tests
 *
 * Ensures the Tauri app is built before tests run
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function globalSetup() {
  console.log('🔨 Building Tauri app for E2E tests...');

  try {
    // Build the Tauri app in debug mode
    // The binary will be in src-tauri/target/debug/bundle/
    // Note: This requires a full build which can take several minutes
    const { stdout, stderr } = await execAsync('bun tauri build -d', {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CCIE_REPO_ROOT: process.cwd(),
      },
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for build output
    });

    if (stderr) {
      console.warn('Build warnings:', stderr);
    }

    console.log('✅ Tauri app built successfully');
  } catch (error) {
    console.error('❌ Failed to build Tauri app:', error);
    console.error('NOTE: E2E tests require tauri-driver setup for UI interaction.');
    console.error('See e2e/README.md for WebDriver configuration instructions.');
    throw error;
  }
}

export default globalSetup;
