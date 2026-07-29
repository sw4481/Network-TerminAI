# Tab Activity Dots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an activity dot on inactive terminal tabs — amber pulse while a command runs, red for needs-attention — derived from `paneActivityStore`.

**Architecture:** A pure severity function `tabActivityState(activities)` (testable) plus a TabBar render addition that subscribes once to `paneActivityStore`, derives each tab's state with the pure function, and renders a dot for non-active terminal tabs. No backend changes, no new commands, no migration.

**Tech Stack:** React + TypeScript, Zustand (`usePaneActivityStore`), vitest + @testing-library/react.

## Global Constraints

- **States → dot:** `running` → amber pulsing dot; `needs_attention` → solid red dot; `idle` → no dot.
- **Non-active tabs only** — the active tab (`t.id === activeTabId`) never shows a dot.
- **Terminal tabs only** — never on api/netconf/editor/topology/vault/recordings/recording-player/troubleshoot/troubleshoot-editor tabs.
- **Split aggregation = highest-severity-wins:** any pane `needs_attention` → `'needs_attention'`; else any `running` → `'running'`; else `null`. Via `getAllForTab(tabId)`.
- **Colors:** amber `#f59e0b`, red `#f87171` (match metadata-card tokens).
- **Rules of hooks:** do NOT call a hook inside `tabs.map`. Subscribe to activities ONCE above the map (`const activities = usePaneActivityStore((s) => s.activities)`), then call the PURE `tabActivityState(...)` inside the map.
- **No backend changes, no migration.** `tsc --noEmit` stays at 43 baseline; full vitest stays green.
- **Existing facts:** `PaneActivity { paneId, tabId, notificationState: 'idle'|'running'|'needs_attention', ... }` (`src/lib/paneActivity.ts`). `usePaneActivityStore` has `activities: Map<string,PaneActivity>` and `getAllForTab(tabId)` (`src/state/paneActivityStore.ts:38`). TabBar gets `activeTabId` from `useTabs` (`TabBar.tsx:33`). The `tab-recording-dot` pattern is at `TabBar.tsx:162` and styled in `src/App.css`.

---

## File Structure

- Create: `src/lib/tabActivity.ts` — pure `tabActivityState(activities: PaneActivity[]): TabActivityState`.
- Create: `src/lib/tabActivity.test.ts` — unit tests for the pure function.
- Modify: `src/components/TabBar.tsx` — subscribe to activities, render the dot for non-active terminal tabs.
- Create: `src/components/TabBar.activityDot.test.tsx` — component tests for dot rendering rules.
- Modify: `src/App.css` — `.tab-activity-dot` + `--running` (pulse) + `--needs-attention` styles.

---

## Task 1: Pure severity function

**Files:**
- Create: `src/lib/tabActivity.ts`
- Create: `src/lib/tabActivity.test.ts`

**Interfaces:**
- Consumes: `PaneActivity` from `./paneActivity`.
- Produces: `type TabActivityState = 'needs_attention' | 'running' | null`; `tabActivityState(activities: PaneActivity[]): TabActivityState` — consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/tabActivity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { tabActivityState } from './tabActivity';
import type { PaneActivity } from './paneActivity';

function pa(notificationState: PaneActivity['notificationState']): PaneActivity {
  return {
    paneId: 'p', tabId: 't', activeCommand: null, cwd: '/',
    lastFocusTime: null, notificationState, updatedAt: 0,
  };
}

describe('tabActivityState', () => {
  it('returns needs_attention when any pane needs attention (highest severity)', () => {
    expect(tabActivityState([pa('idle'), pa('running'), pa('needs_attention')]))
      .toBe('needs_attention');
  });

  it('returns running when a pane runs and none need attention', () => {
    expect(tabActivityState([pa('idle'), pa('running')])).toBe('running');
  });

  it('returns null when all panes idle', () => {
    expect(tabActivityState([pa('idle'), pa('idle')])).toBeNull();
  });

  it('returns null for no tracked panes', () => {
    expect(tabActivityState([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/lib/tabActivity.test.ts 2>&1 | tail -12`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure function**

Create `src/lib/tabActivity.ts`:
```ts
import type { PaneActivity } from './paneActivity';

export type TabActivityState = 'needs_attention' | 'running' | null;

/**
 * Aggregate a tab's pane activities into a single dot state using
 * highest-severity-wins: needs_attention > running > idle.
 */
export function tabActivityState(activities: PaneActivity[]): TabActivityState {
  let hasRunning = false;
  for (const a of activities) {
    if (a.notificationState === 'needs_attention') return 'needs_attention';
    if (a.notificationState === 'running') hasRunning = true;
  }
  return hasRunning ? 'running' : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/tabActivity.test.ts 2>&1 | tail -12`
Expected: PASS (4 tests).

- [ ] **Step 5: tsc**

Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `43`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tabActivity.ts src/lib/tabActivity.test.ts
git commit -m "feat(tabs): pure tabActivityState severity aggregator

needs_attention > running > idle; empty -> null. Pure + unit-tested.

Part of tab activity dots (Task 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Render the dot in TabBar + styles

**Files:**
- Modify: `src/components/TabBar.tsx`
- Modify: `src/App.css`
- Create: `src/components/TabBar.activityDot.test.tsx`

**Interfaces:**
- Consumes: `tabActivityState` (Task 1); `usePaneActivityStore` (`activities`, `getAllForTab`); `useTabs` (`activeTabId`).
- Produces: a `tab-activity-dot` span on non-active terminal tabs.

- [ ] **Step 1: Write the failing component tests**

Create `src/components/TabBar.activityDot.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TabBar } from './TabBar';
import { useTabs } from '../state/tabsStore';
import { usePaneActivityStore } from '../state/paneActivityStore';
import type { PaneActivity } from '../lib/paneActivity';

// Stub child stores/components TabBar pulls in but that aren't under test.
vi.mock('../state/recordingStore', () => ({
  useRecordings: (sel: any) => sel({ active: {} }),
}));
vi.mock('./NotificationCenter', () => ({ default: () => null }));

function pa(tabId: string, notificationState: PaneActivity['notificationState']): PaneActivity {
  return { paneId: `${tabId}-p`, tabId, activeCommand: null, cwd: '/', lastFocusTime: null, notificationState, updatedAt: 0 };
}

function setTabs(tabs: any[], activeTabId: string | null) {
  useTabs.setState({ tabs, activeTabId } as any);
}
function setActivities(list: PaneActivity[]) {
  usePaneActivityStore.setState({ activities: new Map(list.map((a) => [a.paneId, a])) } as any);
}

const noop = () => {};

beforeEach(() => {
  setActivities([]);
});

describe('TabBar activity dot', () => {
  it('shows a needs-attention dot on a non-active terminal tab', () => {
    setTabs(
      [{ id: 'tab-1', title: 'one', tab_type: 'terminal' }, { id: 'tab-2', title: 'two', tab_type: 'terminal' }],
      'tab-2',
    );
    setActivities([pa('tab-1', 'needs_attention')]);
    const { container } = render(<TabBar onNew={noop} />);
    expect(container.querySelector('.tab-activity-dot--needs-attention')).toBeTruthy();
  });

  it('shows a running dot on a non-active terminal tab', () => {
    setTabs(
      [{ id: 'tab-1', title: 'one', tab_type: 'terminal' }, { id: 'tab-2', title: 'two', tab_type: 'terminal' }],
      'tab-2',
    );
    setActivities([pa('tab-1', 'running')]);
    const { container } = render(<TabBar onNew={noop} />);
    expect(container.querySelector('.tab-activity-dot--running')).toBeTruthy();
  });

  it('shows NO dot on the active tab even with activity', () => {
    setTabs([{ id: 'tab-1', title: 'one', tab_type: 'terminal' }], 'tab-1');
    setActivities([pa('tab-1', 'needs_attention')]);
    const { container } = render(<TabBar onNew={noop} />);
    expect(container.querySelector('.tab-activity-dot')).toBeNull();
  });

  it('shows NO dot for idle or non-terminal tabs', () => {
    setTabs(
      [{ id: 'tab-1', title: 'idle', tab_type: 'terminal' }, { id: 'tab-2', title: 'api', tab_type: 'api' }],
      'tab-9',
    );
    setActivities([pa('tab-1', 'idle'), pa('tab-2', 'needs_attention')]);
    const { container } = render(<TabBar onNew={noop} />);
    expect(container.querySelector('.tab-activity-dot')).toBeNull();
  });
});
```

NOTE: confirm `TabBar` is a named export (`export function TabBar` / `export const TabBar`). The import above assumes named. If it's a default export, adjust the import. Also confirm the minimum required props — the tests pass only `onNew`; if TabBar destructures other required props without defaults and crashes, pass `{}`-returning noops for them (all the `onNew*` are optional per the props type at TabBar.tsx:22-31, so `onNew` alone should suffice).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/TabBar.activityDot.test.tsx 2>&1 | tail -15`
Expected: FAIL — no `.tab-activity-dot` rendered yet.

- [ ] **Step 3: Wire activity into TabBar**

In `src/components/TabBar.tsx`:
- Add imports near the others (top of file):
```tsx
import { usePaneActivityStore } from "../state/paneActivityStore";
import { tabActivityState } from "../lib/tabActivity";
```
- Inside the component body, near the other store subscriptions (~line 33-35, after `const activeRecordings = ...`), subscribe ONCE to activities (rules-of-hooks: above the map, not inside it):
```tsx
  const activities = usePaneActivityStore((s) => s.activities);
```
- Inside the `tabs.map((t) => {...})` block, after the existing `const isRecording = ...` line (~line 97), compute the dot state. The terminal-tab check is the inverse of the existing type flags (a tab with none of the special types is a terminal tab):
```tsx
            const isTerminalTab =
              !isApi && !isNetconf && !isEditor && !isTopology &&
              !isVault && !isRecordings && !isRecordingPlayer &&
              !isTroubleshoot && !isTroubleshootEditor;
            const tabActivity =
              isTerminalTab && t.id !== activeTabId
                ? tabActivityState(
                    Array.from(activities.values()).filter((a) => a.tabId === t.id),
                  )
                : null;
```
- In the tab's JSX, next to the existing `{isRecording && (<span className="tab-recording-dot" .../>)}` block (~line 161), add the activity dot:
```tsx
            {tabActivity && (
              <span
                className={`tab-activity-dot tab-activity-dot--${tabActivity === 'needs_attention' ? 'needs-attention' : 'running'}`}
                title={tabActivity === 'needs_attention' ? 'Needs attention' : 'Running'}
                aria-label={tabActivity === 'needs_attention' ? 'Needs attention' : 'Running'}
                data-testid={`tab-activity-dot-${t.id}`}
              />
            )}
```

NOTE: the class suffix maps `needs_attention` (underscore, the state value) → `needs-attention` (hyphen, the CSS class) and `running` → `running`. Keep this mapping exact so the CSS in Step 5 matches.

- [ ] **Step 4: Run component tests to verify they pass**

Run: `npx vitest run src/components/TabBar.activityDot.test.tsx 2>&1 | tail -15`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the styles**

In `src/App.css`, near the `.tab-recording-dot` rule, add:
```css
.tab-activity-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 6px;
  flex: 0 0 auto;
}
.tab-activity-dot--needs-attention {
  background: #f87171;
}
.tab-activity-dot--running {
  background: #f59e0b;
  animation: tab-activity-pulse 1.2s ease-in-out infinite;
}
@keyframes tab-activity-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}
```

- [ ] **Step 6: Full build + suite**

Run:
```bash
npx tsc --noEmit 2>&1 | grep -c "error TS"
npx vitest run src/lib/tabActivity.test.ts src/components/TabBar.activityDot.test.tsx 2>&1 | tail -8
```
Expected: tsc `43`; the 8 dot tests pass. (If `tsc` rises above 43, fix the new code — watch for the mock-spread pitfall: don't spread args into zero-arg `vi.fn()`.)

- [ ] **Step 7: Commit**

```bash
git add src/components/TabBar.tsx src/App.css src/components/TabBar.activityDot.test.tsx
git commit -m "feat(tabs): activity dot on inactive terminal tabs

Subscribes to paneActivityStore once, derives each tab's state via the
pure tabActivityState, renders amber-pulse (running) / red (needs
attention) dots on non-active terminal tabs only. Mirrors tab-recording-dot.

Part of tab activity dots (Task 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 8: LIVE verification (run app, report actual results)**

1. `npm run tauri dev`.
2. Open tab 2 so tab 1 is inactive. In tab 1 run `sleep 35`. Expected: **tab 1 shows an amber pulsing dot**; after it finishes in the background → **red dot**. Click tab 1 → **dot clears** (focus → idle).
3. The active tab never shows a dot while you're on it.
4. (If splits work for you) split a tab, run `ls /nope` in one pane while that tab is inactive → **tab shows red** (highest-severity-wins).
Record actual results; if anything doesn't light up, check the log + report.

---

## Self-Review

**Spec coverage:**
- running→amber pulse / needs_attention→red / idle→none → Task 2 (render + CSS) ✅
- non-active tabs only → Task 2 (`t.id !== activeTabId`) ✅
- terminal tabs only → Task 2 (`isTerminalTab`) ✅
- highest-severity-wins split aggregation → Task 1 (`tabActivityState`) ✅
- colors `#f59e0b`/`#f87171` → Task 2 Step 5 ✅
- rules-of-hooks (subscribe above map, pure fn inside) → Task 2 Step 3 ✅
- unit + component + live tests → Tasks 1, 2 ✅
- no backend/migration → honored ✅

**Placeholder scan:** None. Two NOTEs flag real verification points (TabBar export form; class-suffix mapping) with concrete guidance, not vague TODOs.

**Type consistency:** `tabActivityState(activities: PaneActivity[]): TabActivityState` consistent between Task 1 definition and Task 2 usage. `TabActivityState = 'needs_attention'|'running'|null`. CSS classes `tab-activity-dot--needs-attention` / `--running` match the suffix mapping in the render code and the test selectors.
