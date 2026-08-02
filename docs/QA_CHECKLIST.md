# QA Checklist - CCIE Terminal v1.0

**Testing Date:** _____________  
**Tester:** _____________  
**Platform:** macOS / Linux / Windows (circle one)  
**Build:** _____________

---

## 1. Installation & First Launch

- [ ] App installs without errors
- [ ] macOS checksum matches and the documented Gatekeeper override succeeds
- [ ] Windows checksum matches and the documented SmartScreen path is recorded
- [ ] Linux AppImage and Debian installs each select their matching signed updater
- [ ] First launch creates config directory (`~/.config/ccie-terminal/`)
- [ ] Default shell integration installs successfully
- [ ] SQLite database initializes correctly
- [ ] No console errors on first launch

**Notes:**

---

## 2. Terminal Functionality

### Basic Terminal Operations
- [ ] Terminal displays prompt correctly
- [ ] Can type commands
- [ ] Commands execute (e.g., `echo test`)
- [ ] Output displays correctly
- [ ] ANSI colors render properly
- [ ] Unicode characters display correctly
- [ ] Copy/paste works (Cmd+C, Cmd+V)
- [ ] Terminal scrolls correctly
- [ ] Resize terminal window - reflows correctly

### PTY & Shell Integration
- [ ] Shell integration markers work (OSC 133)
- [ ] Current working directory tracked correctly
- [ ] Exit codes captured correctly (0 vs non-zero)
- [ ] Long-running commands work (e.g., `sleep 5`)
- [ ] Ctrl+C interrupts running command
- [ ] Shell history persists across sessions

**Notes:**

---

## 3. Multi-Tab Functionality

- [ ] New tab creates successfully (New Tab button)
- [ ] New tab keyboard shortcut works (Cmd+T)
- [ ] Tab shows correct title (shell name or cwd)
- [ ] Switch between tabs (click)
- [ ] Switch between tabs (keyboard shortcut Cmd+1, Cmd+2, etc.)
- [ ] Close tab (close button)
- [ ] Close tab keyboard shortcut (Cmd+W)
- [ ] Cannot close last tab (or app prompts before closing)
- [ ] Each tab has independent terminal state
- [ ] Each tab has independent working directory
- [ ] Each tab has independent AI chat history

**Edge Cases:**
- [ ] Create 10+ tabs - performance remains good
- [ ] Close tabs in random order - no crashes
- [ ] Close active tab - switches to adjacent tab correctly

**Notes:**

---

## 4. Command Blocks

- [ ] Commands parse into blocks correctly
- [ ] Block shows command text
- [ ] Block shows output
- [ ] Block shows exit code (✓ for 0, ✗ for non-zero)
- [ ] Block shows timestamp
- [ ] Failed command blocks highlighted (red/warning color)
- [ ] Can copy command text
- [ ] Can copy output
- [ ] Can collapse/expand blocks
- [ ] Blocks scroll independently from terminal
- [ ] Long output truncated with "Show more" option

**Edge Cases:**
- [ ] Very long command (>1000 chars) displays correctly
- [ ] Very long output (>100KB) doesn't freeze UI
- [ ] Output with null bytes handled correctly
- [ ] Binary output doesn't corrupt display

**Notes:**

---

## 5. AI Chat Integration

### Basic Chat
- [ ] AI panel visible by default
- [ ] Can toggle AI panel open/close
- [ ] Chat input field works
- [ ] Send button works
- [ ] Keyboard shortcut sends message (Cmd+Enter)
- [ ] Cmd+K focuses chat input
- [ ] User messages appear immediately
- [ ] AI responses stream (don't wait for completion)
- [ ] Can scroll chat history
- [ ] Chat history persists across app restarts

### AI Providers
- [ ] Can configure API keys in Settings
- [ ] Can select provider profile (fast, smart, local, etc.)
- [ ] Claude provider works (if API key configured)
- [ ] OpenAI provider works (if API key configured)
- [ ] Google provider works (if API key configured)
- [ ] Ollama provider works (if running locally)
- [ ] vLLM provider works (if configured)
- [ ] Shows clear error for invalid API key
- [ ] Shows clear error for rate limiting
- [ ] Can switch providers mid-conversation

### AI Features
- [ ] `#` command conversion works (e.g., `# list files`)
- [ ] NL command inserts into prompt (doesn't auto-execute)
- [ ] "✨ Fix this" button appears on failed commands
- [ ] "Fix this" suggests corrected command
- [ ] "Explain this" works on command blocks
- [ ] AI can read scrollback history
- [ ] AI respects per-tab context (doesn't mix tabs)
- [ ] Token usage displayed (if available from provider)

**Edge Cases:**
- [ ] Very long AI response (10K+ tokens) renders correctly
- [ ] Network timeout handled gracefully
- [ ] Cancel streaming response works
- [ ] Multiple rapid messages don't crash

**Notes:**

---

## 6. Search Functionality

- [ ] Cmd+F opens search bar
- [ ] Search input focused when opened
- [ ] Escape closes search bar
- [ ] Search results update as you type
- [ ] Search finds commands
- [ ] Search finds output
- [ ] Search finds AI chat messages
- [ ] Search highlights matches
- [ ] Search shows tab name for each result
- [ ] Click result navigates to correct tab
- [ ] Search works across all tabs
- [ ] "No results" message when nothing found

**Edge Cases:**
- [ ] Search with special regex characters (e.g., `.*`)
- [ ] Search with very long query (>1000 chars)
- [ ] Search with Unicode characters
- [ ] Empty search shows all recent items

**Notes:**

---

## 7. Session Management

- [ ] Last session restores on app launch
- [ ] Tabs restored with correct count
- [ ] Tab order preserved
- [ ] Working directory restored per tab
- [ ] AI chat history restored per tab
- [ ] Active tab restored correctly
- [ ] Scrollback restored (if implemented)

### Named Sessions
- [ ] Can save current session with name
- [ ] Save session modal appears
- [ ] Session name validation (no empty names)
- [ ] Saved sessions list shows all sessions
- [ ] Can load saved session
- [ ] Loading session replaces current tabs
- [ ] Can delete saved session
- [ ] Delete prompts for confirmation
- [ ] Can rename saved session
- [ ] Can export session to JSON
- [ ] JSON export contains all tab data
- [ ] Can import session from JSON

**Edge Cases:**
- [ ] Save session with 20+ tabs
- [ ] Save session with large scrollback (10MB+)
- [ ] Load session while commands are running
- [ ] Import corrupted JSON - shows error

**Notes:**

---

## 8. MCP (Model Context Protocol) Integration

### MCP Server Management
- [ ] Can add MCP server in Settings
- [ ] Can add via JSON paste (Import MCP Server)
- [ ] Server config validates (required fields)
- [ ] Server list shows all added servers
- [ ] Can enable/disable server
- [ ] Can edit server config
- [ ] Can delete server
- [ ] Server status shown (running, stopped, error)
- [ ] Server stderr visible for debugging

### MCP Tool Usage
- [ ] AI can discover MCP tools
- [ ] Tool call prompts for approval
- [ ] Approval modal shows tool name, args, server
- [ ] Can approve tool call
- [ ] Can deny tool call
- [ ] "Always allow for this server" works
- [ ] Tool result returned to AI correctly
- [ ] Tool call history visible

**MCP Transports:**
- [ ] stdio transport works
- [ ] HTTP/SSE transport works
- [ ] Environment variables passed correctly

**Edge Cases:**
- [ ] MCP server crashes - app doesn't crash
- [ ] MCP tool timeout handled gracefully
- [ ] Very large tool response (1MB+) handled

**Notes:**

---

## 9. Skills System

### Skill Management
- [ ] Skills directory created (`~/.ccie-terminal/skills/`)
- [ ] Skills list shows installed skills
- [ ] Skill detail view shows metadata
- [ ] Skill detail shows scripts
- [ ] Can enable/disable skill
- [ ] Can delete skill
- [ ] Skill hot reload works (edit SKILL.md, app sees changes)

### Skill Creation
- [ ] "Create Skill" wizard opens
- [ ] Wizard has clear steps
- [ ] Can enter skill name, description
- [ ] Can specify when-to-use criteria
- [ ] Can add script files
- [ ] "Generate with AI" creates skill from description
- [ ] Generated skill has valid SKILL.md
- [ ] Generated skill has working scripts
- [ ] Can preview generated skill before saving
- [ ] Can edit generated skill before saving
- [ ] Saved skill appears in skills list

### Skill Invocation
- [ ] `/skill-name` manually invokes skill
- [ ] AI auto-triggers skill based on when-to-use
- [ ] Skill scripts execute correctly
- [ ] Script output captured and returned to AI
- [ ] Script errors handled gracefully
- [ ] Script timeout works (doesn't hang forever)

**Edge Cases:**
- [ ] Skill with no scripts
- [ ] Skill script returns very large output (1MB+)
- [ ] Skill script runs very long (1min+) - can cancel
- [ ] Create 50+ skills - UI performance OK

**Notes:**

---

## 10. Settings & Configuration

### Settings Window
- [ ] Settings button opens settings window
- [ ] Settings window has tabs (Profiles, MCP, Skills, General)
- [ ] Settings persist across app restarts

### Profiles Tab
- [ ] Shows list of configured profiles
- [ ] Can add new profile
- [ ] Can edit profile (name, provider, model, API key)
- [ ] Can delete profile
- [ ] Can set default profile
- [ ] API key input is masked (type="password")
- [ ] "Test Connection" button works
- [ ] Invalid config shows clear error

### MCP Tab
- [ ] Shows list of MCP servers
- [ ] Import JSON button works
- [ ] Can add server manually
- [ ] Server config editor validates JSON

### Skills Tab
- [ ] Shows skills list
- [ ] "Create Skill" button opens wizard
- [ ] Shows skill directory path
- [ ] "Open Folder" button works

### General Tab
- [ ] Can change theme (light/dark)
- [ ] Can change font size
- [ ] Can change shell (default shell path)
- [ ] Can toggle auto-save sessions
- [ ] Can set search result limit

**Notes:**

---

## 11. Keyboard Shortcuts

| Shortcut | Action | Works? |
|----------|--------|--------|
| Cmd+T | New Tab | ☐ |
| Cmd+W | Close Tab | ☐ |
| Cmd+1..9 | Switch to Tab N | ☐ |
| Cmd+F | Open Search | ☐ |
| Cmd+K | Focus AI Chat | ☐ |
| Cmd+Enter | Send AI Message | ☐ |
| Cmd+, | Open Settings | ☐ |
| Cmd+C | Copy (in terminal) | ☐ |
| Cmd+V | Paste (in terminal) | ☐ |
| Escape | Close Search/Modal | ☐ |
| Ctrl+C | Interrupt Command | ☐ |
| Up/Down | Navigate Shell History | ☐ |

**Notes:**

---

## 12. Error Handling & Edge Cases

### Error Messages
- [ ] Invalid API key - shows user-friendly message
- [ ] Network error - shows retry option
- [ ] Database error - shows error but doesn't crash
- [ ] PTY spawn error - shows error and restart option
- [ ] Python sidecar crash - restarts automatically

### Stress Testing
- [ ] Open 50+ tabs - performance OK
- [ ] Run 1000+ commands in one tab - no memory leak
- [ ] Very large scrollback (100MB+) - doesn't freeze
- [ ] Very long AI conversation (100+ messages) - works
- [ ] Rapid tab switching (click 10 tabs quickly) - no crash
- [ ] Fill disk space - shows graceful error

### Platform-Specific
- [ ] macOS: Cmd key shortcuts work
- [ ] Windows: Ctrl key shortcuts work
- [ ] Linux: Ctrl key shortcuts work
- [ ] macOS: Touch Bar support (if applicable)
- [ ] Windows: High DPI scaling correct
- [ ] Linux: Wayland compatibility

**Notes:**

---

## 13. Performance

- [ ] App launches in <5 seconds
- [ ] Tab creation is instant (<500ms)
- [ ] Typing latency <50ms (feels responsive)
- [ ] AI response starts streaming within 2 seconds
- [ ] Search results appear within 1 second
- [ ] Memory usage reasonable (<500MB with 10 tabs)
- [ ] CPU usage low when idle (<5%)
- [ ] No memory leaks after 1 hour of use
- [ ] Scrollback render efficient (can scroll large output)

**Benchmarks:**
- Time to launch: _______ seconds
- Time to create tab: _______ ms
- Memory usage (10 tabs): _______ MB
- Memory usage (50 tabs): _______ MB

**Notes:**

---

## 14. Security

- [ ] API keys stored encrypted (or in secure keychain)
- [ ] API keys not visible in logs
- [ ] Shell command injection prevention works
- [ ] MCP tool approval prevents dangerous operations by default
- [ ] No XSS vulnerabilities (test with malicious output)
- [ ] No command injection in skill scripts
- [ ] Session files have correct permissions (600)
- [ ] Config files have correct permissions (600 for .env)

**Security Tests:**
- [ ] Try command injection: `; rm -rf /`
- [ ] Try XSS in output: `echo "<script>alert(1)</script>"`
- [ ] Try path traversal: `cat ../../../etc/passwd`
- [ ] Try malicious skill script

**Notes:**

---

## 15. Documentation

- [ ] README.md is clear and accurate
- [ ] USER_GUIDE.md covers all features
- [ ] API.md documents all Tauri commands
- [ ] CONTRIBUTING.md exists for developers
- [ ] Code examples in docs are correct
- [ ] Screenshots are up-to-date
- [ ] Keyboard shortcuts documented
- [ ] FAQ section covers common issues

**Notes:**

---

## 16. Accessibility

- [ ] Keyboard navigation works throughout app
- [ ] Focus indicators visible
- [ ] Screen reader announces UI changes (macOS VoiceOver)
- [ ] Color contrast meets WCAG AA standards
- [ ] Can use app without mouse
- [ ] Font size changes respected
- [ ] High contrast mode works

**Notes:**

---

## 17. Internationalization (Future)

- [ ] UI text uses i18n system (if implemented)
- [ ] Non-English input works in terminal
- [ ] Unicode emoji display correctly
- [ ] RTL languages work in chat (if supported)

**Notes:**

---

## 18. Auto-Update (If Implemented)

- [ ] App checks for updates on launch
- [ ] Update notification appears if available
- [ ] Can view changelog before updating
- [ ] Can skip update
- [ ] Can download and install update
- [ ] Update process doesn't lose data
- [ ] After update, sessions restore correctly

**Notes:**

---

## 19. Crash Recovery

- [ ] If app crashes, sessions auto-saved
- [ ] After crash, can restore last session
- [ ] Crash report generated (if implemented)
- [ ] No data loss from crash

**Crash Tests:**
- [ ] Force quit app (Cmd+Q) - sessions saved
- [ ] Kill app process - sessions saved
- [ ] Simulate crash - recovery works

**Notes:**

---

## 20. Final Checklist

- [ ] All critical bugs fixed
- [ ] No console errors in production build
- [ ] No compiler warnings (Rust clippy)
- [ ] All tests passing (unit, integration, E2E)
- [ ] Version number correct in About dialog
- [ ] Release notes written
- [ ] Installers built for all platforms
- [ ] Tauri updater signatures verified for all supported platforms
- [ ] `SHA256SUMS.txt` covers every public installer
- [ ] Unsigned macOS/Windows warning limitations are stated in release notes
- [ ] Ready for v1.0 release

**Overall Grade:** _____ / 10

**Critical Issues Found:**

**Minor Issues Found:**

**Recommendations:**

---

## Sign-Off

**Tester Signature:** _____________  
**Date:** _____________  
**Release Manager Signature:** _____________  
**Date:** _____________
