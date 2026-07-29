# TFTP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an embedded TFTP server (UDP/69) to CCIE Terminal as a Settings tab, mirroring the existing FTP server, so network gear can push/pull configs and images.

**Architecture:** A self-contained `src-tauri/src/tftp/` module exposes a `TftpService` stored in `AppState`, driving the `async-tftp` crate. For ports ≥ 1024 the server runs in-process on a tokio task (like FTP). For ports < 1024 (the standard port 69) the app relaunches its own binary in a `--tftp-helper` mode via an `osascript … with administrator privileges` prompt; the elevated child runs the listener and is controlled through a runfile it polls. Transfers are logged to a `tftp_events` table via a custom `async-tftp` `Handler`; the Settings tab shows a live feed by polling `tftp_events_tail`.

**Tech Stack:** Rust + Tauri, `async-tftp = "0.4"`, `async-fs` (futures-io compatible files for the handler), tokio, rusqlite, SQLite migration, React + TypeScript (Vite/vitest).

## Global Constraints

- **Next free migration is `V0077`** — the latest existing is `V0076__whatsapp_bound_chat.sql`. Use `V0077__tftp.sql`.
- **All Rust serde structs use `#[serde(rename_all = "camelCase")]`** (matches FTP; the TS types are camelCase).
- **TFTP has no accounts/login/passive-ports.** Do NOT port `ftp_users`, the authenticator, or passive-port config.
- **Run vitest with `--exclude '**/.worktrees/**'`** (project convention — worktree copies otherwise double-run).
- **Frontend RPC wrappers live in `src/lib/tauri.ts`; the tab mounts in `src/windows/Settings.tsx`, NOT `App.tsx`** (FTP has no App.tsx/menu/shortcut wiring — match that exactly).
- **Default port is 69, default host `0.0.0.0`, default root `~/.ccie-terminal/tftp`.**
- **Cross-privilege control:** a non-root process cannot `kill` a root-owned process. The elevated helper is stopped by removing a runfile it polls — never by signalling its PID.

---

## File Structure

**New files:**
- `src-tauri/migrations/V0077__tftp.sql` — `tftp_config` (singleton) + `tftp_events` + index.
- `src-tauri/src/tftp/mod.rs` — module decls + public re-exports.
- `src-tauri/src/tftp/types.rs` — `TftpConfig`, `TftpStatus`, `TftpEvent`.
- `src-tauri/src/tftp/server.rs` — `TftpService`, the logging `Handler`, path-jail, event insert, in-process + elevated lifecycle, `default_tftp_root`.
- `src-tauri/src/tftp/helper.rs` — the `--tftp-helper` entry: parse env, open DB, run listener, poll runfile.
- `src/windows/TftpSettingsTab.tsx` — the Settings tab UI + live feed.

**Modified files:**
- `src-tauri/Cargo.toml` — add `async-tftp`, `async-fs`.
- `src-tauri/src/lib.rs` — `pub mod tftp;`, `--tftp-helper` short-circuit at top of `run()`, register 6 commands.
- `src-tauri/src/commands/mod.rs` — `use crate::tftp;`, `AppState.tftp` field + construction, 6 command fns.
- `src/lib/tauri.ts` — TFTP types + RPC wrappers.
- `src/windows/Settings.tsx` — import, `"tftp"` in `activeTab` union, sidebar button, mount line.

---

### Task 1: Migration + Rust types

**Files:**
- Create: `src-tauri/migrations/V0077__tftp.sql`
- Create: `src-tauri/src/tftp/types.rs`
- Create: `src-tauri/src/tftp/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod tftp;` after line 33 `pub mod ftp;`)

**Interfaces:**
- Produces: `tftp::TftpConfig { bind_host: String, bind_port: u16, root_dir: String, read_only: bool, auto_start: bool }` (+ `Default`); `tftp::TftpStatus { running: bool, bind_address: Option<String>, started_at: Option<i64>, last_error: Option<String>, elevated: bool }`; `tftp::TftpEvent { id: i64, ts: i64, kind: String, client_ip: Option<String>, path: Option<String>, detail: Option<String> }`.

- [ ] **Step 1: Write the migration file**

Create `src-tauri/migrations/V0077__tftp.sql`:

```sql
-- TFTP server config (singleton row). TFTP has no users/passive ports.
CREATE TABLE IF NOT EXISTS tftp_config (
    id           INTEGER PRIMARY KEY DEFAULT 1 CHECK(id = 1),
    bind_host    TEXT    NOT NULL DEFAULT '0.0.0.0',
    bind_port    INTEGER NOT NULL DEFAULT 69,
    root_dir     TEXT    NOT NULL DEFAULT '',   -- empty = default_tftp_root() at read time
    read_only    INTEGER NOT NULL DEFAULT 0,
    auto_start   INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
INSERT OR IGNORE INTO tftp_config (id) VALUES (1);

-- Append-only transfer log for the live feed. Capped via LIMIT in app code.
CREATE TABLE IF NOT EXISTS tftp_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    kind       TEXT    NOT NULL,  -- 'read'|'write'|'error'|'info'
    client_ip  TEXT,
    path       TEXT,
    detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tftp_events_ts ON tftp_events(ts DESC);
```

- [ ] **Step 2: Write the types module with a failing test**

Create `src-tauri/src/tftp/types.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TftpConfig {
    pub bind_host: String,
    pub bind_port: u16,
    /// Empty string means "use default_tftp_root()".
    pub root_dir: String,
    pub read_only: bool,
    pub auto_start: bool,
}

impl Default for TftpConfig {
    fn default() -> Self {
        TftpConfig {
            bind_host: "0.0.0.0".into(),
            bind_port: 69,
            root_dir: String::new(),
            read_only: false,
            auto_start: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TftpStatus {
    pub running: bool,
    pub bind_address: Option<String>,
    pub started_at: Option<i64>,
    pub last_error: Option<String>,
    /// True when served by the elevated helper process (port < 1024).
    pub elevated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TftpEvent {
    pub id: i64,
    pub ts: i64,
    pub kind: String,
    pub client_ip: Option<String>,
    pub path: Option<String>,
    pub detail: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_port_69_all_ifaces() {
        let c = TftpConfig::default();
        assert_eq!(c.bind_port, 69);
        assert_eq!(c.bind_host, "0.0.0.0");
        assert!(c.root_dir.is_empty());
        assert!(!c.read_only);
        assert!(!c.auto_start);
    }
}
```

- [ ] **Step 3: Write the module file**

Create `src-tauri/src/tftp/mod.rs`:

```rust
pub mod helper;
pub mod server;
pub mod types;

pub use server::{default_tftp_root, TftpService};
pub use types::{TftpConfig, TftpEvent, TftpStatus};
```

(`server.rs` and `helper.rs` are created in later tasks; this will not compile until then — that is expected. Do the `cargo test` verification for this task's type test only after Task 2 & 4 stub those files, OR temporarily comment the `pub mod server;`/`pub mod helper;` lines to run the isolated type test. Prefer: implement Task 2 next so the crate compiles.)

- [ ] **Step 4: Register the module in lib.rs**

In `src-tauri/src/lib.rs`, immediately after line 33 (`pub mod ftp;`), add:

```rust
pub mod tftp;
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/migrations/V0077__tftp.sql src-tauri/src/tftp/types.rs src-tauri/src/tftp/mod.rs src-tauri/src/lib.rs
git commit -m "feat(tftp): migration V0077 + config/status/event types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: TFTP logging Handler (path-jail, read-only, event insert)

**Files:**
- Create: `src-tauri/src/tftp/server.rs` (this task creates the file with the handler + helpers; Task 3 adds `TftpService`)
- Modify: `src-tauri/Cargo.toml` (add deps)

**Interfaces:**
- Consumes: `TftpEvent` (Task 1).
- Produces:
  - `pub fn default_tftp_root() -> anyhow::Result<std::path::PathBuf>` = `~/.ccie-terminal/tftp`.
  - `pub fn resolve_in_root(root: &Path, requested: &Path) -> Result<PathBuf, String>` — jails a requested path to `root`, rejecting `..`/absolute escapes.
  - `pub fn insert_event(conn: &Mutex<Connection>, kind: &str, client_ip: Option<&str>, path: Option<&str>, detail: Option<&str>)` — inserts one `tftp_events` row (best-effort).
  - `pub struct LoggingHandler { pub db: Arc<Mutex<Connection>>, pub root: PathBuf, pub read_only: bool }` implementing `async_tftp::server::Handler` with `Reader = async_fs::File`, `Writer = async_fs::File`.

- [ ] **Step 1: Add dependencies to Cargo.toml**

In `src-tauri/Cargo.toml`, in `[dependencies]` near the existing `libunftp`/`unftp-sbe-fs` lines (59–60), add:

```toml
async-tftp = "0.4"
async-fs = "2"
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/tftp/server.rs` with the helpers + tests (the `Handler` impl comes in Step 3):

```rust
use crate::tftp::types::*;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Default TFTP root: ~/.ccie-terminal/tftp
pub fn default_tftp_root() -> Result<PathBuf> {
    let home = dirs::home_dir().context("home dir")?;
    Ok(home.join(".ccie-terminal").join("tftp"))
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Resolve `requested` inside `root`, rejecting any `..` or absolute-path escape.
/// Returns the joined absolute path on success.
pub fn resolve_in_root(root: &Path, requested: &Path) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    for comp in requested.components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            // Reject traversal and absolute/rooted escapes outright.
            Component::ParentDir => return Err("path traversal rejected".into()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("absolute path rejected".into())
            }
        }
    }
    Ok(out)
}

/// Best-effort insert of one event row. Never panics.
pub fn insert_event(
    db: &Mutex<Connection>,
    kind: &str,
    client_ip: Option<&str>,
    path: Option<&str>,
    detail: Option<&str>,
) {
    let conn = db.lock();
    let _ = conn.execute(
        "INSERT INTO tftp_events (ts, kind, client_ip, path, detail)
           VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![now_unix_ms(), kind, client_ip, path, detail],
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tftp_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL, kind TEXT NOT NULL,
                client_ip TEXT, path TEXT, detail TEXT);",
        )
        .unwrap();
        Arc::new(Mutex::new(conn))
    }

    #[test]
    fn resolve_rejects_parent_traversal() {
        let root = Path::new("/srv/tftp");
        assert!(resolve_in_root(root, Path::new("../etc/passwd")).is_err());
        assert!(resolve_in_root(root, Path::new("a/../../b")).is_err());
    }

    #[test]
    fn resolve_rejects_absolute() {
        let root = Path::new("/srv/tftp");
        assert!(resolve_in_root(root, Path::new("/etc/passwd")).is_err());
    }

    #[test]
    fn resolve_allows_normal_nested() {
        let root = Path::new("/srv/tftp");
        let got = resolve_in_root(root, Path::new("cfg/switch1.cfg")).unwrap();
        assert_eq!(got, Path::new("/srv/tftp/cfg/switch1.cfg"));
    }

    #[test]
    fn insert_event_writes_row() {
        let db = mem_db();
        insert_event(&db, "write", Some("10.0.0.1"), Some("r.cfg"), Some("42 bytes"));
        let conn = db.lock();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM tftp_events WHERE kind='write'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail (compile first)**

Run: `cd src-tauri && cargo test tftp::server::tests 2>&1 | tail -20`
Expected: fails to compile until deps resolve, then the 4 tests appear. (If `mod.rs` still references `helper`, temporarily comment `pub mod helper;` to compile.)

- [ ] **Step 4: Add the `LoggingHandler` implementing `async_tftp::server::Handler`**

Append to `src-tauri/src/tftp/server.rs` (above the `#[cfg(test)]` block):

```rust
use async_tftp::server::Handler;
use std::future::Future;
use std::net::SocketAddr;

/// Custom async-tftp handler: enforces the read-only toggle + path jail and
/// logs every RRQ/WRQ into tftp_events. File I/O uses async-fs (futures-io
/// compatible, which async-tftp's Reader/Writer bounds require).
pub struct LoggingHandler {
    pub db: Arc<Mutex<Connection>>,
    pub root: PathBuf,
    pub read_only: bool,
}

impl Handler for LoggingHandler {
    type Reader = async_fs::File;
    type Writer = async_fs::File;

    fn read_req_open(
        &mut self,
        client: &SocketAddr,
        path: &Path,
    ) -> impl Future<Output = Result<(Self::Reader, Option<u64>), async_tftp::Error>> + Send {
        let db = self.db.clone();
        let root = self.root.clone();
        let ip = client.ip().to_string();
        let req = path.to_path_buf();
        async move {
            let full = resolve_in_root(&root, &req).map_err(|e| {
                insert_event(&db, "error", Some(&ip), req.to_str(), Some(&e));
                async_tftp::Error::FileNotFound(req.clone())
            })?;
            let file = async_fs::File::open(&full).await.map_err(|e| {
                insert_event(&db, "error", Some(&ip), full.to_str(), Some(&e.to_string()));
                async_tftp::Error::FileNotFound(req.clone())
            })?;
            let size = file.metadata().await.ok().map(|m| m.len());
            insert_event(&db, "read", Some(&ip), full.to_str(), size.map(|s| format!("{s} bytes")).as_deref());
            Ok((file, size))
        }
    }

    fn write_req_open(
        &mut self,
        client: &SocketAddr,
        path: &Path,
        _size: Option<u64>,
    ) -> impl Future<Output = Result<Self::Writer, async_tftp::Error>> + Send {
        let db = self.db.clone();
        let root = self.root.clone();
        let ip = client.ip().to_string();
        let req = path.to_path_buf();
        let read_only = self.read_only;
        async move {
            if read_only {
                insert_event(&db, "error", Some(&ip), req.to_str(), Some("server is read-only"));
                return Err(async_tftp::Error::PermissionDenied);
            }
            let full = resolve_in_root(&root, &req).map_err(|e| {
                insert_event(&db, "error", Some(&ip), req.to_str(), Some(&e));
                async_tftp::Error::PermissionDenied
            })?;
            if let Some(parent) = full.parent() {
                let _ = async_fs::create_dir_all(parent).await;
            }
            let file = async_fs::File::create(&full).await.map_err(|e| {
                insert_event(&db, "error", Some(&ip), full.to_str(), Some(&e.to_string()));
                async_tftp::Error::PermissionDenied
            })?;
            insert_event(&db, "write", Some(&ip), full.to_str(), None);
            Ok(file)
        }
    }
}
```

> **Verification note for implementer:** confirm the exact `async_tftp::Error` variant names against `async-tftp = "0.4.2"` (`cargo doc --open -p async-tftp`, enum `Error`). If `FileNotFound(PathBuf)` / `PermissionDenied` differ, use the closest real variants; the goal is "reject cleanly + log." Also confirm `async_fs::File` satisfies `AsyncRead/AsyncWrite + Unpin + Send + 'static` (it does in `async-fs` 2.x). If the trait uses `async fn` sugar instead of `impl Future`, rewrite the two methods as `async fn` — semantics identical.

- [ ] **Step 5: Add a read-only + file-roundtrip test**

Add to the `#[cfg(test)]` module in `server.rs`:

```rust
    #[test]
    fn read_only_flag_is_honored_by_handler_state() {
        // Unit-level guard: a read-only handler must carry read_only=true so
        // write_req_open's early-return path triggers. (Full WRQ rejection is
        // covered by the async path; this asserts the wiring.)
        let db = mem_db();
        let h = LoggingHandler { db, root: PathBuf::from("/tmp/x"), read_only: true };
        assert!(h.read_only);
    }

    #[tokio::test]
    async fn write_then_read_roundtrips_and_logs() {
        let db = mem_db();
        let dir = std::env::temp_dir().join(format!("tftp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let client: SocketAddr = "10.0.0.9:5000".parse().unwrap();

        // Write
        let mut wh = LoggingHandler { db: db.clone(), root: dir.clone(), read_only: false };
        {
            use futures_lite::AsyncWriteExt;
            let mut w = wh.write_req_open(&client, Path::new("r.cfg"), None).await.unwrap();
            w.write_all(b"hostname R1\n").await.unwrap();
            w.flush().await.unwrap();
        }
        // Read
        let mut rh = LoggingHandler { db: db.clone(), root: dir.clone(), read_only: false };
        let (mut r, size) = rh.read_req_open(&client, Path::new("r.cfg")).await.unwrap();
        assert_eq!(size, Some(12));
        {
            use futures_lite::AsyncReadExt;
            let mut buf = String::new();
            r.read_to_string(&mut buf).await.unwrap();
            assert_eq!(buf, "hostname R1\n");
        }
        // Events: one write + one read
        let conn = db.lock();
        let writes: i64 = conn.query_row("SELECT COUNT(*) FROM tftp_events WHERE kind='write'", [], |r| r.get(0)).unwrap();
        let reads: i64 = conn.query_row("SELECT COUNT(*) FROM tftp_events WHERE kind='read'", [], |r| r.get(0)).unwrap();
        assert_eq!((writes, reads), (1, 1));
    }
```

Add `futures-lite = "2"` to `[dev-dependencies]` in `Cargo.toml` if not already present (used only by the test's read/write extension traits).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test tftp::server::tests 2>&1 | tail -25`
Expected: all `tftp::server::tests` pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/tftp/server.rs
git commit -m "feat(tftp): logging Handler with path-jail + read-only + event log

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: TftpService in-process lifecycle (ports ≥ 1024)

**Files:**
- Modify: `src-tauri/src/tftp/server.rs` (add `TftpService` + handle + in-process start/stop)

**Interfaces:**
- Consumes: `LoggingHandler`, `default_tftp_root`, `resolve_in_root`, `insert_event`, `TftpConfig`, `TftpStatus` (Tasks 1–2).
- Produces:
  - `pub struct TftpService { db, handle, last_error }` with `pub fn new(db: Arc<Mutex<Connection>>) -> Self`, `pub fn is_running(&self) -> bool`, `pub fn status(&self) -> TftpStatus`, `pub async fn start(&self, config: TftpConfig) -> Result<()>`, `pub fn stop(&self) -> Result<()>`.
  - `fn effective_root(config: &TftpConfig) -> Result<PathBuf>` — `config.root_dir` if non-empty else `default_tftp_root()`.

- [ ] **Step 1: Write the failing integration test**

Add to the `#[cfg(test)]` module in `server.rs`:

```rust
    #[tokio::test]
    async fn service_starts_and_stops_on_high_port() {
        let db = mem_db_with_events();
        let svc = TftpService::new(db);
        assert!(!svc.is_running());

        let cfg = TftpConfig {
            bind_host: "127.0.0.1".into(),
            bind_port: 16969, // high port → in-process, no elevation
            root_dir: std::env::temp_dir().join("tftp-svc-test").to_string_lossy().into(),
            read_only: false,
            auto_start: false,
        };
        svc.start(cfg).await.expect("start");
        assert!(svc.is_running());
        let st = svc.status();
        assert!(st.running);
        assert!(!st.elevated);
        assert_eq!(st.bind_address.as_deref(), Some("127.0.0.1:16969"));

        svc.stop().expect("stop");
        assert!(!svc.is_running());
    }
```

Update the test helper `mem_db` to also create `tftp_config` (rename usage): add a second helper next to `mem_db`:

```rust
    fn mem_db_with_events() -> Arc<Mutex<Connection>> {
        // Same as mem_db but reused by service tests; events table is enough
        // because in-process start reads config from the passed TftpConfig,
        // not the DB.
        mem_db()
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test tftp::server::tests::service_starts_and_stops_on_high_port 2>&1 | tail -20`
Expected: FAIL — `TftpService` not defined.

- [ ] **Step 3: Implement `TftpService` (in-process path)**

Append to `server.rs` (above tests). Add `use tokio::sync::broadcast;` to the imports at the top of the file:

```rust
fn effective_root(config: &TftpConfig) -> Result<PathBuf> {
    if config.root_dir.trim().is_empty() {
        default_tftp_root()
    } else {
        Ok(PathBuf::from(&config.root_dir))
    }
}

/// Handle for the in-process (non-elevated) server task.
struct InProcHandle {
    shutdown_tx: broadcast::Sender<()>,
    started_at: i64,
    bind_address: String,
}

/// TFTP lifecycle state stored in AppState.
pub struct TftpService {
    pub db: Arc<Mutex<Connection>>,
    handle: Arc<Mutex<Option<InProcHandle>>>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl TftpService {
    pub fn new(db: Arc<Mutex<Connection>>) -> Self {
        Self {
            db,
            handle: Arc::new(Mutex::new(None)),
            last_error: Arc::new(Mutex::new(None)),
        }
    }

    pub fn is_running(&self) -> bool {
        // In-process running, OR an elevated helper is alive (Task 4 augments this).
        self.handle.lock().is_some() || crate::tftp::helper::helper_is_running()
    }

    pub fn status(&self) -> TftpStatus {
        if let Some(h) = self.handle.lock().as_ref() {
            return TftpStatus {
                running: true,
                bind_address: Some(h.bind_address.clone()),
                started_at: Some(h.started_at),
                last_error: self.last_error.lock().clone(),
                elevated: false,
            };
        }
        // Elevated helper status (Task 4 fills real values; default is stopped).
        crate::tftp::helper::helper_status(self.last_error.lock().clone())
    }

    pub async fn start(&self, config: TftpConfig) -> Result<()> {
        if self.is_running() {
            anyhow::bail!("TFTP server is already running");
        }
        let root = effective_root(&config)?;
        std::fs::create_dir_all(&root).ok();

        // Ports < 1024 need root on macOS → elevated helper (Task 4).
        if config.bind_port < 1024 {
            return crate::tftp::helper::spawn_elevated(&config, &root);
        }

        let bind_address = format!("{}:{}", config.bind_host, config.bind_port);
        let addr: std::net::SocketAddr = bind_address
            .parse()
            .map_err(|e| anyhow::anyhow!("bad bind address {bind_address}: {e}"))?;

        let db = self.db.clone();
        let read_only = config.read_only;
        let last_error = self.last_error.clone();
        let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(1);
        let root_for_task = root.clone();
        let addr_for_log = bind_address.clone();

        tokio::spawn(async move {
            use async_tftp::server::TftpServerBuilder;
            let handler = LoggingHandler { db: db.clone(), root: root_for_task, read_only };
            let server = match TftpServerBuilder::with_handler(handler).bind(addr).build().await {
                Ok(s) => s,
                Err(e) => {
                    *last_error.lock() = Some(format!("build: {e}"));
                    insert_event(&db, "error", None, None, Some(&format!("build failed: {e}")));
                    return;
                }
            };
            insert_event(&db, "info", None, None, Some(&format!("listening on {addr_for_log}")));
            tokio::select! {
                res = server.serve() => {
                    if let Err(e) = res {
                        *last_error.lock() = Some(e.to_string());
                        insert_event(&db, "error", None, None, Some(&format!("serve error: {e}")));
                    }
                }
                _ = shutdown_rx.recv() => {
                    insert_event(&db, "info", None, None, Some("shut down"));
                }
            }
        });

        *self.handle.lock() = Some(InProcHandle {
            shutdown_tx,
            started_at: now_unix_ms(),
            bind_address,
        });
        *self.last_error.lock() = None;
        Ok(())
    }

    pub fn stop(&self) -> Result<()> {
        if let Some(h) = self.handle.lock().take() {
            let _ = h.shutdown_tx.send(());
            return Ok(());
        }
        // Otherwise stop an elevated helper if present (Task 4).
        crate::tftp::helper::stop_elevated()
    }
}
```

> **Verification note:** confirm `TftpServer::serve()` exists on `async-tftp` 0.4.2 (the docs page for `TftpServerBuilder` didn't render `TftpServer`'s methods). If the run method is named differently (e.g. `serve_forever`), adjust the single call site in the `tokio::select!`.

- [ ] **Step 4: Add temporary helper stubs so the crate compiles**

`server.rs` references `crate::tftp::helper::{helper_is_running, helper_status, spawn_elevated, stop_elevated}`. Create the file `src-tauri/src/tftp/helper.rs` with stubs now; Task 4 replaces the bodies:

```rust
//! Elevated TFTP helper (port < 1024). Task 4 implements the real logic.
use crate::tftp::types::{TftpConfig, TftpStatus};
use anyhow::Result;
use std::path::Path;

pub fn helper_is_running() -> bool {
    false
}

pub fn helper_status(last_error: Option<String>) -> TftpStatus {
    TftpStatus {
        running: false,
        bind_address: None,
        started_at: None,
        last_error,
        elevated: false,
    }
}

pub fn spawn_elevated(_config: &TftpConfig, _root: &Path) -> Result<()> {
    anyhow::bail!("elevated TFTP (port < 1024) not implemented yet")
}

pub fn stop_elevated() -> Result<()> {
    Ok(())
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test tftp:: 2>&1 | tail -25`
Expected: all TFTP tests pass, including `service_starts_and_stops_on_high_port`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/tftp/server.rs src-tauri/src/tftp/helper.rs
git commit -m "feat(tftp): TftpService in-process lifecycle (ports >= 1024)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Elevated helper mode (port < 1024, osascript + runfile control)

**Files:**
- Modify: `src-tauri/src/tftp/helper.rs` (replace stubs with real logic)
- Modify: `src-tauri/src/lib.rs` (short-circuit `--tftp-helper` at the top of `run()`)

**Interfaces:**
- Consumes: `TftpConfig` (Task 1), `LoggingHandler`/`effective_root` semantics (Tasks 2–3).
- Produces (replacing stubs, same signatures): `helper_is_running() -> bool`, `helper_status(Option<String>) -> TftpStatus`, `spawn_elevated(&TftpConfig, &Path) -> Result<()>`, `stop_elevated() -> Result<()>`, plus `pub fn run_helper_if_requested() -> bool` (called first in `run()`), and control-file path helpers.

**Control model (critical):** A non-root parent cannot signal a root child. So:
- Parent, before elevating, writes a **runfile** `~/.ccie-terminal/tftp.run` (plain text: `host:port`).
- Parent spawns the elevated helper via `osascript … with administrator privileges`, passing config through env vars; the helper writes its PID to `~/.ccie-terminal/tftp.pid`.
- Helper races `server.serve()` against a 1s poll: if the runfile disappears OR its own parent is gone (`getppid()==1`), it exits cleanly and removes the pidfile.
- `stop_elevated()` = parent removes the runfile (parent owns it → allowed). Helper self-exits on next poll.
- `helper_is_running()` = pidfile exists AND that PID is alive.

- [ ] **Step 1: Write failing unit tests for the pure pieces**

Add to `helper.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osascript_command_exports_env_and_execs_binary() {
        let cmd = build_helper_shell_command(
            "/Applications/CCIE.app/Contents/MacOS/ccie-terminal",
            "0.0.0.0",
            69,
            "/Users/x/.ccie-terminal/tftp",
            true,
            "/Users/x/.ccie-terminal/db.sqlite",
            "/Users/x/.ccie-terminal/tftp.pid",
            "/Users/x/.ccie-terminal/tftp.run",
        );
        assert!(cmd.contains("CCIE_TFTP_PORT=69"));
        assert!(cmd.contains("CCIE_TFTP_HOST=0.0.0.0"));
        assert!(cmd.contains("CCIE_TFTP_RO=1"));
        assert!(cmd.contains("--tftp-helper"));
        assert!(cmd.contains("ccie-terminal")); // the binary path
    }

    #[test]
    fn read_only_flag_serializes_to_zero_when_false() {
        let cmd = build_helper_shell_command(
            "/bin/x", "0.0.0.0", 69, "/r", false, "/db", "/p", "/run",
        );
        assert!(cmd.contains("CCIE_TFTP_RO=0"));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test tftp::helper::tests 2>&1 | tail -20`
Expected: FAIL — `build_helper_shell_command` not defined.

- [ ] **Step 3: Implement the helper module**

Replace the entire body of `src-tauri/src/tftp/helper.rs` with:

```rust
//! Elevated TFTP helper for privileged ports (< 1024, i.e. the standard port 69).
//!
//! The unprivileged app cannot bind port 69, so it relaunches its own binary in
//! `--tftp-helper` mode via `osascript ... with administrator privileges` (native
//! macOS auth prompt). Because a non-root parent cannot signal a root child, the
//! helper is controlled by a *runfile* it polls: the parent removes the runfile to
//! request shutdown, and the helper self-exits on its next poll.
use crate::tftp::server::{effective_root_pub, LoggingHandler};
use crate::tftp::types::{TftpConfig, TftpStatus};
use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn ctrl_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".ccie-terminal")
}
fn pidfile() -> PathBuf {
    ctrl_dir().join("tftp.pid")
}
fn runfile() -> PathBuf {
    ctrl_dir().join("tftp.run")
}

/// Build the shell command run (as root) by osascript. Exports config via env
/// and execs the app binary in --tftp-helper mode, backgrounded via nohup.
pub fn build_helper_shell_command(
    binary: &str,
    host: &str,
    port: u16,
    root: &str,
    read_only: bool,
    db_path: &str,
    pid_path: &str,
    run_path: &str,
) -> String {
    // Single-quote each value for the shell; values are app-controlled paths.
    format!(
        "CCIE_TFTP_HOST='{host}' CCIE_TFTP_PORT={port} CCIE_TFTP_ROOT='{root}' \
         CCIE_TFTP_RO={ro} CCIE_TFTP_DB='{db}' CCIE_TFTP_PID='{pid}' CCIE_TFTP_RUN='{run}' \
         nohup '{bin}' --tftp-helper >/tmp/ccie-tftp-helper.log 2>&1 &",
        host = host,
        port = port,
        root = root,
        ro = if read_only { 1 } else { 0 },
        db = db_path,
        pid = pid_path,
        run = run_path,
        bin = binary,
    )
}

fn pid_is_alive(pid: i32) -> bool {
    // kill(pid, 0): Ok or EPERM => exists; ESRCH => gone.
    unsafe {
        let r = libc::kill(pid, 0);
        if r == 0 {
            return true;
        }
        // errno EPERM (1) means it exists but we can't signal it (root-owned).
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

pub fn helper_is_running() -> bool {
    let pf = pidfile();
    let Ok(txt) = std::fs::read_to_string(&pf) else {
        return false;
    };
    match txt.trim().parse::<i32>() {
        Ok(pid) => pid_is_alive(pid),
        Err(_) => false,
    }
}

pub fn helper_status(last_error: Option<String>) -> TftpStatus {
    if helper_is_running() {
        let bind = std::fs::read_to_string(runfile()).ok().map(|s| s.trim().to_string());
        TftpStatus {
            running: true,
            bind_address: bind,
            started_at: None,
            last_error,
            elevated: true,
        }
    } else {
        TftpStatus {
            running: false,
            bind_address: None,
            started_at: None,
            last_error,
            elevated: false,
        }
    }
}

/// Spawn the elevated helper. Blocks until the osascript auth dialog resolves.
pub fn spawn_elevated(config: &TftpConfig, root: &Path) -> Result<()> {
    let dir = ctrl_dir();
    std::fs::create_dir_all(&dir).ok();

    let bind = format!("{}:{}", config.bind_host, config.bind_port);
    // Runfile presence == "keep running". Written by us (non-root) so we can remove it.
    std::fs::write(runfile(), &bind)?;
    let _ = std::fs::remove_file(pidfile()); // clear stale

    let binary = std::env::current_exe()?.to_string_lossy().to_string();
    let db_path = crate::db::default_db_path()?.to_string_lossy().to_string();
    let shell = build_helper_shell_command(
        &binary,
        &config.bind_host,
        config.bind_port,
        &root.to_string_lossy(),
        config.read_only,
        &db_path,
        &pidfile().to_string_lossy(),
        &runfile().to_string_lossy(),
    );

    // osascript: prompt once for admin, then run the shell command as root.
    let apple = format!(
        "do shell script {} with administrator privileges",
        applescript_quote(&shell)
    );
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&apple)
        .status()?;
    if !status.success() {
        let _ = std::fs::remove_file(runfile());
        anyhow::bail!("authorization cancelled or failed");
    }
    Ok(())
}

/// Quote a string as an AppleScript string literal.
fn applescript_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// Request shutdown by removing the runfile the helper polls.
pub fn stop_elevated() -> Result<()> {
    let _ = std::fs::remove_file(runfile());
    Ok(())
}

/// If invoked with `--tftp-helper`, run the listener and never return.
/// Returns true if we handled helper mode (caller should exit).
pub fn run_helper_if_requested() -> bool {
    if !std::env::args().any(|a| a == "--tftp-helper") {
        return false;
    }
    // Build a single-threaded tokio runtime and run the listener.
    let rt = tokio::runtime::Runtime::new().expect("helper runtime");
    rt.block_on(async {
        if let Err(e) = helper_main().await {
            eprintln!("tftp helper error: {e}");
        }
    });
    true
}

async fn helper_main() -> Result<()> {
    let host = std::env::var("CCIE_TFTP_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port: u16 = std::env::var("CCIE_TFTP_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(69);
    let root = PathBuf::from(std::env::var("CCIE_TFTP_ROOT").unwrap_or_default());
    let read_only = std::env::var("CCIE_TFTP_RO").ok().as_deref() == Some("1");
    let db_path = std::env::var("CCIE_TFTP_DB")?;
    let pid_path = PathBuf::from(std::env::var("CCIE_TFTP_PID")?);
    let run_path = PathBuf::from(std::env::var("CCIE_TFTP_RUN")?);

    std::fs::write(&pid_path, std::process::id().to_string())?;
    let _ = effective_root_pub; // ensure symbol import stays even if unused

    let conn = Connection::open(&db_path)?;
    let db = Arc::new(Mutex::new(conn));
    let addr: std::net::SocketAddr = format!("{host}:{port}").parse()?;

    use async_tftp::server::TftpServerBuilder;
    let handler = LoggingHandler { db: db.clone(), root, read_only };
    let server = TftpServerBuilder::with_handler(handler).bind(addr).build().await?;

    let parent_gone = async {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let runfile_gone = !run_path.exists();
            let orphaned = unsafe { libc::getppid() } == 1;
            if runfile_gone || orphaned {
                break;
            }
        }
    };

    tokio::select! {
        res = server.serve() => { res?; }
        _ = parent_gone => {}
    }
    let _ = std::fs::remove_file(&pid_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osascript_command_exports_env_and_execs_binary() {
        let cmd = build_helper_shell_command(
            "/Applications/CCIE.app/Contents/MacOS/ccie-terminal",
            "0.0.0.0", 69, "/Users/x/.ccie-terminal/tftp", true,
            "/Users/x/.ccie-terminal/db.sqlite",
            "/Users/x/.ccie-terminal/tftp.pid",
            "/Users/x/.ccie-terminal/tftp.run",
        );
        assert!(cmd.contains("CCIE_TFTP_PORT=69"));
        assert!(cmd.contains("CCIE_TFTP_HOST=0.0.0.0"));
        assert!(cmd.contains("CCIE_TFTP_RO=1"));
        assert!(cmd.contains("--tftp-helper"));
        assert!(cmd.contains("ccie-terminal"));
    }

    #[test]
    fn read_only_flag_serializes_to_zero_when_false() {
        let cmd = build_helper_shell_command("/bin/x", "0.0.0.0", 69, "/r", false, "/db", "/p", "/run");
        assert!(cmd.contains("CCIE_TFTP_RO=0"));
    }

    #[test]
    fn applescript_quote_escapes_quotes() {
        assert_eq!(applescript_quote(r#"a"b"#), r#""a\"b""#);
    }
}
```

Add to `[dependencies]` in `Cargo.toml` if not present: `libc = "0.2"` (it usually already is — check first with `grep '^libc' src-tauri/Cargo.toml`).

- [ ] **Step 4: Expose `effective_root` for the helper**

In `server.rs`, add a public alias next to `effective_root`:

```rust
/// Public re-export so the helper module can share root resolution.
pub fn effective_root_pub(config: &TftpConfig) -> Result<PathBuf> {
    effective_root(config)
}
```

(The helper reads its root from the `CCIE_TFTP_ROOT` env directly, so this is only to keep a shared definition available; if you prefer, drop the `let _ = effective_root_pub;` line in `helper_main` and this alias entirely.)

- [ ] **Step 5: Wire `--tftp-helper` short-circuit into `run()`**

In `src-tauri/src/lib.rs`, make it the very first thing in `pub fn run()` (before logging init at line 82):

```rust
pub fn run() {
    // Privileged TFTP helper mode: bind port < 1024 as root, run listener, exit.
    if crate::tftp::helper::run_helper_if_requested() {
        return;
    }

    // Initialize logging first
    if let Err(e) = logging::init_default_logging() {
```

- [ ] **Step 6: Run the tests + full build**

Run: `cd src-tauri && cargo test tftp::helper::tests 2>&1 | tail -20`
Expected: 3 helper tests pass.
Run: `cd src-tauri && cargo build 2>&1 | tail -15`
Expected: builds clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/tftp/helper.rs src-tauri/src/tftp/server.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(tftp): elevated helper for port 69 (osascript + runfile control)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> **Manual verification (cannot be automated — needs the auth prompt):** deferred to the end-to-end check after Task 7.

---

### Task 5: Tauri commands + AppState wiring + registration

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (`use crate::tftp;`, AppState field + construction, 6 command fns)
- Modify: `src-tauri/src/lib.rs` (register the 6 commands in `generate_handler!`)

**Interfaces:**
- Consumes: `TftpService`, `TftpConfig`, `TftpStatus`, `TftpEvent` (Tasks 1–4).
- Produces (Tauri commands): `tftp_config_get`, `tftp_config_set`, `tftp_status`, `tftp_start` (async), `tftp_stop`, `tftp_events_tail`. `AppState.tftp: Arc<tftp::TftpService>`.

- [ ] **Step 1: Add the import**

In `src-tauri/src/commands/mod.rs`, near line 171 (`use crate::ftp;`), add:

```rust
use crate::tftp;
```

- [ ] **Step 2: Add the AppState field**

In the `AppState` struct, right after the `ftp` field (line 222 `pub ftp: Arc<ftp::FtpService>,`), add:

```rust
    /// TFTP server lifecycle + event pipeline.
    pub tftp: Arc<tftp::TftpService>,
```

- [ ] **Step 3: Construct it**

In `AppState::new`, right after line 338 (`let ftp = Arc::new(ftp::FtpService::new(db_arc.clone()));`), add:

```rust
        let tftp = Arc::new(tftp::TftpService::new(db_arc.clone()));
```

And in the `Self { ... }` struct literal, right after the `ftp,` line (line 379), add:

```rust
            tftp,
```

- [ ] **Step 4: Add the command functions**

In `src-tauri/src/commands/mod.rs`, immediately after the FTP command block (after `ftp_events_stream`, ~line 4530, before `get_iac_execution`), add:

```rust
// ============================================================================
// TFTP server — config, lifecycle, events (no users; TFTP is anonymous)
// ============================================================================

fn read_tftp_config(db: &rusqlite::Connection) -> Result<tftp::TftpConfig, String> {
    db.query_row(
        "SELECT bind_host, bind_port, root_dir, read_only, auto_start
           FROM tftp_config WHERE id = 1",
        [],
        |row| {
            Ok(tftp::TftpConfig {
                bind_host: row.get(0)?,
                bind_port: row.get::<_, i64>(1)? as u16,
                root_dir: row.get(2)?,
                read_only: row.get::<_, i64>(3)? != 0,
                auto_start: row.get::<_, i64>(4)? != 0,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tftp_config_get(state: State<'_, AppState>) -> Result<tftp::TftpConfig, String> {
    let db = state.db.lock();
    read_tftp_config(&db)
}

#[tauri::command]
pub fn tftp_config_set(state: State<'_, AppState>, config: tftp::TftpConfig) -> Result<(), String> {
    // Make sure the chosen root exists (empty root = default, created on start).
    if !config.root_dir.trim().is_empty() {
        std::fs::create_dir_all(&config.root_dir).ok();
    }
    let db = state.db.lock();
    db.execute(
        "UPDATE tftp_config SET
           bind_host = ?1, bind_port = ?2, root_dir = ?3,
           read_only = ?4, auto_start = ?5,
           updated_at = strftime('%s','now')
         WHERE id = 1",
        rusqlite::params![
            &config.bind_host,
            config.bind_port as i64,
            &config.root_dir,
            if config.read_only { 1i64 } else { 0 },
            if config.auto_start { 1i64 } else { 0 },
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn tftp_status(state: State<'_, AppState>) -> Result<tftp::TftpStatus, String> {
    Ok(state.tftp.status())
}

#[tauri::command]
pub async fn tftp_start(state: State<'_, AppState>) -> Result<tftp::TftpStatus, String> {
    let config = {
        let db = state.db.lock();
        read_tftp_config(&db)?
    };
    state.tftp.start(config).await.map_err(|e| e.to_string())?;
    Ok(state.tftp.status())
}

#[tauri::command]
pub fn tftp_stop(state: State<'_, AppState>) -> Result<tftp::TftpStatus, String> {
    state.tftp.stop().map_err(|e| e.to_string())?;
    Ok(state.tftp.status())
}

#[tauri::command]
pub fn tftp_events_tail(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<tftp::TftpEvent>, String> {
    let lim = limit.unwrap_or(200).min(5000);
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT id, ts, kind, client_ip, path, detail
               FROM tftp_events ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([lim as i64], |r| {
            Ok(tftp::TftpEvent {
                id: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                client_ip: r.get(3)?,
                path: r.get(4)?,
                detail: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    out.reverse(); // oldest-first for the feed
    Ok(out)
}
```

- [ ] **Step 5: Register the commands**

In `src-tauri/src/lib.rs`, in the `tauri::generate_handler![ ... ]` block, right after the FTP entries (after `commands::ftp_events_stream,`, ~line 452), add:

```rust
            commands::tftp_config_get,
            commands::tftp_config_set,
            commands::tftp_status,
            commands::tftp_start,
            commands::tftp_stop,
            commands::tftp_events_tail,
```

- [ ] **Step 6: Build to verify**

Run: `cd src-tauri && cargo build 2>&1 | tail -15`
Expected: builds clean (no unresolved command/type errors).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(tftp): Tauri commands + AppState wiring + registration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Frontend RPC wrappers

**Files:**
- Modify: `src/lib/tauri.ts` (add TFTP types + wrappers after the FTP block, ~line 2116)

**Interfaces:**
- Produces: TS types `TftpConfig`, `TftpStatus`, `TftpEvent`; functions `tftpConfigGet`, `tftpConfigSet`, `tftpStatus`, `tftpStart`, `tftpStop`, `tftpEventsTail`.

- [ ] **Step 1: Add types + wrappers**

In `src/lib/tauri.ts`, immediately after the FTP `ftpEventsStream` function (line 2116, before the `// EDITOR COMMANDS` banner), add:

```typescript
// ============================================================================
// TFTP server (anonymous; no users)
// ============================================================================

export type TftpConfig = {
  bindHost: string;
  bindPort: number;
  rootDir: string;
  readOnly: boolean;
  autoStart: boolean;
};

export type TftpStatus = {
  running: boolean;
  bindAddress: string | null;
  startedAt: number | null;
  lastError: string | null;
  elevated: boolean;
};

export type TftpEvent = {
  id: number;
  ts: number;
  kind: string;
  clientIp: string | null;
  path: string | null;
  detail: string | null;
};

export const tftpConfigGet = () => invoke<TftpConfig>("tftp_config_get");
export const tftpConfigSet = (config: TftpConfig) =>
  invoke<void>("tftp_config_set", { config });

export const tftpStatus = () => invoke<TftpStatus>("tftp_status");
export const tftpStart = () => invoke<TftpStatus>("tftp_start");
export const tftpStop = () => invoke<TftpStatus>("tftp_stop");

export const tftpEventsTail = (limit?: number) =>
  invoke<TftpEvent[]>("tftp_events_tail", { limit: limit ?? null });
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | tail -15`
Expected: no new errors from `tauri.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(tftp): frontend RPC wrappers + types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: TftpSettingsTab UI + live feed + Settings mount

**Files:**
- Create: `src/windows/TftpSettingsTab.tsx`
- Create: `src/windows/TftpSettingsTab.test.tsx`
- Modify: `src/windows/Settings.tsx` (import, union member, sidebar button, mount line)

**Interfaces:**
- Consumes: `tftpConfigGet/Set`, `tftpStatus/Start/Stop`, `tftpEventsTail`, `TftpConfig`, `TftpStatus`, `TftpEvent` (Task 6); `openDialog` from `@tauri-apps/plugin-dialog`.
- Produces: `export function TftpSettingsTab({ visible }: { visible: boolean })`.

- [ ] **Step 1: Write the component**

Create `src/windows/TftpSettingsTab.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  tftpConfigGet,
  tftpConfigSet,
  tftpStatus,
  tftpStart,
  tftpStop,
  tftpEventsTail,
  type TftpConfig,
  type TftpStatus,
  type TftpEvent,
} from "../lib/tauri";

export function TftpSettingsTab({ visible }: { visible: boolean }) {
  const [config, setConfig] = useState<TftpConfig | null>(null);
  const [status, setStatus] = useState<TftpStatus | null>(null);
  const [events, setEvents] = useState<TftpEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const [c, s, e] = await Promise.all([
        tftpConfigGet(),
        tftpStatus(),
        tftpEventsTail(200),
      ]);
      setConfig(c);
      setStatus(s);
      setEvents(e);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Poll status + events while the tab is visible (works for in-process AND
  // the elevated helper, which can't push over an in-process channel).
  useEffect(() => {
    if (!visible) return;
    load();
    pollRef.current = setInterval(async () => {
      try {
        const [s, e] = await Promise.all([tftpStatus(), tftpEventsTail(200)]);
        setStatus(s);
        setEvents(e);
      } catch {
        /* transient — ignore */
      }
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [visible]);

  const handleSaveConfig = async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      await tftpConfigSet(config);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await tftpStart());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await tftpStop());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleBrowseRoot = async () => {
    if (!config) return;
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose TFTP root directory",
        defaultPath: config.rootDir || undefined,
      });
      if (typeof picked === "string" && picked.length > 0) {
        setConfig({ ...config, rootDir: picked });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!config) {
    return (
      <div className="tab-content">
        <h2>TFTP Server</h2>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <div className="tab-header">
        <h2>TFTP Server</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusPill status={status} />
          {status?.running ? (
            <button className="secondary" onClick={handleStop} disabled={busy}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={handleStart} disabled={busy}>
              Start
            </button>
          )}
        </div>
      </div>

      <p className="muted" style={{ marginBottom: 16 }}>
        Anonymous UDP TFTP server for pushing/pulling configs and images to lab gear.
        Port 69 requires a one-time macOS admin prompt when you start it.
      </p>

      {error && (
        <div className="error-message">
          <strong>Error:</strong> {error}
        </div>
      )}

      <h3 style={{ marginTop: 8 }}>Server configuration</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="form-group">
          <label>Bind host</label>
          <input
            type="text"
            value={config.bindHost}
            onChange={(e) => setConfig({ ...config, bindHost: e.target.value })}
            placeholder="0.0.0.0"
          />
          <small className="hint">0.0.0.0 = all interfaces (for lab gear)</small>
        </div>
        <div className="form-group">
          <label>Port</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={config.bindPort}
            onChange={(e) =>
              setConfig({ ...config, bindPort: Number(e.target.value) || 69 })
            }
          />
          <small className="hint">
            69 = standard TFTP (prompts for admin). ≥ 1024 runs without a prompt.
          </small>
        </div>
        <div className="form-group" style={{ gridColumn: "1 / -1" }}>
          <label>Root directory</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={config.rootDir}
              onChange={(e) => setConfig({ ...config, rootDir: e.target.value })}
              placeholder="Default: ~/.ccie-terminal/tftp"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="secondary"
              onClick={handleBrowseRoot}
              style={{ whiteSpace: "nowrap" }}
            >
              📁 Browse
            </button>
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={config.readOnly}
            onChange={(e) => setConfig({ ...config, readOnly: e.target.checked })}
          />
          Read-only (reject uploads)
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={config.autoStart}
            onChange={(e) => setConfig({ ...config, autoStart: e.target.checked })}
          />
          Auto-start (persisted; not yet auto-run at boot)
        </label>
      </div>
      <div className="form-actions" style={{ marginTop: 4 }}>
        <button className="primary" onClick={handleSaveConfig} disabled={busy}>
          Save configuration
        </button>
      </div>

      <h3 style={{ marginTop: 24 }}>Activity</h3>
      {events.length === 0 ? (
        <p className="muted">No transfers yet. Point a device at this server to see activity.</p>
      ) : (
        <div className="servers-list" data-testid="tftp-feed">
          {events.map((ev) => (
            <div key={ev.id} className="server-item" style={{ padding: "6px 10px" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12 }}>
                <span className="transport-badge">{ev.kind}</span>
                <code style={{ flex: 1 }}>{ev.path ?? "—"}</code>
                <span className="muted">{ev.clientIp ?? ""}</span>
                {ev.detail && <span className="muted">{ev.detail}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: TftpStatus | null }) {
  const running = status?.running === true;
  const label = running
    ? `Running${status?.elevated ? " · elevated" : ""} · ${status?.bindAddress ?? ""}`
    : "Stopped";
  return (
    <span
      className="tftp-pill"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        background: running ? "#0a2e1a" : "#262a33",
        color: running ? "#6bd968" : "#8a8d94",
        border: `1px solid ${running ? "#1b5a34" : "#262a33"}`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: running ? "#6bd968" : "#6c7380",
          boxShadow: running ? "0 0 6px #6bd968" : "none",
        }}
      />
      {label}
    </span>
  );
}
```

- [ ] **Step 2: Write the failing test**

Create `src/windows/TftpSettingsTab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TftpSettingsTab } from "./TftpSettingsTab";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("../lib/tauri", () => ({
  tftpConfigGet: vi.fn(),
  tftpConfigSet: vi.fn(),
  tftpStatus: vi.fn(),
  tftpStart: vi.fn(),
  tftpStop: vi.fn(),
  tftpEventsTail: vi.fn(),
}));

import * as tauri from "../lib/tauri";

const cfg = {
  bindHost: "0.0.0.0",
  bindPort: 69,
  rootDir: "",
  readOnly: false,
  autoStart: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  (tauri.tftpConfigGet as any).mockResolvedValue(cfg);
  (tauri.tftpStatus as any).mockResolvedValue({
    running: false,
    bindAddress: null,
    startedAt: null,
    lastError: null,
    elevated: false,
  });
  (tauri.tftpEventsTail as any).mockResolvedValue([]);
});

describe("TftpSettingsTab", () => {
  it("shows the empty-activity state when there are no events", async () => {
    render(<TftpSettingsTab visible={true} />);
    await waitFor(() => expect(screen.getByText(/no transfers yet/i)).toBeInTheDocument());
  });

  it("renders a feed row per event", async () => {
    (tauri.tftpEventsTail as any).mockResolvedValue([
      { id: 1, ts: 1, kind: "write", clientIp: "10.0.0.1", path: "r.cfg", detail: null },
      { id: 2, ts: 2, kind: "read", clientIp: "10.0.0.2", path: "img.bin", detail: "100 bytes" },
    ]);
    render(<TftpSettingsTab visible={true} />);
    await waitFor(() => expect(screen.getByTestId("tftp-feed")).toBeInTheDocument());
    expect(screen.getByText("r.cfg")).toBeInTheDocument();
    expect(screen.getByText("img.bin")).toBeInTheDocument();
    expect(screen.getByText("write")).toBeInTheDocument();
    expect(screen.getByText("read")).toBeInTheDocument();
  });

  it("shows a Start button when stopped", async () => {
    render(<TftpSettingsTab visible={true} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /start/i })).toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/windows/TftpSettingsTab.test.tsx --exclude '**/.worktrees/**' 2>&1 | tail -25`
Expected: fails first because the component/module isn't wired — then passes once Step 1 is in place. (If it already passes, good; proceed.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/windows/TftpSettingsTab.test.tsx --exclude '**/.worktrees/**' 2>&1 | tail -25`
Expected: 3 tests pass.

- [ ] **Step 5: Mount in Settings.tsx**

Four edits in `src/windows/Settings.tsx`:

(a) After line 10 (`import { FtpSettingsTab } from "./FtpSettingsTab";`), add:
```tsx
import { TftpSettingsTab } from "./TftpSettingsTab";
```

(b) In the `activeTab` union (line 91), add `"tftp"` right after `"ftp"`:
```tsx
    ... | "ftp" | "tftp" | "pyats" | ...
```

(c) After the FTP sidebar button (lines 520–525), add:
```tsx
            <button
              className={activeTab === "tftp" ? "active" : ""}
              onClick={() => setActiveTab("tftp")}
            >
              TFTP Server
            </button>
```

(d) After the FTP mount line (line 1126), add:
```tsx
        {activeTab === "tftp" && <TftpSettingsTab visible={activeTab === "tftp"} />}
```

- [ ] **Step 6: Typecheck + test**

Run: `npx tsc --noEmit 2>&1 | tail -15`
Expected: no new errors.
Run: `npx vitest run src/windows/TftpSettingsTab.test.tsx --exclude '**/.worktrees/**' 2>&1 | tail -10`
Expected: 3 pass.

- [ ] **Step 7: Commit**

```bash
git add src/windows/TftpSettingsTab.tsx src/windows/TftpSettingsTab.test.tsx src/windows/Settings.tsx
git commit -m "feat(tftp): Settings tab with config form + live activity feed

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end manual verification

**Files:** none (verification only).

This exercises the two paths automated tests can't: the real UDP wire and the osascript elevation prompt. Do this with the dev app running (`npm run tauri dev` or the project's run skill) — the dev server must be up.

- [ ] **Step 1: High-port smoke (no elevation)**

In Settings → TFTP Server: set port to `6969`, root to a scratch folder, Save, Start. Confirm the pill shows `Running · …:6969` and `elevated` is absent.

From a terminal:
```bash
echo "hostname R1" > /tmp/up.cfg
tftp 127.0.0.1 6969 <<'EOF'
binary
put /tmp/up.cfg up.cfg
get up.cfg /tmp/down.cfg
quit
EOF
diff /tmp/up.cfg /tmp/down.cfg && echo "ROUNDTRIP OK"
```
Expected: `ROUNDTRIP OK`, and the Activity feed shows a `write` then a `read` row with client `127.0.0.1`. Stop the server; pill returns to `Stopped`.

- [ ] **Step 2: Read-only rejects writes**

Enable "Read-only", Save, Start (still port 6969). Re-run the `put` above.
Expected: the `put` fails (permission denied), an `error` row appears in the feed, and the `get` of an existing file still succeeds.

- [ ] **Step 3: Port 69 elevation**

Set port back to `69`, disable read-only, Save, Start.
Expected: the native macOS admin password dialog appears once. After authorizing, the pill shows `Running · elevated · 0.0.0.0:69`.
```bash
tftp 127.0.0.1 69 <<'EOF'
binary
get up.cfg /tmp/down69.cfg
quit
EOF
```
Expected: transfer succeeds; feed shows the read.

- [ ] **Step 4: Stop tears down the elevated helper**

Click Stop. Within ~2s the pill shows `Stopped`. Verify no orphan:
```bash
ps aux | grep -- '--tftp-helper' | grep -v grep
cat ~/.ccie-terminal/tftp.pid 2>/dev/null; ls ~/.ccie-terminal/tftp.run 2>/dev/null
```
Expected: no `--tftp-helper` process; runfile gone. (pidfile may linger harmlessly; the helper removes it on clean exit.)

- [ ] **Step 5: Record result**

If all pass, note it in the commit/PR description. If the elevated helper leaves an orphan or Stop doesn't take effect within a few seconds, that's a Task 4 bug (runfile poll or getppid path) — fix before declaring done.

---

## Self-Review

**1. Spec coverage:**
- Access model (single root, RW, read-only toggle, path jail) → Tasks 2, 5, 7. ✓
- Activity log + live feed → Tasks 2 (insert), 5 (`tftp_events_tail`), 7 (feed). ✓
- Port 69 + elevation via osascript self-relaunch helper → Task 4. ✓
- Root dir default + folder picker → Tasks 3 (`effective_root`), 7 (Browse). ✓
- Backend module / migration / commands / RPC / tab mount → Tasks 1, 3, 5, 6, 7. ✓
- `async-tftp` dependency → Task 2. ✓
- Testing (path-jail, read-only, roundtrip, config, feed) → Tasks 2, 3, 7; elevation manual → Task 8. ✓

**2. Placeholder scan:** No TBD/TODO left as work. Two explicit **Verification notes** flag exact `async-tftp` symbol names (`Error` variants, `serve()`) to confirm against 0.4.2 docs — these are real risk callouts with fallbacks, not deferred work.

**3. Type consistency:** `TftpConfig`/`TftpStatus`/`TftpEvent` field names identical across `types.rs`, commands (`read_tftp_config`, `tftp_events_tail`), `tauri.ts`, and the component. `TftpService` methods (`new`/`is_running`/`status`/`start`/`stop`) consistent between Tasks 3, 5. Helper fns (`helper_is_running`/`helper_status`/`spawn_elevated`/`stop_elevated`/`run_helper_if_requested`) consistent between Tasks 3 (stubs) and 4 (impl). Migration column names match the SQL in the command layer.

## Open Risks (carried from spec)

- **`async-tftp` 0.4.2 API drift:** the `Error` enum variants and the server run method (`serve()`) weren't fully rendered from docs. Both are flagged inline with fallbacks. Confirm with `cargo doc -p async-tftp --open` during Task 2/3.
- **`async-fs::File` trait bounds:** must satisfy `AsyncRead/AsyncWrite + Unpin + Send + 'static`. It does in 2.x; if not, wrap with `blocking::Unblock` over `std::fs::File`.
- **Elevation UX / orphans:** helper must self-exit on runfile removal AND on parent death (`getppid()==1`). Task 8 Step 4 explicitly checks for orphans.
