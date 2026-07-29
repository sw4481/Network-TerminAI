# End-to-End Testing for CCIE Terminal

This directory contains end-to-end (E2E) tests for the CCIE Terminal application using Playwright.

## Overview

The E2E tests verify critical user flows in the application:

1. **Basic Terminal Flow** - App launch, session restoration, tab management, command execution
2. **AI Chat Integration** - AI panel interaction, message streaming, keyboard shortcuts
3. **Search Functionality** - Full-text search across commands, output, and AI chat
4. **Session Management** - Save/load sessions, tab restoration, export/import

## Prerequisites

- Node.js 22+ and Bun installed
- Rust toolchain (for building Tauri app)
- Python 3.12+ (for sidecar)
- All dependencies installed (`bun install`)

## Running Tests

### Run all E2E tests
```bash
bun run test:e2e
```

### Run with UI mode (interactive)
```bash
bun run test:e2e:ui
```

### Run in debug mode (step through)
```bash
bun run test:e2e:debug
```

### Run specific test file
```bash
bunx playwright test e2e/tests/basic-flow.spec.ts
```

### View test report
```bash
bun run test:e2e:report
```

## Test Structure

```
e2e/
├── playwright.config.ts       # Playwright configuration
├── global-setup.ts            # Build Tauri app before tests
├── global-teardown.ts         # Cleanup after tests
├── fixtures.ts                # Custom Playwright fixtures
├── tauri-driver.ts            # Tauri app launch utilities
└── tests/
    ├── basic-flow.spec.ts     # Terminal and tab tests
    ├── ai-chat.spec.ts        # AI integration tests
    ├── search.spec.ts         # Search functionality tests
    └── sessions.spec.ts       # Session management tests
```

## Important Notes

### Tauri E2E Testing Challenges

Tauri applications use native webviews (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux) which are not directly accessible via Playwright's browser automation. This presents challenges:

1. **No Remote Debugging Protocol**: Unlike Electron apps, Tauri doesn't expose a CDP (Chrome DevTools Protocol) endpoint by default.

2. **WebDriver Support**: The recommended approach for Tauri E2E testing is using `tauri-driver`, a WebDriver implementation for Tauri. However, this requires additional setup.

3. **Current Implementation**: The test scaffolds in this directory demonstrate the test structure but may need adaptation based on your chosen testing strategy.

### Recommended Approaches

#### Option 1: Use tauri-driver (Recommended)

Install tauri-driver and configure WebDriver:

```bash
cargo install tauri-driver
```

Then update the tests to use WebDriver instead of direct Playwright browser contexts.

#### Option 2: Manual Testing with QA Checklist

For Phase 7, focus on comprehensive manual testing using the QA checklist:

```
docs/QA_CHECKLIST.md
```

This 200+ point checklist covers all features, edge cases, and platform-specific behavior.

#### Option 3: Integration Testing at Tauri Command Level

Instead of E2E UI testing, test Tauri commands directly:

```typescript
// Example: Test Tauri commands from frontend
import { invoke } from '@tauri-apps/api/core';

test('spawn_terminal command works', async () => {
  const result = await invoke('spawn_terminal', {
    shell: '/bin/zsh',
    cwd: '/tmp'
  });
  expect(result.tab_id).toBeDefined();
});
```

## Writing Tests

### Using Fixtures

The `test` fixture from `fixtures.ts` provides a `tauriApp` and `tauriPage`:

```typescript
import { test, expect } from '../fixtures';

test('my test', async ({ tauriApp, tauriPage }) => {
  // tauriApp - access to app process
  expect(tauriApp.process.exitCode).toBeNull();
  
  // tauriPage - Playwright Page object (if webview is accessible)
  await tauriPage.goto('tauri://localhost');
  await tauriPage.click('button.new-tab');
});
```

### Selectors

Use descriptive selectors that match the actual UI:

```typescript
// By class
await page.locator('.agent-panel').click();

// By text
await page.locator('button:has-text("New Tab")').click();

// By role
await page.locator('[role="search"]').fill('query');

// By test ID (recommended - add data-testid attributes)
await page.locator('[data-testid="new-tab-button"]').click();
```

### Waiting Strategies

```typescript
// Wait for element
await page.waitForSelector('.terminal', { timeout: 10000 });

// Wait for condition
await page.waitForFunction(() => document.querySelectorAll('.tab').length > 1);

// Wait for timeout (last resort)
await page.waitForTimeout(1000);
```

## Debugging Tests

### Take Screenshots
```typescript
await tauriPage.screenshot({ path: 'debug-screenshot.png' });
```

### Enable Video Recording
Videos are automatically recorded on failure (configured in `playwright.config.ts`).

### View Traces
Traces are captured on failure. View with:
```bash
bunx playwright show-trace trace.zip
```

### Console Logs
```typescript
page.on('console', msg => console.log('PAGE LOG:', msg.text()));
```

## CI/CD Integration

Add to GitHub Actions:

```yaml
- name: Install Playwright
  run: bunx playwright install --with-deps

- name: Run E2E Tests
  run: bun run test:e2e
  env:
    CCIE_REPO_ROOT: ${{ github.workspace }}

- name: Upload Test Report
  if: always()
  uses: actions/upload-artifact@v3
  with:
    name: playwright-report
    path: e2e/test-results/
```

## Test Coverage

The E2E tests aim to cover:

- ✅ Core terminal functionality (80% coverage goal)
- ✅ Multi-tab management (90% coverage goal)
- ✅ AI chat integration (70% coverage goal)
- ✅ Search across tabs (80% coverage goal)
- ✅ Session save/restore (90% coverage goal)
- ⚠️ MCP integration (manual testing recommended)
- ⚠️ Skills system (manual testing recommended)

## Known Limitations

1. **Webview Access**: Direct webview DOM access may not be possible without tauri-driver
2. **Native UI**: File pickers, system dialogs cannot be automated
3. **Keyboard Input**: Some keyboard shortcuts may not work in automated tests
4. **Timing Issues**: Tauri IPC calls have variable latency
5. **Platform Differences**: Tests may need platform-specific adjustments

## Contributing

When adding new features, add corresponding E2E tests:

1. Create a new `.spec.ts` file in `e2e/tests/`
2. Use the fixture pattern for consistency
3. Write clear test descriptions
4. Add appropriate assertions
5. Handle async operations with proper waits
6. Test both happy paths and error cases

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [Tauri Testing Guide](https://tauri.app/v2/guides/testing/)
- [tauri-driver GitHub](https://github.com/tauri-apps/tauri-driver)
- [WebDriver Protocol](https://www.w3.org/TR/webdriver/)

## Support

For questions or issues with E2E tests:
1. Check the troubleshooting section in docs/QA_CHECKLIST.md
2. Review Playwright documentation
3. Consult Tauri testing guide
4. File an issue with test logs and screenshots
