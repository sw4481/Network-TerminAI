/**
 * Tauri WebDriver helper
 *
 * Utilities for launching and controlling the Tauri app in E2E tests
 */
import { spawn, ChildProcess } from 'child_process';
import { Page } from '@playwright/test';
import path from 'path';
import { platform } from 'os';

export interface TauriApp {
  process: ChildProcess;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Get the path to the built Tauri binary
 */
export function resolveTauriBinaryPath({
  cwd = process.cwd(),
  platform: targetPlatform = platform(),
  env = process.env,
}: {
  cwd?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
} = {}): string {
  const explicitBinary = env.E2E_TAURI_BIN?.trim();
  if (explicitBinary) {
    return path.resolve(cwd, explicitBinary);
  }

  const targetDir = env.CARGO_TARGET_DIR?.trim()
    ? path.resolve(cwd, env.CARGO_TARGET_DIR)
    : path.join(cwd, 'src-tauri', 'target');
  const executableName = targetPlatform === 'win32' ? 'TerminAI.exe' : 'TerminAI';

  return path.join(targetDir, 'debug', executableName);
}

/**
 * Launch the Tauri app and return a Page object for testing
 *
 * Note: Tauri apps use webview, not Chromium, so we can't use Playwright's
 * browser context directly. Instead, we spawn the app and connect to its
 * webview via Tauri's IPC mechanism.
 *
 * For now, we'll use a simplified approach: spawn the app and interact
 * with it via accessibility APIs or window title detection.
 */
export async function launchTauriApp(): Promise<TauriApp> {
  const binaryPath = resolveTauriBinaryPath();

  console.log(`Launching Tauri app: ${binaryPath}`);

  // Spawn the Tauri app
  const appProcess = spawn(binaryPath, [], {
    env: {
      ...process.env,
      CCIE_REPO_ROOT: process.cwd(),
      RUST_BACKTRACE: '1',
      RUST_LOG: 'info',
    },
    stdio: 'pipe',
  });

  // Wait for app to start (give it a few seconds)
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Check if process is still running
  if (appProcess.exitCode !== null) {
    throw new Error('Tauri app exited immediately');
  }

  // Since Tauri uses native webviews and doesn't expose a remote debugging port
  // by default, we'll need to use a different strategy for E2E testing.
  //
  // For now, we return a simplified interface that allows manual testing
  // and basic assertions. For proper E2E, we'd need to:
  // 1. Use tauri-driver (WebDriver implementation for Tauri)
  // 2. Or add custom IPC commands for test automation
  // 3. Or use native UI automation (e.g., accessibility APIs)

  // Create a mock page object for now
  // In a real implementation, this would connect to the webview
  const mockPage: any = {
    goto: async (url: string) => {
      console.log(`Navigate to: ${url}`);
    },
    click: async (selector: string) => {
      console.log(`Click: ${selector}`);
    },
    fill: async (selector: string, value: string) => {
      console.log(`Fill ${selector} with: ${value}`);
    },
    waitForSelector: async (selector: string) => {
      console.log(`Wait for: ${selector}`);
    },
    screenshot: async (options: any) => {
      console.log('Screenshot taken');
      return Buffer.from('');
    },
    close: async () => {
      console.log('Page closed');
    },
  };

  return {
    process: appProcess,
    page: mockPage as Page,
    close: async () => {
      console.log('Closing Tauri app...');
      appProcess.kill('SIGTERM');

      // Wait for graceful shutdown
      await new Promise((resolve) => {
        appProcess.once('exit', resolve);
        setTimeout(() => {
          if (appProcess.exitCode === null) {
            appProcess.kill('SIGKILL');
            resolve(null);
          }
        }, 5000);
      });
    },
  };
}

/**
 * Wait for the app to be ready
 */
export async function waitForAppReady(app: TauriApp, timeout = 10000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    // Check if process is still alive
    if (app.process.exitCode !== null) {
      throw new Error('App exited unexpectedly');
    }

    // TODO: Add actual readiness check (e.g., window title, IPC ping)
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
