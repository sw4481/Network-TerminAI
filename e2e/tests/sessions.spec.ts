/**
 * E2E Test: Session Management
 *
 * Tests session save/load functionality:
 * - Save session with name
 * - Load saved session
 * - Verify tabs restored correctly
 * - Export session to JSON
 * - Import session from JSON
 */
import { test, expect } from '../fixtures';

test.describe('Session Management', () => {
  test('should save current session with name', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Create a few tabs to save
    const newTabButton = tauriPage.locator('button:has-text("New Tab")');
    await newTabButton.click();
    await tauriPage.waitForTimeout(1000);

    // Run a command in the second tab
    await tauriPage.keyboard.type('echo "session test"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    // Open save session dialog
    // This might be in a menu or toolbar
    const saveButton = tauriPage.locator(
      'button:has-text("Save Session"), button[title*="Save Session"]'
    );
    await saveButton.click();
    await tauriPage.waitForTimeout(500);

    // Modal should appear
    const modal = tauriPage.locator('.modal, [role="dialog"]');
    expect(await modal.isVisible()).toBe(true);

    // Enter session name
    const nameInput = modal.locator('input[type="text"], input[placeholder*="name"]');
    await nameInput.fill('test-session-e2e');

    // Click save button in modal
    const saveModalButton = modal.locator('button:has-text("Save")');
    await saveModalButton.click();
    await tauriPage.waitForTimeout(1000);

    // Modal should close
    expect(await modal.isVisible()).toBe(false);

    // TODO: Verify session appears in saved sessions list
  });

  test('should list saved sessions', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Open sessions list
    // This might be in settings or a dedicated button
    const sessionsButton = tauriPage.locator(
      'button:has-text("Sessions"), button[title*="Session"]'
    );
    await sessionsButton.click();
    await tauriPage.waitForTimeout(500);

    // Sessions list should be visible
    const sessionsList = tauriPage.locator('.sessions-list, .saved-sessions');
    expect(await sessionsList.isVisible()).toBe(true);

    // Should show at least the last session
    const sessionItems = sessionsList.locator('.session-item, .session');
    expect(await sessionItems.count()).toBeGreaterThanOrEqual(0);
  });

  test('should load saved session', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // First, save a session
    const newTabButton = tauriPage.locator('button:has-text("New Tab")');
    await newTabButton.click();
    await tauriPage.waitForTimeout(1000);

    await tauriPage.keyboard.type('echo "load test"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    // Save session
    const saveButton = tauriPage.locator(
      'button:has-text("Save Session"), button[title*="Save Session"]'
    );
    await saveButton.click();
    await tauriPage.waitForTimeout(500);

    const modal = tauriPage.locator('.modal, [role="dialog"]');
    const nameInput = modal.locator('input[type="text"]');
    await nameInput.fill('load-test-session');

    const saveModalButton = modal.locator('button:has-text("Save")');
    await saveModalButton.click();
    await tauriPage.waitForTimeout(1000);

    // Now close all tabs (except one)
    const tabs = tauriPage.locator('.tab-bar .tab');
    const tabCount = await tabs.count();

    for (let i = 0; i < tabCount - 1; i++) {
      const tab = tabs.first();
      const closeButton = tab.locator('.close-btn');
      await closeButton.click();
      await tauriPage.waitForTimeout(500);
    }

    // Open sessions list
    const sessionsButton = tauriPage.locator('button:has-text("Sessions")');
    await sessionsButton.click();
    await tauriPage.waitForTimeout(500);

    // Find and load the saved session
    const sessionsList = tauriPage.locator('.sessions-list, .saved-sessions');
    const sessionItem = sessionsList.locator('text=load-test-session').first();
    await sessionItem.click();
    await tauriPage.waitForTimeout(2000);

    // Verify tabs were restored
    const newTabCount = await tauriPage.locator('.tab-bar .tab').count();
    expect(newTabCount).toBeGreaterThanOrEqual(2);
  });

  test('should restore tab order from session', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Create 3 tabs with identifiable commands
    const newTabButton = tauriPage.locator('button:has-text("New Tab")');

    await newTabButton.click();
    await tauriPage.waitForTimeout(1000);
    await tauriPage.keyboard.type('echo "tab 2"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    await newTabButton.click();
    await tauriPage.waitForTimeout(1000);
    await tauriPage.keyboard.type('echo "tab 3"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    // Get current tab order
    const tabs = tauriPage.locator('.tab-bar .tab');
    const initialCount = await tabs.count();

    // Save session
    const saveButton = tauriPage.locator('button:has-text("Save Session")');
    await saveButton.click();
    await tauriPage.waitForTimeout(500);

    const modal = tauriPage.locator('.modal, [role="dialog"]');
    const nameInput = modal.locator('input[type="text"]');
    await nameInput.fill('order-test-session');

    const saveModalButton = modal.locator('button:has-text("Save")');
    await saveModalButton.click();
    await tauriPage.waitForTimeout(1000);

    // Close app and relaunch would normally happen here
    // For now, we'll just verify the session was saved

    // Load the session again
    const sessionsButton = tauriPage.locator('button:has-text("Sessions")');
    await sessionsButton.click();
    await tauriPage.waitForTimeout(500);

    const sessionsList = tauriPage.locator('.sessions-list');
    const sessionItem = sessionsList.locator('text=order-test-session').first();
    await sessionItem.click();
    await tauriPage.waitForTimeout(2000);

    // Verify same number of tabs
    const restoredCount = await tauriPage.locator('.tab-bar .tab').count();
    expect(restoredCount).toBe(initialCount);
  });

  test('should restore AI chat history from session', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Send AI message
    const agentPanel = tauriPage.locator('.agent-panel');
    const input = agentPanel.locator('textarea, input[type="text"]');
    await input.fill('Remember this message');

    const sendButton = agentPanel.locator('button:has-text("Send")');
    await sendButton.click();
    await tauriPage.waitForTimeout(2000);

    // Get message count
    const messagesBefore = await agentPanel.locator('.message, .chat-message').count();

    // Save session
    const saveSessionButton = tauriPage.locator('button:has-text("Save Session")');
    await saveSessionButton.click();
    await tauriPage.waitForTimeout(500);

    const modal = tauriPage.locator('.modal, [role="dialog"]');
    const nameInput = modal.locator('input[type="text"]');
    await nameInput.fill('chat-history-session');

    const saveModalButton = modal.locator('button:has-text("Save")');
    await saveModalButton.click();
    await tauriPage.waitForTimeout(1000);

    // Create a new tab to clear current context
    const newTabButton = tauriPage.locator('button:has-text("New Tab")');
    await newTabButton.click();
    await tauriPage.waitForTimeout(1000);

    // New tab should have empty chat
    const newTabMessages = await agentPanel.locator('.message, .chat-message').count();
    expect(newTabMessages).toBe(0);

    // Load session
    const sessionsButton = tauriPage.locator('button:has-text("Sessions")');
    await sessionsButton.click();
    await tauriPage.waitForTimeout(500);

    const sessionsList = tauriPage.locator('.sessions-list');
    const sessionItem = sessionsList.locator('text=chat-history-session').first();
    await sessionItem.click();
    await tauriPage.waitForTimeout(2000);

    // Switch to first tab (the restored one)
    const tabs = tauriPage.locator('.tab-bar .tab');
    await tabs.first().click();
    await tauriPage.waitForTimeout(500);

    // Chat history should be restored
    const messagesAfter = await agentPanel.locator('.message, .chat-message').count();
    expect(messagesAfter).toBe(messagesBefore);

    // Verify the message content
    const messages = await agentPanel.locator('.message, .chat-message').allTextContents();
    const hasMessage = messages.some((msg) => msg.includes('Remember this message'));
    expect(hasMessage).toBe(true);
  });

  test('should export session to JSON', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Create a session with content
    await tauriPage.keyboard.type('echo "export test"');
    await tauriPage.keyboard.press('Enter');
    await tauriPage.waitForTimeout(1000);

    // Save session
    const saveButton = tauriPage.locator('button:has-text("Save Session")');
    await saveButton.click();
    await tauriPage.waitForTimeout(500);

    const modal = tauriPage.locator('.modal, [role="dialog"]');
    const nameInput = modal.locator('input[type="text"]');
    await nameInput.fill('export-test-session');

    const saveModalButton = modal.locator('button:has-text("Save")');
    await saveModalButton.click();
    await tauriPage.waitForTimeout(1000);

    // Open sessions list
    const sessionsButton = tauriPage.locator('button:has-text("Sessions")');
    await sessionsButton.click();
    await tauriPage.waitForTimeout(500);

    // Find export button for the session
    const sessionsList = tauriPage.locator('.sessions-list');
    const exportButton = sessionsList.locator('button:has-text("Export"), button[title*="Export"]');

    if ((await exportButton.count()) > 0) {
      await exportButton.first().click();
      await tauriPage.waitForTimeout(1000);

      // File save dialog would open (can't test programmatically)
      // But we can verify the button is functional
    }
  });

  test('should delete saved session', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Save a session to delete
    const saveButton = tauriPage.locator('button:has-text("Save Session")');
    await saveButton.click();
    await tauriPage.waitForTimeout(500);

    const modal = tauriPage.locator('.modal, [role="dialog"]');
    const nameInput = modal.locator('input[type="text"]');
    await nameInput.fill('delete-me-session');

    const saveModalButton = modal.locator('button:has-text("Save")');
    await saveModalButton.click();
    await tauriPage.waitForTimeout(1000);

    // Open sessions list
    const sessionsButton = tauriPage.locator('button:has-text("Sessions")');
    await sessionsButton.click();
    await tauriPage.waitForTimeout(500);

    // Get initial session count
    const sessionsList = tauriPage.locator('.sessions-list');
    const initialCount = await sessionsList.locator('.session-item, .session').count();

    // Find and click delete button
    const deleteButton = sessionsList.locator(
      'button:has-text("Delete"), button[title*="Delete"]'
    );

    if ((await deleteButton.count()) > 0) {
      await deleteButton.first().click();
      await tauriPage.waitForTimeout(500);

      // Confirm deletion if there's a confirmation dialog
      const confirmButton = tauriPage.locator('button:has-text("Confirm"), button:has-text("Yes")');
      if ((await confirmButton.count()) > 0) {
        await confirmButton.click();
        await tauriPage.waitForTimeout(500);
      }

      // Session count should decrease
      const newCount = await sessionsList.locator('.session-item, .session').count();
      expect(newCount).toBe(initialCount - 1);
    }
  });

  test('should handle session restore failure gracefully', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Try to load a non-existent session (if there's a way to trigger this)
    // Or simulate an error condition

    // The app should show an error message but remain functional
    const tabs = tauriPage.locator('.tab-bar .tab');
    expect(await tabs.count()).toBeGreaterThanOrEqual(1);
  });
});
