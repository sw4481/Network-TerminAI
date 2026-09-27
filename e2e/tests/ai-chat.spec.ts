/**
 * E2E Test: AI Chat Integration
 *
 * Tests AI chat panel functionality:
 * - Open AI chat panel
 * - Send message
 * - Verify streaming response
 * - Test Cmd+K shortcut
 */
import { test, expect } from '../fixtures';

test.describe('AI Chat Integration', () => {
  test('should open AI chat panel', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Look for the agent panel
    const agentPanel = tauriPage.locator('.agent-panel');
    await agentPanel.waitFor({ state: 'visible', timeout: 5000 });

    // Panel should be visible by default
    expect(await agentPanel.isVisible()).toBe(true);
  });

  test('should toggle AI chat panel', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    const agentPanel = tauriPage.locator('.agent-panel');
    const toggleButton = tauriPage.locator('button[title*="Agent"]');

    // Panel should be visible initially
    const initiallyVisible = await agentPanel.isVisible();

    // Click toggle button
    await toggleButton.click();
    await tauriPage.waitForTimeout(500);

    // State should have changed
    const afterToggle = await agentPanel.isVisible();
    expect(afterToggle).toBe(!initiallyVisible);

    // Toggle again to restore
    await toggleButton.click();
    await tauriPage.waitForTimeout(500);

    const afterSecondToggle = await agentPanel.isVisible();
    expect(afterSecondToggle).toBe(initiallyVisible);
  });

  test('should send message to AI', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Ensure agent panel is visible
    const agentPanel = tauriPage.locator('.agent-panel');
    await agentPanel.waitFor({ state: 'visible' });

    // Find the input field
    const input = agentPanel.locator('textarea, input[type="text"]');
    await input.waitFor({ state: 'visible' });

    // Type a message
    await input.fill('Hello, can you help me with a test?');

    // Find and click send button
    const sendButton = agentPanel.locator('button:has-text("Send"), button[title="Send"]');
    await sendButton.click();

    // Wait for message to appear in chat history
    await tauriPage.waitForTimeout(2000);

    // Verify message appears in chat
    const messages = agentPanel.locator('.message, .chat-message');
    expect(await messages.count()).toBeGreaterThanOrEqual(1);

    // Check for user message
    const userMessages = messages.locator('.user, [data-role="user"]');
    expect(await userMessages.count()).toBeGreaterThanOrEqual(1);
  });

  test('should receive streaming AI response', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    const agentPanel = tauriPage.locator('.agent-panel');
    const input = agentPanel.locator('textarea, input[type="text"]');

    // Send a simple question
    await input.fill('What is 2 + 2?');
    const sendButton = agentPanel.locator('button:has-text("Send"), button[title="Send"]');
    await sendButton.click();

    // Wait for AI response to start streaming
    await tauriPage.waitForTimeout(3000);

    // Check for assistant message
    const messages = agentPanel.locator('.message, .chat-message');
    const assistantMessages = messages.locator('.assistant, [data-role="assistant"]');

    // Should have at least one assistant message
    expect(await assistantMessages.count()).toBeGreaterThanOrEqual(1);

    // Verify response contains some text
    const responseText = await assistantMessages.first().textContent();
    expect(responseText?.length).toBeGreaterThan(0);
  });

  test('should use Cmd+K shortcut to focus chat', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Press Cmd+K (or Ctrl+K on Windows/Linux)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await tauriPage.keyboard.press(`${modifier}+KeyK`);

    // Wait for chat panel to focus
    await tauriPage.waitForTimeout(500);

    // Verify agent panel is visible
    const agentPanel = tauriPage.locator('.agent-panel');
    expect(await agentPanel.isVisible()).toBe(true);

    // Verify input is focused
    const input = agentPanel.locator('textarea, input[type="text"]');
    expect(await input.evaluate((el) => el === document.activeElement)).toBe(true);
  });

  test('should show AI provider status', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    const agentPanel = tauriPage.locator('.agent-panel');

    // Look for provider/model indicator
    // This might show as "Claude 3.5 Sonnet" or "GPT-4" etc.
    const statusText = await agentPanel.textContent();

    // Should mention either a provider or model
    const hasProviderInfo =
      statusText?.includes('Claude') ||
      statusText?.includes('GPT') ||
      statusText?.includes('Gemini') ||
      statusText?.includes('Ollama') ||
      statusText?.includes('vLLM');

    expect(hasProviderInfo).toBe(true);
  });

  test('should handle AI error gracefully', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    // Send a message that might trigger an error (e.g., if API key is invalid)
    const agentPanel = tauriPage.locator('.agent-panel');
    const input = agentPanel.locator('textarea, input[type="text"]');

    await input.fill('Test error handling');
    const sendButton = agentPanel.locator('button:has-text("Send"), button[title="Send"]');
    await sendButton.click();

    // Wait for response or error
    await tauriPage.waitForTimeout(5000);

    // Check that UI is still responsive (no crash)
    expect(await agentPanel.isVisible()).toBe(true);
    expect(await input.isEnabled()).toBe(true);
  });

  test('should maintain chat history per tab', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.shell', { timeout: 10000 });

    const agentPanel = tauriPage.locator('.agent-panel');
    const input = agentPanel.locator('textarea, input[type="text"]');

    // Send message in first tab
    await input.fill('Message in tab 1');
    const sendButton = agentPanel.locator('button:has-text("Send"), button[title="Send"]');
    await sendButton.click();
    await tauriPage.waitForTimeout(2000);

    // Get message count in first tab
    const tab1Messages = await agentPanel.locator('.message, .chat-message').count();

    // Create new tab
    const newTabButton = tauriPage.locator('button:has-text("New Tab")');
    await newTabButton.click();
    await tauriPage.waitForTimeout(1000);

    // New tab should have empty chat history
    const tab2Messages = await agentPanel.locator('.message, .chat-message').count();
    expect(tab2Messages).toBe(0);

    // Switch back to first tab
    const tabs = tauriPage.locator('.tab-bar .tab');
    await tabs.first().click();
    await tauriPage.waitForTimeout(500);

    // First tab should still have its messages
    const tab1MessagesAfter = await agentPanel.locator('.message, .chat-message').count();
    expect(tab1MessagesAfter).toBe(tab1Messages);
  });
});
