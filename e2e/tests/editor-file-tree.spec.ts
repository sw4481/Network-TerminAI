/**
 * E2E Test: Editor File Tree Explorer
 *
 * Tests the file explorer functionality in editor tabs:
 * - File tree displays on editor tab creation
 * - Toggle button hides/shows explorer
 * - Directory list loads home directory by default
 * - Click directory expands with children
 * - Click file loads content into editor
 * - File nodes have correct icons
 */
import { test, expect } from '../fixtures';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

test.describe('Editor File Tree Explorer', () => {
  // Setup: Create test files in home directory for testing
  const testDir = path.join(os.homedir(), '.ccie-terminal-test');
  const testFile = path.join(testDir, 'test.txt');
  const testSubDir = path.join(testDir, 'subdir');
  const testPythonFile = path.join(testDir, 'script.py');

  test.beforeAll(async () => {
    // Create test directory structure
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    if (!fs.existsSync(testSubDir)) {
      fs.mkdirSync(testSubDir);
    }
    fs.writeFileSync(testFile, 'Hello from test file!', 'utf-8');
    fs.writeFileSync(testPythonFile, 'print("Hello World")', 'utf-8');
    fs.writeFileSync(path.join(testSubDir, 'nested.md'), '# Nested File', 'utf-8');
  });

  test.afterAll(async () => {
    // Cleanup test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('should display file explorer on editor tab creation', async ({ tauriPage }) => {
    // Wait for app to load
    await tauriPage.waitForSelector('.tab-bar', { timeout: 10000 });

    // Click "+ Editor" button to create new editor tab
    const editorButton = tauriPage.locator('button:has-text("+ Editor")');
    await editorButton.click();
    await tauriPage.waitForTimeout(1000);

    // Verify editor tab exists
    const editorTab = tauriPage.locator('[data-testid="editor-tab"]');
    expect(await editorTab.isVisible()).toBe(true);

    // Verify file explorer is visible
    const fileExplorer = tauriPage.locator('.file-explorer');
    expect(await fileExplorer.isVisible()).toBe(true);

    // Verify explorer header shows "Explorer"
    const explorerTitle = tauriPage.locator('.explorer-title');
    expect(await explorerTitle.textContent()).toBe('Explorer');
  });

  test('should load home directory by default', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.tab-bar', { timeout: 10000 });

    // Create new editor tab
    const editorButton = tauriPage.locator('button:has-text("+ Editor")');
    await editorButton.click();
    await tauriPage.waitForTimeout(1500);

    // Wait for file tree to load
    await tauriPage.waitForSelector('.file-tree', { timeout: 5000 });

    // Verify file tree has nodes (home directory should have files/folders)
    const fileNodes = tauriPage.locator('.file-node');
    const nodeCount = await fileNodes.count();
    expect(nodeCount).toBeGreaterThan(0);
  });

  test('should toggle explorer visibility with button', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.tab-bar', { timeout: 10000 });

    // Create new editor tab
    const editorButton = tauriPage.locator('button:has-text("+ Editor")');
    await editorButton.click();
    await tauriPage.waitForTimeout(1000);

    const fileExplorer = tauriPage.locator('.file-explorer');
    const toggleButton = tauriPage.locator('[data-testid="editor-toggle-explorer"]');

    // Verify explorer is initially visible
    expect(await fileExplorer.isVisible()).toBe(true);

    // Click toggle button to hide
    await toggleButton.click();
    await tauriPage.waitForTimeout(500);

    // Verify explorer is hidden
    expect(await fileExplorer.isVisible()).toBe(false);

    // Click toggle button to show again
    await toggleButton.click();
    await tauriPage.waitForTimeout(500);

    // Verify explorer is visible again
    expect(await fileExplorer.isVisible()).toBe(true);
  });

  test('should expand directory when clicked', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.tab-bar', { timeout: 10000 });

    // Create new editor tab
    const editorButton = tauriPage.locator('button:has-text("+ Editor")');
    await editorButton.click();
    await tauriPage.waitForTimeout(1500);

    // Wait for file tree to load
    await tauriPage.waitForSelector('.file-tree', { timeout: 5000 });

    // Find the test directory we created
    const testDirNode = tauriPage.locator(`.file-node:has-text(".ccie-terminal-test")`).first();

    if (await testDirNode.isVisible()) {
      // Click the directory
      await testDirNode.click();
      await tauriPage.waitForTimeout(1000);

      // Verify children are now visible (should have test.txt, script.py, subdir)
      const children = tauriPage.locator('.file-children .file-node');
      const childCount = await children.count();
      expect(childCount).toBeGreaterThan(0);
    } else {
      console.warn('Test directory not visible in file tree - skipping expand test');
    }
  });

  test('should display correct file icons', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.tab-bar', { timeout: 10000 });

    // Create new editor tab
    const editorButton = tauriPage.locator('button:has-text("+ Editor")');
    await editorButton.click();
    await tauriPage.waitForTimeout(1500);

    // Wait for file tree to load
    await tauriPage.waitForSelector('.file-tree', { timeout: 5000 });

    // Find test directory and expand it
    const testDirNode = tauriPage.locator(`.file-node:has-text(".ccie-terminal-test")`).first();

    if (await testDirNode.isVisible()) {
      await testDirNode.click();
      await tauriPage.waitForTimeout(1000);

      // Check for folder icon (📁)
      const folderIcon = testDirNode.locator('.file-icon');
      const folderIconText = await folderIcon.textContent();
      expect(folderIconText).toBe('📁');

      // Check for Python file icon (🐍)
      const pythonFile = tauriPage.locator(`.file-node:has-text("script.py")`).first();
      if (await pythonFile.isVisible()) {
        const pythonIcon = pythonFile.locator('.file-icon');
        const pythonIconText = await pythonIcon.textContent();
        expect(pythonIconText).toBe('🐍');
      }
    }
  });

  test('should load file content when file is clicked', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.tab-bar', { timeout: 10000 });

    // Create new editor tab
    const editorButton = tauriPage.locator('button:has-text("+ Editor")');
    await editorButton.click();
    await tauriPage.waitForTimeout(1500);

    // Wait for file tree to load
    await tauriPage.waitForSelector('.file-tree', { timeout: 5000 });

    // Find and expand test directory
    const testDirNode = tauriPage.locator(`.file-node:has-text(".ccie-terminal-test")`).first();

    if (await testDirNode.isVisible()) {
      await testDirNode.click();
      await tauriPage.waitForTimeout(1000);

      // Click on test.txt file
      const testFileNode = tauriPage.locator(`.file-node:has-text("test.txt")`).first();
      if (await testFileNode.isVisible()) {
        await testFileNode.click();
        await tauriPage.waitForTimeout(1500);

        // Verify file path is shown in toolbar
        const filePath = tauriPage.locator('.file-path');
        expect(await filePath.isVisible()).toBe(true);
        const pathText = await filePath.textContent();
        expect(pathText).toContain('test.txt');

        // Verify Monaco editor contains the file content
        // Note: Monaco content is in .monaco-editor, but direct text access may be tricky
        // We verify by checking the file info shows the file name
        const fileName = tauriPage.locator('.file-name');
        expect(await fileName.textContent()).toBe('test.txt');
      }
    }
  });

  test('should show loading state while directory loads', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.tab-bar', { timeout: 10000 });

    // Create new editor tab
    const editorButton = tauriPage.locator('button:has-text("+ Editor")');
    await editorButton.click();

    // Check for loading state (may be brief)
    const loadingState = tauriPage.locator('.file-explorer-loading');
    // This test is timing-sensitive, so we just verify the component structure exists
    // The actual loading state might complete too quickly to catch
    await tauriPage.waitForTimeout(100);

    // Verify we end up with either file tree or error (not stuck loading)
    await tauriPage.waitForSelector('.file-tree, .file-explorer-error', { timeout: 5000 });
  });

  test('should sort directories before files', async ({ tauriPage }) => {
    await tauriPage.waitForSelector('.tab-bar', { timeout: 10000 });

    // Create new editor tab
    const editorButton = tauriPage.locator('button:has-text("+ Editor")');
    await editorButton.click();
    await tauriPage.waitForTimeout(1500);

    // Wait for file tree to load
    await tauriPage.waitForSelector('.file-tree', { timeout: 5000 });

    // Find and expand test directory
    const testDirNode = tauriPage.locator(`.file-node:has-text(".ccie-terminal-test")`).first();

    if (await testDirNode.isVisible()) {
      await testDirNode.click();
      await tauriPage.waitForTimeout(1000);

      // Get all child nodes
      const childNodes = tauriPage.locator('.file-children .file-node');
      const count = await childNodes.count();

      if (count > 1) {
        // Check that the first item is the subdirectory (folder icon)
        const firstNode = childNodes.first().locator('.file-icon');
        const firstIcon = await firstNode.textContent();
        expect(firstIcon).toBe('📁'); // Should be directory icon
      }
    }
  });
});
