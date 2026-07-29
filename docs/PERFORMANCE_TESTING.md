# Performance Testing Guide - CCIE Terminal

This document provides guidelines and scripts for performance testing the CCIE Terminal application.

---

## Performance Targets

### Response Time Targets

| Operation | Target | Acceptable | Poor |
|-----------|--------|------------|------|
| App launch (cold start) | <3s | <5s | >5s |
| App launch (warm start) | <2s | <3s | >3s |
| Create new tab | <300ms | <500ms | >500ms |
| Close tab | <200ms | <300ms | >300ms |
| Switch tab | <100ms | <200ms | >200ms |
| Terminal keystroke latency | <30ms | <50ms | >50ms |
| Command execution (echo) | <100ms | <200ms | >200ms |
| AI response start (TTFB) | <1s | <2s | >2s |
| Search query results | <500ms | <1s | >1s |
| Load saved session (10 tabs) | <2s | <3s | >3s |

### Resource Usage Targets

| Metric | Target | Acceptable | Poor |
|--------|--------|------------|------|
| Memory (1 tab) | <100MB | <150MB | >150MB |
| Memory (10 tabs) | <300MB | <500MB | >500MB |
| Memory (50 tabs) | <800MB | <1GB | >1GB |
| CPU idle | <2% | <5% | >5% |
| CPU active typing | <20% | <30% | >30% |
| CPU AI streaming | <30% | <50% | >50% |
| Disk space (fresh install) | <200MB | <300MB | >300MB |
| Database size (100 cmds) | <10MB | <20MB | >20MB |

---

## Manual Performance Testing

### 1. Launch Time Test

**Goal:** Measure time from click to usable UI.

**Steps:**
1. Quit the app completely
2. Clear system caches (optional): `purge` on macOS
3. Start timer when clicking app icon
4. Stop timer when terminal is ready for input
5. Record time

**Command (macOS):**
```bash
# Cold start test
pkill -9 "CCIE Terminal"
time open -a "CCIE Terminal"
# Manually verify when UI is ready
```

**Expected:** <3s cold, <2s warm

---

### 2. Tab Operations Test

**Goal:** Measure tab creation/switch/close performance.

**Steps:**
1. Launch app with 1 tab
2. Time creating 10 new tabs (click New Tab button)
3. Time switching through all tabs (click each)
4. Time closing all but 1 tab
5. Calculate average per operation

**Expected:**
- Create: <300ms per tab
- Switch: <100ms per tab
- Close: <200ms per tab

---

### 3. Typing Latency Test

**Goal:** Measure keystroke-to-display latency.

**Method:**
1. Use high-speed camera (240fps+) or software profiler
2. Film screen while typing
3. Count frames between keypress and character display
4. Calculate latency: frames / fps * 1000 = ms

**Alternative (manual):**
1. Type rapidly in terminal
2. Observe if characters lag behind typing
3. Note if any dropped characters

**Expected:** <50ms, imperceptible lag

---

### 4. Scrollback Performance Test

**Goal:** Test rendering large output.

**Steps:**
1. Generate large output:
   ```bash
   # 10,000 lines
   for i in {1..10000}; do echo "Line $i: Lorem ipsum dolor sit amet"; done
   
   # Or use system log
   cat /var/log/system.log
   
   # Or generate colored output
   for i in {1..10000}; do echo -e "\033[3$((i%7))mLine $i\033[0m"; done
   ```

2. Measure:
   - Time to render all output
   - Scroll smoothness (60fps?)
   - Memory usage before/after
   - Can terminal still accept input?

**Expected:**
- Renders without freezing
- Smooth 60fps scrolling
- Memory increase <100MB

---

### 5. Many Tabs Test

**Goal:** Test with 50+ tabs open.

**Steps:**
1. Create 50 tabs (can script this with Cmd+T repeatedly)
2. Run simple command in each tab
3. Measure:
   - Total memory usage
   - Tab switching latency
   - App responsiveness
   - Any UI slowdown

**Script to create tabs:**
```javascript
// Run in browser dev console (if app uses webview)
for (let i = 0; i < 50; i++) {
  // Simulate Cmd+T keypress
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 't',
    metaKey: true,
    bubbles: true
  }));
  await new Promise(r => setTimeout(r, 500));
}
```

**Expected:**
- <1GB memory total
- No significant slowdown
- UI remains responsive

---

### 6. AI Streaming Performance Test

**Goal:** Test AI response streaming.

**Steps:**
1. Send message to AI: "Write a long essay about networking"
2. Measure:
   - Time to first token (TTFB)
   - Tokens per second
   - UI responsiveness during streaming
   - Memory usage

**Expected:**
- TTFB <2s
- Smooth streaming (no stutters)
- UI remains responsive

---

### 7. Search Performance Test

**Goal:** Test full-text search with large dataset.

**Steps:**
1. Generate large dataset:
   - 100+ commands across multiple tabs
   - Long outputs (1000+ lines each)
   - AI chat history (50+ messages)

2. Perform searches:
   - Common terms (100+ results)
   - Rare terms (1-2 results)
   - No results

3. Measure:
   - Time to first results
   - UI responsiveness during search
   - Memory usage

**Expected:**
- Results in <1s
- UI doesn't freeze
- Handles 1000+ results gracefully

---

### 8. Session Load Test

**Goal:** Test restoring large session.

**Steps:**
1. Create session with:
   - 20 tabs
   - Long scrollback in each
   - AI chat history in each

2. Save session
3. Quit app
4. Measure time to restore session

**Expected:**
- <5s to restore 20 tabs
- All scrollback loaded
- All chat history restored

---

### 9. Memory Leak Test

**Goal:** Detect memory leaks during extended use.

**Steps:**
1. Launch app and note initial memory
2. Perform operations for 1 hour:
   - Create/close tabs (100 times)
   - Run commands (1000 times)
   - Send AI messages (50 times)
   - Perform searches (100 times)

3. Monitor memory every 5 minutes
4. Check if memory grows unbounded

**Monitoring script (macOS):**
```bash
while true; do
  pid=$(pgrep "CCIE Terminal")
  if [ -n "$pid" ]; then
    date
    ps -o pid,rss,vsz -p $pid
    echo "---"
  fi
  sleep 300  # 5 minutes
done > memory_log.txt
```

**Expected:**
- Memory stabilizes after initial use
- No continuous growth
- Occasional GC cycles acceptable

---

## Automated Performance Tests

### Benchmark Script

Create a benchmark script to automate common tests:

```typescript
// benchmarks/perf-tests.ts
import { invoke } from '@tauri-apps/api/core';

async function benchmarkTabCreation() {
  const iterations = 10;
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await invoke('spawn_terminal', { shell: '/bin/zsh', cwd: '/' });
    const end = performance.now();
    times.push(end - start);
  }

  const avg = times.reduce((a, b) => a + b) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  console.log(`Tab creation: avg=${avg.toFixed(2)}ms, min=${min.toFixed(2)}ms, max=${max.toFixed(2)}ms`);
}

async function benchmarkSearch() {
  const start = performance.now();
  const results = await invoke('search', { query: 'echo' });
  const end = performance.now();

  console.log(`Search: ${end - start}ms, results=${results.length}`);
}

async function runBenchmarks() {
  console.log('Running performance benchmarks...');
  await benchmarkTabCreation();
  await benchmarkSearch();
  // Add more benchmarks...
}

runBenchmarks();
```

---

## Profiling Tools

### macOS

**Instruments:**
```bash
# Time Profiler
instruments -t "Time Profiler" -D time_profile.trace /path/to/CCIE\ Terminal.app

# Allocations (memory)
instruments -t "Allocations" -D memory_profile.trace /path/to/CCIE\ Terminal.app

# Leaks
instruments -t "Leaks" -D leaks.trace /path/to/CCIE\ Terminal.app
```

**Activity Monitor:**
- Open Activity Monitor
- Find "CCIE Terminal" process
- Monitor CPU, Memory, Energy

**top/htop:**
```bash
top -pid $(pgrep "CCIE Terminal")
# or
htop -p $(pgrep "CCIE Terminal")
```

### Rust Profiling

**cargo-flamegraph:**
```bash
cargo install flamegraph
cd src-tauri
cargo flamegraph --bin ccie-terminal
# Open flamegraph.svg in browser
```

**perf (Linux):**
```bash
perf record -g ./target/release/ccie-terminal
perf report
```

**valgrind (Linux):**
```bash
valgrind --tool=callgrind ./target/release/ccie-terminal
kcachegrind callgrind.out.*
```

### Frontend Profiling

**Chrome DevTools:**
1. Open app with remote debugging:
   ```bash
   # If Tauri supports remote debugging
   TAURI_DEBUG=1 ./target/release/ccie-terminal
   ```

2. Open Chrome DevTools
3. Use Performance tab to record

**React DevTools:**
- Install React DevTools
- Use Profiler to identify slow components

### Python Profiling

**cProfile:**
```python
# In sidecar/server.py
import cProfile
import pstats

profiler = cProfile.Profile()
profiler.enable()

# ... run operations ...

profiler.disable()
stats = pstats.Stats(profiler)
stats.sort_stats('cumulative')
stats.print_stats(20)
```

**py-spy:**
```bash
pip install py-spy
py-spy top -- python sidecar/server.py
```

---

## Load Testing

### Stress Test Script

```bash
#!/bin/bash
# stress-test.sh

echo "Starting CCIE Terminal stress test..."

# 1. Create many tabs
echo "Creating 50 tabs..."
for i in {1..50}; do
  # Send Cmd+T via AppleScript (macOS)
  osascript -e 'tell application "System Events" to keystroke "t" using command down'
  sleep 0.5
done

# 2. Run commands in each tab
echo "Running commands..."
for i in {1..50}; do
  osascript -e 'tell application "System Events" to keystroke "echo \"Tab '$i'\""'
  osascript -e 'tell application "System Events" to keystroke return'
  osascript -e 'tell application "System Events" to keystroke "'" using command down'  # Cmd+' to switch tab
  sleep 0.2
done

# 3. Perform searches
echo "Performing searches..."
for i in {1..100}; do
  osascript -e 'tell application "System Events" to keystroke "f" using command down'
  sleep 0.1
  osascript -e 'tell application "System Events" to keystroke "echo"'
  sleep 0.1
  osascript -e 'tell application "System Events" to key code 53'  # Escape
  sleep 0.1
done

echo "Stress test complete. Check for crashes or hangs."
```

---

## Performance Regression Testing

### Baseline Metrics

Record baseline metrics from Phase 6 (before Phase 7 changes):

```
Phase 6 Baseline (to be measured):
- Launch time: ___ s
- Tab creation: ___ ms
- Memory (10 tabs): ___ MB
- Search time: ___ ms
```

### After Phase 7

Re-run all tests and compare:

```
Phase 7 Results:
- Launch time: ___ s (Δ ___ %)
- Tab creation: ___ ms (Δ ___ %)
- Memory (10 tabs): ___ MB (Δ ___ %)
- Search time: ___ ms (Δ ___ %)
```

**Acceptance Criteria:**
- No regression >10% on critical paths
- Memory increase <20%
- All targets still met

---

## Optimization Guidelines

### If Launch Time is Slow

1. Profile startup sequence
2. Lazy-load non-critical components
3. Cache frequently used data
4. Parallelize independent init tasks
5. Defer Python sidecar spawn

### If Memory Usage is High

1. Check for memory leaks (use profiler)
2. Implement scrollback limits
3. Clear old command blocks
4. Optimize SQLite queries
5. Profile allocations with instruments

### If UI is Laggy

1. Check render performance (React DevTools)
2. Use React.memo for expensive components
3. Virtualize long lists
4. Debounce expensive operations
5. Move work to background threads

### If Search is Slow

1. Check SQLite query performance (EXPLAIN QUERY PLAN)
2. Add missing indexes
3. Limit result count
4. Implement pagination
5. Use FTS5 correctly

---

## Reporting Performance Issues

When reporting performance bugs, include:

1. **Metric:** What is slow? (launch, tab creation, etc.)
2. **Measured:** Actual time/memory measurement
3. **Expected:** What it should be
4. **Environment:** OS, hardware specs, build type
5. **Repro:** Steps to reproduce
6. **Profile:** Attach profiler output if available

**Example:**

```markdown
## Bug: Slow tab creation

**Metric:** Tab creation time
**Measured:** 850ms average
**Expected:** <300ms
**Environment:** macOS 14.2, M1 Pro, Debug build
**Repro:** Click "New Tab" button 10 times, measure with Date.now()
**Profile:** Attached flamegraph.svg shows 600ms in pty_spawn()
```

---

## Continuous Performance Monitoring

### CI Performance Tests

Add to `.github/workflows/performance.yml`:

```yaml
name: Performance Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  benchmark:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Build release
        run: bun tauri build --debug
      
      - name: Run benchmarks
        run: bun run benchmarks
      
      - name: Compare with baseline
        run: |
          if [ -f baseline-results.json ]; then
            node scripts/compare-perf.js baseline-results.json results.json
          fi
      
      - name: Upload results
        uses: actions/upload-artifact@v3
        with:
          name: perf-results
          path: results.json
```

---

## Performance Dashboard

Consider creating a dashboard to track metrics over time:

- Launch time trend
- Memory usage per version
- Test execution time
- Build size

Tools:
- Grafana + InfluxDB
- GitHub Actions artifacts + custom scripts
- Lighthouse CI (if web-based metrics)

---

## Summary Checklist

Before release, verify all performance targets are met:

- [ ] Launch time <5s
- [ ] Tab operations <500ms
- [ ] Typing latency <50ms
- [ ] Memory (10 tabs) <500MB
- [ ] Memory (50 tabs) <1GB
- [ ] CPU idle <5%
- [ ] Search <1s
- [ ] No memory leaks
- [ ] All stress tests pass
- [ ] No performance regressions vs Phase 6

---

## Resources

- [Rust Performance Book](https://nnethercote.github.io/perf-book/)
- [React Performance](https://react.dev/learn/render-and-commit)
- [SQLite Performance Tuning](https://www.sqlite.org/optoverview.html)
- [macOS Instruments Guide](https://developer.apple.com/library/archive/documentation/DeveloperTools/Conceptual/InstrumentsUserGuide/)
