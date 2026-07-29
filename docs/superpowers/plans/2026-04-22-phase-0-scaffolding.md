# Phase 0: Project Scaffolding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a buildable, testable Tauri v2 + React + TypeScript + Python-sidecar project skeleton that compiles on macOS (local) and passes CI on macOS/Linux/Windows, with SQLite migrations infra and signing stubs ready for Phase 1.

**Architecture:** Three-tier — React frontend (Vite), Rust core (Tauri v2), Python sidecar (standalone binary launched by Rust). Phase 0 wires the tiers together with a trivial "ping/pong" call through all three layers to prove the bridge works end-to-end.

**Tech Stack:** Tauri v2, Rust (stable), React 18 + TypeScript + Vite, Bun (frontend package manager — already installed), Python 3.12, `python-build-standalone` from Astral, SQLite via `rusqlite` + `refinery` migrations, GitHub Actions for CI.

**Project root:** `/Users/shaunwhi/CCIE Terminal` (empty git-initialized repo at start of Task 1).

---

## File structure created by this phase

```
CCIE Terminal/
├── .github/workflows/ci.yml          # build matrix (mac/linux/win)
├── .gitignore
├── README.md
├── docs/superpowers/                 # already exists (specs + plans)
├── package.json                      # root — workspace + scripts
├── bun.lockb
├── vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── index.html
├── src/                              # React frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── App.css
│   └── lib/tauri.ts                  # typed wrappers around invoke
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── capabilities/default.json
│   ├── icons/                        # placeholder icons
│   ├── migrations/V0001__init.sql   # empty but wired
│   └── src/
│       ├── main.rs                   # app entrypoint, registers commands
│       ├── lib.rs                    # re-exports for testing
│       ├── db.rs                     # SQLite open + migrations runner
│       ├── bridge.rs                 # spawns sidecar + ping test
│       └── commands.rs               # #[tauri::command] fns exposed to frontend
├── sidecar/
│   ├── pyproject.toml
│   ├── README.md
│   ├── src/ccie_sidecar/
│   │   ├── __init__.py
│   │   ├── __main__.py               # python -m ccie_sidecar entrypoint
│   │   └── server.py                 # NDJSON stdio loop, handles "ping"
│   ├── tests/test_server.py
│   └── scripts/
│       ├── build-binary-macos.sh     # stub that produces a sidecar binary
│       ├── build-binary-linux.sh
│       └── build-binary-windows.ps1
└── ci/
    └── sign-sidecar-macos.sh         # stub; real impl in Phase 7
```

---

## Task 1: Initialize git repo and gitignore

**Files:**
- Modify: `/Users/shaunwhi/CCIE Terminal/` (git init)
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Initialize repo**

Run:
```bash
cd "/Users/shaunwhi/CCIE Terminal"
git init
git branch -m main
```

Expected: `Initialized empty Git repository`, branch set to `main`.

- [ ] **Step 2: Write `.gitignore`**

Create `.gitignore` with this exact content:

```gitignore
# macOS
.DS_Store

# Node / Bun
node_modules/
dist/
.vite/
bun.lockb.lock

# Rust / Tauri
src-tauri/target/
src-tauri/gen/
src-tauri/binaries/

# Python
sidecar/dist/
sidecar/build/
sidecar/**/__pycache__/
sidecar/**/*.pyc
sidecar/.venv/

# IDE / OS
.idea/
.vscode/
*.swp

# App/user data that may accidentally land here
.superpowers/
.ccie-test/

# Local env files (but keep .env.example)
.env
!.env.example
```

- [ ] **Step 3: Write `README.md`**

Create `README.md`:

```markdown
# CCIE Terminal

A CCIE-focused, Warp-like terminal with deeply integrated AI for computer-networking experts.

## Status

Phase 0 — scaffolding.

## Dev

Prereqs: Rust (stable), Node 22+, Bun, Python 3.12.

```
bun install
bun tauri dev
```

## License

TBD
```

- [ ] **Step 4: First commit**

Run:
```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add .gitignore README.md docs/
git commit -m "chore: init repo with gitignore and readme"
```

Expected: clean commit, no errors.

---

## Task 2: Install Rust toolchain

Rust is not yet installed on the dev machine. This task sets it up.

**Files:** none created; system-level install.

- [ ] **Step 1: Install rustup (user confirmation required)**

The rustup installer is a shell script. Run:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
sh /tmp/rustup-init.sh -y --default-toolchain stable --profile minimal
source "$HOME/.cargo/env"
```

Expected: `rustup` installed, `cargo` and `rustc` on PATH.

- [ ] **Step 2: Verify**

Run:
```bash
cargo --version
rustc --version
```

Expected: both print versions ≥ 1.80.0.

- [ ] **Step 3: Add targets for cross-platform builds (noop locally but keeps flag parity)**

Run:
```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

Expected: either already installed or `installed` messages.

No commit yet (system-level only).

---

## Task 3: Scaffold Tauri v2 + React + TS project

This uses `bun create tauri-app` (official scaffolder) then trims what we don't want.

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `index.html`
- Create: `src/main.tsx`, `src/App.tsx`, `src/App.css`
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `src-tauri/icons/*`

- [ ] **Step 1: Run the scaffolder**

Run from the project root:
```bash
cd "/Users/shaunwhi/CCIE Terminal"
# Bun scaffolder puts files INTO current dir when given "."
bun create tauri-app ccie-terminal-scratch --rc --manager bun --template react-ts --identifier com.ccie.terminal
```

The scaffolder will ask questions; we pre-answered via flags. It produces `ccie-terminal-scratch/` with a working Tauri v2 + React + TS project.

- [ ] **Step 2: Move the generated files into project root**

Run:
```bash
cd "/Users/shaunwhi/CCIE Terminal"
# Move content up, avoiding overwrites of docs/ and .gitignore we already wrote
rsync -a --exclude='docs' --exclude='.gitignore' --exclude='README.md' ccie-terminal-scratch/ ./
rm -rf ccie-terminal-scratch/
```

Expected: `src/`, `src-tauri/`, `package.json`, `vite.config.ts`, `index.html`, `tsconfig.json`, `tsconfig.node.json` now at project root.

- [ ] **Step 3: Merge the scaffolded `.gitignore` into ours**

The scaffolder wrote a `.gitignore`; we already have one. Inspect the scaffolded one (if not present because we excluded) and add any missing patterns to our existing `.gitignore`. Specifically ensure these are present in the merged file: `/dist`, `/src-tauri/target`, `/node_modules`.

- [ ] **Step 4: Install deps**

Run:
```bash
bun install
```

Expected: `bun install` completes with no errors; `node_modules/` created.

- [ ] **Step 5: Smoke-test the dev build**

Run:
```bash
bun tauri build -- --debug
```

Expected: after several minutes, a debug `.app` is produced at `src-tauri/target/debug/bundle/macos/`. First build is slow (Rust compile); subsequent are fast.

If build fails with a missing icon/entitlement: the scaffolder should have provided placeholder icons. If missing, run `bun tauri icon` with any PNG.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: scaffold Tauri v2 + React + TS project"
```

---

## Task 4: Trim scaffold to our bundle identifier, app name, and entrypoint structure

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `package.json`
- Modify: `src/App.tsx`
- Create: `src-tauri/src/lib.rs`

- [ ] **Step 1: Edit `src-tauri/tauri.conf.json`**

Change identifier, productName, and window title. Open `src-tauri/tauri.conf.json` and ensure these fields:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "CCIE Terminal",
  "version": "0.0.1",
  "identifier": "com.ccie.terminal",
  "build": {
    "beforeDevCommand": "bun run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "bun run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "CCIE Terminal",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 500
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

- [ ] **Step 2: Edit `src-tauri/Cargo.toml` package name**

Ensure the `[package]` section has:

```toml
[package]
name = "ccie-terminal"
version = "0.0.1"
edition = "2021"
```

Rename the lib target if present:

```toml
[lib]
name = "ccie_terminal_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
```

- [ ] **Step 3: Edit `package.json` name and scripts**

Ensure:

```json
{
  "name": "ccie-terminal",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "tauri": "tauri"
  }
}
```

Keep the dependency versions the scaffolder chose — don't edit those now.

- [ ] **Step 4: Replace `src/App.tsx` with a minimal placeholder**

Overwrite `src/App.tsx`:

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [msg, setMsg] = useState("");

  return (
    <div className="app">
      <h1>CCIE Terminal</h1>
      <p className="status">Phase 0 scaffold</p>
      <button
        onClick={async () => {
          const r = await invoke<string>("ping");
          setMsg(r);
        }}
      >
        ping core
      </button>
      {msg && <pre className="result">{msg}</pre>}
    </div>
  );
}

export default App;
```

- [ ] **Step 5: Replace `src/App.css` with minimal dark style**

Overwrite `src/App.css`:

```css
:root {
  color-scheme: dark;
  font-family: -apple-system, system-ui, sans-serif;
}

body {
  margin: 0;
  background: #0f1114;
  color: #e6e1cf;
}

.app {
  padding: 32px;
  max-width: 720px;
  margin: 0 auto;
}

h1 {
  color: #5ccfe6;
  margin: 0 0 8px;
}

.status {
  color: #6c7380;
  margin: 0 0 24px;
}

button {
  background: #262a33;
  color: #e6e1cf;
  border: 1px solid #3e4451;
  padding: 8px 14px;
  border-radius: 4px;
  cursor: pointer;
}

button:hover { background: #2d3138; }

.result {
  margin-top: 16px;
  background: #0b0d10;
  padding: 12px;
  border-radius: 4px;
  border-left: 3px solid #6bd968;
}
```

- [ ] **Step 6: Verify dev mode runs**

Run:
```bash
bun tauri dev
```

Expected: a window opens titled "CCIE Terminal" showing "Phase 0 scaffold" and a "ping core" button. Clicking the button won't work yet (ping command not implemented); errors in console are expected at this step. Close the window to stop.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: set app identity (CCIE Terminal, com.ccie.terminal)"
```

---

## Task 5: Add the `ping` Tauri command (TDD)

Proves the React → Rust path works.

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/main.rs`
- Create: `src-tauri/src/commands.rs`
- Create: `src-tauri/tests/commands_test.rs`

- [ ] **Step 1: Write the failing Rust unit test**

Create `src-tauri/tests/commands_test.rs`:

```rust
use ccie_terminal_lib::commands::ping;

#[test]
fn ping_returns_pong_with_timestamp() {
    let result = ping();
    assert!(result.starts_with("pong @"), "got: {}", result);
}
```

- [ ] **Step 2: Run the test — expect compile failure**

Run:
```bash
cd src-tauri
cargo test --test commands_test
```

Expected: FAIL with "unresolved import" or "cannot find module" — module `commands` and fn `ping` don't exist yet.

- [ ] **Step 3: Create `src-tauri/src/commands.rs`**

```rust
use std::time::{SystemTime, UNIX_EPOCH};

pub fn ping() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("pong @ {}", ts)
}

#[tauri::command]
pub fn ping_cmd() -> String {
    ping()
}
```

- [ ] **Step 4: Ensure `lib.rs` re-exports the module**

Edit or create `src-tauri/src/lib.rs`:

```rust
pub mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![commands::ping_cmd])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

(The `tauri_plugin_opener` line exists because the scaffolder added it; leave it.)

- [ ] **Step 5: Update `src-tauri/src/main.rs` to call `run`**

Overwrite:

```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ccie_terminal_lib::run();
}
```

- [ ] **Step 6: Run the test — expect pass**

Run:
```bash
cd src-tauri
cargo test --test commands_test
```

Expected: PASS.

- [ ] **Step 7: Wire the frontend to the renamed command**

The scaffolder may have left `greet` or similar. Update `src/App.tsx` so the `invoke<string>("ping")` uses the new command name. Since we registered `ping_cmd` but named it `"ping"` by default from the fn name — correct: Tauri uses the function's Rust name, so it's `ping_cmd`. Fix the frontend to call `"ping_cmd"`:

In `src/App.tsx`, change:
```tsx
const r = await invoke<string>("ping");
```
to:
```tsx
const r = await invoke<string>("ping_cmd");
```

- [ ] **Step 8: Smoke-test in dev**

Run:
```bash
bun tauri dev
```

Click "ping core" button. Expected: the green output box shows `pong @ 1745...`. Close window.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): add ping command exposed to frontend"
```

---

## Task 6: Add SQLite + refinery migrations (TDD)

Phase 1 will need the migrations runner working. Get the infrastructure in now with one empty migration.

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/migrations/V0001__init.sql`
- Create: `src-tauri/src/db.rs`
- Create: `src-tauri/tests/db_test.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add deps to `src-tauri/Cargo.toml`**

Under `[dependencies]` add:

```toml
rusqlite = { version = "0.32", features = ["bundled"] }
refinery = { version = "0.8", features = ["rusqlite"] }
anyhow = "1"
dirs = "5"
```

Under `[build-dependencies]` (create section if missing):

```toml
[build-dependencies]
refinery-cli = { version = "0.8", optional = true }
```

- [ ] **Step 2: Create the first migration file**

Create `src-tauri/migrations/V0001__init.sql`:

```sql
-- Phase 0 placeholder migration. Phase 1 will add real tables.
CREATE TABLE IF NOT EXISTS schema_placeholder (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

- [ ] **Step 3: Write the failing test**

Create `src-tauri/tests/db_test.rs`:

```rust
use ccie_terminal_lib::db;
use tempfile::TempDir;

#[test]
fn opens_and_migrates_fresh_db() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");

    let mut conn = db::open_and_migrate(&db_path).expect("open_and_migrate");

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_placeholder'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}
```

Add to `[dev-dependencies]` in `src-tauri/Cargo.toml`:

```toml
tempfile = "3"
```

- [ ] **Step 4: Run test — expect compile failure**

Run:
```bash
cd src-tauri
cargo test --test db_test
```

Expected: FAIL, module `db` not found.

- [ ] **Step 5: Create `src-tauri/src/db.rs`**

```rust
use anyhow::{Context, Result};
use refinery::embed_migrations;
use rusqlite::Connection;
use std::path::Path;

embed_migrations!("migrations");

pub fn open_and_migrate(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("create db parent dir")?;
    }
    let mut conn = Connection::open(path).context("open sqlite")?;
    migrations::runner()
        .run(&mut conn)
        .context("run migrations")?;
    Ok(conn)
}

pub fn default_db_path() -> Result<std::path::PathBuf> {
    let dir = dirs::config_dir()
        .context("could not determine OS config dir")?
        .join("ccie-terminal");
    std::fs::create_dir_all(&dir).context("create config dir")?;
    Ok(dir.join("sessions.db"))
}
```

- [ ] **Step 6: Add `pub mod db;` to `src-tauri/src/lib.rs`**

Top of file, add: `pub mod db;`

- [ ] **Step 7: Run test — expect pass**

Run:
```bash
cd src-tauri
cargo test --test db_test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): add SQLite connection + refinery migrations infrastructure"
```

---

## Task 7: Scaffold Python sidecar package (TDD)

Just the NDJSON stdio loop with a `ping` method. No Python build-standalone bundling yet — that's Phase 2. For Phase 0 we just establish the package layout and test the protocol.

**Files:**
- Create: `sidecar/pyproject.toml`
- Create: `sidecar/README.md`
- Create: `sidecar/src/ccie_sidecar/__init__.py`
- Create: `sidecar/src/ccie_sidecar/__main__.py`
- Create: `sidecar/src/ccie_sidecar/server.py`
- Create: `sidecar/tests/__init__.py`
- Create: `sidecar/tests/test_server.py`

- [ ] **Step 1: Write `sidecar/pyproject.toml`**

```toml
[project]
name = "ccie-sidecar"
version = "0.0.1"
description = "CCIE Terminal Python AI sidecar"
requires-python = ">=3.12"
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-asyncio>=0.23"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/ccie_sidecar"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
```

- [ ] **Step 2: Write `sidecar/README.md`**

```markdown
# CCIE Sidecar

Python AI backend for CCIE Terminal. Spawned by the Rust core over stdio.

## Dev

```
cd sidecar
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
```

## Protocol

NDJSON (newline-delimited JSON) over stdin/stdout. One JSON object per line.
```

- [ ] **Step 3: Create `__init__.py` files**

`sidecar/src/ccie_sidecar/__init__.py`:

```python
"""CCIE Terminal Python AI sidecar."""
__version__ = "0.0.1"
```

`sidecar/tests/__init__.py`: empty file.

- [ ] **Step 4: Write the failing test**

Create `sidecar/tests/test_server.py`:

```python
import io
import json
from ccie_sidecar.server import handle_request


def test_ping_returns_pong():
    req = {"id": "r1", "method": "ping"}
    resp = handle_request(req)
    assert resp["id"] == "r1"
    assert resp["type"] == "done"
    assert resp["result"] == "pong"


def test_unknown_method_returns_error():
    req = {"id": "r2", "method": "bogus"}
    resp = handle_request(req)
    assert resp["id"] == "r2"
    assert resp["type"] == "error"
    assert "unknown method" in resp["message"].lower()


def test_missing_id_uses_null_string():
    req = {"method": "ping"}
    resp = handle_request(req)
    assert resp["id"] == ""
    assert resp["type"] == "done"


def test_run_loop_reads_ndjson_and_writes_response():
    from ccie_sidecar.server import run_loop
    stdin = io.StringIO(json.dumps({"id": "r1", "method": "ping"}) + "\n")
    stdout = io.StringIO()
    run_loop(stdin, stdout)
    lines = [ln for ln in stdout.getvalue().splitlines() if ln]
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed == {"id": "r1", "type": "done", "result": "pong"}
```

- [ ] **Step 5: Run test — expect failure**

Run:
```bash
cd sidecar
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
```

Expected: ImportError — `server` module doesn't exist yet.

- [ ] **Step 6: Implement `sidecar/src/ccie_sidecar/server.py`**

```python
"""NDJSON stdio server. One JSON object per line on stdin; responses on stdout."""
from __future__ import annotations

import json
import sys
from typing import Any, TextIO


def handle_request(req: dict[str, Any]) -> dict[str, Any]:
    req_id = str(req.get("id", ""))
    method = req.get("method")
    if method == "ping":
        return {"id": req_id, "type": "done", "result": "pong"}
    return {"id": req_id, "type": "error", "message": f"unknown method: {method!r}"}


def run_loop(stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            err = {"id": "", "type": "error", "message": f"invalid json: {e}"}
            stdout.write(json.dumps(err) + "\n")
            stdout.flush()
            continue
        resp = handle_request(req)
        stdout.write(json.dumps(resp) + "\n")
        stdout.flush()
```

- [ ] **Step 7: Implement `sidecar/src/ccie_sidecar/__main__.py`**

```python
"""Entry point: `python -m ccie_sidecar`."""
from ccie_sidecar.server import run_loop


if __name__ == "__main__":
    run_loop()
```

- [ ] **Step 8: Run tests — expect pass**

Run:
```bash
cd sidecar
source .venv/bin/activate
pytest -v
```

Expected: 4 tests pass.

- [ ] **Step 9: Smoke-test the binary manually**

Run:
```bash
cd sidecar
source .venv/bin/activate
echo '{"id":"r1","method":"ping"}' | python -m ccie_sidecar
```

Expected output (single line):
```json
{"id": "r1", "type": "done", "result": "pong"}
```

- [ ] **Step 10: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add -A
git commit -m "feat(sidecar): scaffold Python package with NDJSON ping handler"
```

---

## Task 8: Add Rust→Python spawn + integration test

Prove the Rust core can spawn the Python sidecar and get a ping response.

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/bridge.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/bridge_test.rs`

- [ ] **Step 1: Add deps**

In `src-tauri/Cargo.toml` `[dependencies]`:

```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: Write the failing integration test**

Create `src-tauri/tests/bridge_test.rs`:

```rust
use ccie_terminal_lib::bridge::SidecarHandle;

// Set via env by the test runner; points at `python3.12 -m ccie_sidecar`
// running out of the repo's sidecar/.venv.
fn python_cmd() -> (String, Vec<String>) {
    let repo_root = std::env::var("CCIE_REPO_ROOT")
        .unwrap_or_else(|_| {
            std::env::current_dir()
                .unwrap()
                .parent()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        });
    let venv_python = format!("{}/sidecar/.venv/bin/python", repo_root);
    (venv_python, vec!["-m".into(), "ccie_sidecar".into()])
}

#[test]
fn spawn_sidecar_and_ping() {
    let (cmd, args) = python_cmd();
    let mut handle = SidecarHandle::spawn(&cmd, &args).expect("spawn");
    let resp = handle.call("ping", serde_json::json!({})).expect("call");
    assert_eq!(resp["type"], "done");
    assert_eq!(resp["result"], "pong");
    handle.shutdown();
}
```

- [ ] **Step 3: Run test — expect compile failure**

```bash
cd src-tauri
cargo test --test bridge_test
```

Expected: FAIL — `bridge` module missing.

- [ ] **Step 4: Implement `src-tauri/src/bridge.rs`**

```rust
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

static REQ_SEQ: AtomicU64 = AtomicU64::new(1);

pub struct SidecarHandle {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl SidecarHandle {
    pub fn spawn(program: &str, args: &[String]) -> Result<Self> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("spawn sidecar {program}"))?;
        let stdin = child.stdin.take().context("capture stdin")?;
        let stdout = BufReader::new(child.stdout.take().context("capture stdout")?);
        Ok(Self { child, stdin, stdout })
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = REQ_SEQ.fetch_add(1, Ordering::Relaxed).to_string();
        let req = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.flush()?;

        // Phase 0: one-in-one-out. Phase 2 will multiplex by id.
        let mut resp_line = String::new();
        let n = self.stdout.read_line(&mut resp_line)?;
        if n == 0 {
            bail!("sidecar closed stdout");
        }
        let resp: Value = serde_json::from_str(resp_line.trim())?;
        Ok(resp)
    }

    pub fn shutdown(mut self) {
        // Drop stdin to signal EOF, then wait briefly.
        drop(self.stdin);
        let _ = self.child.wait();
    }
}
```

- [ ] **Step 5: Register module in `src-tauri/src/lib.rs`**

Add: `pub mod bridge;`

- [ ] **Step 6: Run test — expect pass**

Run:
```bash
cd src-tauri
CCIE_REPO_ROOT="/Users/shaunwhi/CCIE Terminal" cargo test --test bridge_test -- --nocapture
```

Expected: PASS. If sidecar stderr prints, that's fine (inherited).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): spawn Python sidecar over stdio and round-trip ping"
```

---

## Task 9: Wire frontend "ping core" button through to sidecar

End-to-end: React → Rust → Python → back.

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/lib/tauri.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `ping_sidecar` Rust command**

Add to `src-tauri/src/commands.rs`:

```rust
use crate::bridge::SidecarHandle;

#[tauri::command]
pub async fn ping_sidecar() -> Result<String, String> {
    let repo_root = std::env::var("CCIE_REPO_ROOT")
        .map_err(|_| "CCIE_REPO_ROOT not set (Phase 0 dev-only)".to_string())?;
    let python = format!("{}/sidecar/.venv/bin/python", repo_root);
    let args = vec!["-m".to_string(), "ccie_sidecar".to_string()];

    let mut handle = SidecarHandle::spawn(&python, &args).map_err(|e| e.to_string())?;
    let resp = handle
        .call("ping", serde_json::json!({}))
        .map_err(|e| e.to_string())?;
    handle.shutdown();

    resp.get("result")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("malformed response: {resp}"))
}
```

- [ ] **Step 2: Register it**

In `src-tauri/src/lib.rs`, update the handler list:

```rust
.invoke_handler(tauri::generate_handler![
    commands::ping_cmd,
    commands::ping_sidecar
])
```

- [ ] **Step 3: Create typed frontend wrapper `src/lib/tauri.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export async function pingCore(): Promise<string> {
  return invoke<string>("ping_cmd");
}

export async function pingSidecar(): Promise<string> {
  return invoke<string>("ping_sidecar");
}
```

- [ ] **Step 4: Update `src/App.tsx`**

```tsx
import { useState } from "react";
import { pingCore, pingSidecar } from "./lib/tauri";
import "./App.css";

function App() {
  const [msg, setMsg] = useState("");

  async function run(fn: () => Promise<string>, label: string) {
    try {
      const r = await fn();
      setMsg(`${label}: ${r}`);
    } catch (e) {
      setMsg(`${label} ERROR: ${e}`);
    }
  }

  return (
    <div className="app">
      <h1>CCIE Terminal</h1>
      <p className="status">Phase 0 scaffold</p>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => run(pingCore, "core")}>ping core</button>
        <button onClick={() => run(pingSidecar, "sidecar")}>ping sidecar</button>
      </div>
      {msg && <pre className="result">{msg}</pre>}
    </div>
  );
}

export default App;
```

- [ ] **Step 5: Smoke-test end-to-end**

Run:
```bash
cd "/Users/shaunwhi/CCIE Terminal"
CCIE_REPO_ROOT="/Users/shaunwhi/CCIE Terminal" bun tauri dev
```

In the window:
- Click "ping core" → see `core: pong @ <timestamp>`.
- Click "ping sidecar" → see `sidecar: pong`.

Close window.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: end-to-end ping from React through Rust to Python sidecar"
```

---

## Task 10: GitHub Actions CI — 3-platform build matrix

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  rust-test:
    name: rust-test (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install system deps (Linux only, Tauri)
        if: matrix.os == 'ubuntu-latest'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev build-essential curl wget file

      - name: Set up Python 3.12
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install sidecar deps
        working-directory: sidecar
        run: |
          python -m venv .venv
          . .venv/bin/activate || . .venv/Scripts/activate
          pip install -e '.[dev]'
        shell: bash

      - name: Cache cargo
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: cargo fmt check
        working-directory: src-tauri
        run: cargo fmt --check

      - name: cargo clippy
        working-directory: src-tauri
        run: cargo clippy --all-targets -- -D warnings

      - name: cargo test
        working-directory: src-tauri
        env:
          CCIE_REPO_ROOT: ${{ github.workspace }}
        run: cargo test

  python-test:
    name: python-test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Install + test
        working-directory: sidecar
        run: |
          python -m venv .venv
          source .venv/bin/activate
          pip install -e '.[dev]'
          pytest -v

  frontend-build:
    name: frontend-build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build
```

- [ ] **Step 2: Format Rust code so `cargo fmt --check` passes**

Run:
```bash
cd src-tauri
cargo fmt
```

- [ ] **Step 3: Run clippy locally to catch warnings**

```bash
cd src-tauri
cargo clippy --all-targets -- -D warnings
```

Fix any warnings it reports. If it insists on suppressions, add `#[allow(...)]` only where justified.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci: add 3-platform build matrix (rust, python, frontend)"
```

---

## Task 11: Stub out per-platform sidecar build scripts

These scripts will eventually produce the `python-build-standalone` + our sidecar, renamed with target-triple suffix as Tauri expects. Phase 0 just creates stubs that exit 0 so the CI wiring is in place.

**Files:**
- Create: `sidecar/scripts/build-binary-macos.sh`
- Create: `sidecar/scripts/build-binary-linux.sh`
- Create: `sidecar/scripts/build-binary-windows.ps1`
- Create: `ci/sign-sidecar-macos.sh`

- [ ] **Step 1: Create shell stubs**

`sidecar/scripts/build-binary-macos.sh`:
```bash
#!/usr/bin/env bash
# Phase 7 implements this. Phase 0 stub only.
set -euo pipefail
echo "build-binary-macos.sh: not yet implemented (Phase 7)"
exit 0
```

`sidecar/scripts/build-binary-linux.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
echo "build-binary-linux.sh: not yet implemented (Phase 7)"
exit 0
```

`sidecar/scripts/build-binary-windows.ps1`:
```powershell
# Phase 7 implements this. Phase 0 stub only.
Write-Output "build-binary-windows.ps1: not yet implemented (Phase 7)"
exit 0
```

`ci/sign-sidecar-macos.sh`:
```bash
#!/usr/bin/env bash
# Sign each nested .dylib/.so inside python-build-standalone before Tauri bundles.
# Phase 7 implements this. Phase 0 stub only.
set -euo pipefail
echo "sign-sidecar-macos.sh: not yet implemented (Phase 7)"
exit 0
```

- [ ] **Step 2: Make them executable**

Run:
```bash
chmod +x sidecar/scripts/build-binary-macos.sh \
         sidecar/scripts/build-binary-linux.sh \
         ci/sign-sidecar-macos.sh
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: add sidecar build/sign stubs for Phase 7"
```

---

## Task 12: Write `.env.example` and document dev env

**Files:**
- Create: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Write `.env.example`**

```
# Phase 0 doesn't use any of these — they're listed so devs know what's coming.
# Real keys live in ~/.config/ccie-terminal/.env (not in repo).

ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434
VLLM_BASE_URL=
```

- [ ] **Step 2: Update README with working dev flow**

Overwrite `README.md`:

```markdown
# CCIE Terminal

A CCIE-focused, Warp-like terminal with deeply integrated AI for computer-networking experts.

## Status

Phase 0 — scaffolding. Ships an empty Tauri app that round-trips a "ping" through React → Rust → Python sidecar.

## Requirements

- Rust stable (`rustup`)
- Node 22+ and [Bun](https://bun.sh)
- Python 3.12

## First run

```
git clone <repo>
cd "CCIE Terminal"

# Install frontend deps
bun install

# Set up sidecar venv
cd sidecar
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
cd ..

# Run the app (Phase 0 requires CCIE_REPO_ROOT because the sidecar isn't yet bundled)
CCIE_REPO_ROOT="$PWD" bun tauri dev
```

Click "ping core" and "ping sidecar" in the window. Both should return `pong`.

## Tests

```
# Rust
cd src-tauri && cargo test

# Python
cd sidecar && source .venv/bin/activate && pytest

# Frontend (none in Phase 0)
```

## Phases

See `docs/superpowers/specs/2026-04-22-ccie-terminal-design.md`.

## License

TBD
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: env.example and dev setup instructions"
```

---

## Task 13: Final verification & Phase-0 exit checks

- [ ] **Step 1: Fresh clone smoke test (local simulation)**

Run a "from-scratch" check:
```bash
cd "/Users/shaunwhi/CCIE Terminal"
rm -rf node_modules dist src-tauri/target sidecar/.venv
bun install
(cd sidecar && python3.12 -m venv .venv && source .venv/bin/activate && pip install -e '.[dev]')
(cd src-tauri && cargo test)
(cd sidecar && source .venv/bin/activate && pytest -v)
CCIE_REPO_ROOT="$PWD" bun tauri dev
```

Expected:
- `cargo test` passes (3+ tests: ping, db, bridge).
- `pytest` passes (4 tests).
- Dev window opens; both ping buttons return `pong`.

- [ ] **Step 2: Confirm CI green**

Push branch. Watch GitHub Actions complete. If anything fails, fix it and push again before calling Phase 0 done.

- [ ] **Step 3: Tag the phase**

```bash
git tag -a phase-0 -m "Phase 0: scaffolding complete"
```

(Don't push tags unless user asks.)

---

## Phase 0 definition of done

- `bun tauri dev` opens a working app window titled "CCIE Terminal".
- Both "ping core" and "ping sidecar" buttons succeed.
- `cd src-tauri && cargo test` passes all tests.
- `cd sidecar && pytest` passes all tests.
- GitHub Actions `ci` workflow is green on all 3 OS matrix legs.
- SQLite migrations runner works against a fresh DB (covered by `db_test.rs`).
- Python sidecar NDJSON protocol works (covered by `test_server.py` + `bridge_test.rs`).

Phase 1 (PTY + multi-tab terminal) is unblocked.
