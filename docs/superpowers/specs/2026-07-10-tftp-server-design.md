# TFTP Server — Design

**Date:** 2026-07-10
**Status:** Approved for implementation
**Author:** brainstormed with operator

## 1. Goal & context

Add a **TFTP server** to CCIE Terminal, parallel to the existing FTP server, so
network devices (switches, routers) can push/pull configs and IOS images to/from
the workstation. It lives as a **Settings tab** ("TFTP Server", next to
"FTP Server") — exactly like the FTP feature (no App.tsx mount, no menu, no
keyboard shortcut).

The FTP feature it mirrors:
- Backend module `src-tauri/src/ftp/` (`mod.rs`/`types.rs`/`server.rs`) exposing a
  `FtpService` stored in `AppState`.
- Commands in `commands/mod.rs`, registered in `lib.rs`.
- RPC wrappers/types in `src/lib/tauri.ts`.
- One React tab `src/windows/FtpSettingsTab.tsx`, mounted in `src/windows/Settings.tsx`.
- One migration (`V00xx__ftp.sql`) with `ftp_config` (singleton), `ftp_users`,
  `ftp_events`.

## 2. How TFTP differs from FTP (important)

TFTP (RFC 1350, UDP) has **no user accounts, no login/logout, no passive ports**.
This is a **structural mirror, not a line-for-line copy**.

- **Drop:** `tftp_users`, `SqliteAuthenticator`, per-user chroot, passive ports,
  presence (login/logout) events.
- **Keep:** config singleton, status, start/stop lifecycle, events table, Settings tab.
- **Add:** a global **read-only toggle**, a **live activity feed** shown in the tab,
  and **privilege elevation** for the standard port 69.

## 3. Access model

- A single shared **root directory**. Default `~/.ccie-terminal/tftp` (auto-created),
  changeable via a native **"Browse…" folder picker** (reuse
  `@tauri-apps/plugin-dialog` `open({ directory: true })`, as the FTP tab does).
- Anonymous **read (RRQ) + write (WRQ)**.
- A global **read-only** toggle: when on, WRQ (uploads) are rejected.
- **Path jail:** every requested path is resolved and confirmed to stay within the
  root; reject `..` traversal and absolute escapes.

## 4. Port & privilege elevation (the hard part)

- Default **UDP/69** (the real TFTP port), editable. Zero client-side port config
  on network gear.
- Binding a port `< 1024` on macOS requires **root**. The FTP-style server runs
  **in-process** in the (unprivileged) app, so we cannot bind 69 directly.

**Mechanism (approved):**
- On **enable**, if `bind_port < 1024`: the app **relaunches its own binary in a
  `--tftp-helper` mode** via `osascript … "with administrator privileges"`. macOS
  shows its **native password dialog once**. The elevated helper process:
  - binds UDP/`bind_port`,
  - runs the TFTP listener,
  - writes transfer events directly into the **shared SQLite DB** (path passed via
    argument/env),
  - is tracked by PID in `TftpService`.
- On **enable** with `bind_port >= 1024`: run the listener **in-process** on a tokio
  task (identical shape to FTP), no prompt.
- **Stop:** if elevated, terminate the helper process (and it should also self-exit
  if the parent dies); if in-process, signal shutdown on the task.
- **Errors:** bind failures (not elevated / port busy / user cancelled the auth
  prompt) surface as a visible error in the tab via `TftpStatus.last_error`, mirroring
  FTP.

**Consequence for the activity feed:** because the elevated server is a *separate
process*, an in-process broadcast channel can't carry its events. So the live feed
**polls `tftp_events_tail`** (~1.5s while the tab is visible) instead of a push
`Channel`. This one polling path works for BOTH in-process and elevated modes, which
keeps the UI uniform and simpler.

## 5. Backend — `src-tauri/src/tftp/`

### `mod.rs`
Declares `pub mod server;` / `pub mod types;` and re-exports the public API
(`TftpService`, `default_tftp_root`, and the `types` structs).

### `types.rs` (all `#[serde(rename_all = "camelCase")]`)
- `TftpConfig { bind_host: String, bind_port: u16, root_dir: String, read_only: bool, auto_start: bool }`
  with a `Default` impl (host `0.0.0.0`, port `69`, root = `default_tftp_root()`,
  read_only `false`, auto_start `false`).
- `TftpStatus { running: bool, bind_address: Option<String>, started_at: Option<i64>, last_error: Option<String>, elevated: bool }` (Serialize only).
- `TftpEvent { id: i64, ts: i64, kind: String, client_ip: Option<String>, path: Option<String>, detail: Option<String> }` (Serialize only). `kind` ∈ `"read"` | `"write"` | `"error"`.

### `server.rs`
- `struct TftpService { db, handle: Arc<Mutex<Option<TftpServerHandle>>>, last_error: Arc<Mutex<Option<String>>> }` — stored in `AppState`.
  - `new(db)`, `is_running()`, `status() -> TftpStatus`
  - `async fn start(&self, config: TftpConfig) -> Result<()>` — bails if running; if
    `port < 1024` spawn elevated helper, else run in-process via `async-tftp`.
  - `fn stop(&self) -> Result<()>` — idempotent; kills helper or signals task.
- In-process listener uses the **`async-tftp`** crate; custom handler enforces the
  path jail + read-only, and inserts a `tftp_events` row per RRQ/WRQ (and on error).
- `TftpServerHandle` variants for in-process (shutdown signal + join handle) vs
  elevated (child `Pid`). Track `started_at`, `bind_address`, `elevated`.
- `default_tftp_root() -> Result<PathBuf>` = `~/.ccie-terminal/tftp`.
- Event insertion is a shared helper both modes call (the helper process opens the DB
  by the path passed to it).

### Helper entry
A `--tftp-helper` branch in `main`/`lib.rs` startup that parses the DB path + config
from args/env, runs ONLY the listener (no Tauri window), and exits when the parent
process is gone.

## 6. Migration — `V0077__tftp.sql`

(Next free confirmed: latest is `V0076__whatsapp_bound_chat.sql`.)

```sql
CREATE TABLE tftp_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  bind_host  TEXT    NOT NULL DEFAULT '0.0.0.0',
  bind_port  INTEGER NOT NULL DEFAULT 69,
  root_dir   TEXT    NOT NULL DEFAULT '',
  read_only  INTEGER NOT NULL DEFAULT 0,
  auto_start INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO tftp_config (id) VALUES (1);

CREATE TABLE tftp_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  client_ip TEXT,
  path      TEXT,
  detail    TEXT
);
CREATE INDEX idx_tftp_events_ts ON tftp_events (ts);
```

(An empty `root_dir` is interpreted at read time as `default_tftp_root()`.)

## 7. Commands (`commands/mod.rs`, registered in `lib.rs`)

- `tftp_config_get(state) -> Result<TftpConfig, String>` — SELECT from `tftp_config WHERE id=1`; empty root → default.
- `tftp_config_set(state, config: TftpConfig)` — UPDATE `tftp_config WHERE id=1`; `create_dir_all` on root.
- `tftp_status(state) -> TftpStatus`
- `async tftp_start(state) -> TftpStatus` — read config, then `state.tftp.start(config).await`.
- `tftp_stop(state) -> TftpStatus`
- `tftp_events_tail(state, limit: Option<u32>)` — default 200, max 5000, oldest-first.

`AppState` gains `pub tftp: Arc<tftp::TftpService>` (constructed alongside `ftp`).
No users commands.

## 8. Frontend

### `src/lib/tauri.ts`
Types (`TftpConfig`, `TftpStatus`, `TftpEvent`) + wrappers `tftpConfigGet/Set`,
`tftpStatus/Start/Stop`, `tftpEventsTail`, mirroring the FTP ones minus users.

### `src/windows/TftpSettingsTab.tsx`
`function TftpSettingsTab({ visible }: { visible: boolean })`. On `visible`, load
config + status in parallel. Renders:
- Config form: bind host, port, root dir + "Browse…", read-only toggle, auto-start toggle.
- A `StatusPill` (running/stopped, shows "elevated" when applicable, shows `last_error`).
- Start / Stop buttons (Start may trigger the macOS auth prompt).
- A **live activity feed**: polls `tftpEventsTail` (~1.5s) while visible; renders
  rows (time, kind, client IP, path). Empty state before first transfer.

Inline styles + shared Settings classes (`tab-content`, `tab-header`, `form-group`,
`servers-list`, `server-item`, `transport-badge`, `error-message`, etc.).

### `src/windows/Settings.tsx`
- `import { TftpSettingsTab } from "./TftpSettingsTab";`
- Add `"tftp"` to the `activeTab` union.
- Sidebar tab button "TFTP Server" next to "FTP Server".
- Mount: `{activeTab === "tftp" && <TftpSettingsTab visible={activeTab === "tftp"} />}`

## 9. Dependency

Add to `src-tauri/Cargo.toml`: `async-tftp = "0.3"` (tokio-native, async RRQ/WRQ).
Everything else needed (tokio, rusqlite, dirs, tracing, anyhow, parking_lot) is
already present. `libunftp`/`unftp-sbe-fs` stay untouched.

## 10. Testing

**Rust**
- Path-jail: requests containing `..` / absolute escapes are rejected.
- Read-only: WRQ rejected when `read_only = true`.
- Config round-trip through `tftp_config`.
- Loopback integration: start on a high port (avoids elevation in CI), WRQ a file
  then RRQ it back, assert bytes match and two rows landed in `tftp_events`.

**Frontend**
- vitest for the feed: given a stubbed `tftpEventsTail`, polling renders rows and the
  empty state. Run with `--exclude '**/.worktrees/**'` (project convention).

Elevation itself (osascript prompt) is manual/live-verified, not in automated tests.

## 11. Files summary

**New:** `src-tauri/src/tftp/{mod.rs,types.rs,server.rs}`,
`src-tauri/migrations/V0077__tftp.sql`, `src/windows/TftpSettingsTab.tsx`.

**Edit:** `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` (`pub mod tftp;` + helper-mode
branch + command registration), `src-tauri/src/commands/mod.rs` (`use crate::tftp;`,
AppState field/construction, command fns), `src/lib/tauri.ts`,
`src/windows/Settings.tsx`.

## 12. Open risks

- **Elevation UX:** osascript auth prompt each enable on a fresh privilege session;
  helper lifecycle must not leave an orphaned root-owned process. Ensure the helper
  self-exits when the parent dies and that `stop` reliably kills it.
- **`async-tftp` API:** confirm the crate exposes per-request read/write hooks (or a
  custom handler trait) sufficient for path-jail, read-only, and event logging; if the
  0.3 API is too closed, fall back to a hand-rolled minimal RFC 1350 handler over
  `tokio::net::UdpSocket`.
