use crate::tftp::types::{TftpConfig, TftpStatus};
use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

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

use async_tftp::packet;
use async_tftp::server::Handler;
use std::net::SocketAddr;

/// Custom async-tftp handler: enforces the read-only toggle + path jail and
/// logs every RRQ/WRQ into tftp_events. File I/O uses async-fs (futures-io
/// compatible, which async-tftp's Reader/Writer bounds require).
///
/// NOTE on the error type: async-tftp 0.4.2's `Handler` trait returns
/// `Result<_, async_tftp::packet::Error>` (the TFTP protocol error, NOT
/// `async_tftp::Error`). Its `FileNotFound` / `PermissionDenied` variants are
/// unit variants (no `PathBuf` payload). We map jail/IO failures to the
/// closest protocol error and log every rejection.
pub struct LoggingHandler {
    pub db: Arc<Mutex<Connection>>,
    pub root: PathBuf,
    pub read_only: bool,
}

impl Handler for LoggingHandler {
    type Reader = async_fs::File;
    type Writer = async_fs::File;

    async fn read_req_open(
        &mut self,
        client: &SocketAddr,
        path: &Path,
    ) -> Result<(Self::Reader, Option<u64>), packet::Error> {
        let db = self.db.clone();
        let root = self.root.clone();
        let ip = client.ip().to_string();
        let req = path.to_path_buf();

        let full = resolve_in_root(&root, &req).map_err(|e| {
            insert_event(&db, "error", Some(&ip), req.to_str(), Some(&e));
            packet::Error::FileNotFound
        })?;
        let file = async_fs::File::open(&full).await.map_err(|e| {
            insert_event(&db, "error", Some(&ip), full.to_str(), Some(&e.to_string()));
            packet::Error::FileNotFound
        })?;
        let size = file.metadata().await.ok().map(|m| m.len());
        insert_event(
            &db,
            "read",
            Some(&ip),
            full.to_str(),
            size.map(|s| format!("{s} bytes")).as_deref(),
        );
        Ok((file, size))
    }

    async fn write_req_open(
        &mut self,
        client: &SocketAddr,
        path: &Path,
        _size: Option<u64>,
    ) -> Result<Self::Writer, packet::Error> {
        let db = self.db.clone();
        let root = self.root.clone();
        let ip = client.ip().to_string();
        let req = path.to_path_buf();
        let read_only = self.read_only;

        if read_only {
            insert_event(&db, "error", Some(&ip), req.to_str(), Some("server is read-only"));
            return Err(packet::Error::PermissionDenied);
        }
        let full = resolve_in_root(&root, &req).map_err(|e| {
            insert_event(&db, "error", Some(&ip), req.to_str(), Some(&e));
            packet::Error::PermissionDenied
        })?;
        if let Some(parent) = full.parent() {
            let _ = async_fs::create_dir_all(parent).await;
        }
        let file = async_fs::File::create(&full).await.map_err(|e| {
            insert_event(&db, "error", Some(&ip), full.to_str(), Some(&e.to_string()));
            packet::Error::PermissionDenied
        })?;
        insert_event(&db, "write", Some(&ip), full.to_str(), None);
        Ok(file)
    }
}

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
        let root_for_task = root.clone();
        let addr_for_log = bind_address.clone();

        // Build AND bind the UDP socket SYNCHRONOUSLY here (build().await is what
        // binds), BEFORE inserting any handle. This way a failure (e.g. port in
        // use) surfaces as an Err from start() instead of a phantom "running"
        // state set from inside a detached task.
        use async_tftp::server::TftpServerBuilder;
        let handler = LoggingHandler { db: db.clone(), root: root_for_task, read_only };
        let server = match TftpServerBuilder::with_handler(handler).bind(addr).build().await {
            Ok(s) => s,
            Err(e) => {
                *self.last_error.lock() = Some(format!("build: {e}"));
                insert_event(&db, "error", None, None, Some(&format!("build failed: {e}")));
                anyhow::bail!("failed to bind TFTP server on {bind_address}: {e}");
            }
        };

        // Success: the socket is bound. Only now create the shutdown channel,
        // record the handle, and clear last_error. Moving the built server into
        // the task is sound: TftpServer<H> is Send + 'static (serve() consumes
        // self, and tokio::spawn already required this bound previously).
        let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(1);
        insert_event(&db, "info", None, None, Some(&format!("listening on {addr_for_log}")));
        tokio::spawn(async move {
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

    fn mem_db_with_events() -> Arc<Mutex<Connection>> {
        // Same as mem_db but reused by service tests; events table is enough
        // because in-process start reads config from the passed TftpConfig,
        // not the DB.
        mem_db()
    }

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

    #[tokio::test]
    async fn start_on_busy_port_errors_and_stays_stopped() {
        // A second service binding the same in-process port must fail the bind
        // synchronously: start() returns Err AND is_running() stays false (no
        // phantom "running" handle).
        let cfg = |port: u16| TftpConfig {
            bind_host: "127.0.0.1".into(),
            bind_port: port,
            root_dir: std::env::temp_dir().join("tftp-busy-test").to_string_lossy().into(),
            read_only: false,
            auto_start: false,
        };

        let svc1 = TftpService::new(mem_db_with_events());
        svc1.start(cfg(16971)).await.expect("first start binds");
        assert!(svc1.is_running());

        let svc2 = TftpService::new(mem_db_with_events());
        let res = svc2.start(cfg(16971)).await;
        assert!(res.is_err(), "binding an already-bound port must return Err");
        assert!(!svc2.is_running(), "a failed bind must not leave the service running");
        assert!(svc2.status().last_error.is_some(), "the bind failure must be recorded");

        svc1.stop().expect("stop");
        assert!(!svc1.is_running());
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

    #[tokio::test]
    async fn read_only_rejects_upload_and_logs_error() {
        // Behavioral coverage of the read-only toggle: a read-only handler must
        // reject a WRQ (write_req_open -> Err) AND record an 'error' event.
        let db = mem_db();
        let client: SocketAddr = "10.0.0.7:5000".parse().unwrap();
        let mut h = LoggingHandler {
            db: db.clone(),
            root: PathBuf::from("/tmp/x"),
            read_only: true,
        };
        let res = h.write_req_open(&client, Path::new("r.cfg"), None).await;
        assert!(res.is_err(), "read-only handler must reject uploads");

        let conn = db.lock();
        let errors: i64 = conn
            .query_row("SELECT COUNT(*) FROM tftp_events WHERE kind='error'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(errors, 1, "a read-only rejection must log one error event");
    }

    #[tokio::test]
    async fn write_then_read_roundtrips_and_logs() {
        let db = mem_db();
        let dir = std::env::temp_dir().join(format!("tftp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let client: SocketAddr = "10.0.0.9:5000".parse().unwrap();

        // Write
        let mut wh = LoggingHandler {
            db: db.clone(),
            root: dir.clone(),
            read_only: false,
        };
        {
            use futures_lite::AsyncWriteExt;
            let mut w = wh.write_req_open(&client, Path::new("r.cfg"), None).await.unwrap();
            w.write_all(b"hostname R1\n").await.unwrap();
            w.flush().await.unwrap();
        }
        // Read
        let mut rh = LoggingHandler {
            db: db.clone(),
            root: dir.clone(),
            read_only: false,
        };
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
        let writes: i64 = conn
            .query_row("SELECT COUNT(*) FROM tftp_events WHERE kind='write'", [], |r| r.get(0))
            .unwrap();
        let reads: i64 = conn
            .query_row("SELECT COUNT(*) FROM tftp_events WHERE kind='read'", [], |r| r.get(0))
            .unwrap();
        assert_eq!((writes, reads), (1, 1));
    }
}
