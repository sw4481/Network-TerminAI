# Tab Activity Dots — Design

> **Status:** Design approved 2026-06-22. Next: implementation plan via `writing-plans`.
> **Goal:** Show an activity dot on inactive terminal tabs so background activity is visible at a glance.

## Problem

Pane-level activity indicators (running border, badge) and the notification bell exist, but there's no per-tab indicator — you can't tell which background tabs are busy or need attention without clicking through them. The data already exists in `paneActivityStore` (just fixed so it populates correctly); `TabBar` simply doesn't read it.

## Behavior (decided)

- **Non-active tabs only.** The active/focused tab never shows a dot (you're already looking at it).
- **State → dot:**
  - `running` → 🟡 pulsing amber dot
  - `needs_attention` → 🔴 solid red dot
  - `idle` → no dot
- **Terminal tabs only.** API / NETCONF / editor / topology / vault / recordings / troubleshoot tabs have no PTY activity → never show an activity dot.
- **Split tabs — highest-severity-wins** via `getAllForTab(tabId)`: if ANY pane is `needs_attention` → red; else if ANY is `running` → pulse; else nothing. One dot per tab.

## Architecture

Small, additive: one selector helper + a TabBar render addition + CSS. No backend changes, no new commands, no migration.

### Selector helper
A pure severity function + a store-subscribed hook:
- `tabActivityState(activities: PaneActivity[]): 'needs_attention' | 'running' | null` — pure, testable. Applies severity `needs_attention > running > idle`. Empty/all-idle → `null`.
- `useTabActivityState(tabId: string): 'needs_attention' | 'running' | null` — reads `usePaneActivityStore`'s `getAllForTab(tabId)` and derives via the pure function; subscribes so it re-renders on activity changes.

Location: add both to `src/lib/tabActivity.ts` (pure fn + hook), OR colocate the hook in `paneActivityStore` and the pure fn in `tabActivity.ts`. Pure fn MUST be separately exported for unit testing.

### TabBar render
In `src/components/TabBar.tsx`, inside the existing `tabs.map((t) => {...})` (~line 87): for terminal-type tabs that are NOT the active tab, compute `useTabActivityState(t.id)` and render:
```tsx
{activityState && t.id !== activeTabId && isTerminalTab && (
  <span className={`tab-activity-dot tab-activity-dot--${activityState}`} />
)}
```
Mirrors the existing `tab-recording-dot` pattern already in TabBar (~line 161). `isTerminalTab` = not api/netconf/editor/topology/vault/recordings/recording-player/troubleshoot/troubleshoot-editor (i.e. the default terminal case).

NOTE on hooks: `useTabActivityState` is a hook called inside `.map`. React requires stable hook order — calling a hook inside `.map` is fine ONLY if the list length/order is stable per render, which it is NOT guaranteed to be (tabs add/remove). To stay rules-of-hooks-safe, do ONE of:
- (preferred) compute all tab states with a single `usePaneActivityStore` subscription ABOVE the map (e.g. `const activities = usePaneActivityStore(s => s.activities)`), then derive each tab's state with the PURE `tabActivityState(...)` function inside the map (no hook in the loop), or
- render a small `<TabActivityDot tabId=... />` child component that calls the hook once at its own top level.

The pure-function-above-the-map approach is simplest and avoids a child component; use it unless it complicates TabBar.

### CSS
Add to TabBar's stylesheet (where `tab-recording-dot` lives):
- `.tab-activity-dot` — base: small inline dot (~7px), border-radius 50%, margin.
- `.tab-activity-dot--running` — amber `#f59e0b`, `@keyframes` pulse (opacity/scale, ~1.2s).
- `.tab-activity-dot--needs-attention` — solid red `#f87171`, no animation (steady = "stop and look").

(Colors match the metadata card tokens for consistency: amber `#f59e0b`, red `#f87171`.)

## Data Flow

PTY lifecycle event → backend emits `pane_activity_updated` (keyed by terminalId/tabId) → `paneActivityStore.updateActivity` (already wired) → `useTabActivityState`/`tabActivityState` re-derives → dot updates. Clearing: focusing a tab/pane transitions it toward `idle` (existing backend heuristic), removing the dot.

## Testing

**Unit (pure `tabActivityState`):**
- `[{idle},{running},{needs_attention}]` → `'needs_attention'`
- `[{idle},{running}]` → `'running'`
- `[{idle},{idle}]` → `null`
- `[]` (no panes tracked) → `null`

**Component (TabBar):**
- needs_attention activity on a NON-active terminal tab → red dot (`tab-activity-dot--needs-attention`) present.
- running on a non-active terminal tab → pulse dot (`tab-activity-dot--running`).
- the ACTIVE tab with running/needs_attention activity → NO dot.
- idle / non-terminal (api/editor) tab → NO dot.

**Live:**
- Open tab 2 (tab 1 inactive). Run `sleep 35` in tab 1 → tab 1 shows pulse; after it completes in background → red. Click tab 1 → dot clears (focus → idle).
- Split a tab, run a failing command in one pane while the tab is inactive → tab shows red (highest-severity-wins).

**Baselines:** `tsc --noEmit` stays at 43; full vitest stays green.

## Out of Scope (YAGNI)
- Count badges (e.g. "2 panes need attention").
- Dots on non-terminal tabs.
- Configurable thresholds (reuse the existing 30s / error-keyword backend heuristic).

## Key Design Decisions
- **Non-active-only** dots — the active tab is where you already are; a dot there is noise.
- **Highest-severity-wins** for split tabs — one dot, shows the most urgent state.
- **Pure severity fn separate from the hook** — testable without React/store.
- **Reuse `tab-recording-dot` pattern + metadata color tokens** — consistency, minimal new surface.
- Tab activity is **tab-granular** (the backend keys pane activity by tab/terminal id); split aggregation via `getAllForTab` works now that the terminal registry reconciles split-pane ids.
