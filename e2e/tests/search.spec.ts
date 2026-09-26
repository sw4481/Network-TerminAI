/**
 * E2E Test: Search Functionality
 *
 * Tests the search feature:
 * - Open search with Cmd+F
 * - Type query
 * - Verify results appear
 * - Click result to navigate to tab
 */
import { test, expect } from '../fixtures';

test.describe('Search Functionality', () => {
  test('should open search with Cmd+F', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Press Cmd+F (or Ctrl+F on Windows/Linux)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+KeyF`);

    // Wait for search bar to appear
    await tauriPage.waitForTimeout(500);

    // Verify search bar is visible
    const searchBar = tauriPage.locator('.search-bar, [role="search"]');
    expect(await searchBar.isVisible()).toBe(true);

    // Verify search input is focused
    const searchInput = searchBar.locator('input[type="text"], input[type="search"]');
    expect(await searchInput.evaluate((el) => el === document.activeElement)).toBe(true);
  });

  test('should close search with Escape', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Open search
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+KeyF`);
    await tauriPage.waitForTimeout(500);

    const searchBar = tauriPage.locator('.search-bar, [role="search"]');
    expect(await searchBar.isVisible()).toBe(true);

    // Press Escape to close
    await tauriPage.keyboard.press('Escape');
    await tauriPage.waitForTimeout(500);

    // Search bar should be hidden
    expect(await searchBar.isVisible()).toBe(false);
  });

  test('should search command history', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Run some commands first to have searchable content
    await tauriPage.keyboard.type('echo "searchable content"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    await tauriPage.keyboard.type('ls -la');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    // Open search
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+KeyF`);
    await tauriPage.waitForTimeout(500);

    // Type search query
    const searchInput = tauriPage.locator('.search-bar input, [role="search"] input');
    await searchInput.fill('echo');

    // Wait for search results
    await tauriPage.waitForTimeout(1000);

    // Verify results appear
    const searchResults = tauriPage.locator('.search-results, .results-list');
    expect(await searchResults.isVisible()).toBe(true);

    // Should have at least one result
    const resultItems = searchResults.locator('.result-item, .search-result');
    expect(await resultItems.count()).toBeGreaterThanOrEqual(1);
  });

  test('should display search results with context', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Run command
    await tauriPage.keyboard.type('echo "unique-test-string-123"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(2000);

    // Open search
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+KeyF`);
    await tauriPage.waitForTimeout(500);

    // Search for the unique string
    const searchInput = tauriPage.locator('.search-bar input, [role="search"] input');
    await searchInput.fill('unique-test-string');
    await tauriPage.waitForTimeout(1000);

    // Check first result contains the search term
    const searchResults = tauriPage.locator('.search-results, .results-list');
    const firstResult = searchResults.locator('.result-item, .search-result').first();

    const resultText = await firstResult.textContent();
    expect(resultText).toContain('unique-test-string');
  });

  test('should navigate to tab when clicking search result', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Create a second tab and run command
    const newTabButton = tauriPage.locator('button:has-text("New Tab")');
    await newTabButton.click();
    await tauriPage.waitForTimeout(1000);

    await tauriPage.keyboard.type('echo "find-me-in-tab-2"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(2000);

    // Switch to first tab
    const tabs = tauriPage.locator('.tab-bar .tab');
    await tabs.first().click();
    await tauriPage.waitForTimeout(500);

    // Open search
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+KeyF`);
    await tauriPage.waitForTimeout(500);

    // Search for content in second tab
    const searchInput = tauriPage.locator('.search-bar input, [role="search"] input');
    await searchInput.fill('find-me-in-tab-2');
    await tauriPage.waitForTimeout(1000);

    // Click first result
    const searchResults = tauriPage.locator('.search-results, .results-list');
    const firstResult = searchResults.locator('.result-item, .search-result').first();
    await firstResult.click();
    await tauriPage.waitForTimeout(500);

    // Should navigate to second tab
    const activeTab = tauriPage.locator('.tab-bar .tab.active');
    const activeTabIndex = await tabs.evaluateAll((tabs, activeEl) => {
      return tabs.findIndex((tab) => tab === activeEl);
    }, activeTab);

    // Active tab should be the second one (index 1)
    expect(activeTabIndex).toBe(1);
  });

  test('should search across all tabs', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Run command in first tab
    await tauriPage.keyboard.type('echo "tab1-content"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    // Create second tab and run command
    const newTabButton = tauriPage.locator('button:has-text("New Tab")');
    await newTabButton.click();
    await tauriPage.waitForTimeout(1000);

    await tauriPage.keyboard.type('echo "tab2-content"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    // Open search
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+KeyF`);
    await tauriPage.waitForTimeout(500);

    // Search for "echo" which appears in both tabs
    const searchInput = tauriPage.locator('.search-bar input, [role="search"] input');
    await searchInput.fill('echo');
    await tauriPage.waitForTimeout(1000);

    // Should have results from multiple tabs
    const searchResults = tauriPage.locator('.search-results, .results-list');
    const resultItems = searchResults.locator('.result-item, .search-result');
    expect(await resultItems.count()).toBeGreaterThanOrEqual(2);
  });

  test('should search AI chat history', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Send a chat message
    const agentPanel = tauriPage.locator('.agent-panel');
    const input = agentPanel.locator('textarea, input[type="text"]');
    await input.fill('This is a unique chat message for search testing');

    const sendButton = agentPanel.locator('button:has-text("Send"), button[title="Send"]');
    await sendButton.click();
    await tauriPage.waitForTimeout(2000);

    // Open search
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+KeyF`);
    await tauriPage.waitForTimeout(500);

    // Search for the chat message
    const searchInput = tauriPage.locator('.search-bar input, [role="search"] input');
    await searchInput.fill('unique chat message');
    await tauriPage.waitForTimeout(1000);

    // Should find the AI chat message
    const searchResults = tauriPage.locator('.search-results, .results-list');
    const resultItems = searchResults.locator('.result-item, .search-result');
    expect(await resultItems.count()).toBeGreaterThanOrEqual(1);

    // Result should indicate it's from chat
    const firstResult = resultItems.first();
    const resultText = await firstResult.textContent();
    expect(resultText?.toLowerCase()).toMatch(/chat|ai|message/);
  });

  test('should handle no results gracefully', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Open search
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+KeyF`);
    await tauriPage.waitForTimeout(500);

    // Search for something that doesn't exist
    const searchInput = tauriPage.locator('.search-bar input, [role="search"] input');
    await searchInput.fill('xyznonexistentquery9999');
    await tauriPage.waitForTimeout(1000);

    // Should show "no results" message
    const searchResults = tauriPage.locator('.search-results, .results-list');
    const noResultsText = await searchResults.textContent();

    expect(noResultsText?.toLowerCase()).toMatch(/no results|nothing found|0 results/);
  });
});
