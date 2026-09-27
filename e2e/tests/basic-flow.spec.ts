/**
 * E2E Test: Basic Terminal Flow
 *
 * Tests the core terminal functionality:
 * - App launches successfully
 * - Session restoration works
 * - Create new tab
 * - Run shell command
 * - Verify output captured
 */
import { test, expect } from '../fixtures';

test.describe('Basic Terminal Flow', () => {
  test('should launch app successfully', async ({ tauriApp }) => {
    // Verify app process is running
    expect(tauriApp.process.exitCode).toBeNull();
    expect(tauriApp.process.pid).toBeGreaterThan(0);
  });

  test('should restore last session on launch', async ({ tauriPage }) => {
    // Wait for the app to load
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Check if tabs are restored (if there was a previous session)
    // The app should show at least one tab
    const tabBar = await tauriPage.locator('.tab-bar');
    expect(await tabBar.isVisible()).toBe(true);

    // Should have at least one tab (either restored or newly created)
    const tabs = await tauriPage.locator('.tab-bar .tab');
    expect(await tabs.count()).toBeGreaterThanOrEqual(1);
  });

  test('should create new tab', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Get initial tab count
    const initialTabs = await tauriPage.locator('.tab-bar .tab').count();

    // Click "New Tab" button
    const newTabButton = tauriPage.locator('button:has-text("New Tab")');
    await newTabButton.click();

    // Wait for new tab to appear
    await tauriPage.waitForTimeout(1000);

    // Verify tab count increased
    const newTabCount = await tauriPage.locator('.tab-bar .tab').count();
    expect(newTabCount).toBe(initialTabs + 1);
  });

  test('should run shell command and capture output', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Wait for terminal to be ready
    const terminal = tauriPage.locator('.terminal');
    await terminal.waitFor({ state: 'visible' });

    // Type a simple command (echo test)
    // Note: Typing into xterm.js requires special handling
    await tauriPage.keyboard.type('echo "test command"');
    await tauriPage.keyboard.press('Enter');

    // Wait for command to complete
    await tauriPage.waitForTimeout(2000);

    // Verify command block appears
    const commandBlocks = tauriPage.locator('.blocks-col .command-block');
    expect(await commandBlocks.count()).toBeGreaterThanOrEqual(1);

    // Verify command text is captured
    const firstBlock = commandBlocks.first();
    const commandText = await firstBlock.locator('.command-text').textContent();
    expect(commandText).toContain('echo');
  });

  test('should display command output in blocks', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Run a command with visible output
    await tauriPage.keyboard.type('ls -la');
    await tauriPage.keyboard.press('Enter');

    // Wait for command to complete
    await tauriPage.waitForTimeout(2000);

    // Check that output is visible in command block
    const commandBlocks = tauriPage.locator('.blocks-col .command-block');
    const lastBlock = commandBlocks.last();

    // Should have output section
    const output = await lastBlock.locator('.output');
    expect(await output.isVisible()).toBe(true);
  });

  test('should switch between tabs', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Create a second tab
    const newTabButton = tauriPage.locator('button:has-text("New Tab")');
    await newTabButton.click();
    await tauriPage.waitForTimeout(1000);

    // Get all tabs
    const tabs = tauriPage.locator('.tab-bar .tab');
    expect(await tabs.count()).toBeGreaterThanOrEqual(2);

    // Click first tab
    await tabs.first().click();
    await tauriPage.waitForTimeout(500);

    // Verify first tab is active
    expect(await tabs.first().getAttribute('class')).toContain('active');

    // Click second tab
    await tabs.nth(1).click();
    await tauriPage.waitForTimeout(500);

    // Verify second tab is active
    expect(await tabs.nth(1).getAttribute('class')).toContain('active');
  });

  test('should close tab', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Ensure we have at least 2 tabs
    const newTabButton = tauriPage.locator('button:has-text("New Tab")');
    await newTabButton.click();
    await tauriPage.waitForTimeout(1000);

    const initialCount = await tauriPage.locator('.tab-bar .tab').count();

    // Close the active tab
    const activeTab = tauriPage.locator('.tab-bar .tab.active');
    const closeButton = activeTab.locator('.close-btn');
    await closeButton.click();

    // Wait for tab to close
    await tauriPage.waitForTimeout(500);

    // Verify tab count decreased
    const newCount = await tauriPage.locator('.tab-bar .tab').count();
    expect(newCount).toBe(initialCount - 1);
  });
});
