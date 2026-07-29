# AI Assistant Integration (cmux-inspired) Design

**Date:** 2026-06-18  
**Status:** Approved Design  
**Target:** Phase 1-3 Feature Rollout

## Overview

Add deep AI assistant integration to CCIE Terminal, inspired by [cmux](https://github.com/manaflow-ai/cmux). Enable agents (built-in CCIE agents and external agents like Claude Code/Codex) to understand multi-pane terminal state, coordinate across sessions, and interact with browser panes alongside terminal work.

**Problem:** AI assistants working in terminals lack context about multi-pane state. They can't see what's running in other panes, which commands need attention, or provide coordinated help across splits. Users lose track of pane activity when working with multiple sessions.

**Solution:** Build a pane context system that tracks all terminal activity (commands, outputs, timing, focus) in real-time. Inject this context into agent prompts automatically. Add visual indicators (animated borders, badges) to show pane state at a glance. Expose pane state via MCP for external agents. Support browser panes for web UI management alongside terminals.

## Goals

1. **Context-aware agents** - Agents automatically receive rich workspace context (focused pane, other panes, active commands, recent output)
2. **Visual workspace clarity** - At-a-glance understanding of pane activity via animated borders and badges
3. **Smart notifications** - Intelligent alerts for panes needing attention (long-running completions, errors, agent output)
4. **Multi-agent coordination** - Support multiple parallel agents with awareness of each other's work
5. **Browser integration** - Browser panes alongside terminals with scriptable agent control
6. **External agent support** - MCP interface for Claude Code, Codex, and other external agents

## Architecture

### Core Component: PaneContextManager

Single source of truth for all pane state. Sits between PTY layer and consuming features.

**Data Flow:**
```
PTY → CommandParser (OSC 133) → PaneContextManager
                                        ↓
                    ┌───────────────────┼───────────────────┐
                    ↓                   ↓                   ↓
              Agent Bridge      Frontend (Visual)    MCP Server
              (auto-inject)     (rings/badges)    (external agents)
```

**State Tracked Per Pane:**
- Active command (name, start time, exit code, output preview)
- Current working directory (OSC 7)
- Focus history
- Notification state (Idle | Running | NeedsAttention)
- Agent session (if agent active in pane)

**Persistence:**
New SQLite table `pane_activity` stores ephemeral state. Long-term history remains in existing `command_blocks` table.

### Why This Architecture

The existing codebase already streams PTY events through Tokio channels with OSC 133 parsing. Adding PaneContextManager as another consumer is clean and non-destructive. All features (agent context, UI, notifications, MCP) read from one source, avoiding duplication and keeping views consistent.

## Three-Phase Rollout

### Phase 1: Foundation (Pane Context + Visual Indicators)

**Build:**
- PaneContextManager tracking command state, output, timing
- Agent context injection (automatic for built-in agents)
- Visual indicators (animated rings, badges, hover tooltips)
- Smart notification heuristics (>30s, errors, keywords)
- Database schema V0052

**Value:** Agents become workspace-aware. Users get visual feedback on pane activity. Immediate productivity improvement.

### Phase 2: Multi-Agent Coordination & MCP

**Build:**
- Agent session tracking across panes
- Multi-agent context (agents see other active agents)
- MCP server exposing pane state (resources + tools)
- Notification center UI (dropdown, keyboard shortcuts)
- User notification preferences

**Value:** External agents (Claude Code) can query pane state via MCP. Multiple agents coordinate passively through shared context. Users control notification behavior.

**Future Hooks:** Document (don't implement) where active agent-to-agent coordination (Phase 2B/C) would plug in based on real workflow patterns.

### Phase 3: Browser Panes & Metadata

**Build:**
- Browser pane type using Tauri WebView
- Browser controls (navigate, back/forward, reload)
- Scriptable browser API for agents (click, type, evaluate JS)
- Cookie import from Chrome/Firefox/Safari/Arc/Edge
- Metadata sidebar (git branch, ports, processes, URLs)
- MCP browser tools

**Value:** Unified workspace with browser + terminal + agents. Network engineer workflows (device web UI + SSH + agent) in one place. Agents script browsers for automation.

## Key Design Decisions

### Smart Notification Heuristics

Flag pane as "NeedsAttention" when:
- Command runs >30 seconds AND completes in non-focused pane
- Non-zero exit code in non-focused pane
- Output contains keywords: "error", "failed", "timeout"
- Agent output detected

Don't flag for:
- Quick commands (<5 seconds)
- Focused pane (user already looking)
- Successful quick commands

**Rationale:** Network engineers run hundreds of quick commands. Naive "alert on everything" causes fatigue. Smart heuristics surface genuinely interesting events. Configuration in settings lets users tune thresholds.

### Agent Context Injection

Built-in CCIE agents get context automatically (no opt-in). External agents use MCP tools to query on demand.

**Rationale:** Automatic injection provides better UX ("it just works") without breaking existing agent definitions. MCP gives external agents explicit control when needed.

**Context Format:**
```
## Current Terminal Context

Layout: 3 panes - Pane 1 (focused), Pane 2 (running), Pane 3 (idle)

Focused Pane:
- Working Directory: /Users/user/project
- Active Command: pytest tests/ (45s)
- Recent Output: [last 20 lines]

Other Visible Panes:
Pane 2: Running `tail -f logs` (2m30s)
  [last 10 lines]

Pane 3: Completed `npm build` (exit 0, 5m ago)
  [last 10 lines]
```

### Visual Indicator Design

Animated borders communicate state without cluttering terminal:
- **Idle:** No border
- **Running:** Blue rotating gradient (1px, 2s animation)
- **Needs Attention:** Pulsing orange ring (2px, 1.5s breathing)

Badge in corner shows command name + timing + exit code. Hover tooltip expands to full details.

**Rationale:** cmux-style rings are eye-catching but non-intrusive. Existing CCIE Terminal design already uses borders and animations effectively. Hover tooltips provide detail on demand.

### Browser Panes via Tauri WebView

Use Tauri's built-in WebView (system browser engine) rather than embedding Chromium.

**Rationale:** App already uses Tauri 2. WebView is cross-platform, scriptable, supports cookies, and has minimal overhead. Chromium embedding would add 100+ MB to bundle size.

### Context-First vs MCP-First

Build PaneContextManager first (direct Rust/TypeScript access), expose MCP on top in Phase 2.

**Rationale:** MCP adds latency for internal features. Direct calls are faster for built-in agents and UI. MCP is perfect for external agents (Claude Code) but over-engineered for internal use. Context-first gives speed + extensibility.

## Implementation Details

### Phase 1 - Critical Files

**New Rust Modules:**
- `src-tauri/src/pane_context/mod.rs`
- `src-tauri/src/pane_context/manager.rs` - State tracking
- `src-tauri/src/pane_context/notifications.rs` - Smart heuristics
- `src-tauri/src/pane_context/types.rs` - Data structures

**Modified Rust:**
- `src-tauri/src/pty.rs` - Add channel to context manager
- `src-tauri/src/commands/ai.rs` - Inject pane context
- `src-tauri/src/database.rs` - V0052 migration

**New Frontend:**
- `src/state/paneActivityStore.ts` - Zustand store
- `src/components/PaneActivityIndicator.tsx` - Rings/badges
- `src/styles/pane-activity.css` - Animations

**Modified Frontend:**
- `src/components/Pane.tsx` - Wrap with indicator

**Tauri Commands:**
- `get_pane_activity(pane_id)`
- `get_all_pane_activities(tab_id)`
- `clear_pane_notification(pane_id)`
- Event: `pane_activity_updated`

### Phase 2 - Critical Files

**New Rust:**
- `src-tauri/src/pane_context/agent_sessions.rs`
- `src-tauri/src/pane_context/notification_config.rs`
- `src-tauri/src/mcp/pane_context_server.rs`

**New Frontend:**
- `src/components/NotificationCenter.tsx`
- `src/components/AgentActivityBadge.tsx`
- `src/components/NotificationSettings.tsx`

**MCP Resources:**
- `pane://layout` - Pane tree JSON
- `pane://{id}/activity` - Activity details
- `pane://{id}/output` - Output buffer
- `pane://{id}/history` - Command blocks

**MCP Tools:**
- `get_pane_layout()`
- `get_pane_activity(pane_id)`
- `get_focused_pane()`
- `get_all_active_commands()`

### Phase 3 - Critical Files

**New Rust:**
- `src-tauri/src/browser/mod.rs`
- `src-tauri/src/browser/control.rs` - Automation API
- `src-tauri/src/browser/cookies.rs` - Import from browsers
- `src-tauri/src/pane_context/metadata.rs` - Git/ports/processes

**New Frontend:**
- `src/components/BrowserPane.tsx`
- `src/components/MetadataSidebar.tsx`
- `src/components/CookieImportModal.tsx`

**Browser Commands:**
- `create_browser_pane(tab_id, url)`
- `browser_navigate/go_back/go_forward/reload(pane_id)`
- `browser_click/type/evaluate_js(pane_id, ...)`
- `browser_get_content/title/cookies(pane_id)`
- `browser_screenshot(pane_id)`
- `browser_import_cookies(source)`

## Use Case Examples

### Example 1: Multi-Pane Debugging

**Setup:**
- Pane 1: Running Python script (crashes)
- Pane 2: Tailing application logs
- Pane 3: SSH to server watching system logs

**Workflow:**
1. Script crashes in pane 1, orange ring appears
2. User asks agent in pane 1: "Why did this crash?"
3. Agent sees pane context:
   - Pane 1: script stderr showing import error
   - Pane 2: app logs showing missing dependency
   - Pane 3: system logs showing disk full
4. Agent: "Your script crashed because of missing dependency, but the real issue is your disk is full. I can see in the system logs (pane 3) that /var is at 100%."

### Example 2: Network Device Management

**Setup (Phase 3):**
- Topology view shows Cisco switch
- Right-click → "Open Web UI" (browser pane)
- Right-click → "SSH" (terminal pane)

**Workflow:**
1. Browser pane loads switch web interface (cookies imported from Chrome)
2. Terminal pane SSH'd to switch CLI
3. User asks agent: "Configure VLAN 100 on all access ports"
4. Agent sees both contexts:
   - Browser: web UI shows current VLAN assignments
   - Terminal: SSH session ready for commands
5. Agent suggests config commands, user approves
6. Agent executes via SSH, verifies via web UI

### Example 3: External Agent Coordination

**Setup (Phase 2):**
- Claude Code running in pane 1 (implementing feature)
- CCIE agent running in pane 2 (running tests)

**Workflow:**
1. Claude Code writes code in pane 1
2. CCIE agent context shows: "Pane 1: claude-code active, implementing auth feature"
3. CCIE agent runs tests, sees failures
4. CCIE agent: "Tests failing because of changes in pane 1. Let that agent finish first."
5. User coordinates between agents based on their awareness

## Verification Strategy

**Phase 1:**
- Create 3-pane split, verify visual indicators update correctly
- Run long command in background pane, verify notification
- Invoke agent, check logs for pane context in prompt
- Database has pane_activity entries
- Hover tooltips show correct info

**Phase 2:**
- Multiple agent sessions tracked correctly
- Multi-agent context appears in prompts
- MCP `get_pane_layout()` returns correct JSON
- Notification center UI functional
- Settings persistence works

**Phase 3:**
- Browser pane creation and navigation
- Cookie import functional
- Agent browser automation works
- Metadata sidebar accurate (git branch, ports)
- Topology integration (right-click → web UI/SSH)

**Performance:**
- PaneContextManager overhead <1ms per PTY event
- UI responsive with 10+ panes
- Agent context injection <100ms
- MCP server handles concurrent requests

## Success Criteria

**User Experience:**
- Glance at panes, immediately know status
- Agents provide contextually relevant help
- Multi-pane workflows feel seamless
- Browser + terminal integration feels unified

**Technical:**
- Zero performance regression on PTY throughput
- Agent context token overhead <5% of typical prompt
- MCP API stable for external agent consumption
- Visual indicators render at 60fps

## Future Considerations

**Not Implemented (noted for later):**
- Active agent-to-agent coordination (messaging, task handoff)
- Browser session restoration
- Multi-tab pane context (cross-tab awareness)
- Pane grouping and naming
- Advanced metadata: network connections, resource usage graphs

These await real user workflows to validate requirements.

## Related Work

- [cmux](https://github.com/manaflow-ai/cmux) - Inspiration for pane awareness and notifications
- Existing CCIE Terminal: OSC 133 parsing, session storage, agent bridge
- Tauri WebView: Browser embedding
- MCP: External agent integration protocol

---

**Next Step:** Create implementation plan (writing-plans skill) breaking down Phase 1 into executable tasks with dependency analysis and verification steps.
