/**
 * E2E Test: Command Blocks
 *
 * Tests the command blocks feature:
 * - Block creation on command execution
 * - Exit codes displayed correctly
 * - Collapse/expand functionality
 * - Bookmarking blocks
 * - Command palette (Cmd+K)
 * - Fuzzy search filtering
 * - Keyboard navigation
 *
 * NOTE: These tests are currently SKIPPED because they require proper WebDriver
 * setup via tauri-driver. The current tauri-driver.ts uses a mock page object
 * that cannot interact with the actual UI.
 *
 * To enable these tests:
 * 1. Install tauri-driver: cargo install tauri-driver
 * 2. Update tauri-driver.ts to use WebDriver instead of mock
 * 3. Configure Playwright to connect via WebDriver protocol
 * 4. Rebuild tests with proper selectors
 *
 * For now, these features should be tested manually using Terminal mode (blocks
 * are created via OSC 133) or Blocks mode (Warp-style interface).
 */
import { test, expect } from '../fixtures';

// Skip all tests in this suite until WebDriver is properly configured
test.describe.skip('Command Blocks', () => {
  test('should create blocks for each command', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Run a command
    await tauriPage.keyboard.type('echo "Hello World"');
    await tauriPage.keyboard.press('Enter');

    // Wait for block to be created
    await tauriPage.waitForTimeout(2000);

    // Verify block was created
    const blocks = await tauriPage.locator('[data-block-id]').count();
    expect(blocks).toBeGreaterThan(0);

    // Verify command text is in block header
    const commandText = await tauriPage.locator('.command-text').first().textContent();
    expect(commandText).toContain('echo');
  });

  test('should show exit code after command completes', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Run a successful command
    await tauriPage.keyboard.type('true');
    await tauriPage.keyboard.press('Enter');

    // Wait for command to complete
    await tauriPage.waitForTimeout(2000);

    // Verify exit code appears
    const exitCode = await tauriPage.locator('.exit-code').first().textContent();
    expect(exitCode).toContain('0');
  });

  test('should collapse and expand blocks', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Run a command with output
    await tauriPage.keyboard.type('ls');
    await tauriPage.keyboard.press('Enter');

    // Wait for command to complete
    await tauriPage.waitForTimeout(2000);

    // Get the block
    const block = tauriPage.locator('[data-block-id]').first();

    // Initially expanded - output should be visible
    await expect(block.locator('.output-text')).toBeVisible();

    // Click header to collapse
    await block.locator('.block-header').click();

    // Wait for animation
    await tauriPage.waitForTimeout(500);

    // Output should be hidden
    await expect(block.locator('.output-text')).not.toBeVisible();

    // Click again to expand
    await block.locator('.block-header').click();

    // Wait for animation
    await tauriPage.waitForTimeout(500);

    // Output should be visible again
    await expect(block.locator('.output-text')).toBeVisible();
  });

  test('should bookmark blocks', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Run a command
    await tauriPage.keyboard.type('echo "important"');
    await tauriPage.keyboard.press('Enter');

    // Wait for command to complete
    await tauriPage.waitForTimeout(2000);

    const block = tauriPage.locator('[data-block-id]').first();

    // Click bookmark button
    const bookmarkBtn = block.locator('.action-btn').filter({ hasText: '★' });
    await bookmarkBtn.click();

    // Wait for update
    await tauriPage.waitForTimeout(500);

    // Verify bookmark indicator appears (button should be highlighted/filled)
    const bookmarkState = await bookmarkBtn.getAttribute('class');
    expect(bookmarkState).toContain('bookmarked');
  });

  test('should open command palette with Cmd+K', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Press Cmd+K (Meta on macOS, Control on others)
    await tauriPage.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');

    // Wait for palette to appear
    await tauriPage.waitForTimeout(500);

    // Palette should open
    await expect(tauriPage.locator('.palette-modal')).toBeVisible();

    // Search input should be visible
    const input = tauriPage.locator('.palette-search input');
    await expect(input).toBeVisible();
  });

  test('should filter palette items by query', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Run some commands first
    await tauriPage.keyboard.type('git status');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    await tauriPage.keyboard.type('npm install');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    // Open palette
    await tauriPage.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await tauriPage.waitForTimeout(500);

    // Type search query
    const input = tauriPage.locator('.palette-search input');
    await input.fill('git');

    // Wait for filter
    await tauriPage.waitForTimeout(300);

    // Should show git-related items
    const items = await tauriPage.locator('.palette-item').count();
    expect(items).toBeGreaterThan(0);

    // First item should contain 'git'
    const firstItemText = await tauriPage.locator('.palette-item').first().textContent();
    expect(firstItemText?.toLowerCase()).toContain('git');
  });

  test('should close palette with Escape', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Open palette
    await tauriPage.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await tauriPage.waitForTimeout(500);
    await expect(tauriPage.locator('.palette-modal')).toBeVisible();

    // Press Escape
    await tauriPage.keyboard.press('Escape');

    // Wait for close animation
    await tauriPage.waitForTimeout(300);

    // Palette should close
    await expect(tauriPage.locator('.palette-modal')).not.toBeVisible();
  });

  test('should navigate palette items with arrow keys', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Run a few commands to populate history
    await tauriPage.keyboard.type('echo "test1"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    await tauriPage.keyboard.type('echo "test2"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    // Open palette
    await tauriPage.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await tauriPage.waitForTimeout(500);

    // Navigate down
    await tauriPage.keyboard.press('ArrowDown');
    await tauriPage.waitForTimeout(200);

    // Second item should be selected
    const selectedItems = await tauriPage.locator('.palette-item.selected').count();
    expect(selectedItems).toBe(1);

    // Navigate up
    await tauriPage.keyboard.press('ArrowUp');
    await tauriPage.waitForTimeout(200);

    // First item should be selected
    const firstSelected = await tauriPage.locator('.palette-item.selected').first();
    expect(await firstSelected.isVisible()).toBe(true);
  });
});
